/** The tool can report only for its captured host context, and cannot select its own trust level. */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolContext } from "./tools.ts";
import type { ToolOutcome } from "./tool-outcome.ts";
export const TASK_PROGRESS_TOOL: Anthropic.Tool = {
  name: "TaskProgress",
  description: "Read/report business-object progress for this admitted task. Read first for sourceSequence and expectedRevision. Reports replace counts or upsert unique objects by id; retries never add the same object twice. Sources/stages are separate and never summed. A report is your claim, not task completion or independent verification. Use a distinct named stage if the range changes. Read sources/objects in pages after context loss. Only the host's admitted verifier may submit checks referencing an executor source/object/version. For a long script, read returns the execution-bound descriptor for progress.json; keep its task/work/epoch/grant fields, reportId, sequence/revision and observedAt on each write. Old files are ignored.",
  input_schema: { type: "object", properties: {
    action: { type: "string", enum: ["read", "report", "objects", "sources"] }, stage: { type: "string" },
    unit: { type: "string" }, total: { type: ["integer", "null"] },
    expectedRevision: { type: "integer" }, sourceSequence: { type: "integer" }, reportId: { type: "string" }, observedAt: { type: "string" },
    counts: { type: "object", properties: Object.fromEntries(["processed", "succeeded", "failed", "skipped", "unknown"].map(key => [key, { type: "integer", minimum: 0 }])), required: ["processed", "succeeded", "failed", "skipped", "unknown"] },
    objects: { type: "array", maxItems: 1000, items: { type: "object", properties: { id: { type: "string" }, state: { type: "string", enum: ["succeeded", "failed", "skipped", "unknown"] }, version: { type: "string" } }, required: ["id", "state", "version"] } },
    checks: { type: "array", maxItems: 1000, items: { type: "object", properties: { sourceId: { type: "string" }, id: { type: "string" }, version: { type: "string" } }, required: ["sourceId", "id", "version"] } },
    sourceId: { type: "string" }, cursor: { type: "string" },
  }, required: ["action"] },
};
export function runTaskProgressTool(input: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const receiver = context.tasks?.progress, execution = context.progressContext;
  if (!receiver || !execution) return { text: "No current admitted progress execution. Activity and task stage remain available; no completion percentage was inferred.", isError: true };
  try {
    const result = input.action === "report" ? receiver.receive(execution, { ...input, observedAt: input.observedAt ?? new Date().toISOString() }, `tool:${context.turnId}:${context.toolUseId}`)
      : input.action === "sources" ? receiver.sources(execution, typeof input.cursor === "string" ? input.cursor : undefined)
      : input.action === "objects" ? receiver.objects(execution, String(input.sourceId ?? ""), typeof input.cursor === "string" ? input.cursor : undefined)
      : input.action === "read" ? receiver.info(execution, typeof input.stage === "string" ? input.stage : undefined) : undefined;
    return result ? { text: JSON.stringify(result) } : { text: "Unknown progress action", isError: true };
  } catch (error) { return { text: error instanceof Error ? error.message : String(error), isError: true }; }
}
