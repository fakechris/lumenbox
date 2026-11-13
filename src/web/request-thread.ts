/**
 * A conversation as the person who had it: what they asked and what they were told (INV-1843).
 *
 * On 2026-11-13 Chris opened three agents' main conversations and found a plan he had not asked for,
 * runs of "N steps", a wall of checkpoints and the same stop notice four times over. Counted on a copy
 * of the record: he had opened 64 turns in those conversations; the host's audit dispatch had opened
 * 1,208, and teammates and job notices 736 more. One agent's thread held 19,701 entries and two of his
 * requests. Every turn was drawn as conversation, so the conversation could not be found in it.
 *
 * Nothing is removed from the record and nothing is hidden for good. What no request opened is folded
 * where it happened into one line that says how much there was, and opens to it.
 */

import type { DisplayEntry } from "./transcript.ts";

/** Runs of background entries become one entry each; everything else is left exactly as it was. */
export function asRequests(display: readonly DisplayEntry[]): DisplayEntry[] {
  const out: DisplayEntry[] = [];
  let run: Extract<DisplayEntry, { kind: "background" }> | undefined;
  /** How the request now open has already been said to have ended: a stopped turn refuses every call after the stop, in the same words each time. */
  let ended: string | undefined;
  display.forEach((entry, index) => {
    if (entry.background !== true) {
      if (entry.kind === "text" && entry.role === "user") ended = undefined;
      if (entry.kind === "status") { if (ended === entry.what) return; ended = entry.what; }
      run = undefined; out.push(entry); return;
    }
    const at = "at" in entry && typeof entry.at === "string" ? entry.at : undefined;
    if (run === undefined) { run = { kind: "background", turns: 0, steps: 0, first: index, last: index, ...(at !== undefined ? { from: at } : {}) }; out.push(run); }
    run.last = index;
    if (at !== undefined) run.to = at;
    // A turn is counted by what opened it; a note the host dropped into a turn already running is not another turn.
    if (entry.kind === "peer" || (entry.kind === "trigger" && !entry.skipped)) run.turns += 1;
    if (entry.kind === "tools") run.steps += entry.tools.length;
  });
  return out;
}

/** The entries one folded line stands for, for the person who opens it: bounded, because a single line has stood for thousands. */
export const SPAN_SHOWN = 200;
export function spanOf(display: readonly DisplayEntry[], first: number, last: number): { entries: DisplayEntry[]; more: number } {
  const from = Math.max(0, Math.trunc(first)), to = Math.min(display.length - 1, Math.trunc(last));
  if (!(to >= from)) return { entries: [], more: 0 };
  const start = Math.max(from, to - SPAN_SHOWN + 1);
  return { entries: display.slice(start, to + 1), more: start - from };
}
