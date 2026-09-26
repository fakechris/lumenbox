/**
 * Noticing what a conversation taught, without being asked.
 *
 * `RememberFact` covers the case where an agent knows something is worth keeping. It does not cover
 * the ordinary one: a person says how they want things done, the agent absorbs it for this
 * conversation, and next week nobody remembers. Automatic extraction is for that.
 *
 * Three decisions, each about cost or about honesty:
 *
 * **After the turn, never inside it.** Extraction is a model call, and a person waiting on an answer
 * should not also wait on bookkeeping. It runs when the work is done, and if it fails the turn has
 * already succeeded.
 *
 * **Every few turns, not every turn.** Extracting on every exchange is the right call when a cheap
 * dedicated model is a given; here it would add a call to every single turn for a system whose
 * whole cost story is per-token. Batching several exchanges also gives the
 * extractor more to work with, which produces fewer restatements of the obvious.
 *
 * **It is allowed to find nothing.** An extractor that must produce output invents something, and a
 * memory filling with restatements of the obvious is worse than an empty one — it is read on every
 * future turn and crowds out what matters. The sentinel is explicit and the parser honours it.
 */

import { envNumber } from "../config.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ProviderProfile } from "./provider.ts";
import type { UsageLog } from "./usage.ts";
import {
  buildEpisodePrompt,
  buildExtractionPrompt,
  parseEpisode,
  parseExtraction,
  selectRelevant,
  type MemoryRecord,
} from "./memory.ts";
import {
  buildMaintenancePrompt,
  parseMaintenanceProposals,
  recordsOfPlan,
  snapshotForMaintenance,
  verifyMaintenanceProposals,
  type MaintenancePlan,
} from "./memory-maintenance.ts";
import { buildPitfallPrompt, parsePitfall, type PitfallSource } from "./pitfalls.ts";
import { credentialIn } from "./secret-scan.ts";
import type { HistoryEntry } from "./compaction.ts";
import { memoryRef } from "./memory.ts";

/**
 * How many exchanges accumulate before extraction runs.
 *
 * Three: enough for the extractor to see a pattern rather than one remark, few enough that something
 * learned early in a session is not lost if the process stops. Zero disables extraction entirely,
 * which is the honest way to turn off a feature that spends money.
 */
export const EXTRACT_EVERY = envNumber("AGENTBOX_EXTRACT_EVERY", 3);

/**
 * How many extractions before those exchanges are condensed into one episode.
 *
 * An episode exists so that when the individual notes decay, what they were about survives. Four
 * extractions is roughly a session's worth.
 */
export const EPISODE_EVERY = envNumber("AGENTBOX_EPISODE_EVERY", 4);

/**
 * How many episodes are condensed before the memory file is tidied (INV-781).
 *
 * The maintenance pass reads the whole live view and is the one memory call that can
 * write retractions on its own, so it runs at the cadence of condense or lower, never
 * higher: two episodes is a couple of sessions' worth, enough for a "next Tuesday" to
 * have passed. One runs it after every episode; zero disables it, which is the honest
 * way to turn off a feature that spends money and changes the file.
 */
export const MAINTAIN_EVERY = envNumber("AGENTBOX_MAINTAIN_EVERY", 2);

/**
 * Dry run: the pass proposes and verifies, logs what it would have written, and writes
 * nothing. For watching a model's judgement on a real memory file before trusting it.
 */
export const MAINTAIN_DRY_RUN = (process.env.AGENTBOX_MAINTAIN_DRY_RUN ?? "") !== "" && process.env.AGENTBOX_MAINTAIN_DRY_RUN !== "0";

/** How many existing memories the extractor is shown, so it can avoid repeating them. */
const RELEVANT_LIMIT = 12;

/**
 * How long a pre-compaction flush may take before it is given up on (INV-778).
 *
 * The flush is insurance for the summary, not a gate on it: compaction never waits for
 * it, but the agent's write chain does, and a hung extractor would hold every later
 * memory write behind it. One line is logged and the chain moves on.
 */
export const FLUSH_TIMEOUT_MS = envNumber("AGENTBOX_FLUSH_TIMEOUT_MS", 30_000);

/** Total prose a flush shows the extractor; and each exchange's share, so one long turn cannot take it all. */
const FLUSH_CHAR_CAP = 12_000;
const FLUSH_EXCHANGE_CHARS = 4_000;

export interface Exchange {
  agentId: string;
  /** What arrived, and what the agent said back. Trimmed: the extractor needs the gist, not the log. */
  text: string;
  /** Who the exchange was with, when a person drove it. Carried so the note-taking is billed. */
  principal?: string;
  /** Where in the transcript this was: `<conversation>@<time>`. What a kept note cites. */
  ref?: string;
  /**
   * The conversation and the time of the last transcript entry the exchange covers
   * (INV-778). Together they are the watermark: a compaction flush extracts only the
   * entries after it, and an exchange a flush already covered is not batched again.
   * Absent on callers that do not know — then the exchange is batched as before.
   */
  conversation?: string;
  at?: string;
}

/** One exchange waiting for its batch, with everything the batch will need. */
interface PendingExchange {
  text: string;
  principal?: string;
  ref?: string;
  conversation?: string;
  at?: string;
  guard: () => boolean;
}

export interface RememberDeps {
  registry: AgentRegistry;
  client: Anthropic;
  /** The cheap profile, so bookkeeping is not billed at the agent's model. */
  provider: ProviderProfile;
  /**
   * Where these calls are billed.
   *
   * Optional because a Rememberer without one still works; present because without it these
   * calls were invisible, and "the model cost X today" quietly meant "the turn loop cost X".
   */
  usage?: UsageLog;
  log?: (line: string) => void;
  /** How long a pre-compaction flush may run; defaults to `FLUSH_TIMEOUT_MS`. A test sets it short. */
  flushTimeoutMs?: number;
}

/**
 * Who a batch of exchanges belongs to, or nobody.
 *
 * Extraction runs over several exchanges, and in a team room those can be with different
 * people. One principal for a mixed batch would be a guess, and an attribution that is a
 * guess is worse than an absence — a bill nobody can check is worse than a gap everybody
 * can see. So a batch bills to a person only when every exchange in it was theirs.
 */
export function payerOf(principals: readonly (string | undefined)[]): string | undefined {
  const first = principals[0];
  if (first === undefined) return undefined;
  return principals.every(principal => principal === first) ? first : undefined;
}

/**
 * Accumulates exchanges and extracts from them when enough have piled up.
 *
 * One per orchestrator, keyed by agent. In memory on purpose: a pending exchange is worth nothing
 * after a restart — the conversation it came from is still in the transcript, and re-extracting it
 * would cost a call to recover something nobody missed.
 */
export class Rememberer {
  private readonly pending = new Map<string, PendingExchange[]>();
  /**
   * Per agent and conversation, the transcript time through which exchanges have been
   * handed to the extractor (INV-778). The compaction flush reads it so it does not
   * extract what a batch already has, and advances it so the next batch does not
   * extract what the flush just did. In memory like the queue: after a restart the
   * worst case is one re-extraction, which dedupe absorbs.
   */
  private readonly extractedThrough = new Map<string, string>();
  /**
   * One write chain per agent (docs/24 review, Codex finding 6 + Grok round 2).
   *
   * `record` used to clear the pending queue and then await extraction, so a second
   * batch could run concurrently with the first: each snapshots the known records at
   * its own start and appends at its own completion, and a *slow older* batch then
   * lands after a newer correction — later in the file, newer-looking timestamps —
   * and replaces it through dedupe rather than merely reordering the prompt. The
   * chain makes every memory write for one agent sequential in conversation order:
   * batch N's append is on disk before batch N+1 reads what is known.
   */
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly extractions = new Map<string, string[]>();
  /** Who each pending extraction batch belonged to, for the episode that condenses them. */
  private readonly extractionPayers = new Map<string, (string | undefined)[]>();
  /** Where each condensed batch's exchanges were, for the episode to cite. */
  private readonly extractionRefs = new Map<string, string[]>();
  private readonly extractionGuards = new Map<string, (() => boolean)[]>();
  /** Episodes condensed since the last maintenance pass, per agent (INV-781). */
  private readonly episodesSinceMaintenance = new Map<string, number>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RememberDeps) {
    this.log = deps.log ?? (() => {});
  }

  /**
   * Distils one observed failure into a pitfall, or into nothing.
   *
   * Fire-and-forget like extraction, and for the same reason: nobody is waiting on it, and
   * a failure to take notes about a failure must not become a second failure. Written
   * immediately rather than batched — the four events that trigger it are rare, and a
   * batch would mix unrelated walls.
   */
  async recordPitfall(input: {
    agentId: string;
    source: PitfallSource;
    attempt: string;
    detail: string;
    principal?: string;
  }): Promise<void> {
    const guard = this.deps.registry.contextWriteGuard();
    await this.enqueue(input.agentId, () => this.writePitfall(input, guard));
  }

  private async writePitfall(input: {
    agentId: string;
    source: PitfallSource;
    attempt: string;
    detail: string;
    principal?: string;
  }, guard: () => boolean): Promise<void> {
    try {
      if (!guard()) return;
      const reply = await this.ask(
        input.agentId,
        buildPitfallPrompt({ source: input.source, attempt: input.attempt, detail: input.detail }),
        input.principal
      );
      const record = parsePitfall(reply, input.source);
      if (record === undefined || !guard()) return;
      this.deps.registry.appendMemoryRecords(input.agentId, [record]);
      this.log(`kept a pitfall from ${input.source}: ${record.text.slice(0, 80)}`);
    } catch (error) {
      this.log(
        `could not distil a pitfall: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Records an exchange, and runs extraction when the batch is full.
   *
   * Awaitable so a test can drive it, but callers are expected not to: the turn is over and nothing
   * downstream depends on this finishing.
   */
  async record(exchange: Exchange): Promise<void> {
    if (EXTRACT_EVERY <= 0) return;
    // Already covered by a compaction flush: batching it again would extract it twice.
    if (this.behindWatermark(exchange.agentId, exchange.conversation, exchange.at)) return;
    const batch = this.pending.get(exchange.agentId) ?? [];
    batch.push({
      text: exchange.text,
      principal: exchange.principal,
      ref: exchange.ref,
      conversation: exchange.conversation,
      at: exchange.at,
      guard: this.deps.registry.contextWriteGuard(),
    });
    this.pending.set(exchange.agentId, batch);
    if (batch.length < EXTRACT_EVERY) return;

    this.pending.set(exchange.agentId, []);
    this.advanceWatermark(exchange.agentId, batch);
    await this.enqueue(exchange.agentId, () =>
      this.extract(
        exchange.agentId,
        batch.map(item => item.text),
        payerOf(batch.map(item => item.principal)),
        batch.map(item => item.ref),
        () => batch.every(item => item.guard())
      )
    );
  }

  /**
   * Extracts from the entries a summary is about to replace, now, ahead of the batch
   * (INV-778).
   *
   * The batch waits for three exchanges; a compaction does not wait for anything. Only
   * the entries past the watermark go: what a batch already extracted is not extracted
   * again, and what this flush covers is taken out of the pending queue so the next batch
   * does not repeat it. Each exchange is cited by its own place in the transcript, the way
   * a batch is. The extractor is told state changes come first, because a summary keeps
   * a fact and loses that it stopped being true.
   *
   * Never throws and never blocks compaction: the caller does not await it, and a flush
   * that fails or hangs past `FLUSH_TIMEOUT_MS` is one logged line.
   */
  async flush(agentId: string, conversation: string, entries: readonly HistoryEntry[]): Promise<void> {
    if (EXTRACT_EVERY <= 0) return;
    const watermark = this.extractedThrough.get(watermarkKey(agentId, conversation));
    const fresh = entries.filter(entry => {
      const at = (entry as { at?: string }).at;
      return at === undefined || watermark === undefined || at > watermark;
    });
    const exchanges = exchangesOf(fresh, conversation);
    if (exchanges.length === 0) return;
    const skipped = entries.length - fresh.length;
    this.log(
      `flushing ${exchanges.length} exchange${exchanges.length === 1 ? "" : "s"} to memory before they are summarised` +
        (skipped > 0 ? ` (${skipped} entr${skipped === 1 ? "y" : "ies"} already extracted)` : "")
    );
    // Marked as extracted before the model answers, so a batch that fills meanwhile does
    // not take the same exchanges; the pending queue is trimmed for the same reason.
    const through = exchanges[exchanges.length - 1]!.at;
    this.extractedThrough.set(watermarkKey(agentId, conversation), through);
    this.pending.set(
      agentId,
      (this.pending.get(agentId) ?? []).filter(item => !this.behindWatermark(agentId, item.conversation, item.at))
    );
    const guard = this.deps.registry.contextWriteGuard();
    await this.enqueue(agentId, async () => {
      let timer: NodeJS.Timeout | undefined;
      const limit = this.deps.flushTimeoutMs ?? FLUSH_TIMEOUT_MS;
      const timeout = new Promise<"timeout">(resolve => {
        timer = setTimeout(() => resolve("timeout"), limit);
      });
      try {
        const outcome = await Promise.race([
          this.extract(agentId, exchanges.map(item => item.text), undefined, exchanges.map(item => item.ref), guard, { stateChangesFirst: true }),
          timeout,
        ]);
        if (outcome === "timeout") this.log(`pre-compaction memory flush timed out after ${limit}ms; the summary stands`);
      } catch (error) {
        this.log(`pre-compaction memory flush failed (${error instanceof Error ? error.message : String(error)}); the summary stands`);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    });
  }

  private behindWatermark(agentId: string, conversation: string | undefined, at: string | undefined): boolean {
    if (conversation === undefined || at === undefined) return false;
    const watermark = this.extractedThrough.get(watermarkKey(agentId, conversation));
    return watermark !== undefined && at <= watermark;
  }

  private advanceWatermark(agentId: string, batch: readonly PendingExchange[]): void {
    for (const item of batch) {
      if (item.conversation === undefined || item.at === undefined) continue;
      const key = watermarkKey(agentId, item.conversation);
      const current = this.extractedThrough.get(key);
      if (current === undefined || item.at > current) this.extractedThrough.set(key, item.at);
    }
  }

  /** Resolves once every memory write queued so far for the agent has landed or failed. For tests and shutdown. */
  settle(agentId: string): Promise<void> {
    return this.writeChains.get(agentId) ?? Promise.resolve();
  }

  /** Appends work to the agent's write chain. A failed link never breaks the chain. */
  private enqueue(agentId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.writeChains.get(agentId) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The stored link swallows, so one failure cannot poison every later batch;
    // the returned one does not, so a caller that awaits still sees its own error.
    this.writeChains.set(agentId, next.catch(() => {}));
    return next;
  }

  private async extract(
    agentId: string,
    exchanges: readonly string[],
    principal?: string,
    refs: readonly (string | undefined)[] = [],
    guard: () => boolean = () => true,
    options: { stateChangesFirst?: boolean } = {}
  ): Promise<void> {
    if (!guard()) return;
    // Citable only when every exchange has a place: a numbering with holes would let the
    // extractor cite a number that means nothing, and a wrong source is worse than none.
    const citable = refs.length === exchanges.length && refs.every(ref => ref !== undefined)
      ? (refs as string[])
      : [];
    const combined =
      citable.length > 1
        ? exchanges.map((exchange, index) => `[${index + 1}]\n${exchange}`).join("\n\n---\n\n")
        : exchanges.join("\n\n---\n\n");
    const known = this.deps.registry.readMemoryRecords(agentId);
    // Only the memories this conversation could plausibly restate, so the extractor is not shown
    // hundreds of lines to check against — and so the prompt stays a sensible size.
    const relevant = selectRelevant(combined, known, RELEVANT_LIMIT);

    let records: MemoryRecord[];
    try {
      const reply = await this.ask(
        agentId,
        buildExtractionPrompt(combined, relevant, citable.length > 1 ? citable.length : 1, options),
        principal
      );
      records = parseExtraction(reply, known, new Date(), citable);
      // parseExtraction drops what validateRecord refuses; a credential is the one worth saying so,
      // and only by kind — the line itself is what must not be written anywhere (INV-740).
      const leaked = reply.split("\n").map(line => credentialIn(line)).filter((kind): kind is string => kind !== undefined);
      if (leaked.length > 0) this.log(`dropped ${leaked.length} extracted line(s) that looked like a credential (${[...new Set(leaked)].join(", ")})`);
    } catch (error) {
      // Swallowed on purpose, and said once. The turn already succeeded; a failure to take notes is
      // not a failure the person needs to see, and retrying would spend money on the same guess.
      this.log(
        `could not extract memories: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    if (!guard()) return;
    if (records.length > 0) {
      this.deps.registry.appendMemoryRecords(agentId, records);
      this.log(`kept ${records.length} memor${records.length === 1 ? "y" : "ies"} from ${exchanges.length} exchanges`);
    }

    // Whether or not anything was extracted, the exchanges count toward an episode: a stretch of
    // work that produced no individual facts still happened, and that is what an episode is for.
    const seen = this.extractions.get(agentId) ?? [];
    seen.push(combined);
    const seenPayers = this.extractionPayers.get(agentId) ?? [];
    seenPayers.push(principal);
    const seenRefs = this.extractionRefs.get(agentId) ?? [];
    seenRefs.push(...citable);
    const seenGuards = this.extractionGuards.get(agentId) ?? [];
    seenGuards.push(guard);
    if (seen.length < EPISODE_EVERY) {
      this.extractions.set(agentId, seen);
      this.extractionPayers.set(agentId, seenPayers);
      this.extractionRefs.set(agentId, seenRefs);
      this.extractionGuards.set(agentId, seenGuards);
      return;
    }
    this.extractions.set(agentId, []);
    this.extractionPayers.set(agentId, []);
    this.extractionRefs.set(agentId, []);
    this.extractionGuards.set(agentId, []);
    await this.condense(agentId, seen, payerOf(seenPayers), seenRefs, () => seenGuards.every(check => check()));
  }

  private async condense(
    agentId: string,
    exchanges: readonly string[],
    principal?: string,
    refs: readonly string[] = [],
    guard: () => boolean = () => true
  ): Promise<void> {
    try {
      if (!guard()) return;
      const reply = await this.ask(agentId, buildEpisodePrompt(exchanges), principal);
      const episode = parseEpisode(reply, new Date(), refs);
      if (episode !== undefined && guard()) {
        this.deps.registry.appendMemoryRecords(agentId, [episode]);
        this.log(`condensed ${exchanges.length} batches into an episode`);
      }
    } catch (error) {
      this.log(
        `could not write an episode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Whether or not the episode was worth writing, the stretch of work it stood for
    // counts toward the tidy: the file aged either way.
    if (MAINTAIN_EVERY <= 0 || !guard()) return;
    const count = (this.episodesSinceMaintenance.get(agentId) ?? 0) + 1;
    if (count < MAINTAIN_EVERY) {
      this.episodesSinceMaintenance.set(agentId, count);
      return;
    }
    this.episodesSinceMaintenance.set(agentId, 0);
    await this.maintain(agentId, { principal, guard });
  }

  /**
   * The memory maintenance pass (INV-781): propose, verify, apply.
   *
   * Runs on the agent's write chain like every other memory write, so a batch cannot
   * land between the snapshot and the apply — and the verify step re-reads the live view
   * anyway, refusing any proposal whose version has moved. Public so a test and an
   * operator can run it on demand; `condense` runs it on its own cadence. The plan is
   * returned so a caller can see what was and was not applied, and why.
   */
  async maintain(
    agentId: string,
    options: { principal?: string; guard?: () => boolean; dryRun?: boolean; now?: Date } = {}
  ): Promise<MaintenancePlan | undefined> {
    const guard = options.guard ?? this.deps.registry.contextWriteGuard();
    const dryRun = options.dryRun ?? MAINTAIN_DRY_RUN;
    const now = options.now ?? new Date();
    try {
      if (!guard()) return undefined;
      const candidates = snapshotForMaintenance(this.deps.registry.readMemoryRecords(agentId));
      if (candidates.length < 2) return undefined;
      const reply = await this.ask(agentId, buildMaintenancePrompt(candidates, now), options.principal, 2048);
      const parsed = parseMaintenanceProposals(reply);
      if (!guard()) return undefined;
      // The live view is read again here, after the model answered: what the verify step
      // compares versions against is what is on disk now, not what the snapshot saw.
      const plan = verifyMaintenanceProposals(parsed.proposals, candidates, this.deps.registry.readMemoryRecords(agentId), { now });
      plan.dropped.unshift(...parsed.dropped);
      for (const { proposal, why } of plan.dropped) {
        this.log(`maintenance dropped ${proposal.op ?? "a proposal"}${proposal.ids !== undefined ? ` of ${proposal.ids.join(",")}` : ""}: ${why}`);
      }
      const records = recordsOfPlan(plan);
      const summary = plan.changes.map(change => change.proposal.op).join(", ");
      if (records.length === 0) {
        this.log(`maintenance pass over ${candidates.length} memories found nothing to change`);
        return plan;
      }
      if (dryRun) {
        this.log(`maintenance dry run: would apply ${plan.changes.length} change(s) (${summary}) as ${records.length} record(s); nothing written`);
        return plan;
      }
      this.deps.registry.appendMemoryRecords(agentId, records);
      this.log(`maintenance applied ${plan.changes.length} change(s) (${summary}) over ${candidates.length} memories`);
      return plan;
    } catch (error) {
      this.log(`maintenance pass failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** One plain, tool-free call on the cheap profile. */
  private async ask(agentId: string, prompt: string, principal?: string, maxTokens = 1024): Promise<string> {
    const response = await this.deps.client.messages.create({
      model: this.deps.provider.model,
      // Small: three lines of memory or six sentences of episode. A cap this tight is also a guard
      // against an extractor that decides to narrate. Maintenance asks for twice that: a JSON
      // list of ten proposals with their text does not fit in one thousand tokens.
      max_tokens: Math.min(maxTokens, this.deps.provider.maxTokens),
      messages: [{ role: "user", content: prompt }],
    });
    this.deps.usage?.recordAside({
      kind: "memory",
      agentId,
      agentName: this.deps.registry.tryGet(agentId)?.profile.name ?? agentId,
      provider: this.deps.provider.label,
      model: this.deps.provider.model,
      usage: response.usage,
      ...(principal !== undefined ? { principal } : {}),
    });
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map(block => block.text)
      .join("\n");
  }
}

/**
 * The text an exchange contributes, trimmed.
 *
 * What the person said and what the agent concluded — not the tool traffic in between. Extraction is
 * looking for durable preferences and decisions, and a page of shell output is where it goes to
 * hallucinate a fact about a filename.
 */
export function summariseExchange(inbound: string, outbound: string, limit = 4_000): string {
  const trim = (text: string) => {
    const clean = text.trim().replace(/\s+\n/g, "\n");
    return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
  };
  return [`They said: ${trim(inbound)}`, `You replied: ${trim(outbound)}`].join("\n\n");
}

function watermarkKey(agentId: string, conversation: string): string {
  return `${agentId}\u0000${conversation}`;
}

/**
 * The entries a summary will replace, regrouped as the exchanges the extractor reads
 * (INV-778): a person's message and what the agent said back until the next message.
 * Tool traffic is left out for the reason `summariseExchange` gives; text the agent
 * wrote alongside a tool call is kept, because that is where it says what it decided.
 * Each exchange cites its own place, so a record kept from it can be checked against
 * what was said — the provenance a batch-extracted record carries.
 */
export function exchangesOf(
  entries: readonly HistoryEntry[],
  conversation: string
): { text: string; ref: string; at: string }[] {
  const groups: { lines: string[]; first: string; last: string }[] = [];
  for (const entry of entries) {
    const at = (entry as { at?: string }).at ?? "";
    let line: string | undefined;
    if (!("kind" in entry)) {
      line = `${entry.role === "user" ? "They said" : "You replied"}: ${entry.text.trim()}`;
    } else if (entry.kind === "blocks") {
      const said = entry.blocks
        .filter((block): block is { type: "text"; text: string } => (block as { type?: string }).type === "text")
        .map(block => block.text.trim())
        .filter(text => text !== "")
        .join("\n");
      if (said !== "") line = `You replied: ${said}`;
    }
    if (line === undefined || line.trim() === "") continue;
    const opensExchange = !("kind" in entry) && entry.role === "user";
    const current = groups[groups.length - 1];
    if (opensExchange || current === undefined) groups.push({ lines: [line], first: at, last: at });
    else {
      current.lines.push(line);
      if (at > current.last) current.last = at;
    }
  }
  const share = Math.max(400, Math.min(FLUSH_EXCHANGE_CHARS, Math.floor(FLUSH_CHAR_CAP / Math.max(1, groups.length))));
  return groups.map(group => {
    const joined = group.lines.join("\n\n");
    const text = joined.length > share ? `${joined.slice(0, share)}…` : joined;
    const when = group.first === "" ? new Date() : new Date(group.first);
    return { text, ref: memoryRef(conversation, Number.isNaN(when.getTime()) ? new Date() : when), at: group.last };
  });
}
