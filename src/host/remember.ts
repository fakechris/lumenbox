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

/** How many existing memories the extractor is shown, so it can avoid repeating them. */
const RELEVANT_LIMIT = 12;

export interface Exchange {
  agentId: string;
  /** What arrived, and what the agent said back. Trimmed: the extractor needs the gist, not the log. */
  text: string;
  /** Who the exchange was with, when a person drove it. Carried so the note-taking is billed. */
  principal?: string;
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
  private readonly pending = new Map<string, string[]>();
  /** Who each pending exchange was with, positionally — see payerOf. */
  private readonly pendingPayers = new Map<string, (string | undefined)[]>();
  private readonly extractions = new Map<string, string[]>();
  /** Who each pending extraction batch belonged to, for the episode that condenses them. */
  private readonly extractionPayers = new Map<string, (string | undefined)[]>();
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RememberDeps) {
    this.log = deps.log ?? (() => {});
  }

  /**
   * Records an exchange, and runs extraction when the batch is full.
   *
   * Awaitable so a test can drive it, but callers are expected not to: the turn is over and nothing
   * downstream depends on this finishing.
   */
  async record(exchange: Exchange): Promise<void> {
    if (EXTRACT_EVERY <= 0) return;
    const batch = this.pending.get(exchange.agentId) ?? [];
    batch.push(exchange.text);
    this.pending.set(exchange.agentId, batch);
    const payers = this.pendingPayers.get(exchange.agentId) ?? [];
    payers.push(exchange.principal);
    this.pendingPayers.set(exchange.agentId, payers);
    if (batch.length < EXTRACT_EVERY) return;

    this.pending.set(exchange.agentId, []);
    this.pendingPayers.set(exchange.agentId, []);
    await this.extract(exchange.agentId, batch, payerOf(payers));
  }

  private async extract(
    agentId: string,
    exchanges: readonly string[],
    principal?: string
  ): Promise<void> {
    const combined = exchanges.join("\n\n---\n\n");
    const known = this.deps.registry.readMemoryRecords(agentId);
    // Only the memories this conversation could plausibly restate, so the extractor is not shown
    // hundreds of lines to check against — and so the prompt stays a sensible size.
    const relevant = selectRelevant(combined, known, RELEVANT_LIMIT);

    let records: MemoryRecord[];
    try {
      const reply = await this.ask(agentId, buildExtractionPrompt(combined, relevant), principal);
      records = parseExtraction(reply, known);
    } catch (error) {
      // Swallowed on purpose, and said once. The turn already succeeded; a failure to take notes is
      // not a failure the person needs to see, and retrying would spend money on the same guess.
      this.log(
        `could not extract memories: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

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
    if (seen.length < EPISODE_EVERY) {
      this.extractions.set(agentId, seen);
      this.extractionPayers.set(agentId, seenPayers);
      return;
    }
    this.extractions.set(agentId, []);
    this.extractionPayers.set(agentId, []);
    await this.condense(agentId, seen, payerOf(seenPayers));
  }

  private async condense(
    agentId: string,
    exchanges: readonly string[],
    principal?: string
  ): Promise<void> {
    try {
      const reply = await this.ask(agentId, buildEpisodePrompt(exchanges), principal);
      const episode = parseEpisode(reply);
      if (episode === undefined) return;
      this.deps.registry.appendMemoryRecords(agentId, [episode]);
      this.log(`condensed ${exchanges.length} batches into an episode`);
    } catch (error) {
      this.log(
        `could not write an episode: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** One plain, tool-free call on the cheap profile. */
  private async ask(agentId: string, prompt: string, principal?: string): Promise<string> {
    const response = await this.deps.client.messages.create({
      model: this.deps.provider.model,
      // Small: three lines of memory or six sentences of episode. A cap this tight is also a guard
      // against an extractor that decides to narrate.
      max_tokens: Math.min(1024, this.deps.provider.maxTokens),
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
