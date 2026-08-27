/**
 * What the model cost, from the records rather than from a script typed into a shell.
 *
 * On 2026-08-26 every question of this shape — how many calls, what did that batch cost,
 * how long did that turn take — was answered by an improvised one-liner. Fifteen or so,
 * none kept, several wrong on the first attempt *because* they were improvised. The
 * principle this file applies is the one `scan-records` established: **a number nobody can
 * re-run is a claim, not a measurement.**
 *
 * Three cuts, because three questions get asked:
 *
 *   - a **day** — what did the installation spend, and on what
 *   - a **piece of work** (`workId`) — what did that ask cost, across every attempt at it
 *   - a **task** — via the turn ids its board history already records
 *
 * The honesty rules here are load-bearing and each exists because the opposite is a quiet
 * lie: an unpriced model is named rather than costed at zero, money is withheld unless
 * every model in the window has a rate, a total over a compacted file says it is a floor,
 * and an empty window says so rather than reporting a confident zero.
 */

import type { UsageRecord, UsageTotals } from "./usage.ts";

/**
 * What a model costs, per million tokens.
 *
 * Read from configuration rather than baked in. Prices change, they differ per account,
 * and a table shipped in source is a number that is wrong at some unknown later date while
 * still looking authoritative — which is the failure mode this file is built to avoid.
 */
export interface Rate {
  inputPerM: number;
  outputPerM: number;
  /** Usually a fraction of input. Charging cache reads at the input rate overstates a long conversation by an order of magnitude. */
  cacheReadPerM?: number;
  cacheWritePerM?: number;
}

export type Rates = Record<string, Rate>;

/** What one call cost, or `undefined` when the model has no rate. */
export function priceOf(record: UsageRecord, rates: Rates): number | undefined {
  const rate = rates[record.model];
  if (rate === undefined) return undefined;
  const perMillion = (tokens: number, price: number | undefined) =>
    price === undefined ? 0 : (tokens / 1e6) * price;
  return (
    perMillion(record.inputTokens, rate.inputPerM) +
    perMillion(record.outputTokens, rate.outputPerM) +
    perMillion(record.cacheReadTokens, rate.cacheReadPerM) +
    perMillion(record.cacheWriteTokens, rate.cacheWritePerM)
  );
}

export interface SpendReport {
  /** What was being asked about, for the heading. */
  scope: string;
  records: number;
  /** How many distinct turns contributed — an ask that took three attempts says three. */
  turns: number;
  totals: UsageTotals;
  byKind: { kind: string; totals: UsageTotals }[];
  byAgent: { agent: string; totals: UsageTotals }[];
  byModel: { model: string; totals: UsageTotals }[];
  /** Money, only when every model in the window had a rate. See `unpriced`. */
  money?: number;
  /** Models seen with no rate configured. Non-empty means `money` is withheld. */
  unpriced: string[];
  /** Whether the source file has been compacted, which makes every total a floor. */
  compacted: boolean;
  /**
   * Why an empty result is empty, when the reason is the records rather than the question.
   *
   * `workId` and `turnId` were added on 2026-08-27. Every row written before that carries
   * neither, so asking what a task from last week cost returns nothing — and "no records"
   * reads as "it was free", which is the exact failure this report exists to avoid.
   */
  unjoinable?: string;
}

export interface SpendQuery {
  /** A calendar day in the local timezone, `YYYY-MM-DD`. */
  day?: string;
  /** One piece of work, across every attempt at it. */
  workId?: string;
  /** Specific turns — how a task is costed, from the ids its board history records. */
  turnIds?: readonly string[];
  rates?: Rates;
  compacted?: boolean;
}

const ZERO: UsageTotals = {
  records: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function add(into: UsageTotals, record: UsageRecord): UsageTotals {
  return {
    records: into.records + 1,
    inputTokens: into.inputTokens + record.inputTokens,
    outputTokens: into.outputTokens + record.outputTokens,
    cacheReadTokens: into.cacheReadTokens + record.cacheReadTokens,
    cacheWriteTokens: into.cacheWriteTokens + record.cacheWriteTokens,
  };
}

/** Groups records by a key, summing each group, heaviest first. */
function group<K extends string>(
  records: readonly UsageRecord[],
  keyOf: (record: UsageRecord) => string,
  name: K
): ({ [P in K]: string } & { totals: UsageTotals })[] {
  const groups = new Map<string, UsageTotals>();
  for (const record of records) {
    groups.set(keyOf(record), add(groups.get(keyOf(record)) ?? ZERO, record));
  }
  return [...groups.entries()]
    .map(([key, totals]) => ({ [name]: key, totals }) as { [P in K]: string } & { totals: UsageTotals })
    .sort((a, b) => b.totals.outputTokens - a.totals.outputTokens);
}

/** The local calendar day a record belongs to, which is the day a person means. */
function dayOf(record: UsageRecord): string {
  const at = new Date(record.at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

export function summariseSpend(records: readonly UsageRecord[], query: SpendQuery): SpendReport {
  const rates = query.rates ?? {};
  const turnIds = query.turnIds === undefined ? undefined : new Set(query.turnIds);
  const selected = records.filter(record => {
    if (query.day !== undefined && dayOf(record) !== query.day) return false;
    if (query.workId !== undefined && record.workId !== query.workId) return false;
    if (turnIds !== undefined && (record.turnId === undefined || !turnIds.has(record.turnId))) {
      return false;
    }
    return true;
  });

  const unpriced = [
    ...new Set(selected.filter(record => rates[record.model] === undefined).map(record => record.model)),
  ].sort();
  // Withheld rather than partial. A bill missing one model reads low *and reads complete*,
  // which is a number somebody will act on that is wrong by an unknown amount.
  // And not for an empty window either. Nothing to price sums to zero, which renders as a
  // confident $0.00 — a figure that says "this cost nothing" where the truth is "nothing
  // here is costable". Seen on screen the first time a task drill-down was opened.
  const money =
    unpriced.length > 0 || selected.length === 0
      ? undefined
      : selected.reduce((all, record) => all + (priceOf(record, rates) ?? 0), 0);

  // Only when the answer is empty *and* the question depended on a field the rows may not
  // have. A live filter that legitimately matched nothing should not be explained away.
  let unjoinable: string | undefined;
  if (selected.length === 0 && records.length > 0) {
    const field = query.workId !== undefined ? "workId" : turnIds !== undefined ? "turnId" : undefined;
    const carrying = records.filter(record =>
      field === "workId" ? record.workId !== undefined : record.turnId !== undefined
    ).length;
    if (field !== undefined && carrying === 0) {
      unjoinable =
        `none of the ${records.length} records on file carry a ${field} — they were written ` +
        `before that field existed (2026-08-27), so this cannot be answered from them`;
    }
  }

  return {
    scope:
      query.workId !== undefined
        ? `work ${query.workId}`
        : turnIds !== undefined
          ? `${turnIds.size} turn(s)`
          : (query.day ?? "everything on file"),
    records: selected.length,
    turns: new Set(selected.map(record => record.turnId).filter(id => id !== undefined)).size,
    totals: selected.reduce(add, ZERO),
    byKind: group(selected, record => record.kind ?? "unattributed", "kind"),
    byAgent: group(selected, record => record.agentName, "agent"),
    byModel: group(selected, record => record.model, "model"),
    ...(money !== undefined ? { money } : {}),
    unpriced,
    compacted: query.compacted === true,
    ...(unjoinable !== undefined ? { unjoinable } : {}),
  };
}

/**
 * Every day on file, newest first — the entry point of the admin view.
 *
 * The day string is the same one `summariseSpend({ day })` filters on, deliberately: a list
 * whose ids do not open anything is two views of data that only look related.
 */
export function spendByDay(
  records: readonly UsageRecord[],
  rates: Rates
): { day: string; totals: UsageTotals; money?: number; unpriced: string[] }[] {
  const days = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = dayOf(record);
    (days.get(key) ?? days.set(key, []).get(key)!).push(record);
  }
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, rows]) => {
      const report = summariseSpend(rows, { rates });
      return {
        day,
        totals: report.totals,
        ...(report.money !== undefined ? { money: report.money } : {}),
        unpriced: report.unpriced,
      };
    });
}

/** The minimum a task has to expose to be costed: its identity and the turns it was worked in. */
export interface CostableTask {
  id: string;
  title: string;
  status: string;
  /** `TaskChange.run` for every change an agent made, deduplicated. */
  runs: readonly string[];
}

export interface TaskCost {
  id: string;
  title: string;
  status: string;
  turns: number;
  totals: UsageTotals;
  money?: number;
  /**
   * True when nothing on file can answer this task's cost.
   *
   * Distinguished from zero because they render identically in a column of numbers and mean
   * opposite things: a task nobody spent anything on, and a task whose spend is not
   * recoverable. Every task created before 2026-08-27 is the second kind.
   */
  unknown: boolean;
}

export function costOfTasks(
  tasks: readonly CostableTask[],
  records: readonly UsageRecord[],
  rates: Rates
): TaskCost[] {
  return tasks.map(task => {
    const report = summariseSpend(records, { turnIds: task.runs, rates });
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      turns: report.turns,
      totals: report.totals,
      ...(report.money !== undefined ? { money: report.money } : {}),
      unknown: report.records === 0,
    };
  });
}

const thousands = (value: number) => value.toLocaleString("en-US");

/** The report as lines, so the CLI is a printer and the shape is what gets tested. */
export function describeSpend(report: SpendReport): string[] {
  if (report.records === 0) {
    // Not "0 tokens". A quiet day and a filter that matched nothing produce the same total
    // and mean opposite things, and the second one is usually a mistyped id.
    return [`no records for ${report.scope}`, ...(report.unjoinable ? [`  ${report.unjoinable}`] : [])];
  }

  const lines = [
    `${report.scope} — ${thousands(report.records)} call(s)` +
      (report.turns > 0 ? ` across ${thousands(report.turns)} turn(s)` : ""),
    `  in ${thousands(report.totals.inputTokens)}  out ${thousands(report.totals.outputTokens)}` +
      `  cache read ${thousands(report.totals.cacheReadTokens)}` +
      `  cache write ${thousands(report.totals.cacheWriteTokens)}`,
  ];

  if (report.money !== undefined) {
    lines.push(`  cost $${report.money.toFixed(2)}`);
  } else if (report.unpriced.length > 0) {
    lines.push(
      `  cost not shown: no rate for ${report.unpriced.join(", ")}` +
        ` — set "rates" in config.json to price them`
    );
  }

  const section = (title: string, rows: { totals: UsageTotals }[], label: (row: never) => string) => {
    if (rows.length <= 1) return;
    lines.push(`  by ${title}:`);
    for (const row of rows) {
      lines.push(
        `    ${label(row as never).padEnd(22)} ` +
          `out ${thousands(row.totals.outputTokens).padStart(9)}` +
          `  in ${thousands(row.totals.inputTokens).padStart(11)}`
      );
    }
  };
  section("kind", report.byKind, (row: { kind: string }) => row.kind);
  section("agent", report.byAgent, (row: { agent: string }) => row.agent);
  section("model", report.byModel, (row: { model: string }) => row.model);

  if (report.compacted) {
    lines.push(
      "  this is a lower bound: the usage file has been compacted, so older calls in this",
      "  window are no longer on disk (AGENTBOX_USAGE_RETAIN_HOURS, default 48)"
    );
  }
  return lines;
}
