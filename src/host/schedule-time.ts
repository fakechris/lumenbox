/**
 * When a routine runs: the schedule grammar (cron, @daily, @every, @at), the clock it is read
 * in, due-ness, the next firing and the words for it. Pure; the scheduler imports it.
 */

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
  /**
   * Set instead of the fields above for `@at <instant>` (INV-430): a one-time task. It fires
   * once, at or after that instant, and never again — the recorded run is what says it is done.
   */
  at?: number;
}

/** How late a one-time task may still fire: a host that was down at the instant catches up within this. */
export const ONCE_GRACE_MS = 24 * 3_600_000;

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

  const once = /^@at\s+(.+)$/i.exec(text.trim());
  if (once !== null) {
    const at = Date.parse(once[1]!.trim());
    if (Number.isNaN(at)) return { problem: `"${text}": @at needs an instant such as 2026-09-12T09:00 or 2026-09-12T09:00+08:00` };
    return { schedule: { source: text.trim(), at } };
  }

  const expanded = ALIASES[raw] ?? raw;
  if (expanded.startsWith("@")) {
    return {
      problem:
        `"${text}" is not a schedule this understands. Use five cron fields ` +
        `(\`0 9 * * 1-5\`), \`@every 30m\`, \`@at 2026-09-12T09:00\`, or one of ${Object.keys(ALIASES).join(", ")}.`,
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
  if (schedule.at !== undefined) {
    // Once: never after it has run, not before its instant, and not so late that firing
    // would be a surprise — a task set for a morning the host slept through fires when the
    // host wakes that day, not a month later when somebody restarts it.
    if (lastRun !== undefined) return false;
    return now.getTime() >= schedule.at && now.getTime() - schedule.at < ONCE_GRACE_MS;
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
/**
 * When a schedule fires next, after an instant: for the automations view, so "next" is
 * read from the same rules the tick uses. Undefined means never again (a one-time task
 * that ran, or a cron that matches nothing in the coming year).
 */
export function nextFire(schedule: Schedule, after: Date, lastRun: Date | undefined, timezone?: string): Date | undefined {
  if (schedule.everyMs !== undefined) {
    return lastRun === undefined ? after : new Date(Math.max(after.getTime(), lastRun.getTime() + schedule.everyMs));
  }
  if (schedule.at !== undefined) {
    if (lastRun !== undefined || after.getTime() - schedule.at >= ONCE_GRACE_MS) return undefined;
    return new Date(Math.max(schedule.at, after.getTime()));
  }
  // Minute by minute from the next whole minute, jumping a day or an hour at a time when
  // the day or the hour cannot match — a year is the horizon, as a yearly cron needs.
  const horizon = after.getTime() + 366 * 86_400_000;
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  while (t <= horizon) {
    const now = new Date(t);
    const at = wallClock(now, timezone);
    if (!within(schedule.months, at.month) || !within(schedule.daysOfMonth, at.day) || !within(schedule.daysOfWeek, at.weekday)) {
      t += (24 - at.hour) * 3_600_000 - at.minute * 60_000;
      continue;
    }
    if (!within(schedule.hours, at.hour)) {
      t += 3_600_000 - at.minute * 60_000;
      continue;
    }
    if (within(schedule.minutes, at.minute)) return now;
    t += 60_000;
  }
  return undefined;
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.at !== undefined) return `once, at ${new Date(schedule.at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
