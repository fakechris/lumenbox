/** Export is a narrower projection than the interactive viewer, never a raw transcript dump. */
import { heldValues, redactLine } from "../host/audit-export.ts";
import { buildRedactor, currentRedactor } from "../host/secret-redaction.ts";
import { digestOf } from "../host/task-deliverables.ts";
import { summarizeTaskProgress } from "../host/task-progress.ts";
import type { Task } from "../host/tasks.ts";
import type { ExecutionAccess, ExecutionDetail } from "./task-execution.ts";
import { sourceDigest } from "./execution-source.ts";

export const EXPORT_POLICY = "task-export/1:source-references-only";
const forbidden = /^(?:.*(?:password|passwd|secret|token|cookie|authorization|apikey|privatekey).*|system|systemprompt|prompt|messages|thinking|reasoning|hiddenreasoning|bootstrap|html|dom)$/i;
const normalize = (key: string) => key.replace(/[^a-z0-9]/gi, "");
export function exportRedaction(home: string) {
  const held = heldValues(home), vault = currentRedactor(), config = buildRedactor([...held].map(([name, value]) => ({ name, value })));
  const version = sourceDigest([EXPORT_POLICY, vault.version, config.version, [...held].sort(([a], [b]) => a.localeCompare(b))]);
  let clipped = false;
  const text = (value: string): string => redactLine(config.text(vault.text(value)), new Map()).text;
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 24) { clipped = true; return "[depth limit]"; }
    if (typeof value === "string") {
      // Parse before clipping: quoted credential keys must not become ordinary prose at a boundary.
      if (/^\s*[\[{]/.test(value)) { try { return clean(JSON.parse(value), depth + 1); } catch { /* ordinary text */ } }
      const redacted = text(value);
      if (redacted.length > 32000) clipped = true;
      return redacted.slice(0, 32000);
    }
    if (Array.isArray(value)) return value.map(item => clean(item, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !forbidden.test(normalize(key))).map(([key, item]) => [text(key), clean(item, depth + 1)]));
    return value;
  };
  return { version, clean, get clipped() { return clipped; } };
}

/** Only fields the task workspace already presents. No mandate, prompt, file path or raw history. */
export function exportTask(task: Task, access: ExecutionAccess) {
  const progress = summarizeTaskProgress(task, 128, access);
  return { id: task.id, title: task.title, description: task.description, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
    contract: task.contract && { outcome: task.contract.outcome, scope: task.contract.scope, constraints: task.contract.constraints, acceptance: task.contract.acceptance, verification: task.contract.verification },
    goal: task.pursuit && { objective: task.pursuit.objective, status: task.pursuit.status, workId: task.pursuit.workId,
      checklist: task.pursuit.checklist.map(item => ({ id: item.id, text: item.text, verdict: item.verdict })) },
    progress,
    artifacts: (task.deliverables ?? []).filter(item => access.agent(item.by)).map(item => ({ id: item.id, name: item.name, size: item.size, sha256: item.sha256, at: item.at, by: item.by })),
    recoveries: task.recoveries?.map(item => ({ operationId: item.operationId, attempt: item.attempt, epoch: item.epoch, at: item.at, status: item.status })) };
}
export type ExportTask = ReturnType<typeof exportTask>;

/** Reference-only: even a delivered file cannot reauthorize DOM, context or prompt bodies. */
export function exportStep(row: ExecutionDetail, task: ExportTask, redaction: ReturnType<typeof exportRedaction>) {
  const { input: _input, result, detail: _detail, gate: _gate, ...metadata } = row;
  const artifact = result == null ? undefined : task.artifacts.find(item => item.sha256 === digestOf(Buffer.from(result)));
  return redaction.clean({ ...metadata, detail: "", input: null, result: null, bodyPolicy: "source-references-only",
    ...(artifact ? { artifactId: artifact.id } : {}),
    gate: row.gate && { verdict: row.gate.verdict, approvalId: row.gate.approvalId },
    inputOmitted: row.kind === "tool", resultOmitted: result != null,
    inputTruncated: false, resultTruncated: false }) as ExecutionDetail & { bodyPolicy: string; inputOmitted: boolean; resultOmitted: boolean };
}
