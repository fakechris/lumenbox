/**
 * Duty cycle and interruption rate, from the ledgers that already exist.
 *
 * Argus's technical report pairs the two numbers and reports both denominators — how busy the
 * system was over the wall clock, and how busy it was while it had work — and partitions what
 * it had to ask people about. Those are the numbers the R40 shadow week keeps asking for
 * ("does the guard fire, does the interim line land, are turns tool-first") and until now the
 * answers were anecdotes read out of a log. This computes them once, the same way each time.
 *
 * Inputs are the files as they are: `turns.jsonl` (begin/end per attempt), `usage.jsonl`,
 * `schedules.jsonl`, `tasks.jsonl`, and the `[conduct]` lines the turn engine prints. Nothing
 * is written.
 */

export interface MetricsInput {
  /** Lines of turns.jsonl. */
  turns: readonly string[];
  /** Lines of usage.jsonl. */
  usage: readonly string[];
  /** Lines of schedules.jsonl. */
  schedules: readonly string[];
  /** Lines of tasks.jsonl. */
  tasks: readonly string[];
  /** Log lines; only those containing `[conduct]` are read. */
  log: readonly string[];
  /** The window: [fromMs, toMs]. */
  fromMs: number;
  toMs: number;
}

export interface Metrics {
  windowHours: number;
  turns: { total: number; byHow: Record<string, number>; failedBy: Record<string, number>; medianSeconds: number; p90Seconds: number };
  /** Union of turn intervals over the window, and over the hours that had any turn at all. */
  dutyCycle: { busyHours: number; rawPercent: number; activeHours: number; withWorkPercent: number };
  tokens: { total: number; byKind: Record<string, number>; perTurn: number };
  routines: { runs: number; tokens: number; medianSeconds: number };
  /** What needed a person: blocked tasks, and tasks parked in review. */
  interruptions: { blockedTasks: number; reviewWaits: number; perActiveHour: number };
  conduct: {
    openedWithReply: number;
    openedToolFirst: number;
    interimLines: number;
    guardFired: number;
    guardComplied: number;
    guardIgnored: number;
    closingNudges: number;
  };
}

function parse<T>(line: string): T | undefined {
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return sorted[index]!;
}

/** Total length of the union of intervals, clipped to the window, in ms. */
function unionMs(intervals: { start: number; end: number }[], fromMs: number, toMs: number): number {
  const clipped = intervals
    .map(({ start, end }) => ({ start: Math.max(start, fromMs), end: Math.min(end, toMs) }))
    .filter(({ start, end }) => end > start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let current: { start: number; end: number } | undefined;
  for (const interval of clipped) {
    if (current === undefined || interval.start > current.end) {
      if (current !== undefined) total += current.end - current.start;
      current = { ...interval };
    } else if (interval.end > current.end) {
      current.end = interval.end;
    }
  }
  if (current !== undefined) total += current.end - current.start;
  return total;
}

export function computeMetrics(input: MetricsInput): Metrics {
  const { fromMs, toMs } = input;
  const inWindow = (at: string | undefined) => {
    const ms = Date.parse(at ?? "");
    return !Number.isNaN(ms) && ms >= fromMs && ms <= toMs;
  };

  // Turns: pair begin and end by id. An attempt with no end is still open (or died); it counts
  // as busy until the window's end, which is what a person watching would have seen.
  const begins = new Map<string, number>();
  const ends = new Map<string, { at: number; how: string; category?: string }>();
  for (const line of input.turns) {
    const record = parse<{ id?: string; event?: string; at?: string; how?: string; category?: string }>(line);
    if (record?.id === undefined || record.at === undefined) continue;
    const at = Date.parse(record.at);
    if (Number.isNaN(at)) continue;
    if (record.event === "begin") begins.set(record.id, at);
    else if (record.event === "end") ends.set(record.id, { at, how: record.how ?? "unknown", ...(record.category !== undefined ? { category: record.category } : {}) });
  }
  const intervals: { start: number; end: number }[] = [];
  const byHow: Record<string, number> = {};
  const failedBy: Record<string, number> = {};
  const durations: number[] = [];
  for (const [id, start] of begins) {
    if (start < fromMs || start > toMs) continue;
    const end = ends.get(id);
    const stop = end?.at ?? toMs;
    intervals.push({ start, end: Math.max(start, stop) });
    const how = end === undefined ? "open" : end.how;
    byHow[how] = (byHow[how] ?? 0) + 1;
    if (how === "failed") {
      const category = end?.category ?? "unknown";
      failedBy[category] = (failedBy[category] ?? 0) + 1;
    }
    if (end !== undefined) durations.push((end.at - start) / 1000);
  }
  durations.sort((a, b) => a - b);

  const busyMs = unionMs(intervals, fromMs, toMs);
  const windowMs = Math.max(1, toMs - fromMs);
  // Hours that had any turn in them, as the second denominator: a box that sat idle overnight
  // because nobody asked is not a box that was slow.
  const activeHourSet = new Set<number>();
  for (const { start, end } of intervals) {
    for (let hour = Math.floor(start / 3_600_000); hour <= Math.floor((end - 1) / 3_600_000); hour += 1) {
      activeHourSet.add(hour);
    }
  }
  const activeHours = activeHourSet.size;

  // Tokens.
  const byKind: Record<string, number> = {};
  let totalTokens = 0;
  for (const line of input.usage) {
    const record = parse<{
      at?: string;
      kind?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }>(line);
    if (record === undefined || !inWindow(record.at)) continue;
    const tokens =
      (record.inputTokens ?? 0) + (record.outputTokens ?? 0) + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
    const kind = record.kind ?? "unattributed";
    byKind[kind] = (byKind[kind] ?? 0) + tokens;
    totalTokens += tokens;
  }

  // Routines.
  let routineRuns = 0;
  let routineTokens = 0;
  const routineSeconds: number[] = [];
  for (const line of input.schedules) {
    const record = parse<{ at?: string; event?: string; tokens?: number; ms?: number }>(line);
    if (record?.event !== "finished" || !inWindow(record.at)) continue;
    routineRuns += 1;
    routineTokens += record.tokens ?? 0;
    if (record.ms !== undefined) routineSeconds.push(record.ms / 1000);
  }
  routineSeconds.sort((a, b) => a - b);

  // Interruptions: a task that went blocked, or into review, inside the window. Each is a
  // moment somebody had to be asked or had to look. Read from the board's history, which is
  // append-only and records the time of every move.
  let blockedTasks = 0;
  let reviewWaits = 0;
  for (const line of input.tasks) {
    const record = parse<{ history?: { at?: string; status?: string }[]; status?: string; at?: string }>(line);
    if (record === undefined) continue;
    const moves = record.history ?? (record.status !== undefined ? [{ at: record.at, status: record.status }] : []);
    for (const move of moves) {
      if (!inWindow(move.at)) continue;
      if (move.status === "blocked") blockedTasks += 1;
      if (move.status === "review") reviewWaits += 1;
    }
  }

  // Conduct counters, from the lines the engine prints.
  const conduct = {
    openedWithReply: 0,
    openedToolFirst: 0,
    interimLines: 0,
    guardFired: 0,
    guardComplied: 0,
    guardIgnored: 0,
    closingNudges: 0,
  };
  for (const line of input.log) {
    if (!line.includes("[conduct]")) continue;
    const stamp = /^(\d{4}-\d{2}-\d{2}T[^ ]+)/.exec(line)?.[1];
    if (stamp !== undefined && !inWindow(stamp)) continue;
    if (/opened with a reply/.test(line)) conduct.openedWithReply += 1;
    else if (/opened tool-first/.test(line)) conduct.openedToolFirst += 1;
    else if (/interim line delivered/.test(line)) conduct.interimLines += 1;
    else if (/guard \S+ fired/.test(line)) conduct.guardFired += 1;
    else if (/guard \S+ complied/.test(line)) conduct.guardComplied += 1;
    else if (/guard \S+ ignored/.test(line)) conduct.guardIgnored += 1;
    else if (/closing nudge/.test(line)) conduct.closingNudges += 1;
  }

  const turnsTotal = intervals.length;
  return {
    windowHours: windowMs / 3_600_000,
    turns: {
      total: turnsTotal,
      byHow,
      failedBy,
      medianSeconds: percentile(durations, 0.5),
      p90Seconds: percentile(durations, 0.9),
    },
    dutyCycle: {
      busyHours: busyMs / 3_600_000,
      rawPercent: (100 * busyMs) / windowMs,
      activeHours,
      withWorkPercent: activeHours === 0 ? 0 : Math.min(100, (100 * busyMs) / (activeHours * 3_600_000)),
    },
    tokens: { total: totalTokens, byKind, perTurn: turnsTotal === 0 ? 0 : totalTokens / turnsTotal },
    routines: { runs: routineRuns, tokens: routineTokens, medianSeconds: percentile(routineSeconds, 0.5) },
    interruptions: {
      blockedTasks,
      reviewWaits,
      perActiveHour: activeHours === 0 ? 0 : (blockedTasks + reviewWaits) / activeHours,
    },
    conduct,
  };
}

/** The report as a person reads it. */
export function renderMetrics(metrics: Metrics): string {
  const pct = (value: number) => `${value.toFixed(1)}%`;
  const hours = (value: number) => `${value.toFixed(1)} h`;
  const kinds = Object.entries(metrics.tokens.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, tokens]) => `${kind} ${tokens.toLocaleString()}`)
    .join(", ");
  const hows = Object.entries(metrics.turns.byHow)
    .sort((a, b) => b[1] - a[1])
    .map(([how, count]) => `${how} ${count}`)
    .join(", ");
  const c = metrics.conduct;
  return [
    `Window: ${hours(metrics.windowHours)}`,
    `Turns: ${metrics.turns.total} (${hows || "none"}); median ${metrics.turns.medianSeconds.toFixed(0)} s, p90 ${metrics.turns.p90Seconds.toFixed(0)} s` +
      (Object.keys(metrics.turns.failedBy).length > 0
        ? `; failed by class: ${Object.entries(metrics.turns.failedBy).map(([k, n]) => `${k} ${n}`).join(", ")}`
        : ""),
    `Duty cycle: ${pct(metrics.dutyCycle.rawPercent)} of the wall clock (${hours(metrics.dutyCycle.busyHours)} busy); ` +
      `${pct(metrics.dutyCycle.withWorkPercent)} of the ${metrics.dutyCycle.activeHours} hour(s) that had work`,
    `Tokens: ${metrics.tokens.total.toLocaleString()} (${kinds || "none"}); ${Math.round(metrics.tokens.perTurn).toLocaleString()} per turn`,
    `Routines: ${metrics.routines.runs} run(s), ${metrics.routines.tokens.toLocaleString()} tokens, median ${metrics.routines.medianSeconds.toFixed(0)} s`,
    `Interruptions: ${metrics.interruptions.blockedTasks} blocked, ${metrics.interruptions.reviewWaits} waiting for review; ` +
      `${metrics.interruptions.perActiveHour.toFixed(2)} per active hour`,
    `Conduct: opened with a reply ${c.openedWithReply}, tool-first ${c.openedToolFirst}, interim lines ${c.interimLines}; ` +
      `guard fired ${c.guardFired} (complied ${c.guardComplied}, ignored ${c.guardIgnored}); closing nudges ${c.closingNudges}`,
  ].join("\n");
}
