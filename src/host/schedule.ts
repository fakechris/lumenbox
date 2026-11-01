/**
 * Skills that run without anyone asking.
 *
 * A skill with a `schedule:` in its frontmatter is an automation. That is the whole addition — no new
 * storage, no new object, no second concept. A recipe and a time.
 *
 * "Without anyone asking" is where all the weight is, and it forces four answers:
 *
 * **It spends money unwatched.** Which is why this waited for the policy gate. A scheduled run goes
 * through the same check as any other turn, so a box over its budget stops firing rather than
 * quietly draining it, and the refusal is on the record.
 *
 * **Runs must not overlap.** An hourly job that takes seventy minutes meets its own next fire. Piling
 * a second run on top turns a slow problem into an avalanche, so a fire that finds the previous one
 * still going is skipped and *said* — a silent skip is indistinguishable from a schedule that stopped
 * working.
 *
 * **A missed window is not caught up.** If the box was down for two days, "generate the daily report"
 * arguably wants two runs and "check every hour" emphatically does not want forty-eight. There is no
 * way to tell which from a cron expression, so nothing is replayed: the next fire happens at the next
 * scheduled time, and the gap is logged. Stated here because the alternative — silently catching up —
 * is the one that produces a surprise bill.
 *
 * **The agent has to know it was not a person.** A wake with no explanation reads as someone talking,
 * and an agent that thinks a person is waiting behaves differently from one doing background work. So
 * a scheduled turn carries what fired it.
 *
 * Scheduling lives in the orchestrator's own process rather than in a backend that delivers into
 * the box — that split earns its keep when boxes hibernate, and ours are running or they are not
 * running at all. An in-process timer is enough, at the cost that a window passing while the
 * orchestrator is restarting is simply missed, which is the same trade as the paragraph above and
 * is why it is acceptable.
 */

import { describeSchedule, isDue, nextFire, type Schedule } from "./schedule-time.ts";
import { envNumber } from "../config.ts";
import { webhookPrompt } from "./webhooks.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import type { DeliverWhen } from "./routine-resolve.ts";
import type { RunResult } from "./run-result.ts";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";
export { ONCE_GRACE_MS, describeSchedule, isDue, knownTimezone, nextFire, parseSchedule, wallClock, type Schedule } from "./schedule-time.ts";

/**
 * What a scheduled turn is told.
 *
 * The distinction it exists for: a wake with no explanation reads as a person talking, and an agent
 * that believes someone is waiting behaves differently from one doing background work — it asks
 * clarifying questions nobody will answer, and it hurries.
 */
export function triggerPrompt(
  skillName: string,
  path: string,
  described: string,
  deliver?: string
): string {
  return [
    `[scheduled] This turn was started by a timer, not by a person. ${
      deliver === undefined
        ? "Nobody is waiting on a reply and no one will answer a question, so do the work and record the result where it can be found later."
        : "Nobody will answer a question, so decide rather than ask — but your reply is delivered to a chat where people will read it, so write it for them."
    } The rules for unattended work in your system prompt apply: the skill's text is your whole authorization, and a step it did not ask for is a recommendation in your result, not an action. If there is nothing to do this time, call NothingToSay with the reason.`,
    "",
    `You are running the **${skillName}** skill, scheduled ${described}. Read \`${path}\` and follow it.`,
    "",
    deliver === undefined
      ? "If it produces something, write it under /home/box/work and say the path — that is how anyone sees it. If it cannot run, say why in one line rather than retrying: this will come round again."
      : "Your final message is what the chat receives, so make it the thing itself — the brief, the summary, the numbers — not a report that a brief was written. Keep it short enough to read on a phone; put the long version under /home/box/work and name the file. If it could not run, say so in one line: this comes round again.",
  ].join("\n");
}

// ── running them ──────────────────────────────────────────────────────────────────────

/** Just enough of a skill for the runner. Keeps this module unaware of how skills are stored. */
export interface Scheduled {
  slug: string;
  name: string;
  path: string;
  schedule: Schedule;
  runAs?: string;
  mode?: RoutineMode;
  /** IANA zone the times are read in. Absent means the host's own clock. */
  timezone?: string;
  /**
   * Where the run reports to, as a chatKey.
   *
   * Absent means the work happens and the chat hears nothing — right for a tidy-up,
   * wrong for a morning brief, and the difference was invisible before this existed: a
   * scheduled skill wrote into the main conversation, which no chat reads.
   */
  deliver?: string;
  /** Whether every run reaches that chat, or only one that changed something (INV-776). */
  deliverWhen?: DeliverWhen;
  /** The agent that wrote it, when one did. Provenance, not permission — see skills.ts. */
  authoredBy?: string;
  /** Why it exists, in the author's words. */
  because?: string;
  /** Off until a person turns it on. Skipped by the tick, refused by runNow, shown in status. */
  paused?: boolean;
  /** Which box the file lives in (docs/30); the run goes to an agent of that box. */
  boxId?: string;
  /** The tools the skill says it needs (INV-691); an unattended run is narrowed to them. */
  allowedTools?: readonly string[];
}

/** A skill that fires on a matching message. Same runner rules as a schedule. */
/** A routine that fires when its own URL is called (webhooks.ts). */
export interface Hooked {
  slug: string;
  mode?: RoutineMode;
  name: string;
  path: string;
  runAs?: string;
  deliver?: string;
  deliverWhen?: DeliverWhen;
  paused?: boolean;
  boxId?: string;
  authoredBy?: string;
  because?: string;
  /** The tools the skill says it needs (INV-691); an unattended run is narrowed to them. */
  allowedTools?: readonly string[];
}

export interface Listening {
  slug: string;
  name: string;
  path: string;
  match: string;
  chat?: string;
  runAs?: string;
  mode?: RoutineMode;
  paused?: boolean;
  boxId?: string;
  /** The tools the skill says it needs (INV-691); an unattended run is narrowed to them. */
  allowedTools?: readonly string[];
}

/** Whether a message matches a listener's `match:` — a /regex/flags, or a phrase, case-insensitively. */
export function listenerMatches(match: string, text: string): boolean {
  const regex = /^\/(.*)\/([a-z]*)$/s.exec(match);
  if (regex !== null) {
    try {
      return new RegExp(regex[1]!, regex[2]).test(text);
    } catch {
      return false;
    }
  }
  return match.trim() !== "" && text.toLowerCase().includes(match.trim().toLowerCase());
}

/** What the run is told when a message, not a timer, started it. */
export function listenerPrompt(
  skillName: string,
  path: string,
  said: { text: string; sender: string; chatKey: string }
): string {
  return [
    `[listener] This turn was started because a message matched the **${skillName}** routine, not because ` +
      "someone addressed you. Your reply is delivered to the chat it was said in, where people will read it; " +
      "nobody will answer a question, so decide rather than ask. The rules for unattended work in your " +
      "system prompt apply: the routine's text is your whole authorization, and a step it did not ask for " +
      "is a recommendation in your result, not an action.",
    "",
    `Read \`${path}\` and follow it for this message from ${said.sender} in ${said.chatKey}:`,
    "",
    said.text.slice(0, 4_000),
    "",
    "Make your final message the thing itself, short enough to read on a phone. If the routine does not " +
      "actually apply to this message, call NothingToSay with the reason.",
  ].join("\n");
}

/**
 * Where a schedule's run history lives.
 *
 * Kept next to the transcripts and the usage log: same lifetime, same volume, same backup.
 */
export function scheduleLogPath(): string {
  return process.env.AGENTBOX_SCHEDULE_LOG ?? join(agentboxHome(), "schedules.jsonl");
}

/** One thing that happened to one schedule. Append-only, like everything else durable here. */
/** How a routine is allowed to act (INV-1458): off = never evaluated; observe = the trigger is recorded as "would run", nothing runs; auto = runs. */
export type RoutineMode = "off" | "observe" | "auto";

interface RunRecord {
  slug: string;
  at: string;
  event: "started" | "finished" | "skipped" | "observed";
  /** On `observed`: what would have run, in one line (INV-1458). */
  would?: string;
  /** Which agent ran it. On `started` and `finished`. */
  agent?: string;
  /**
   * Tokens billed to that agent between start and finish, on `finished`. The agent runs its
   * turns one at a time, so what it spent in that window is this run — give or take a memory
   * write from the turn before. Absent when there is no usage log to ask.
   */
  tokens?: number;
  /** How long the run took, on `finished`. */
  ms?: number;
  /** How the run came out, on `finished` (INV-1404): done, partial or failed; absent when the runner did not say. */
  result?: RunResult;
}

/**
 * What the ledger knows about a schedule, after reading it back.
 *
 * `interrupted` is the state that only exists across a restart: a run that started and has no
 * matching end. It is deliberately not the same as "running" — the process that owned it is gone,
 * so treating it as running would block that schedule forever, and treating it as never having
 * happened would fire the same window twice.
 */
interface RunState {
  lastRun: Date | undefined;
  interrupted: boolean;
}

export interface SchedulerDeps {
  /** The skills with schedules, re-read each tick so an edit takes effect without a restart. */
  due: () => Promise<readonly Scheduled[]>;
  /** The skills with listeners, re-read on each message so an edit takes effect at once. */
  listeners?: () => Promise<readonly Listening[]>;
  /** The skills that fire on a webhook, re-read per call for the same reason. */
  hooked?: () => Promise<readonly Hooked[]>;
  /**
   * Runs a turn and comes back with what the agent said.
   *
   * Only a waiting webhook needs this: the caller is holding an HTTP connection open and the
   * point of waiting is to hand back the answer. Everything else fires and forgets.
   */
  runAndSay?: (agent: string, prompt: string, toolScope?: readonly string[]) => Promise<string>;
  /**
   * Starts a turn. Rejecting is fine: the next window is the retry.
   *
   * `deliver` is the chat this run reports to, when the skill named one — the runner
   * hands it over rather than resolving it, because which conversation a chatKey means
   * and how a reply reaches it are the caller's business, not the clock's.
   */
  /**
   * `slug` names the routine whose commitments are reconciled afterwards; `identity` names
   * whose result history the run is written to when that is not the same thing (INV-802):
   * a listener passes no slug, because a listener run is not reconciled, but its results
   * are its own — not one `ad-hoc` history every listener shares.
   */
  run: (agent: string, prompt: string, deliver?: string, slug?: string, toolScope?: readonly string[], deliverWhen?: DeliverWhen, identity?: string) => Promise<void | { result: RunResult }>;
  /** A routine in observe mode was triggered and did not run (INV-1458); the audit row. */
  observed?: (slug: string, would: string) => void;
  /**
   * What a routine committed to last time and where it stands (INV-528), prepended to
   * its prompt so a retro opens with its own previous "next week" rather than a blank.
   */
  priorCommitments?: (slug: string) => string | undefined;
  /** Who a schedule wakes when it names nobody. */
  /** The agent a skill runs as when its file names none: the box's first, or the installation's. */
  defaultAgent: (boxId?: string) => string | undefined;
  /** Resolves a name to an agent id, so `agent:` can be compared against the default. */
  resolveAgent?: (nameOrId: string) => string | undefined;
  /**
   * Who the host saw write this skill, when it saw anyone (skill-provenance.ts). What lets a skill
   * run as the agent that wrote it, and nobody else.
   */
  writerOf?: (slug: string) => { agentId: string; agentName: string } | undefined;
  now?: () => Date;
  log?: (line: string) => void;
  /** What an agent has been billed since a moment, so each run's cost goes on its record. */
  spentSinceAgent?: (sinceMs: number, agentId: string) => number;
  /**
   * Where to keep the run history. `null` means keep none, which is what a test wants; omitted means
   * the default path, which is what production wants.
   */
  path?: string | null;
}

/**
 * Fires scheduled skills, one at a time per skill.
 *
 * Ticks every thirty seconds against minute-resolution schedules, so a window is checked twice and
 * `isDue` is what stops it firing twice — a checker that ticked exactly on the minute would miss
 * windows whenever the event loop was busy, which for a daily report means a day with no report.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | undefined;
  private readonly lastRun = new Map<string, Date>();
  /** Slugs with a run still going *in this process*. The whole of the overlap answer. */
  private readonly running = new Set<string>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;
  private readonly path: string | undefined;

  constructor(
    private readonly deps: SchedulerDeps,
    private readonly tickMs = envNumber("AGENTBOX_SCHEDULER_TICK_MS", 30_000)
  ) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
    this.path = deps.path === null ? undefined : (deps.path ?? scheduleLogPath());
    this.loadHistory();
  }

  /**
   * Reads back when each schedule last ran.
   *
   * Without this, `lastRun` was process-local and a restart meant: every cron window that had
   * already fired in the current minute fired again, and every `@every` schedule became immediately
   * due — so a box that restarts often runs its automations far more than they say. An unattended
   * automation firing twice is not a cosmetic problem, it is a duplicate side effect nobody watched.
   */
  private loadHistory(): void {
    if (this.path === undefined || !existsSync(this.path)) return;
    const states = new Map<string, RunState>();
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line.trim() === "") continue;
        let record: RunRecord;
        try {
          record = JSON.parse(line) as RunRecord;
        } catch {
          // A torn last line is the normal cost of append-only. Skip it rather than refusing to
          // start, which would make one bad byte turn every automation off.
          continue;
        }
        const at = new Date(record.at);
        if (Number.isNaN(at.getTime()) || typeof record.slug !== "string") continue;
        const state = states.get(record.slug) ?? { lastRun: undefined, interrupted: false };
        if (record.event === "started") {
          state.lastRun = at;
          state.interrupted = true;
        } else {
          if (state.lastRun === undefined) state.lastRun = at;
          state.interrupted = false;
        }
        states.set(record.slug, state);
      }
    } catch (error) {
      this.log(`could not read the run history: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const [slug, state] of states) {
      if (state.lastRun !== undefined) this.lastRun.set(slug, state.lastRun);
      if (state.interrupted) {
        // Said, because it is the one thing a person cannot work out from the outcome: the run did
        // not fail and did not finish. It is not marked running — the process that owned it is gone
        // — and it is not replayed, because the window it belonged to has passed.
        this.log(`${slug}: a previous run was interrupted by a restart; not resumed, not repeated`);
      }
    }
  }

  private record(
    slug: string,
    event: RunRecord["event"],
    extra: Pick<RunRecord, "agent" | "tokens" | "ms" | "would" | "result"> = {}
  ): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(
        this.path,
        JSON.stringify({ slug, at: this.now().toISOString(), event, ...extra } satisfies RunRecord)
      );
    } catch (error) {
      // Never stop firing over bookkeeping. The cost of a lost record is a window that may repeat
      // after a restart, which is the behaviour this whole file used to have.
      this.log(`${slug}: could not write the run history (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /**
   * Observe mode (INV-1458): the trigger fired and this is what would have run. Recorded on the
   * run history and the policy ledger, nothing started, no chat told. The schedule still advances,
   * so a person reading the record sees each window the routine would have taken.
   */
  private observe(skill: { slug: string; name: string }, agent: string, would: string): void {
    this.lastRun.set(skill.slug, this.now());
    this.record(skill.slug, "observed", { agent, would });
    this.deps.observed?.(skill.slug, would);
    this.log(`${skill.name}: observed, not run — ${would}`);
  }

  /** The observe records of one routine, newest first, for the automations page. */
  observedOf(slug: string, limit = 5): { at: string; would: string }[] {
    if (this.path === undefined || !existsSync(this.path)) return [];
    const out: { at: string; would: string }[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line) as RunRecord;
        if (record.slug === slug && record.event === "observed") out.push({ at: record.at, would: record.would ?? "" });
      } catch { /* torn line */ }
    }
    return out.slice(-limit).reverse();
  }

  /** Message ids already answered by a listener, so a redelivered message fires nothing twice. */
  private readonly heardIds = new Set<string>();

  /**
   * A message from a person arrived; fires every listener it matches. Returns the slugs fired.
   *
   * Only inbound messages reach here — the bot's own output never comes back through ingress —
   * so a routine cannot trigger itself; and one message fires each routine at most once, whatever
   * the channel redelivers. The runner rules are the schedule's: an agent's own skill runs as it,
   * anything else runs as the default agent or not at all.
   */
  async heard(message: {
    text: string;
    chatKey: string;
    threadKey?: string;
    messageId?: string;
    senderLabel?: string;
  }): Promise<string[]> {
    if (this.deps.listeners === undefined) return [];
    if (message.messageId !== undefined) {
      if (this.heardIds.has(message.messageId)) return [];
      this.heardIds.add(message.messageId);
      if (this.heardIds.size > 1_000) this.heardIds.delete(this.heardIds.values().next().value!);
    }
    let listening: readonly Listening[];
    try {
      listening = await this.deps.listeners();
    } catch (error) {
      this.log(`could not read listeners: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
    const fired: string[] = [];
    for (const skill of listening) {
      if (skill.paused === true) continue;
      if (skill.chat !== undefined && skill.chat !== message.chatKey && !message.chatKey.startsWith(`${skill.chat}/`)) continue;
      if (skill.mode === "off" || !listenerMatches(skill.match, message.text)) continue;
      if (this.running.has(skill.slug)) {
        this.log(`${skill.name}: skipped a matching message, the previous run has not finished`);
        this.record(skill.slug, "skipped");
        continue;
      }
      const agent = this.runnerFor(skill);
      if (agent === undefined) continue;
      const deliver = message.threadKey ?? message.chatKey;
      if (skill.mode === "observe") { this.observe(skill, agent, `run as ${agent} for a message in ${deliver} matching ${skill.match}`); fired.push(skill.slug); continue; }
      this.running.add(skill.slug);
      const startedAt = this.now();
      let result: RunResult | undefined;
      this.record(skill.slug, "started", { agent });
      this.log(`${skill.name}: fired by a message in ${deliver}`);
      fired.push(skill.slug);
      void this.deps
        .run(
          agent,
          listenerPrompt(skill.name, skill.path, {
            text: message.text,
            sender: message.senderLabel ?? "someone",
            chatKey: deliver,
          }),
          deliver,
          // No slug, as before: a listener run is not reconciled against commitments.
          undefined,
          skill.allowedTools,
          undefined,
          // But its results are its own (INV-802): keyed by the listener, and by the room
          // it answered in, so a second listener saying the same words, or this one in
          // another room, is not silenced by a result that room never heard.
          skill.slug
        )
        .then(outcome => { result = outcome?.result; })
        .catch(error => {
          this.log(`${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.running.delete(skill.slug);
          this.record(skill.slug, "finished", {
            agent,
            ...(result !== undefined ? { result } : {}),
            ms: this.now().getTime() - startedAt.getTime(),
            ...(this.deps.spentSinceAgent !== undefined
              ? { tokens: this.deps.spentSinceAgent(startedAt.getTime(), agent) }
              : {}),
          });
        });
    }
    return fired;
  }

  /** Runs whatever is due. Exposed so a test drives it directly instead of waiting on a clock. */
  async tick(): Promise<void> {
    let scheduled: readonly Scheduled[];
    try {
      scheduled = await this.deps.due();
    } catch (error) {
      // A box that is restarting should not stop the scheduler; the next tick is thirty seconds away.
      this.log(`could not read schedules: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    for (const skill of scheduled) {
      // Paused is not due. Not logged per tick: a routine somebody switched off would fill the
      // log with the fact every thirty seconds.
      if (skill.paused === true || skill.mode === "off") continue;
      if (!isDue(skill.schedule, this.now(), this.lastRun.get(skill.slug), skill.timezone)) continue;

      if (this.running.has(skill.slug)) {
        // Said, not silent. An hourly job taking seventy minutes meets its own next fire, and piling
        // a second run on top turns a slow problem into an avalanche — but a skip nobody is told
        // about is indistinguishable from a schedule that stopped working.
        this.log(`${skill.name}: skipped, the previous run has not finished`);
        this.lastRun.set(skill.slug, this.now());
        this.record(skill.slug, "skipped");
        continue;
      }

      const agent = this.runnerFor(skill);
      if (agent === undefined) {
        this.log(`${skill.name}: no agent to run it`);
        continue;
      }
      if (skill.mode === "observe") { this.observe(skill, agent, `run as ${agent} (${describeSchedule(skill.schedule)})${skill.deliver !== undefined ? `, report to ${skill.deliver}` : ""}`); continue; }

      // Marked before starting, so a slow first tick cannot be overtaken by the next one.
      this.lastRun.set(skill.slug, this.now());
      this.running.add(skill.slug);
      const startedAt = this.now();
      let result: RunResult | undefined;
      this.record(skill.slug, "started", { agent });
      this.log(`${skill.name}: firing (${describeSchedule(skill.schedule)})`);

      const prior = this.deps.priorCommitments?.(skill.slug);
      void this.deps
        .run(
          agent,
          triggerPrompt(skill.name, skill.path, describeSchedule(skill.schedule), skill.deliver) + (prior !== undefined ? `\n\n${prior}` : ""),
          skill.deliver,
          skill.slug,
          skill.allowedTools,
          skill.deliverWhen
        )
        .then(outcome => { result = outcome?.result; })
        .catch(error => {
          // Reported and dropped. A scheduled run that failed will come round again, and retrying
          // now would be a second unasked-for turn on top of one that just went wrong.
          this.log(
            `${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          this.running.delete(skill.slug);
          this.record(skill.slug, "finished", {
            agent,
            ...(result !== undefined ? { result } : {}),
            ms: this.now().getTime() - startedAt.getTime(),
            ...(this.deps.spentSinceAgent !== undefined
              ? { tokens: this.deps.spentSinceAgent(startedAt.getTime(), agent) }
              : {}),
          });
        });
    }
  }

  /**
   * Every automation and where it stands — for the web page and the chat verb.
   *
   * Reads the same state the runner uses rather than a second copy: a status view that
   * can disagree with the thing it describes is worse than none, because it is believed.
   */
  async status(): Promise<
    readonly {
      slug: string;
      name: string;
      described: string;
      schedule: string;
      agent: string | undefined;
      timezone: string | undefined;
      deliver: string | undefined;
      deliverWhen: DeliverWhen | undefined;
      authoredBy: string | undefined;
      because: string | undefined;
      lastRun: string | undefined;
      /** The next firing by the tick's own rules; absent when it will not fire again. */
      nextRun: string | undefined;
      running: boolean;
      paused: boolean;
      /** Recurring, one-time (`@at`), or on call (INV-430): the view groups on this. */
      kind: "schedule" | "once" | "webhook";
      /** The box the routine lives in; absent means the installation's own. */
      boxId: string | undefined;
      /** How it may act (INV-1458); `modeDefaulted` when the file says nothing and auto is assumed. */
      mode: RoutineMode;
      modeDefaulted: boolean;
      observed: { at: string; would: string }[];
    }[]
  > {
    const skills = await this.deps.due().catch(() => []);
    const scheduled = skills.map(skill => ({
      slug: skill.slug,
      name: skill.name,
      described: describeSchedule(skill.schedule),
      schedule: skill.schedule.source,
      agent: skill.runAs,
      timezone: skill.timezone,
      deliver: skill.deliver,
      deliverWhen: skill.deliverWhen,
      authoredBy: skill.authoredBy,
      because: skill.because,
      lastRun: this.lastRun.get(skill.slug)?.toISOString(),
      nextRun: skill.paused === true ? undefined : nextFire(skill.schedule, this.now(), this.lastRun.get(skill.slug), skill.timezone)?.toISOString(),
      running: this.running.has(skill.slug),
      paused: skill.paused === true,
      kind: skill.schedule.at !== undefined ? ("once" as const) : ("schedule" as const),
      boxId: skill.boxId,
      mode: skill.mode ?? "auto", modeDefaulted: skill.mode === undefined, observed: this.observedOf(skill.slug),
    }));
    // Webhook routines belong in the same list: to a person, "what runs by itself" is one
    // question, and a routine that is missing from the automations page is a routine nobody
    // knows is armed.
    const hooked = this.deps.hooked === undefined ? [] : await this.deps.hooked().catch(() => []);
    return [
      ...scheduled,
      ...hooked.map(skill => ({
        slug: skill.slug,
        name: skill.name,
        described: "when its webhook is called",
        schedule: "webhook",
        agent: skill.runAs,
        timezone: undefined,
        deliver: skill.deliver,
        deliverWhen: skill.deliverWhen,
        authoredBy: skill.authoredBy,
        because: skill.because,
        lastRun: this.lastRun.get(skill.slug)?.toISOString(),
        nextRun: undefined,
        running: this.running.has(skill.slug),
        paused: skill.paused === true,
        kind: "webhook" as const,
        boxId: skill.boxId,
        mode: skill.mode ?? "auto", modeDefaulted: skill.mode === undefined, observed: this.observedOf(skill.slug),
      })),
    ];
  }

  /**
   * Fires one automation now, as if its window had come round.
   *
   * The same path as a timed fire — same prompt, same overlap rule, same record — so
   * "run it now" tests the thing that will run at 06:30 rather than something adjacent
   * to it. `lastRun` is deliberately *not* advanced: a manual run is a rehearsal, and
   * skipping tomorrow's real one because somebody tried it today would be a surprise.
   */
  /**
   * Which agent a scheduled skill may run as.
   *
   * `agent:` in a skill's frontmatter is a *request*, not an authority. A skill file is
   * ordinary content in the box, writable by any agent holding `write_file` or `bash` —
   * so an agent confined to one chat could write `schedule: "@every 1m"` and
   * `agent: <someone with more tools>`, and the scheduler would have run it, unattended,
   * in the main conversation where the confining chat scope no longer applies. That is a
   * privilege escalation with a one-minute clock on it (audit 2026-09-01, #2).
   *
   * Nothing else in the file can gate it: `owner` and `authored_by` are frontmatter too,
   * so an attacker declares whatever the rule asks for. The only anchor a writer cannot
   * forge is who this installation's default agent is, which is decided outside the box.
   * So: a schedule runs as the default agent, and a request for anyone else is refused
   * and said out loud rather than honoured or silently downgraded.
   *
   * This is deliberately blunter than it should be. The real fix is provenance — the
   * host recording who wrote a skill, or scheduled skills living in host-owned state
   * rather than in the box's filesystem — and that is a design change, not a patch
   * (docs/13). Until then this errs towards refusing work rather than running somebody
   * else's.
   */
  private runnerFor(skill: { slug: string; name: string; runAs?: string; boxId?: string }): string | undefined {
    const fallback = this.deps.defaultAgent(skill.boxId);
    if (skill.runAs === undefined) return fallback;
    const named = this.deps.resolveAgent?.(skill.runAs);
    if (named !== undefined && named === fallback) return named;
    if (named === undefined && skill.runAs === fallback) return fallback;
    // An agent may schedule its own skill to run as itself: the host saw it write the file, so the
    // permissions the run carries are its own. Any other name is still borrowing.
    const writer = this.deps.writerOf?.(skill.slug);
    if (named !== undefined && writer !== undefined && writer.agentId === named) return named;
    const seen =
      writer === undefined
        ? "the host has no record of who wrote it"
        : `the host saw ${writer.agentName} write it`;
    this.log(
      `${skill.name}: refuses to run as "${skill.runAs}" — ${seen}, and a skill runs as the ` +
        `agent that wrote it or as this installation's default agent, never as someone else, ` +
        `because naming another agent in a file you can write is a way to borrow its permissions.`
    );
    return undefined;
  }

  /**
   * Fires a webhook routine with the body that arrived.
   *
   * Same bookkeeping as every other run — the pause switch, the "already running" guard, the
   * records the automations page reads — because to a person this is the same object as a timer,
   * differing only in what starts it. It does not wait for the turn: whatever called the URL is a
   * phone on a train, and it gets its answer in milliseconds either way.
   */
  async fireWebhook(
    slug: string,
    body: string,
    from?: string,
    options: { wait?: boolean } = {}
  ): Promise<{ ok: true; said?: string } | { ok: false; reason: string }> {
    const hooked = this.deps.hooked === undefined ? [] : await this.deps.hooked().catch(() => []);
    const skill = hooked.find(candidate => candidate.slug === slug);
    if (skill === undefined) return { ok: false, reason: `No webhook routine "${slug}".` };
    if (skill.paused === true) return { ok: false, reason: `${skill.name} is paused; turn it on first.` };
    if (skill.mode === "off") return { ok: false, reason: `${skill.name} is switched off (mode: off).` };
    // Refused rather than queued: a shortcut pressed twice on a train should not stack two runs
    // of the same routine, and the second press is nearly always the same content.
    if (this.running.has(slug)) return { ok: false, reason: `${skill.name} is already running.` };
    const agent = this.runnerFor(skill);
    if (agent === undefined) return { ok: false, reason: `No agent to run ${skill.name}.` };
    if (skill.mode === "observe") { this.observe(skill, agent, `run as ${agent} for a webhook call${from !== undefined ? ` from ${from}` : ""}`); return { ok: true, said: `${skill.name} is in observe mode: recorded what it would have done, nothing ran.` }; }

    this.running.add(slug);
    const startedAt = this.now();
    let result: RunResult | undefined;
    this.record(slug, "started", { agent });
    this.lastRun.set(slug, startedAt);
    this.log(`${skill.name}: fired by webhook`);
    const prompt = webhookPrompt({
      skillName: skill.name,
      path: skill.path,
      body,
      ...(from !== undefined ? { from } : {}),
      ...(skill.deliver !== undefined ? { deliver: skill.deliver } : {}),
    });
    const finish = () => {
      this.running.delete(slug);
      this.record(slug, "finished", {
        agent,
        ...(result !== undefined ? { result } : {}),
        ms: this.now().getTime() - startedAt.getTime(),
        ...(this.deps.spentSinceAgent !== undefined
          ? { tokens: this.deps.spentSinceAgent(startedAt.getTime(), agent) }
          : {}),
      });
    };

    // The caller asked to be told what happened, and is holding a connection open for it. Awaited
    // here rather than fired and forgotten, and the bookkeeping is the same either way.
    if (options.wait === true && this.deps.runAndSay !== undefined) {
      try {
        const said = await this.deps.runAndSay(agent, prompt, skill.allowedTools);
        return { ok: true, said };
      } catch (error) {
        this.log(`${skill.name}: webhook run failed — ${error instanceof Error ? error.message : String(error)}`);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      } finally {
        finish();
      }
    }

    void this.deps
      .run(agent, prompt, skill.deliver, skill.slug, skill.allowedTools, skill.deliverWhen)
      .then(outcome => { result = outcome?.result; })
      .catch(error => {
        this.log(`${skill.name}: webhook run failed — ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(finish);
    return { ok: true };
  }

  async runNow(slug: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const skills = await this.deps.due().catch(() => []);
    const skill = skills.find(candidate => candidate.slug === slug);
    if (skill === undefined) return { ok: false, reason: `No scheduled skill "${slug}".` };
    if (skill.paused === true) return { ok: false, reason: `${skill.name} is paused; turn it on first.` };
    if (this.running.has(slug)) return { ok: false, reason: `${skill.name} is already running.` };
    const agent = this.runnerFor(skill);
    if (agent === undefined) return { ok: false, reason: `No agent to run ${skill.name}.` };

    this.running.add(slug);
    const startedAt = this.now();
    let result: RunResult | undefined;
      this.record(slug, "started", { agent });
    this.log(`${skill.name}: firing now, by hand`);
    // By hand is still this routine running (INV-534): same slug, same opening with last
    // time's commitments, same reconcile afterwards. Without them "run it now" was a
    // different code path that skipped the very thing a person clicks it to test.
    const priorByHand = this.deps.priorCommitments?.(skill.slug);
    void this.deps
      .run(
        agent,
        triggerPrompt(skill.name, skill.path, describeSchedule(skill.schedule), skill.deliver) + (priorByHand !== undefined ? `\n\n${priorByHand}` : ""),
        skill.deliver,
        skill.slug,
        skill.allowedTools,
        skill.deliverWhen
      )
      .catch(error => {
        this.log(
          `${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        this.running.delete(slug);
        this.record(slug, "finished", {
            agent,
            ...(result !== undefined ? { result } : {}),
            ms: this.now().getTime() - startedAt.getTime(),
            ...(this.deps.spentSinceAgent !== undefined
              ? { tokens: this.deps.spentSinceAgent(startedAt.getTime(), agent) }
              : {}),
          });
      });
    return { ok: true };
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Unref'd: a scheduler must not be the reason a process refuses to exit.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
