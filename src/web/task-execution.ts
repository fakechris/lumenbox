/** Frozen, authorized read projections over the existing records (INV-1785). */
import { executionReadBudget } from "../agents/transcript-bounded.ts";
import { resolveExecutionDetail, type FrozenStep } from "./execution-detail.ts";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import type { TurnLedger } from "../host/resume.ts";
import type { ExecutionStepRecord } from "../host/execution-records.ts";
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

  /** Whole-turn costs only when every retained scope of that logical turn is attributable and readable. */
  costScope(taskId: string, access: ExecutionAccess) {
    if (!access.task(taskId)) throw new ExecutionReset("task unavailable");
    const source = this.deps.turns.executionRecords();
    const observations = source.records.flatMap(record => record.event === "begin" || record.event === "step" || record.event === "maintenance" ? [record] : []);
    const turns = new Map<string, Set<string>>();
    let partial = source.partial;
    for (const record of observations) {
      if (record.taskBinding?.taskId !== taskId) continue;
      if (!record.boxId || !this.allowed({ taskId, agentId: record.agentId, boxId: record.boxId }, access)) { partial = true; continue; }
      const agents = turns.get(record.id) ?? new Set(); agents.add(record.agentId); turns.set(record.id, agents);
    }
    for (const record of observations) {
      if (!turns.has(record.id)) continue;
      if (record.taskBinding?.taskId !== taskId || !record.boxId || !access.agent(record.agentId) || !access.box(record.boxId)) { turns.delete(record.id); partial = true; }
    }
    return { turns, partial, scope: "explicit-retained-unshared-turns" as const };
  }

  /** Join live approvals only through their recorded call binding, never the currently doing task. */
  approvals<T extends { id: string; agentId: string; description: string }>(taskId: string, access: ExecutionAccess, pending: readonly T[]) {
    if (!pending.length || !access.task(taskId)) return [];
    const ids = new Map(pending.map(item => [item.id, item]));
    const matched = new Set<string>();
    for (const record of this.deps.turns.executionRecords().records) {
      if (record.event !== "step" || !record.agentId || !record.boxId || record.taskBinding?.taskId !== taskId || !this.allowed({ taskId, agentId: record.agentId, boxId: record.boxId }, access)) continue;
      const id = record.gate?.approvalId, item = id ? ids.get(id) : undefined;
      if (item && item.agentId === record.agentId) matched.add(item.id);
    }
    return pending.filter(item => matched.has(item.id)).map(item => ({ id: item.id, description: item.description }));
  }

  /** Snapshot rows are immutable metadata and source hashes, never copies of all result bodies. */
  open(taskId: string, access: ExecutionAccess, filters: ExecutionFilters = {}, anchor?: string) {
    if (!access.task(taskId)) throw new ExecutionReset("task unavailable");
    const source = this.deps.turns.executionRecords();
    const grouped = new Map<string, { start?: ExecutionStepRecord; end?: ExecutionStepRecord }>();
    const ended = new Set<string>(), active = new Map<string, string>();
    for (const r of source.records) {
      // Recovery can observe a replay before the full prompt/config begin is written.
      // Its durable start still supersedes the preceding physical invocation.
      if ((r.event === "begin" || r.event === "step" || r.event === "maintenance" || r.event === "selection") && r.executionId) {
        const previous = active.get(r.id);
        if (previous && previous !== r.executionId) ended.add(previous);
        active.set(r.id, r.executionId);
      }
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
    const catalogs = new Map<string, ReturnType<typeof executionContent>>(), budget = executionReadBudget();
    const rows: FrozenStep[] = [];
    let partial = source.partial || (!begunHere && !grouped.size);
    for (const pair of grouped.values()) {
      const r = pair.start ?? pair.end!;
      const selected = selection.get(JSON.stringify([r.id, r.executionId, r.toolUseId])) ?? pair.end?.taskBinding ?? r.taskBinding;
      if (!selected || selected.taskId !== taskId) continue;
      const scopeKey = JSON.stringify([r.agentId, r.conversation]);
      let catalog = catalogs.get(scopeKey);
      if (!catalog) { catalog = executionContent(this.deps.registry, r, budget); catalogs.set(scopeKey, catalog); }
      partial ||= catalog.partial;
      const content = contentFor(catalog.values, r);
      const known = content.result !== undefined;
      const reported = pair.end?.outcome;
      const coverage = content.call && pair.start && (pair.end ? known : !known && !ended.has(r.executionId)) ? "exact" : "partial";
      if (coverage === "partial") partial = true;
      const view: ExecutionStep = {
        id: Buffer.from(JSON.stringify([this.deps.namespace, r.id, r.executionId, r.toolUseId])).toString("base64url"),
        taskId, kind: "tool", turnId: r.id, executionId: r.executionId, attempt: r.attempt,
        toolUseId: r.toolUseId, workId: r.workId, agentId: r.agentId, boxId: r.boxId,
        conversation: r.conversation, contextEpoch: r.contextEpoch,
        role: selected.role, ...(selected.parent ? { parent: selected.parent } : {}),
        name: content.call?.name ?? r.tool, detail: (content.call?.detail ?? "").split("\n")[0]!.slice(0, 160),
        outcome: reported === "unknown" || reported === "waiting" || reported === "refused" ? reported : known ? (!pair.end ? "unknown" : reported === "failed" || content.result!.isError ? "failed" : "succeeded") : pair.end || ended.has(r.executionId) ? "unknown" : "running",
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
      highWater: sourceDigest([partial, rows.map(r => r.view)]),
      rows, partial, createdAt: this.now() };
    this.snapshots.set(snapshot.id, snapshot);
    this.prune();
    if (!this.snapshots.has(snapshot.id)) throw new ExecutionReset("snapshot exceeds metadata capacity");
    return this.page(taskId, access, { snapshot: snapshot.id, limit: 100, ...(anchor ? { anchor } : {}) });
  }

  page(taskId: string, access: ExecutionAccess, input: { snapshot: string; cursor?: string; anchor?: string; limit?: number; filters?: ExecutionFilters }) {
    const snapshot = this.snapshot(taskId, input.snapshot, access);
    if (input.filters && ["workId", "role", "outcome"].some(k => input.filters![k as keyof ExecutionFilters] !== snapshot.filters[k as keyof ExecutionFilters])) throw new ExecutionReset("filters changed");
    const rows = snapshot.rows.filter(r => this.allowed(r.view, access));
    const limit = Math.min(200, Math.max(1, Math.trunc(input.limit ?? 100)));
    if (!Number.isFinite(limit)) throw new ExecutionReset("invalid page limit");
    let offset = 0;
    if (input.anchor) {
      if (input.cursor) throw new ExecutionReset("conflicting page position");
      offset = rows.findIndex(row => row.view.id === input.anchor);
      if (offset < 0) throw new ExecutionReset("anchor unavailable");
    }
    if (input.cursor) {
      let cursor: { snapshot?: string; after?: string; before?: string };
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); } catch { throw new ExecutionReset("invalid cursor"); }
      if (cursor.snapshot !== snapshot.id || (!cursor.after && !cursor.before) || (cursor.after && cursor.before)) throw new ExecutionReset("cursor scope changed");
      const found = rows.findIndex(r => r.view.id === (cursor.after ?? cursor.before));
      if (found < 0) throw new ExecutionReset("cursor item unavailable");
      offset = cursor.before ? Math.max(0, found - limit) : found + 1;
    }
    const page = rows.slice(offset, offset + limit);
    const last = page.at(-1);
    return { schema: 1, snapshot: snapshot.id, highWater: snapshot.highWater, taskId,
      scope: "authorized-retained-bindings" as const, historyCoverage: "explicit-bindings-only" as const, filters: snapshot.filters, coverage: snapshot.partial ? "partial" as const : "exact" as const,
      total: rows.length, steps: page.map(r => r.view),
      from: offset + (page.length ? 1 : 0), to: offset + page.length,
      activity: { latest: rows.at(-1)?.view ?? null, current: rows.findLast(row => row.view.outcome === "running")?.view ?? null,
        groups: [...new Map(rows.map(row => [JSON.stringify([row.view.workId, row.view.role, row.view.conversation, row.view.executionId]), { workId: row.view.workId, role: row.view.role, conversation: row.view.conversation, attempt: row.view.attempt }])).values()].slice(0, 200) },
      previousCursor: offset > 0 && page[0] ? Buffer.from(JSON.stringify({ snapshot: snapshot.id, before: page[0].view.id })).toString("base64url") : null,
      nextCursor: offset + page.length < rows.length && last ? Buffer.from(JSON.stringify({ snapshot: snapshot.id, after: last.view.id })).toString("base64url") : null };
  }

  detail(taskId: string, access: ExecutionAccess, input: { snapshot: string; step: string }): ExecutionDetail {
    const snapshot = this.snapshot(taskId, input.snapshot, access);
    const row = snapshot.rows.find(r => r.view.id === input.step);
    if (!row || !this.allowed(row.view, access)) throw new ExecutionReset("step unavailable");
    return resolveExecutionDetail(row, executionContent(this.deps.registry, row.source, executionReadBudget()).values);
  }

  /** Private export handle: immutable row metadata/hashes, never a client-supplied source path. */
  captureExport(taskId: string, access: ExecutionAccess, filters: ExecutionFilters = {}) {
    const page = this.open(taskId, access, filters), snapshot = this.snapshot(taskId, page.snapshot, access);
    const rows = snapshot.rows.filter(row => this.allowed(row.view, access));
    if (new Set(rows.map(row => JSON.stringify([row.view.agentId, row.view.conversation]))).size > 16) throw new ExecutionReset("export source capacity");
    return { taskId, snapshot: snapshot.id, highWater: snapshot.highWater, filters: snapshot.filters,
      coverage: snapshot.partial ? "partial" as const : "exact" as const, rows, availableHashes: new Set<string>() };
  }

  /** One catalog per conversation, with bounded reads; never detail() once per row. */
  async visitExport(capture: ExecutionExport, access: () => ExecutionAccess, visit: (row: ExecutionDetail) => void, signal?: AbortSignal) {
    const catalogs = new Map<string, ReturnType<typeof executionContent>>(), budget = executionReadBudget();
    let current = access();
    for (let index = 0; index < capture.rows.length; index++) {
      if (index % 64 === 0) { await yieldTurn(); signal?.throwIfAborted(); current = access(); }
      const row = capture.rows[index]!;
      if (!this.allowed(row.view, current)) throw new ExecutionReset("export unavailable");
      const key = JSON.stringify([row.view.agentId, row.view.conversation]);
      let catalog = catalogs.get(key);
      if (!catalog) { catalog = executionContent(this.deps.registry, row.source, budget); catalogs.set(key, catalog); }
      for (const hash of [row.content.call, row.content.result]) if (hash && catalog.values.has("hash:" + hash)) capture.availableHashes.add(hash);
      visit(resolveExecutionDetail(row, catalog.values, Infinity));
    }
  }

  validateExport(capture: ExecutionExport, access: ExecutionAccess): boolean {
    if (!access.task(capture.taskId)) return false;
    const catalogs = new Map<string, ReturnType<typeof executionContent>>(), budget = executionReadBudget();
    for (const row of capture.rows) {
      if (!this.allowed(row.view, access)) return false;
      const required = [row.content.call, row.content.result].filter((hash): hash is string => !!hash && capture.availableHashes.has(hash));
      if (!required.length) continue;
      const key = JSON.stringify([row.view.agentId, row.view.conversation]);
      let catalog = catalogs.get(key);
      if (!catalog) { catalog = executionContent(this.deps.registry, row.source, budget); catalogs.set(key, catalog); }
      if (required.some(hash => !catalog.values.has("hash:" + hash))) return false;
    }
    return true;
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

export type ExecutionExport = ReturnType<TaskExecutions["captureExport"]>;
