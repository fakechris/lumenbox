/**
 * How a run of many parts, or an unattended turn, came out (INV-1404): `done`, `partial` or
 * `failed`, with the counts behind the word.
 *
 * "Done" used to cover "done except for the two that were not": a fan-out plan was committed
 * done unless every item failed, and a routine's record said only whether its result was
 * delivered. A person reading a board, a metric or a side door's status needs the middle word,
 * because the response to partial — look at what was left — is not the response to done or to
 * failed.
 */

export type RunResult = "done" | "partial" | "failed";

export interface RunCounts {
  result: RunResult;
  doneCount: number;
  notDoneCount: number;
}

/** A plan's result from its items: all done is done, none done is failed, anything between is partial. */
export function planResult(items: readonly { status: string }[]): RunCounts {
  const doneCount = items.filter(item => item.status === "done").length;
  const notDoneCount = items.length - doneCount;
  const result: RunResult = items.length === 0 || notDoneCount === 0 ? "done" : doneCount === 0 ? "failed" : "partial";
  return { result, doneCount, notDoneCount };
}

/**
 * A routine run's result from how its turns ended (the turn ledger): a turn that failed or was
 * aborted fails the run; one that stopped itself — the call budget, the loop detector — leaves it
 * partial; a turn that ended with nothing to say ended, which is done.
 */
export function routineResult(ends: readonly { how: string; category?: string }[]): RunResult {
  if (ends.some(end => end.how === "failed" || end.how === "aborted")) return "failed";
  if (ends.some(end => end.how === "incomplete")) return "partial";
  return "done";
}

/** Why a routine run that was not done came out that way, in one line for its run history (INV-1665). */
export function routineReason(ends: readonly { how: string; category?: string }[]): string | undefined {
  const end = ends.find(e => e.how === "failed" || e.how === "aborted") ?? ends.find(e => e.how === "incomplete");
  if (end === undefined) return undefined;
  const what = end.how === "failed" ? "its turn failed" : end.how === "aborted" ? "its turn was stopped" : "its turn stopped itself before finishing";
  return end.category !== undefined ? `${what} (${end.category})` : what;
}

/** The sentence a header or a line carries. */
export function describeRunResult(counts: RunCounts): string {
  if (counts.result === "done") return `done (${counts.doneCount} of ${counts.doneCount + counts.notDoneCount})`;
  if (counts.result === "failed") return `failed (none of ${counts.notDoneCount} done)`;
  return `partial (${counts.doneCount} done, ${counts.notDoneCount} not done)`;
}
