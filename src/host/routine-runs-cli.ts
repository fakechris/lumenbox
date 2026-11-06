/**
 * `agentbox routines runs <slug>` (INV-1665): the list the routines page expands, read from the
 * same ledger the scheduler writes. Read straight from the file rather than asked of a running
 * server, so it answers while the orchestrator is down — which is when somebody asks why a
 * routine did not run. The next five times need the routine's schedule, which lives in the box;
 * the page shows them.
 */

import { formatRuns, readRunLedger, RoutineHolds, runsOf } from "./routine-runs.ts";
import { scheduleLogPath } from "./schedule.ts";

export function cmdRoutines(args: readonly string[], out: (line: string) => void, err: (line: string) => void, path = scheduleLogPath()): number {
  const [sub, slug, ...rest] = args;
  if (sub !== "runs" || slug === undefined || slug === "") {
    err("Usage: agentbox routines runs <slug> [--limit N]");
    return 1;
  }
  const limitAt = rest.indexOf("--limit");
  const limit = limitAt >= 0 ? Math.max(1, Number(rest[limitAt + 1]) || 20) : 20;
  const records = readRunLedger(path);
  const holds = new RoutineHolds();
  for (const record of records) holds.replay(record);
  for (const line of formatRuns(slug, runsOf(records, slug, { limit }), holds.holdOf(slug))) out(line);
  return 0;
}
