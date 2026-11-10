/** A single resolver for on-demand details and task export's batched reads. */
import type { ExecutionStepRecord, ExecutionMaintenanceRecord } from "../host/execution-records.ts";
import type { ExecutionStep, ExecutionDetail } from "./task-execution.ts";
import type { ExecutionContent } from "./execution-source.ts";
export interface FrozenStep { view: ExecutionStep; source: ExecutionStepRecord | ExecutionMaintenanceRecord; content: { call?: string; result?: string }; sourceGaps?: readonly string[] }
export function resolveExecutionDetail(row: FrozenStep, current: Map<string, ExecutionContent>, limit = 32000): ExecutionDetail {
  if (row.source.event === "maintenance") return { ...row.view, maintenance: {
    kind: row.source.kind, covers: row.source.covers, summarised: row.source.summarised,
    delayMs: row.source.delayMs, retryAttempt: row.source.retryAttempt } };
  const call = row.content.call ? current.get("hash:" + row.content.call)?.call : undefined;
  const result = row.content.result ? current.get("hash:" + row.content.result)?.result : undefined;
  const text = result?.text ?? "", inputText = JSON.stringify(call?.input ?? null);
  return { ...row.view, ...(row.sourceGaps?.length ? { sourceGaps: [...row.sourceGaps] } : {}), input: inputText.length > limit ? { preview: inputText.slice(0, limit) } : call?.input ?? null,
    inputTruncated: inputText.length > limit, result: result ? text.slice(0, limit) : null,
    resultTruncated: text.length > limit, sourceExpired: (!!row.content.call && !call) || (!!row.content.result && !result),
    resultCoverage: result ? "stored" : row.content.result ? "expired" : row.sourceGaps?.length ? "source-incomplete-at-snapshot" : "not-recorded-at-snapshot" };
}
