/**
 * The organisation's knowledge, from the page (INV-1729, docs/98 §5): an Admin promotes a memory,
 * a finished task or a receipt, and reviews what waits. Admin only.
 *
 * Promoting here makes a proposal like an agent's Promote does — the Admin's own promotion waits
 * too, owned by that Admin — and each waiting item names its scope and who will read it once
 * approved, so nobody approves an installation-wide line without being told it is one. There is
 * no setting: organisation review is always on (org-promotion.ts).
 */

import type { AgentRegistry } from "../agents/registry.ts";
import type { BoxEntry } from "../box/boxes.ts";
import type { ErrorCode } from "../i18n/server-errors.ts";
import { dedupe } from "../host/memory.ts";
import { versionOf } from "../host/memory-admin.ts";
import type { OrgKnowledge } from "../host/org-knowledge.ts";
import { decide, pendingPromotions, type PromotionRefusal, type PromotionSource, propose, readersOf } from "../host/org-promotion.ts";
import { type Receipt, receiptId } from "../host/receipts.ts";
import type { Task } from "../host/tasks.ts";
import { apiError } from "./api-error.ts";

const REFUSAL: Record<PromotionRefusal, ErrorCode> = {
  "no-owner": "org-no-owner",
  "not-finished": "org-not-finished",
  "no-evidence": "org-no-evidence",
  invalid: "org-invalid",
  duplicate: "org-duplicate",
  personal: "org-personal",
  "not-pending": "org-not-pending",
  "no-readers": "org-no-readers",
};

export interface OrgKnowledgeRouteDeps {
  ledger: Pick<OrgKnowledge, "append" | "lines">;
  registry: Pick<AgentRegistry, "readMemoryRecords" | "readSharedMemory" | "tryGet" | "boxById" | "boxOf">;
  tasks: () => { get(id: string): Task | undefined } | undefined;
  receipts: { byId(id: string): Receipt | undefined; forSubject(subject: string): Receipt[] };
  readJson: () => Promise<Record<string, unknown>>;
  params: URLSearchParams;
  refusedAdmin: () => boolean;
  /** The signed-in person's principal id, or the operator's key: the owner of an Admin's promotion and the approver. */
  by: () => string;
  nameOf: (principalId: string) => string;
  log: (line: string) => void;
}

export async function orgKnowledgeRoute(route: string, deps: OrgKnowledgeRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (!route.startsWith("GET /api/org-knowledge/") && !route.startsWith("POST /api/org-knowledge/")) return undefined;
  if (deps.refusedAdmin()) return { status: 0, body: null };
  const boxById = (id: string): Pick<BoxEntry, "id" | "name" | "members"> | undefined => deps.registry.boxById(id);
  const agentName = (agentId: string) => deps.registry.tryGet(agentId)?.profile.name ?? agentId;
  const view = () => ({
    pending: pendingPromotions(deps.ledger.lines()).map(({ version, item }) => {
      const readers = readersOf(item.scope, boxById);
      return {
        version,
        text: item.text,
        at: item.at,
        scope: item.scope,
        readers: readers.kind === "box" ? { ...readers, members: readers.members === "everyone" ? "everyone" : readers.members.map(deps.nameOf) } : readers,
        owner: item.owner,
        ownerName: item.owner === undefined ? "" : deps.nameOf(item.owner),
        proposedBy: item.via === undefined ? "" : agentName(item.via),
        source: item.source ?? "",
        evidence: item.evidence ?? [],
      };
    }),
  });
  if (route === "GET /api/org-knowledge/review") return { status: 200, body: view() };
  if (route === "GET /api/org-knowledge/receipts") {
    const task = deps.params.get("task") ?? "";
    return { status: 200, body: { receipts: deps.receipts.forSubject(`task:${task}`).map(receipt => ({ id: receiptId(receipt), at: receipt.at, by: receipt.byName ?? receipt.by, decision: receipt.decision, because: receipt.because ?? "" })) } };
  }
  const body = await deps.readJson();
  if (route === "POST /api/org-knowledge/review/decide") {
    const decision = body.decision === "approved" || body.decision === "rejected" ? body.decision : undefined;
    if (decision === undefined) return { status: 400, body: apiError("memory-review-decision") };
    const result = decide(deps.ledger, String(body.version ?? ""), decision, deps.by(), boxById, { pinned: body.pinned === true });
    if (!result.ok) return { status: 409, body: { ...apiError(REFUSAL[result.code], { why: result.why }), ...view() } };
    deps.log(`organisation knowledge: ${deps.by()} ${decision} ${String(body.version)}`);
    return { status: 200, body: view() };
  }
  if (route === "POST /api/org-knowledge/promote") {
    const source = sourceOf(deps, body);
    if (source === undefined) return { status: 400, body: apiError("org-promote-source") };
    if (typeof source === "string") return { status: 404, body: apiError("org-promote-source-unknown", { source }) };
    // "box" is the box named, or the one the thing came from: the memory's agent's, the task's assignee's.
    const near = typeof body.agent === "string" ? body.agent : deps.tasks()?.get(String(body.task ?? ""))?.assigneeId;
    const boxId = typeof body.box === "string" && body.box !== "" ? body.box : near !== undefined && deps.registry.tryGet(near) !== undefined ? deps.registry.boxOf(near).id : undefined;
    const scope = body.scope === "org" ? "org" : body.scope === "box" && boxId !== undefined && boxById(boxId) !== undefined ? (`box:${boxId}` as const) : undefined;
    if (scope === undefined) return { status: 400, body: apiError("org-promote-scope") };
    const text = typeof body.text === "string" && body.text.trim() !== "" ? body.text : undefined;
    const result = propose(deps.ledger, { source, ...(text !== undefined ? { text } : {}), scope, owner: deps.by() });
    if (!result.ok) return { status: 409, body: apiError(REFUSAL[result.code], { why: result.why }) };
    deps.log(`organisation knowledge: ${deps.by()} proposed ${result.version} for ${scope}`);
    return { status: 200, body: view() };
  }
  return { status: 404, body: apiError("route-unknown", { route }) };
}

/** The thing promoted, found where it lives; a string names what was asked for and is not there. */
function sourceOf(deps: OrgKnowledgeRouteDeps, body: Record<string, unknown>): PromotionSource | string | undefined {
  if (typeof body.receipt === "string" && body.receipt !== "") {
    const receipt = deps.receipts.byId(body.receipt);
    return receipt === undefined ? `receipt:${body.receipt}` : { kind: "receipt", receipt };
  }
  if (typeof body.task === "string" && body.task !== "") {
    const task = deps.tasks()?.get(body.task);
    return task === undefined ? `task:${body.task}` : { kind: "task", task };
  }
  if (typeof body.agent === "string" && typeof body.version === "string" && (body.tier === "own" || body.tier === "shared")) {
    const agentId = body.agent;
    if (deps.registry.tryGet(agentId) === undefined) return `memory:${agentId}/${body.version}`;
    const records = body.tier === "own" ? deps.registry.readMemoryRecords(agentId) : deps.registry.readSharedMemory().filter(record => record.via === agentId);
    const record = dedupe(records).find(candidate => versionOf(candidate) === body.version);
    return record === undefined ? `memory:${agentId}/${body.version}` : { kind: "memory", record, holder: agentId };
  }
  return undefined;
}
