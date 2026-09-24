/**
 * Memory as a person sees and corrects it (INV-426): what each agent in each box has
 * kept, whether a line is live or withdrawn, and two acts — withdraw, and edit — that are
 * appends with a version check, an audit line, and the same retraction semantics the
 * agents use, so a correction made here is what the next turn recalls and what the
 * mirror in the box shows, and never resurrects.
 *
 * Versions, not locks: a record's version is a digest of what it says and when it was
 * kept. An edit or a withdrawal names the version it saw; if the live line with that key
 * has moved on, the request is refused with the current line, and the person decides
 * again. Last-write-wins was the alternative, and it is how two people silently undo
 * each other.
 *
 * Nothing here is a second store. The registry's append-only files are the truth; this
 * reads them the way the prompt does (`dedupe` order, retractions withdrawing what came
 * before) and writes to them the way `RememberFact` does.
 */

import { createHash } from "node:crypto";
import { appendLine } from "./jsonl.ts";
import type { AgentRecord, AgentRegistry } from "../agents/registry.ts";
import { dedupeKey, recordHasRevokedSource, revokedMemorySources, type MemoryRecord } from "./memory.ts";

export interface MemoryView {
  /** The dedupe key: what a retraction or a re-record is matched on. */
  key: string;
  /** Digest of (at, kind, text): what an edit or withdrawal must name. */
  version: string;
  at: string;
  kind: MemoryRecord["kind"];
  text: string;
  source?: string;
  via?: string;
  box?: string;
  audience?: "everyone";
  from?: string[];
  status: "live" | "retracted";
  /** For a retracted line: when, and by what. */
  retractedAt?: string;
  retractedBy?: string;
}

export interface MemorySummary {
  agentId: string;
  agentName: string;
  boxId: string;
  live: number;
  byKind: Record<string, number>;
  retracted: number;
  lastAt?: string;
}

export function versionOf(record: Pick<MemoryRecord, "at" | "kind" | "text"> & Pick<Partial<MemoryRecord>, "from">): string {
  return createHash("sha256").update(JSON.stringify([record.at, record.kind, record.text, record.from ?? null])).digest("hex").slice(0, 12);
}

/**
 * The file's records as a person should see them: every line, in order, with the ones a
 * later retraction withdrew marked rather than hidden — a withdrawn line is a fact about
 * the past too. The same rules as `dedupe`: a retraction withdraws what came before it
 * with the same key, and a fact recorded again after it is live again.
 */
export function memoryView(records: readonly MemoryRecord[]): MemoryView[] {
  const views: MemoryView[] = [];
  const liveByKey = new Map<string, MemoryView>();
  const revoked = revokedMemorySources(records);
  const revokedAt = new Map<string, MemoryRecord>();
  for (const record of records) for (const source of record.revokedSources ?? []) revokedAt.set(source, record);
  for (const record of records) {
    if (record.revokedSources !== undefined) continue;
    const key = dedupeKey(record.text);
    if (key === "") continue;
    if (record.kind === "retraction") {
      const target = liveByKey.get(key);
      if (target !== undefined) {
        target.status = "retracted";
        target.retractedAt = record.at;
        if (record.source !== undefined) target.retractedBy = record.source;
        liveByKey.delete(key);
      }
      continue;
    }
    const view: MemoryView = {
      key,
      version: versionOf(record),
      at: record.at,
      kind: record.kind,
      text: record.text,
      ...(record.source !== undefined ? { source: record.source } : {}),
      ...(record.via !== undefined ? { via: record.via } : {}),
      ...(record.box !== undefined ? { box: record.box } : {}),
      ...(record.audience !== undefined ? { audience: record.audience } : {}),
      ...(record.from !== undefined ? { from: [...record.from] } : {}),
      status: recordHasRevokedSource(record, revoked) ? "retracted" : "live",
    };
    if (view.status === "retracted") {
      const tombstone = record.from?.map(source => revokedAt.get(source)).find(Boolean);
      view.retractedAt = tombstone?.at;
      view.retractedBy = tombstone?.source ?? "source withdrawn";
      views.push(view);
      continue;
    }
    const earlier = liveByKey.get(key);
    if (earlier !== undefined) {
      // A fact is never displaced by a note repeating it; anything else, the later wins,
      // exactly as dedupe decides what the prompt shows.
      if (earlier.kind === "fact" && record.kind === "note") {
        view.status = "retracted";
        view.retractedBy = "superseded by an earlier fact";
        views.push(view);
        continue;
      }
      earlier.status = "retracted";
      earlier.retractedAt = record.at;
      earlier.retractedBy = "recorded again";
    }
    liveByKey.set(key, view);
    views.push(view);
  }
  return views;
}

export function summarise(agent: Pick<AgentRecord, "id" | "profile">, boxId: string, records: readonly MemoryRecord[]): MemorySummary {
  const views = memoryView(records);
  const byKind: Record<string, number> = {};
  let lastAt: string | undefined;
  for (const view of views) {
    if (view.status !== "live") continue;
    byKind[view.kind] = (byKind[view.kind] ?? 0) + 1;
    if (lastAt === undefined || view.at > lastAt) lastAt = view.at;
  }
  return {
    agentId: agent.id,
    agentName: agent.profile.name,
    boxId,
    live: views.filter(view => view.status === "live").length,
    byKind,
    retracted: views.filter(view => view.status === "retracted").length,
    ...(lastAt !== undefined ? { lastAt } : {}),
  };
}

export type Scope = "own" | "shared";

export interface ChangeRequest {
  agentId: string;
  scope: Scope;
  key: string;
  /** The version the person saw. */
  version: string;
  /** For an edit: the new text. Absent means withdraw. */
  text?: string;
  /** Who did it, for the audit line. */
  by: string;
}

export interface SourceImpact {
  source: string;
  version: string;
  own: MemoryView[];
  shared: MemoryView[];
}

export type ChangeResult =
  | { ok: true; version?: string }
  | { ok: false; conflict: true; current: MemoryView | undefined; why: string }
  | { ok: false; conflict: false; why: string };

export class MemoryAdmin {
  constructor(
    private readonly registry: Pick<AgentRegistry, "readMemoryRecords" | "readSharedMemory" | "appendMemoryRecords" | "appendSharedMemory" | "tryGet" | "boxOf">,
    private readonly auditPath: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** One line per agent the caller may see, in the caller's own filtering. */
  summary(agents: readonly AgentRecord[]): MemorySummary[] {
    return agents.map(agent => summarise(agent, this.registry.boxOf(agent.id).id, this.registry.readMemoryRecords(agent.id)));
  }

  detail(agentId: string): { own: MemoryView[]; shared: MemoryView[] } {
    return {
      own: memoryView(this.registry.readMemoryRecords(agentId)),
      shared: memoryView(this.registry.readSharedMemory(agentId)),
    };
  }

  /** Preview the exact live derivatives a source withdrawal would disable. */
  sourceImpact(agentId: string, source: string): SourceImpact {
    const matching = (records: readonly MemoryRecord[]) => memoryView(records)
      .filter(view => view.status === "live" && view.from?.includes(source));
    const own = matching(this.registry.readMemoryRecords(agentId));
    const shared = matching(this.registry.readSharedMemory(agentId));
    const version = createHash("sha256")
      .update(JSON.stringify([source, ...[...own, ...shared].map(view => view.version).sort()]))
      .digest("hex").slice(0, 12);
    return { source, version, own, shared };
  }

  /** Withdraw every derivative of one source with the preview's optimistic version. */
  withdrawSource(request: { agentId: string; source: string; version: string; by: string }): ChangeResult {
    if (this.registry.tryGet(request.agentId) === undefined) return { ok: false, conflict: false, why: `no agent ${request.agentId}` };
    if (request.source.trim() === "" || request.source.length > 300) return { ok: false, conflict: false, why: "a valid source id is required" };
    const current = this.sourceImpact(request.agentId, request.source);
    if (current.version !== request.version) {
      return { ok: false, conflict: true, current: undefined, why: "the source impact changed since you previewed it; preview again" };
    }
    if (current.own.length + current.shared.length === 0) {
      return { ok: false, conflict: true, current: undefined, why: "that source has no live derived memory" };
    }
    const at = this.now().toISOString();
    const tombstone = (audience?: "everyone"): MemoryRecord => ({
      at,
      kind: "retraction",
      text: `derived memory from ${request.source}`.slice(0, 500),
      source: `web:${request.by}`,
      revokedSources: [request.source],
      ...(audience !== undefined ? { audience } : {}),
    });
    // Tombstone both tiers even when only one has a derivative today. Otherwise a
    // delayed extractor could publish the same withdrawn source into the other tier.
    this.registry.appendMemoryRecords(request.agentId, [tombstone()]);
    this.registry.appendSharedMemory(request.agentId, [tombstone(current.shared.some(view => view.audience === "everyone") ? "everyone" : undefined)]);
    this.audit({
      at, by: request.by, agentId: request.agentId, scope: "source", action: "withdraw-source",
      source: request.source, fromVersion: request.version,
      affected: { own: current.own.map(view => view.version), shared: current.shared.map(view => view.version) },
    });
    return { ok: true };
  }

  /** Withdraws or edits one live line, if the version the person saw is still the live one. */
  change(request: ChangeRequest): ChangeResult {
    const agent = this.registry.tryGet(request.agentId);
    if (agent === undefined) return { ok: false, conflict: false, why: `no agent ${request.agentId}` };
    const views = request.scope === "own" ? memoryView(this.registry.readMemoryRecords(request.agentId)) : memoryView(this.registry.readSharedMemory(request.agentId));
    const current = views.find(view => view.key === request.key && view.status === "live");
    if (current === undefined) {
      return { ok: false, conflict: true, current: undefined, why: "that line is no longer live: withdrawn or edited by someone else since you saw it" };
    }
    if (current.version !== request.version) {
      return { ok: false, conflict: true, current, why: "that line changed since you saw it; here is what it says now" };
    }
    const at = this.now().toISOString();
    const retraction: MemoryRecord = { at, kind: "retraction", text: current.text, source: `web:${request.by}` };
    const replacement: MemoryRecord | undefined =
      request.text !== undefined && request.text.trim() !== ""
        ? { at: new Date(this.now().getTime() + 1).toISOString(), kind: current.kind === "note" ? "fact" : current.kind, text: request.text.trim(), source: `web:${request.by}`, ...(current.from !== undefined ? { from: [...current.from] } : {}) }
        : undefined;
    const records = replacement === undefined ? [retraction] : [retraction, replacement];
    if (request.scope === "own") this.registry.appendMemoryRecords(request.agentId, records);
    else this.registry.appendSharedMemory(request.agentId, records);
    this.audit({
      at,
      by: request.by,
      agentId: request.agentId,
      scope: request.scope,
      action: replacement === undefined ? "withdraw" : "edit",
      key: request.key,
      fromVersion: current.version,
      before: current.text,
      ...(replacement !== undefined ? { toVersion: versionOf(replacement), after: replacement.text } : {}),
    });
    return { ok: true, ...(replacement !== undefined ? { version: versionOf(replacement) } : {}) };
  }

  private audit(entry: Record<string, unknown>): void {
    try {
      appendLine(this.auditPath, JSON.stringify(entry));
    } catch {
      // The change is made; an unwritable audit log is logged by the caller's own failure
      // to read it later, and must not undo a correction a person just made.
    }
  }
}
