/** Read-only task artifacts. Bounded, expiring download cache; no business-task or MCP writes. */
import { randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { DELIVERABLE_LIMIT_BYTES, digestOf } from "../host/task-deliverables.ts";
import type { Task } from "../host/tasks.ts";
import { sourceDigest } from "./execution-source.ts";
import { ExecutionReset, type ExecutionAccess, type ExecutionExport, type ExecutionFilters, type TaskExecutions } from "./task-execution.ts";
import { EXPORT_POLICY, exportRedaction, exportStep, exportTask, type ExportTask } from "./task-export-policy.ts";

export const TASK_EXPORT_TTL = 10 * 60_000;
const filenames = ["task.md", "steps.jsonl", "manifest.json"] as const;
export type TaskExportFilename = typeof filenames[number];
interface Bundle {
  id: string; taskId: string; expiresAt: number; files: Map<TaskExportFilename, Buffer>;
  capture: ExecutionExport; task: ExportTask; taskVersion: string; redactionVersion: string;
}
export class TaskExports {
  private readonly bundles = new Map<string, Bundle>();
  private inflight = 0;
  constructor(private readonly deps: { home: string; executions: TaskExecutions; task: (id: string) => Task | undefined; now?: () => number }) {}
  private now() { return this.deps.now?.() ?? Date.now(); }
  private prune() { for (const [id, bundle] of this.bundles) if (bundle.expiresAt <= this.now()) this.bundles.delete(id); }
  private descriptor(bundle: Bundle) {
    return { id: bundle.id, taskId: bundle.taskId, snapshot: bundle.capture.snapshot, highWater: bundle.capture.highWater,
      expiresAt: new Date(bundle.expiresAt).toISOString(), files: [...bundle.files].map(([name, bytes]) => ({ name, size: bytes.length, sha256: digestOf(bytes) })) };
  }
  private current(bundle: Bundle, access: ExecutionAccess) {
    const task = this.deps.task(bundle.taskId);
    return !!task && access.task(task.id) && bundle.expiresAt > this.now()
      && bundle.redactionVersion === exportRedaction(this.deps.home).version
      && bundle.taskVersion === sourceDigest(exportTask(task, access));
  }
  async create(taskId: string, access: () => ExecutionAccess, filters: ExecutionFilters = {}, signal?: AbortSignal) {
    this.prune();
    if (this.inflight >= 2) throw new ExecutionReset("export capacity");
    while (this.bundles.size + this.inflight >= 2) this.bundles.delete(this.bundles.keys().next().value!);
    this.inflight++;
    try {
      signal?.throwIfAborted();
      const initialAccess = access(), task = this.deps.task(taskId);
      if (!task || !initialAccess.task(taskId)) throw new ExecutionReset("export unavailable");
      const selected = structuredClone(exportTask(task, initialAccess));
      const capture = this.deps.executions.captureExport(taskId, initialAccess, filters);
      const redaction = exportRedaction(this.deps.home), safeTask = redaction.clean(selected);
      const lines: string[] = [], markdown = ["# Task record", "", "Task metadata and progress cover the whole readable task. Execution filters apply only to steps.", "Tool inputs and results are omitted. Stable source references and exact task-deliverable references are retained.", "This record does not assert user acceptance or complete historical coverage.", "", ...indent(JSON.stringify(safeTask, null, 2)), ""];
      let encodedBytes = Buffer.byteLength(markdown.join("\n")), omitted = 0, truncated = 0, expired = 0, partial = capture.coverage === "partial";
      await this.deps.executions.visitExport(capture, access, raw => {
        const row = exportStep(raw, selected, redaction);
        if (row.resultOmitted || row.inputOmitted) omitted++;
        if (row.resultTruncated || row.inputTruncated) truncated++;
        if (row.sourceExpired) expired++;
        partial ||= row.coverage === "partial" || !!row.sourceExpired || !!row.resultTruncated || !!row.inputTruncated;
        const line = JSON.stringify(row) + "\n";
        lines.push(line);
        const before = markdown.length;
        const metadata = row;
        markdown.push(`## Step ${lines.length}`, "", ...indent(JSON.stringify(metadata)), "");
        encodedBytes += Buffer.byteLength(line) + Buffer.byteLength(markdown.slice(before).join("\n")) + 2;
        if (encodedBytes > DELIVERABLE_LIMIT_BYTES || lines.length > 50_000) throw new ExecutionReset("export capacity");
      }, signal);
      const md = Buffer.from(markdown.join("\n")), jsonl = Buffer.from(lines.join(""));
      if (md.length + jsonl.length > DELIVERABLE_LIMIT_BYTES) throw new ExecutionReset("export capacity");
      const manifest = { schema: "lumenbox-task-export/1", taskId, filters: redaction.clean(capture.filters), snapshot: capture.snapshot, highWater: capture.highWater,
        generatedAt: new Date(this.now()).toISOString(), taskMetadataHighWater: sourceDigest(safeTask), scope: "authorized-retained-bindings", taskMetadataScope: "whole-readable-task",
        order: "startedAt then stable source id; not a global execution order", historyCoverage: "explicit-bindings-only",
        coverage: partial || redaction.clipped || omitted > 0 ? "partial" : "exact-retained-projection", steps: lines.length,
        bodyPolicy: EXPORT_POLICY, policyOmittedSteps: omitted, truncatedSteps: truncated, expiredSteps: expired, metadataClipped: redaction.clipped,
        limits: { sourceBytes: 32 * 1024 * 1024, sourceEntries: 20_000, sources: 16, bodyBytes: 0, fieldCharacters: 32000 },
        retention: "Download cache retains at most two bundles for up to 10 minutes, until process restart, source removal, redaction or task metadata change. New exports can replace older bundles. Recreate when unavailable.",
        files: [{ name: "task.md", size: md.length, sha256: digestOf(md) }, { name: "steps.jsonl", size: jsonl.length, sha256: digestOf(jsonl) }] };
      const files = new Map<TaskExportFilename, Buffer>([["task.md", md], ["steps.jsonl", jsonl], ["manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n")]]);
      if ([...files.values()].reduce((n, bytes) => n + bytes.length, 0) > DELIVERABLE_LIMIT_BYTES) throw new ExecutionReset("export capacity");
      const bundle: Bundle = { id: randomUUID(), taskId, expiresAt: this.now() + TASK_EXPORT_TTL, files, capture, task: selected, taskVersion: sourceDigest(selected), redactionVersion: redaction.version };
      await yieldTurn(); signal?.throwIfAborted();
      if (!this.current(bundle, access()) || !this.deps.executions.validateExport(capture, access()) || !this.current(bundle, access())) throw new ExecutionReset("export unavailable");
      this.bundles.set(bundle.id, bundle);
      return this.descriptor(bundle);
    } finally { this.inflight--; }
  }
  download(taskId: string, id: string, filename: string, access: () => ExecutionAccess) {
    this.prune();
    const bundle = this.bundles.get(id);
    if (!bundle || bundle.taskId !== taskId || !filenames.includes(filename as TaskExportFilename)) throw new ExecutionReset("export unavailable");
    if (!this.current(bundle, access()) || !this.deps.executions.validateExport(bundle.capture, access()) || !this.current(bundle, access())) { this.bundles.delete(id); throw new ExecutionReset("export unavailable"); }
    return bundle.files.get(filename as TaskExportFilename)!;
  }
}
function indent(text: string): string[] { return text.split("\n").map(line => "    " + line); }
