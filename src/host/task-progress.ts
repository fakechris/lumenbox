/** Business progress is a versioned producer report, never a task completion signal. */
import { createHash, randomUUID } from "node:crypto";
import type { Task } from "./tasks.ts";

export type ProgressRole = "executor" | "child" | "verifier";
export type ProgressSource = "agent-reported" | "job-observed" | "independent-verifier";
export interface ProgressScope { epoch: string; scopeVersion: string }
export interface ProgressAdmission extends ProgressScope {
  id: string; ordinal: number; rootWorkId: string;
  kind: "new" | "continuation" | "child" | "verifier";
}
export interface ProgressObject { id: string; state: "succeeded" | "failed" | "skipped" | "unknown"; version: string; artifactVersion?: string }
export interface ProgressCheck { sourceId: string; id: string; version: string }
export interface ProgressCounts { processed: number; succeeded: number; failed: number; skipped: number; unknown: number }
export interface ProgressSnapshot extends ProgressCounts {
  id: string; taskId: string; turnId: string; executionId: string; boxId?: string; workId: string; rootWorkId: string; scopeVersion: string;
  stage: string; unit: string; total: number | null; role: ProgressRole; sourceIdentity?: string; source: ProgressSource; agentId: string;
  sourceRef: string; observedAt: string; receivedAt: string; revision: number; sourceSequence: number;
  reportId: string; digest: string; basis: "objects" | "producer-counts";
  objects?: ProgressObject[]; checks?: ProgressCheck[];
}
export interface TaskProgressState extends ProgressScope {
  schema: 1; guard: string; epochAt: string; nextOrdinal: number; revision: number;
  active?: { workId: string; ordinal: number; admissionId: string };
  sources: Record<string, ProgressSnapshot>;
}
export interface ProgressSourceAccess { agent: (id: string) => boolean; box: (id: string) => boolean }
export const progressSourceAllowed = (source: ProgressSnapshot, access: ProgressSourceAccess): boolean => !!source.boxId && access.agent(source.agentId) && access.box(source.boxId);
export interface ProgressContext {
  id: string; taskId: string; admission: ProgressAdmission; agentId: string; conversation: string;
  turnId: string; executionId: string; boxId?: string; workId: string; role: ProgressRole; startedAt: string;
  /** Only a host-owned job producer may set this; tools and files cannot. */
  trustedJobId?: string; sourceIdentity?: string; access?: ProgressSourceAccess; closed?: boolean;
}
export const PROGRESS_BYTES_MAX = 262_144;
export const PROGRESS_SOURCES_MAX = 128;
export const progressHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function progressScopeVersion(task: Task): string {
  return progressHash([task.description || task.contract?.outcome || task.title, task.contract, task.pursuit?.objective, task.pursuit?.workId]);
}
function guard(task: Task): string {
  const verifying = task.pursuit?.verifying;
  return progressHash([progressScopeVersion(task), ["open", "doing"].includes(task.status) ? "executing" : task.status, task.assigneeId, task.conversation, task.pursuit?.status, verifying && [verifying.agentId, verifying.taskConversation, verifying.conversation, verifying.attempt, verifying.startedAt]]);
}
export function alignTaskProgress(task: Task, before?: TaskProgressState, now = new Date(), initialize = false): TaskProgressState | undefined {
  if (!before && !task.pursuit && !initialize) return undefined;
  const nextGuard = guard(task);
  if (before?.guard === nextGuard) return before;
  return { schema: 1, epoch: randomUUID(), scopeVersion: progressScopeVersion(task), guard: nextGuard, epochAt: now.toISOString(),
    nextOrdinal: before?.nextOrdinal ?? 0, revision: (before?.revision ?? 0) + 1,
    ...(before?.active && before.scopeVersion === progressScopeVersion(task) ? { active: before.active } : {}), sources: before?.sources ?? {} };
}
export const progressScope = (task: Task): ProgressScope | undefined => task.progress ? { epoch: task.progress.epoch, scopeVersion: task.progress.scopeVersion } : undefined;
const writable = (task: Task): boolean => task.proposedBy === undefined && ["open", "doing"].includes(task.status) && (!task.pursuit || task.pursuit.status === "active" || task.pursuit.status === "verifying");

/** The TaskStore remains the single durable home. Physical grants deliberately die with the host. */
export class TaskProgressReceiver {
  private readonly grants = new Map<string, ProgressContext>();
  private readonly contexts = new WeakSet<ProgressContext>();
  constructor(private readonly store: { get: (id: string) => Task | undefined; save: (task: Task) => void }) {}

  private state(taskId: string): { task: Task; state: TaskProgressState } {
    const task = this.store.get(taskId);
    if (!task) throw new Error("Unknown progress task");
    if (!task.progress) {
      const initial = alignTaskProgress(task, undefined, new Date(), true);
      // Ordinary tasks are initialized only when explicitly admitted, without changing their work.
      task.progress = initial!;
      this.store.save(task);
    }
    return { task, state: task.progress! };
  }

  /** Reserve an order before inbox admission. A crash leaves a harmless gap, never a new active work. */
  reserve(taskId: string, rootWorkId: string, kind: ProgressAdmission["kind"], captured?: ProgressScope): ProgressAdmission | undefined {
    const { task, state } = this.state(taskId);
    if ((task.pursuit && rootWorkId !== task.pursuit.workId) || !writable(task) || (captured && (captured.epoch !== state.epoch || captured.scopeVersion !== state.scopeVersion))) return undefined;
    const ordinal = state.nextOrdinal + 1;
    this.store.save({ ...task, progress: { ...state, nextOrdinal: ordinal } });
    return { epoch: state.epoch, scopeVersion: state.scopeVersion, id: randomUUID(), ordinal, rootWorkId, kind };
  }

  /** Call once with host admission identity; never reconstruct it from a report's task/work fields. */
  open(input: Omit<ProgressContext, "id" | "startedAt"> & { resuming?: boolean }): ProgressContext | undefined {
    const task = this.store.get(input.taskId), state = task?.progress, admission = input.admission;
    if (!input.boxId || !task || !state || (task.pursuit && admission.rootWorkId !== task.pursuit.workId) || !writable(task) || admission.epoch !== state.epoch || admission.scopeVersion !== state.scopeVersion || this.grants.size >= 256) return undefined;
    if ((input.role === "verifier") !== (task.pursuit?.status === "verifying")) return undefined;
    if (!input.resuming && admission.kind === "new") {
      if (state.active && (admission.ordinal < state.active.ordinal || (admission.ordinal === state.active.ordinal && admission.id !== state.active.admissionId))) return undefined;
      if (!state.active || state.active.admissionId !== admission.id) this.store.save({ ...task, progress: { ...state, active: { workId: admission.rootWorkId, ordinal: admission.ordinal, admissionId: admission.id } } });
    } else if (!state.active && task.pursuit?.workId === admission.rootWorkId && admission.kind !== "child" && !input.resuming) {
      this.store.save({ ...task, progress: { ...state, active: { workId: admission.rootWorkId, ordinal: admission.ordinal, admissionId: admission.id } } });
    } else if (state.active?.workId !== admission.rootWorkId) return undefined;
    const context: ProgressContext = { ...input, id: randomUUID(), startedAt: new Date().toISOString() };
    this.contexts.add(context); return context;
  }
  close(context: ProgressContext | undefined): void { if (context) { context.closed = true; this.grants.delete(context.id); this.contexts.delete(context); } }

  private current(context: ProgressContext): { task: Task; state: TaskProgressState } {
    const task = this.store.get(context.taskId), state = task?.progress;
    if (context.closed || !context.boxId || !this.access(context).agent(context.agentId) || !this.access(context).box(context.boxId) || !this.contexts.has(context) || !task || !state || !writable(task) || state.epoch !== context.admission.epoch || state.active?.workId !== context.admission.rootWorkId) throw new Error("Progress execution is no longer current");
    return { task, state };
  }
  valid(context: ProgressContext | undefined): boolean { try { if (!context) return false; this.current(context); return true; } catch { return false; } }
  private access(context: ProgressContext): ProgressSourceAccess {
    return context.access ?? { agent: id => id === context.agentId, box: id => !!context.boxId && id === context.boxId };
  }
  sourceId(context: ProgressContext, stage: string): string {
    const identity = context.trustedJobId ?? (context.role === "child" ? context.sourceIdentity : context.agentId);
    if (!identity) throw new Error("Progress child has no admitted fork identity");
    return progressHash([context.admission.rootWorkId, context.boxId, context.role, context.trustedJobId ? "job" : "agent", identity, stage]);
  }
  info(context: ProgressContext, stage = "processing") {
    const { state } = this.current(context), sourceId = this.sourceId(context, stage), previous = state.sources[sourceId];
    if (!this.grants.has(context.id) && this.grants.size >= 256) throw new Error("Too many open progress file grants");
    this.grants.set(context.id, context);
    return { taskId: context.taskId, workId: context.workId, rootWorkId: context.admission.rootWorkId, grantId: context.id,
      scopeVersion: state.scopeVersion, epoch: state.epoch, stage, sourceId,
      expectedRevision: previous?.revision ?? 0, sourceSequence: (previous?.sourceSequence ?? 0) + 1,
      notBefore: context.startedAt, progress: summarizeTaskProgress(this.store.get(context.taskId)!, 8, this.access(context)) };
  }
  sources(context: ProgressContext, cursor?: string) {
    const { task, state } = this.current(context);
    const after = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { revision: number; offset: number } : { revision: state.revision, offset: 0 };
    if (after.revision !== state.revision || !Number.isSafeInteger(after.offset) || after.offset < 0) throw new Error("Progress source cursor expired");
    const sources = summarizeTaskProgress(task, 128, this.access(context))?.sources ?? [];
    let end = after.offset, bytes = 0;
    while (end < sources.length && end < after.offset + 50) {
      const size = Buffer.byteLength(JSON.stringify(sources[end]), "utf8"); if (bytes + size > 12_000 && end > after.offset) break;
      bytes += size; end++;
    }
    return { sources: sources.slice(after.offset, end), revision: state.revision, nextCursor: end < sources.length ? Buffer.from(JSON.stringify({ ...after, offset: end })).toString("base64url") : null };
  }
  objects(context: ProgressContext, sourceId: string, cursor?: string) {
    const { state } = this.current(context), source = state.sources[sourceId];
    if (!source || !progressSourceAllowed(source, this.access(context)) || (context.role !== "verifier" && sourceId !== this.sourceId(context, source.stage))) throw new Error("Progress source unavailable");
    const after = cursor ? JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { sourceId: string; revision: number; offset: number } : { sourceId, revision: source.revision, offset: 0 };
    if (after.sourceId !== sourceId || after.revision !== source.revision || !Number.isSafeInteger(after.offset) || after.offset < 0) throw new Error("Progress object cursor expired");
    const rows = source.objects ?? [];
    let end = after.offset, bytes = 0;
    while (end < rows.length && end < after.offset + 100) {
      const size = Buffer.byteLength(JSON.stringify(rows[end]), "utf8"); if (bytes + size > 12_000 && end > after.offset) break;
      bytes += size; end++;
    }
    return { sourceId, revision: source.revision, digest: source.digest, objects: rows.slice(after.offset, end),
      nextCursor: end < rows.length ? Buffer.from(JSON.stringify({ ...after, offset: end })).toString("base64url") : null };
  }
  receive(context: ProgressContext, raw: unknown, sourceRef: string) {
    const { task, state } = this.current(context);
    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const prior = typeof value.stage === "string" ? state.sources[this.sourceId(context, value.stage)] : undefined;
    // Retrying the same tool arguments preserves the first host-stamped observation time.
    const input = parseProgressReport({ ...value, observedAt: value.observedAt ?? (prior?.reportId === value.reportId ? prior?.observedAt : new Date().toISOString()) });
    const id = this.sourceId(context, input.stage), previous = state.sources[id];
    if (!previous && Object.keys(state.sources).length >= PROGRESS_SOURCES_MAX) throw new Error("Progress source capacity reached; no sources were discarded");
    const digest = progressHash(input);
    if (previous?.reportId === input.reportId) {
      if (previous.digest !== digest) throw new Error("A progress report id cannot change content");
      return this.info(context, input.stage);
    }
    if (input.sourceSequence <= (previous?.sourceSequence ?? 0) || input.expectedRevision !== (previous?.revision ?? 0)) throw new Error("Stale progress sequence or revision");
    if (Date.parse(input.observedAt) < Date.parse(context.startedAt) || Date.parse(input.observedAt) > Date.now() + 30_000) throw new Error("Progress observation is outside this execution");
    const current = previous?.scopeVersion === state.scopeVersion && previous.rootWorkId === state.active?.workId ? previous : undefined;
    if (current && Date.parse(input.observedAt) < Date.parse(current.observedAt)) throw new Error("Progress observation went backwards");
    if (current && (current.unit !== input.unit || current.total !== input.total)) throw new Error("Progress range changed; report a separate, explicitly named stage");
    const objects = input.objects ? new Map((current?.objects ?? []).map(row => [row.id, row])) : undefined;
    if (current && (current.basis === "objects") !== !!objects) throw new Error("Progress counting basis cannot change within a stage");
    for (const object of input.objects ?? []) objects!.set(object.id, { ...object, version: progressHash([object.state, object.artifactVersion ?? object.version]) });
    const rows = objects ? [...objects.values()] : undefined;
    const counts = rows ? objectCounts(rows) : input.counts!;
    if (counts.processed < (current?.processed ?? 0) || (input.total !== null && counts.processed > input.total)) throw new Error("Progress processed count is inconsistent with its retained range");
    const source: ProgressSource = context.role === "verifier" ? "independent-verifier" : context.trustedJobId ? "job-observed" : "agent-reported";
    if (input.checks && source !== "independent-verifier") throw new Error("Only an admitted verifier can report independent coverage");
    if (input.checks?.some(check => !state.sources[check.sourceId] || state.sources[check.sourceId]!.source === "independent-verifier" || !progressSourceAllowed(state.sources[check.sourceId]!, this.access(context)))) throw new Error("Verification reference unavailable");
    const next: ProgressSnapshot = { ...counts, id, taskId: task.id, turnId: context.turnId, executionId: context.executionId, boxId: context.boxId, workId: context.workId, rootWorkId: context.admission.rootWorkId, scopeVersion: state.scopeVersion,
      stage: input.stage, unit: input.unit, total: input.total, role: context.role, sourceIdentity: context.sourceIdentity, source, agentId: context.agentId, sourceRef: sourceRef.slice(0, 500),
      observedAt: input.observedAt, receivedAt: new Date().toISOString(), revision: (previous?.revision ?? 0) + 1, sourceSequence: input.sourceSequence,
      reportId: input.reportId, digest, basis: rows ? "objects" : "producer-counts", ...(rows ? { objects: rows } : {}), ...(input.checks ? { checks: input.checks } : {}) };
    const updated = { ...state, revision: state.revision + 1, sources: { ...state.sources, [id]: next } };
    if (Buffer.byteLength(JSON.stringify(updated), "utf8") > PROGRESS_BYTES_MAX) throw new Error("Progress storage capacity reached; report rejected without losing retained objects");
    this.store.save({ ...task, progress: updated });
    return this.info(context, input.stage);
  }
  file(text: string, identity: { agentId: string; conversation: string; taskId?: string; boxId?: string }): boolean {
    if (Buffer.byteLength(text, "utf8") > PROGRESS_BYTES_MAX) return false;
    try {
      const raw = JSON.parse(text) as Record<string, unknown>, context = typeof raw.grantId === "string" ? this.grants.get(raw.grantId) : undefined;
      if (typeof raw.observedAt !== "string" || !context || context.agentId !== identity.agentId || context.conversation !== identity.conversation || (identity.boxId !== undefined && context.boxId !== identity.boxId) || (identity.taskId !== undefined && context.taskId !== identity.taskId) || raw.taskId !== context.taskId || raw.workId !== context.workId || raw.epoch !== context.admission.epoch || raw.scopeVersion !== context.admission.scopeVersion) return false;
      this.receive(context, raw, `progress.json:${context.turnId}:${context.executionId}`); return true;
    } catch { return false; }
  }
}

function string(raw: unknown, label: string, max = 128): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > max) throw new Error(`Invalid progress ${label}`);
  return raw;
}
function integer(raw: unknown): number { if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw new Error("Invalid progress count or revision"); return Number(raw); }
interface ProgressReport {
  stage: string; unit: string; total: number | null; expectedRevision: number; sourceSequence: number; reportId: string; observedAt: string;
  objects?: ProgressObject[]; counts?: ProgressCounts; checks?: ProgressCheck[];
}
export function parseProgressReport(raw: unknown): ProgressReport {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid progress report");
  const value = raw as Record<string, unknown>;
  const report: ProgressReport = { stage: string(value.stage, "stage", 80), unit: string(value.unit, "unit", 80), total: value.total === null ? null : integer(value.total),
    expectedRevision: integer(value.expectedRevision), sourceSequence: integer(value.sourceSequence), reportId: string(value.reportId, "report id"), observedAt: string(value.observedAt, "observed time") };
  if (!Number.isFinite(Date.parse(report.observedAt))) throw new Error("Invalid progress observed time");
  if (Array.isArray(value.objects)) {
    if (value.objects.length > 1000) throw new Error("Too many progress object updates");
    const seen = new Set<string>();
    report.objects = value.objects.map(raw => {
      if (!raw || typeof raw !== "object") throw new Error("Invalid progress object");
      const row = raw as Record<string, unknown>, id = string(row.id, "object id");
      if (seen.has(id) || !["succeeded", "failed", "skipped", "unknown"].includes(String(row.state))) throw new Error("Duplicate or invalid progress object");
      const artifactVersion = string(row.artifactVersion ?? row.version, "artifact version");
      seen.add(id); return { id, state: row.state as ProgressObject["state"], version: artifactVersion, artifactVersion };
    });
  } else {
    const counts = value.counts as Record<string, unknown> | undefined;
    if (!counts || typeof counts !== "object") throw new Error("Progress requires objects or explicit producer counts");
    report.counts = { processed: integer(counts.processed), succeeded: integer(counts.succeeded), failed: integer(counts.failed), skipped: integer(counts.skipped), unknown: integer(counts.unknown) };
    if (report.counts.processed !== report.counts.succeeded + report.counts.failed + report.counts.skipped + report.counts.unknown) throw new Error("Progress counts do not partition processed objects");
  }
  if (value.checks !== undefined) {
    if (!Array.isArray(value.checks) || value.checks.length > 1000) throw new Error("Invalid progress verification references");
    const seen = new Set<string>();
    report.checks = value.checks.map(raw => { const row = raw as Record<string, unknown>;
      const check = { sourceId: string(row?.sourceId, "checked source"), id: string(row?.id, "checked object"), version: string(row?.version, "checked version") };
      const key = JSON.stringify(check); if (seen.has(key)) throw new Error("Duplicate progress verification"); seen.add(key); return check;
    });
  }
  return report;
}
function objectCounts(rows: readonly ProgressObject[]): ProgressCounts {
  const result = { processed: rows.length, succeeded: 0, failed: 0, skipped: 0, unknown: 0 };
  for (const row of rows) result[row.state]++;
  return result;
}
export function summarizeTaskProgress(task: Task, limit = 128, access?: ProgressSourceAccess) {
  const state = task.progress;
  if (!state || !Object.keys(state.sources).length) return undefined;
  const allSources = Object.values(state.sources).filter(source => !access || progressSourceAllowed(source, access)).sort((a, b) => Number(a.source === "independent-verifier") - Number(b.source === "independent-verifier") || b.receivedAt.localeCompare(a.receivedAt));
  const visible = new Set(allSources.map(source => source.id));
  if (!allSources.length) return undefined;
  const objectVersions = new Map(allSources.map(source => [source.id, new Map((source.objects ?? []).map(row => [row.id, row.version]))]));
  return { omittedSources: Math.max(0, allSources.length - limit), schema: 1, revision: state.revision, scopeVersion: state.scopeVersion, accepting: writable(task),
    sources: allSources.slice(0, limit).map(source => {
      const stale = source.scopeVersion !== state.scopeVersion || source.rootWorkId !== state.active?.workId;
      const checks = (source.checks ?? []).filter(check => !access || visible.has(check.sourceId));
      const matched = new Set(checks.filter(check => {
        const target = state.sources[check.sourceId];
        return !stale && target?.source !== "independent-verifier" && target?.scopeVersion === state.scopeVersion && target.rootWorkId === state.active?.workId && objectVersions.get(target.id)?.get(check.id) === check.version;
      }).map(check => `${check.sourceId}:${check.id}`)).size;
      return { id: source.id, taskId: source.taskId, turnId: source.turnId, executionId: source.executionId, boxId: source.boxId, workId: source.workId, rootWorkId: source.rootWorkId, scopeVersion: source.scopeVersion, stage: source.stage, unit: source.unit,
        processed: source.processed, succeeded: source.succeeded, failed: source.failed, skipped: source.skipped, unknown: source.unknown, total: source.total,
        role: source.role, sourceIdentity: source.sourceIdentity, source: source.source, agentId: source.agentId, sourceRef: source.sourceRef, observedAt: source.observedAt, receivedAt: source.receivedAt, revision: source.revision, basis: source.basis, stale,
        ...(source.source === "independent-verifier" ? { verified: matched, verificationUnmatched: checks.length - matched } : {}) };
    }) };
}
export type TaskProgressSummary = ReturnType<typeof summarizeTaskProgress>;
