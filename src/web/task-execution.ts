/** Frozen, authorized read projections over the existing records (INV-1785). */
import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import type { TurnLedger } from "../host/resume.ts";
import type { ExecutionStepRecord, ExecutionMaintenanceRecord } from "../host/execution-records.ts";
import type { TaskBinding } from "../host/execution-binding.ts";
import { contentFor, executionContent, sourceDigest } from "./execution-source.ts";

export interface ExecutionAccess {
  task: (id: string) => boolean;
  agent: (id: string) => boolean;
  box: (id: string) => boolean;
}
export interface ExecutionFilters { workId?: string; role?: TaskBinding["role"]; outcome?: string }
export interface ExecutionStep {
  id: string; taskId: string; turnId: string; executionId: string; attempt: number;
  toolUseId?: string; workId: string; agentId: string; boxId: string; conversation: string;
  kind: "tool" | "maintenance";
  contextEpoch: number; role: TaskBinding["role"]; parent?: TaskBinding["parent"];
  name: string; detail: string; outcome: "running" | "succeeded" | "failed" | "unknown" | "waiting" | "refused";
  startedAt?: string; endedAt?: string; sourceRefs: string[];
  coverage: "exact" | "partial";
  gate?: ExecutionStepRecord["gate"];
}
export interface ExecutionDetail extends ExecutionStep {
  input?: unknown; inputTruncated?: boolean; result?: string | null; resultTruncated?: boolean;
  sourceExpired?: boolean; resultCoverage?: string;
  maintenance?: { kind: string; covers?: number; summarised?: boolean; delayMs?: number; retryAttempt?: number };
}
interface FrozenStep { view: ExecutionStep; source: ExecutionStepRecord | ExecutionMaintenanceRecord; content: { call?: string; result?: string } }
interface Snapshot {
  id: string; taskId: string; filters: ExecutionFilters; highWater: string; createdAt: number;
  rows: FrozenStep[]; partial: boolean;
}
export class ExecutionReset extends Error {}

export class TaskExecutions {
  private readonly snapshots = new Map<string, Snapshot>();
  constructor(private readonly deps: {
    namespace: string; turns: Pick<TurnLedger, "executionRecords">;
    registry: Pick<AgentRegistry, "readContextTranscriptsByEpoch">;
    now?: () => number;
  }) {}

  private allowed(step: Pick<ExecutionStep, "taskId" | "agentId" | "boxId">, access: ExecutionAccess): boolean {
    return access.task(step.taskId) && access.agent(step.agentId) && access.box(step.boxId);
  }

  /** Snapshot rows are immutable metadata and source hashes, never copies of all result bodies. */
  open(taskId: string, access: ExecutionAccess, filters: ExecutionFilters = {}) {
    if (!access.task(taskId)) throw new ExecutionReset("task unavailable");
    const source = this.deps.turns.executionRecords();
    const grouped = new Map<string, { start?: ExecutionStepRecord; end?: ExecutionStepRecord }>();
    const ended = new Set<string>(), active = new Map<string, string>();
    for (const r of source.records) {
      if (r.event === "begin" && r.executionId) active.set(r.id, r.executionId);
      else if (r.event === "end" && active.has(r.id)) ended.add(active.get(r.id)!);
    }
    const begunHere = source.records.some(r => r.event === "begin" && r.taskBinding?.taskId === taskId);
    const selection = new Map(source.records.filter(r => r.event === "selection").map(r => [JSON.stringify([r.id, r.executionId, r.toolUseId]), r.taskBinding]));
    const candidates = new Set(source.records.flatMap(r => (r.event === "step" || r.event === "selection") && r.taskBinding?.taskId === taskId
      ? [JSON.stringify([r.id, r.executionId, r.toolUseId])] : []));
    // Only exact write-time bindings are upgraded to task facts. Old unbound turns remain explicitly partial.
    for (const r of source.records) {
      if (r.event !== "step" || !candidates.has(JSON.stringify([r.id, r.executionId, r.toolUseId]))) continue;
      if (!r.executionId || !r.toolUseId || !r.agentId || !r.boxId || !r.workId) continue;
      if (!this.allowed({ taskId, agentId: r.agentId, boxId: r.boxId }, access)) continue;
      const key = JSON.stringify([r.agentId, r.conversation, r.id, r.executionId, r.toolUseId]);
      const pair = grouped.get(key) ?? {};
      if (r.phase === "start" && !pair.start) pair.start = r;
      if (r.phase === "end") pair.end = r;
      grouped.set(key, pair);
    }
    const catalogs = new Map<string, ReturnType<typeof executionContent>>();
    const rows: FrozenStep[] = [];
    let partial = source.partial || (!begunHere && !grouped.size);
    for (const pair of grouped.values()) {
      const r = pair.start ?? pair.end!;
      const selected = selection.get(JSON.stringify([r.id, r.executionId, r.toolUseId])) ?? pair.end?.taskBinding ?? r.taskBinding;
      if (!selected || selected.taskId !== taskId) continue;
      const scopeKey = JSON.stringify([r.agentId, r.conversation]);
      let catalog = catalogs.get(scopeKey);
      if (!catalog) { catalog = executionContent(this.deps.registry, r); catalogs.set(scopeKey, catalog); }
      partial ||= catalog.partial;
      const content = contentFor(catalog.values, r);
      const known = content.result !== undefined;
      const reported = pair.end?.outcome;
      const coverage = content.call && pair.start && (!pair.end || known) ? "exact" : "partial";
      if (coverage === "partial") partial = true;
      const view: ExecutionStep = {
        id: Buffer.from(JSON.stringify([this.deps.namespace, r.id, r.executionId, r.toolUseId])).toString("base64url"),
        taskId, kind: "tool", turnId: r.id, executionId: r.executionId, attempt: r.attempt,
        toolUseId: r.toolUseId, workId: r.workId, agentId: r.agentId, boxId: r.boxId,
        conversation: r.conversation, contextEpoch: r.contextEpoch,
        role: selected.role, ...(selected.parent ? { parent: selected.parent } : {}),
        name: content.call?.name ?? r.tool, detail: (content.call?.detail ?? "").split("\n")[0]!.slice(0, 160),
        outcome: reported === "unknown" || reported === "waiting" || reported === "refused" ? reported : known ? (reported === "failed" || content.result!.isError ? "failed" : "succeeded") : pair.end || ended.has(r.executionId) ? "unknown" : "running",
        ...(pair.start ? { startedAt: pair.start.at } : {}), ...(pair.end ? { endedAt: pair.end.at } : {}),
        sourceRefs: [pair.start?.recordId, pair.end?.recordId, content.call?.hash, content.result?.hash].filter((v): v is string => !!v), coverage,
        ...(pair.end?.gate ? { gate: pair.end.gate } : {}),
      };
      if ((filters.workId && view.workId !== filters.workId) || (filters.role && view.role !== filters.role) || (filters.outcome && view.outcome !== filters.outcome)) continue;
      rows.push({ view, source: r, content: { call: content.call?.hash, result: content.result?.hash } });
    }
    for (const r of source.records) {
      if (r.event !== "maintenance" || r.taskBinding?.taskId !== taskId || !this.allowed({ taskId, agentId: r.agentId, boxId: r.boxId }, access)) continue;
      const outcome = r.kind === "compacted" && r.summarised === false ? "failed" : "succeeded";
      if ((filters.workId && r.workId !== filters.workId) || (filters.role && r.taskBinding.role !== filters.role) || (filters.outcome && outcome !== filters.outcome)) continue;
      rows.push({ source: r, content: {}, view: { id: r.recordId, taskId, kind: "maintenance", turnId: r.id, executionId: r.executionId,
        attempt: r.attempt, workId: r.workId, agentId: r.agentId, boxId: r.boxId, conversation: r.conversation,
        contextEpoch: r.contextEpoch, role: r.taskBinding.role, name: r.kind, detail: "", outcome,
        startedAt: r.at, endedAt: r.at, sourceRefs: [r.recordId], coverage: "exact" } });
    }
    // Stable insertion order from the source, with a source id tie-break rather than a claim of global execution order.
    rows.sort((a, b) => (a.view.startedAt ?? "").localeCompare(b.view.startedAt ?? "") || a.view.id.localeCompare(b.view.id));
    this.prune();
    const snapshot: Snapshot = { id: randomUUID(), taskId, filters: { ...filters },
      highWater: sourceDigest(rows.map(r => [r.view.id, r.view.sourceRefs])),
      rows, partial, createdAt: this.now() };
    this.snapshots.set(snapshot.id, snapshot);
    this.prune();
    if (!this.snapshots.has(snapshot.id)) throw new ExecutionReset("snapshot exceeds metadata capacity");
    return this.page(taskId, access, { snapshot: snapshot.id, limit: 100 });
  }

  page(taskId: string, access: ExecutionAccess, input: { snapshot: string; cursor?: string; limit?: number; filters?: ExecutionFilters }) {
    const snapshot = this.snapshot(taskId, input.snapshot, access);
    if (input.filters && ["workId", "role", "outcome"].some(k => input.filters![k as keyof ExecutionFilters] !== snapshot.filters[k as keyof ExecutionFilters])) throw new ExecutionReset("filters changed");
    const rows = snapshot.rows.filter(r => this.allowed(r.view, access));
    let offset = 0;
    if (input.cursor) {
      let cursor: { snapshot?: string; after?: string };
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw new ExecutionReset("invalid cursor"); }
      if (cursor.snapshot !== snapshot.id || !cursor.after) throw new ExecutionReset("cursor scope changed");
      const found = rows.findIndex(r => r.view.id === cursor.after);
      if (found < 0) throw new ExecutionReset("cursor item unavailable");
      offset = found + 1;
    }
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    if (!Number.isFinite(limit)) throw new ExecutionReset("invalid page limit");
    const page = rows.slice(offset, offset + limit);
    const last = page.at(-1);
    return { schema: 1, snapshot: snapshot.id, highWater: snapshot.highWater, taskId,
      scope: "authorized-retained-bindings" as const, historyCoverage: "explicit-bindings-only" as const, filters: snapshot.filters, coverage: snapshot.partial ? "partial" as const : "exact" as const,
      total: rows.length, steps: page.map(r => r.view),
      nextCursor: offset + page.length < rows.length && last ? Buffer.from(JSON.stringify({ snapshot: snapshot.id, after: last.view.id })).toString("base64url") : null };
  }

  detail(taskId: string, access: ExecutionAccess, input: { snapshot: string; step: string }): ExecutionDetail {
    const snapshot = this.snapshot(taskId, input.snapshot, access);
    const row = snapshot.rows.find(r => r.view.id === input.step);
    if (!row || !this.allowed(row.view, access)) throw new ExecutionReset("step unavailable");
    if (row.source.event === "maintenance") return { ...row.view, maintenance: {
      kind: row.source.kind, covers: row.source.covers, summarised: row.source.summarised,
      delayMs: row.source.delayMs, retryAttempt: row.source.retryAttempt } };
    const current = executionContent(this.deps.registry, row.source).values;
    const call = row.content.call ? current.get("hash:" + row.content.call)?.call : undefined;
    const result = row.content.result ? current.get("hash:" + row.content.result)?.result : undefined;
    const text = result?.text ?? "";
    const inputText = JSON.stringify(call?.input ?? null);
    return { ...row.view, input: inputText.length > 32000 ? { preview: inputText.slice(0, 32000) } : call?.input ?? null,
      inputTruncated: inputText.length > 32000, result: result ? text.slice(0, 32000) : null,
      resultTruncated: text.length > 32000, sourceExpired: (!!row.content.call && !call) || (!!row.content.result && !result),
      resultCoverage: result ? "stored" : row.content.result ? "expired" : "not-recorded-at-snapshot" };
  }

  private snapshot(taskId: string, id: string, access: ExecutionAccess): Snapshot {
    this.prune();
    const snapshot = this.snapshots.get(id);
    if (!snapshot || snapshot.taskId !== taskId || !access.task(taskId)) throw new ExecutionReset("snapshot expired or unavailable");
    return snapshot;
  }
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  private prune(): void {
    let total = [...this.snapshots.values()].reduce((n, s) => n + s.rows.length, 0);
    for (const [id, snapshot] of this.snapshots) {
      if (this.now() - snapshot.createdAt > 10 * 60_000 || this.snapshots.size > 8 || total > 50_000) {
        this.snapshots.delete(id); total -= snapshot.rows.length;
      }
    }
  }
}
