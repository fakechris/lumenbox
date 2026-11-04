/**
 * How much of a history one summary call is given (INV-1570).
 *
 * Compaction normally summarises at most about one context's worth: it starts once the active
 * window passes the trigger. A record that was never compacted — imported, migrated, or one whose
 * compactions kept failing — hands the whole of itself to the first one: on 2026-11-04 five 30 MB
 * records each became a ~30 MB summary prompt, larger than any model's window, so the call could
 * only fail into the dropped-history fallback, after ~850 MB of allocation building it.
 *
 * An ordinary pass is given everything, as before. Past a pathological size
 * (`pathologicalSummaryTokens`) the bound is the summary model's own compaction trigger
 * (`policyForModel`), the budget that already says how much of a window history may fill: the most
 * recent entries are the ones given, oldest left out first, with a host line saying how many were.
 * A previous summary at the front is always kept: it is the record of everything before it, and
 * updating it is what a summary call does.
 */

import { CHARS_PER_TOKEN, estimateTokens, policyForModel, type HistoryEntry } from "./compaction.ts";

export interface SummaryInput {
  entries: readonly HistoryEntry[];
  /** Entries left out from the front, for the log. */
  omitted: number;
}

/** The part of `entries` one summary call can take, within `budgetTokens`. */
export function boundSummaryInput(entries: readonly HistoryEntry[], budgetTokens: number): SummaryInput {
  const lead = entries[0] !== undefined && "kind" in entries[0] && entries[0].kind === "summary" ? entries[0] : undefined;
  let room = budgetTokens - (lead === undefined ? 0 : estimateTokens([lead]));
  let start = entries.length;
  const floor = lead === undefined ? 0 : 1;
  while (start > floor) {
    const cost = estimateTokens([entries[start - 1]!]);
    if (cost > room) break;
    room -= cost;
    start -= 1;
  }
  const omitted = start - floor;
  if (omitted === 0) return { entries, omitted: 0 };
  const note: HistoryEntry = {
    role: "user",
    host: true,
    text: `[${omitted} earlier entr${omitted === 1 ? "y was" : "ies were"} left out: this history was too long to summarise in one pass, so only its most recent part follows]`,
    at: entries[start]?.at ?? "",
  };
  return { entries: [...(lead === undefined ? [] : [lead]), note, ...entries.slice(start)], omitted };
}

/**
 * Past this a history is not one that compaction fell behind on but one it never ran over. An
 * ordinary pass summarises a little more than one trigger's worth — the round that crossed it can
 * be large — and is given all of it, exactly as before; the floor keeps small test windows ordinary.
 */
export function pathologicalSummaryTokens(triggerTokens: number): number {
  return Math.max(4 * triggerTokens, 200_000);
}

/** What a summary model is given: the whole older part, unless that is pathological, then its trigger's worth. */
export function summaryInputFor(entries: readonly HistoryEntry[], model: string): SummaryInput {
  const trigger = policyForModel(model).triggerTokens;
  if (estimateTokens(entries) <= pathologicalSummaryTokens(trigger)) return { entries, omitted: 0 };
  const bounded = boundSummaryInput(entries, trigger);
  if (bounded.omitted > 0) console.error(`[compaction] summarising the most recent part only: ${bounded.omitted} older entr${bounded.omitted === 1 ? "y" : "ies"} left out (about ${Math.round(trigger * CHARS_PER_TOKEN / 1000)}k characters fit)`);
  return bounded;
}
