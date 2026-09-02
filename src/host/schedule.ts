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

import { envNumber } from "../config.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/** A parsed schedule: the fields a cron expression constrains. `undefined` means "any". */
export interface Schedule {
  /** The text it was parsed from, for messages and for the prompt. */
  source: string;
  minutes?: readonly number[];
  hours?: readonly number[];
  daysOfMonth?: readonly number[];
  months?: readonly number[];
  daysOfWeek?: readonly number[];
  /** Set instead of the fields above for `@every <n><unit>`. */
  everyMs?: number;
}

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const RANGES: [number, number][] = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week
];

/**
 * Parses a schedule, or says why it could not.
 *
 * Deliberately a small subset: `*`, numbers, comma lists, ranges and `*​/n` steps, plus `@every` and a
 * few aliases. Not a full cron implementation, because the parts left out — names like `MON`, `L`,
 * `#`, seconds fields — vary between implementations, and a schedule that means something slightly
 * different from what its author expected is worse than one that was refused.
 */
export function parseSchedule(text: string): { schedule: Schedule } | { problem: string } {
  const raw = text.trim().toLowerCase();
  if (raw === "") return { problem: "an empty schedule" };

  const every = /^@every\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(raw);
  if (every !== null) {
    const amount = Number(every[1]);
    const unit = every[2] ?? "m";
    const ms = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : 60_000;
    if (amount <= 0) return { problem: `"${text}": an interval has to be more than zero` };
    const everyMs = amount * ms;
    // A minute is the floor because the checker ticks at that resolution, and an automation that
    // claims to run every ten seconds and runs every sixty is lying to whoever wrote it.
    if (everyMs < 60_000) return { problem: `"${text}": the shortest interval is one minute` };
    return { schedule: { source: text.trim(), everyMs } };
  }

  const expanded = ALIASES[raw] ?? raw;
  if (expanded.startsWith("@")) {
    return {
      problem:
        `"${text}" is not a schedule this understands. Use five cron fields ` +
        `(\`0 9 * * 1-5\`), \`@every 30m\`, or one of ${Object.keys(ALIASES).join(", ")}.`,
    };
  }

  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) {
    return {
      problem:
        `"${text}" has ${fields.length} field(s); a cron schedule has five ` +
        `(minute hour day-of-month month day-of-week).`,
    };
  }

  const parsed: (readonly number[] | undefined)[] = [];
  for (let at = 0; at < 5; at++) {
    const field = parseField(fields[at]!, RANGES[at]![0], RANGES[at]![1]);
    // "any" and "unreadable" are different answers and must not share a representation. Collapsing
    // them here made every `*` in fields three to five a parse error — which is to say, almost every
    // real schedule. The third time in this codebase that conflating "nothing" with "failed" has
    // produced a bug, so it is a tagged union rather than a convention.
    if (field.ok === false) {
      return { problem: `"${text}": cannot read field ${at + 1} ("${fields[at]}")` };
    }
    parsed.push(field.any ? undefined : field.values);
  }

  return {
    schedule: {
      source: text.trim(),
      ...(parsed[0] !== undefined ? { minutes: parsed[0] } : {}),
      ...(parsed[1] !== undefined ? { hours: parsed[1] } : {}),
      ...(parsed[2] !== undefined ? { daysOfMonth: parsed[2] } : {}),
      ...(parsed[3] !== undefined ? { months: parsed[3] } : {}),
      ...(parsed[4] !== undefined ? { daysOfWeek: parsed[4] } : {}),
    },
  };
}

/**
 * One cron field, as either "any value", a set of values, or unreadable.
 *
 * Three outcomes, named, because two of them mean opposite things and both were `undefined` in the
 * first version — so `*` in the day-of-month field was read as a parse failure and almost no real
 * schedule loaded.
 */
type Field = { ok: true; any: true } | { ok: true; any: false; values: number[] } | { ok: false };

function parseField(field: string, low: number, high: number): Field {
  if (field === "*") return { ok: true, any: true };
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const step = /^(.+)\/(\d+)$/.exec(part);
    const body = step?.[1] ?? part;
    const stride = step === null ? 1 : Number(step[2]);
    if (stride <= 0) return { ok: false };

    let from: number;
    let to: number;
    if (body === "*") {
      from = low;
      to = high;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(body);
      if (range !== null) {
        from = Number(range[1]);
        to = Number(range[2]);
      } else if (/^\d+$/.test(body)) {
        from = Number(body);
        to = from;
      } else {
        return { ok: false };
      }
    }
    if (from < low || to > high || from > to) return { ok: false };
    for (let value = from; value <= to; value += stride) values.add(value);
  }
  if (values.size === 0) return { ok: false };
  return { ok: true, any: false, values: [...values].sort((a, b) => a - b) };
}

/**
 * Whether a schedule wants to run at this minute, given when it last did.
 *
 * Minute resolution, and the last-run time is what stops one tick firing twice. For `@every`, the
 * question is simply whether the interval has elapsed; for cron it is whether the fields match *and*
 * we have not already fired inside this same minute.
 *
 * **Never catches up.** A schedule whose window passed while nothing was running does not fire late —
 * see the module comment for why that is the safer default rather than an oversight.
 */
/**
 * The wall-clock fields of an instant, in a named zone.
 *
 * `Intl` rather than arithmetic, because the arithmetic is daylight saving and nobody
 * gets that right by hand: "06:30 ET" is 10:30 or 11:30 UTC depending on the date, and a
 * scheduler that silently drifts by an hour twice a year is the kind of wrong that looks
 * right for months.
 *
 * An unknown zone throws at parse time, not here — see `parseTimezone`.
 */
export function wallClock(now: Date, timezone: string | undefined): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  if (timezone === undefined) {
    return {
      minute: now.getMinutes(),
      hour: now.getHours(),
      day: now.getDate(),
      month: now.getMonth() + 1,
      weekday: now.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(now);
  const field = (type: string): string =>
    parts.find(part => part.type === type)?.value ?? "0";
  const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    // "24" is midnight in some locales' hourCycle; normalised so hour 0 means hour 0.
    minute: Number(field("minute")),
    hour: Number(field("hour")) % 24,
    day: Number(field("day")),
    month: Number(field("month")),
    weekday: Math.max(0, WEEKDAYS.indexOf(field("weekday"))),
  };
}

/** Whether a zone name is one this runtime knows. Checked at parse time so a typo is loud. */
export function knownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

export function isDue(
  schedule: Schedule,
  now: Date,
  lastRun: Date | undefined,
  timezone?: string
): boolean {
  if (schedule.everyMs !== undefined) {
    if (lastRun === undefined) return true;
    return now.getTime() - lastRun.getTime() >= schedule.everyMs;
  }

  const at = wallClock(now, timezone);
  const matches =
    within(schedule.minutes, at.minute) &&
    within(schedule.hours, at.hour) &&
    within(schedule.daysOfMonth, at.day) &&
    within(schedule.months, at.month) &&
    within(schedule.daysOfWeek, at.weekday);
  if (!matches) return false;

  // Already fired this minute. Without this a checker ticking every thirty seconds fires twice for
  // one scheduled minute, which for a daily report means two reports. Compared as instants rather
  // than as wall-clock fields, so it holds across a daylight-saving jump too.
  if (lastRun !== undefined && sameMinute(lastRun, now)) return false;
  return true;
}

function within(allowed: readonly number[] | undefined, value: number): boolean {
  return allowed === undefined || allowed.includes(value);
}

function sameMinute(a: Date, b: Date): boolean {
  return Math.floor(a.getTime() / 60_000) === Math.floor(b.getTime() / 60_000);
}

/**
 * Plain language, for the prompt and the UI. A cron expression is not something to make a person
 * read — but a description that understates how often something runs is worse than the cron, since
 * this text is what a person reviews before leaving an automation running unattended.
 *
 * The three it used to get wrong: it read only the first minute, so `0,30 * * * *` was "every hour"
 * when it runs twice an hour; it treated an unrestricted minute field as minute zero, so
 * `* 9 * * *` — sixty runs — read as "at 09:00"; and it ignored the month entirely, so a schedule
 * that fires one month a year claimed to fire every month.
 */
export function describeSchedule(schedule: Schedule): string {
  if (schedule.everyMs !== undefined) {
    const minutes = Math.round(schedule.everyMs / 60_000);
    if (minutes % 1440 === 0) return `every ${minutes / 1440} day(s)`;
    if (minutes % 60 === 0) return `every ${minutes / 60} hour(s)`;
    return `every ${minutes} minute(s)`;
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  const parts: string[] = [];

  if (schedule.minutes === undefined) {
    // Every minute of whichever hours are allowed. Said first and said plainly, because this is the
    // one that surprises people.
    parts.push(
      schedule.hours === undefined
        ? "every minute"
        : `every minute of ${schedule.hours.map(hour => `${pad(hour)}:00`).join(", ")}`
    );
  } else if (schedule.hours === undefined) {
    parts.push(
      schedule.minutes.length === 1
        ? `every hour at :${pad(schedule.minutes[0]!)}`
        : `every hour at ${schedule.minutes.map(minute => `:${pad(minute)}`).join(", ")}`
    );
  } else {
    const times = schedule.hours.flatMap(hour =>
      schedule.minutes!.map(minute => `${pad(hour)}:${pad(minute)}`)
    );
    parts.push(`at ${times.join(", ")}`);
  }

  if (schedule.daysOfWeek !== undefined) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    parts.push(`on ${schedule.daysOfWeek.map(day => names[day]).join(", ")}`);
  }
  if (schedule.daysOfMonth !== undefined) {
    parts.push(`on day ${schedule.daysOfMonth.join(", ")} of the month`);
  }
  if (schedule.months !== undefined) {
    const names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    parts.push(`in ${schedule.months.map(month => names[month]).join(", ")}`);
  }
  return parts.join(" ");
}

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
    }`,
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
  /** The agent that wrote it, when one did. Provenance, not permission — see skills.ts. */
  authoredBy?: string;
  /** Why it exists, in the author's words. */
  because?: string;
}

/** A skill that fires on a matching message. Same runner rules as a schedule. */
export interface Listening {
  slug: string;
  name: string;
  path: string;
  match: string;
  chat?: string;
  runAs?: string;
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
      "nobody will answer a question, so decide rather than ask.",
    "",
    `Read \`${path}\` and follow it for this message from ${said.sender} in ${said.chatKey}:`,
    "",
    said.text.slice(0, 4_000),
    "",
    "Make your final message the thing itself, short enough to read on a phone. If the routine does not " +
      "actually apply to this message, say nothing: reply with an empty message.",
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
interface RunRecord {
  slug: string;
  at: string;
  event: "started" | "finished" | "skipped";
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
  /**
   * Starts a turn. Rejecting is fine: the next window is the retry.
   *
   * `deliver` is the chat this run reports to, when the skill named one — the runner
   * hands it over rather than resolving it, because which conversation a chatKey means
   * and how a reply reaches it are the caller's business, not the clock's.
   */
  run: (agent: string, prompt: string, deliver?: string) => Promise<void>;
  /** Who a schedule wakes when it names nobody. */
  defaultAgent: () => string | undefined;
  /** Resolves a name to an agent id, so `agent:` can be compared against the default. */
  resolveAgent?: (nameOrId: string) => string | undefined;
  /**
   * Who the host saw write this skill, when it saw anyone (skill-provenance.ts). What lets a skill
   * run as the agent that wrote it, and nobody else.
   */
  writerOf?: (slug: string) => { agentId: string; agentName: string } | undefined;
  now?: () => Date;
  log?: (line: string) => void;
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

  private record(slug: string, event: RunRecord["event"]): void {
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(
        this.path,
        JSON.stringify({ slug, at: this.now().toISOString(), event } satisfies RunRecord)
      );
    } catch (error) {
      // Never stop firing over bookkeeping. The cost of a lost record is a window that may repeat
      // after a restart, which is the behaviour this whole file used to have.
      this.log(`${slug}: could not write the run history (${error instanceof Error ? error.message : String(error)})`);
    }
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
      if (skill.chat !== undefined && skill.chat !== message.chatKey && !message.chatKey.startsWith(`${skill.chat}/`)) continue;
      if (!listenerMatches(skill.match, message.text)) continue;
      if (this.running.has(skill.slug)) {
        this.log(`${skill.name}: skipped a matching message, the previous run has not finished`);
        this.record(skill.slug, "skipped");
        continue;
      }
      const agent = this.runnerFor(skill);
      if (agent === undefined) continue;
      const deliver = message.threadKey ?? message.chatKey;
      this.running.add(skill.slug);
      this.record(skill.slug, "started");
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
          deliver
        )
        .catch(error => {
          this.log(`${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.running.delete(skill.slug);
          this.record(skill.slug, "finished");
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

      // Marked before starting, so a slow first tick cannot be overtaken by the next one.
      this.lastRun.set(skill.slug, this.now());
      this.running.add(skill.slug);
      this.record(skill.slug, "started");
      this.log(`${skill.name}: firing (${describeSchedule(skill.schedule)})`);

      void this.deps
        .run(
          agent,
          triggerPrompt(skill.name, skill.path, describeSchedule(skill.schedule), skill.deliver),
          skill.deliver
        )
        .catch(error => {
          // Reported and dropped. A scheduled run that failed will come round again, and retrying
          // now would be a second unasked-for turn on top of one that just went wrong.
          this.log(
            `${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`
          );
        })
        .finally(() => {
          this.running.delete(skill.slug);
          this.record(skill.slug, "finished");
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
      authoredBy: string | undefined;
      because: string | undefined;
      lastRun: string | undefined;
      running: boolean;
    }[]
  > {
    const skills = await this.deps.due().catch(() => []);
    return skills.map(skill => ({
      slug: skill.slug,
      name: skill.name,
      described: describeSchedule(skill.schedule),
      schedule: skill.schedule.source,
      agent: skill.runAs,
      timezone: skill.timezone,
      deliver: skill.deliver,
      authoredBy: skill.authoredBy,
      because: skill.because,
      lastRun: this.lastRun.get(skill.slug)?.toISOString(),
      running: this.running.has(skill.slug),
    }));
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
  private runnerFor(skill: { slug: string; name: string; runAs?: string }): string | undefined {
    const fallback = this.deps.defaultAgent();
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

  async runNow(slug: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const skills = await this.deps.due().catch(() => []);
    const skill = skills.find(candidate => candidate.slug === slug);
    if (skill === undefined) return { ok: false, reason: `No scheduled skill "${slug}".` };
    if (this.running.has(slug)) return { ok: false, reason: `${skill.name} is already running.` };
    const agent = this.runnerFor(skill);
    if (agent === undefined) return { ok: false, reason: `No agent to run ${skill.name}.` };

    this.running.add(slug);
    this.record(slug, "started");
    this.log(`${skill.name}: firing now, by hand`);
    void this.deps
      .run(
        agent,
        triggerPrompt(skill.name, skill.path, describeSchedule(skill.schedule), skill.deliver),
        skill.deliver
      )
      .catch(error => {
        this.log(
          `${skill.name}: run failed — ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        this.running.delete(slug);
        this.record(slug, "finished");
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
