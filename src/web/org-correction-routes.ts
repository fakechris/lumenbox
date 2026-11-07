/**
 * Settings → Memory → the organisation's knowledge (INV-1730, docs/98 §7): what a person may read of
 * it, with each item's state and its supersession chain, and the correction verbs.
 *
 * Read by a driver or above, filtered by scope the way an agent's read is (`viewFor`); an Admin
 * reads all of it. Anyone who reads an item may mark it unverified; its owner or an Admin may
 * retract or supersede it. The verbs and their rules are org-knowledge.ts's — this is the door.
 */

import type { CorrectionResult, OrgItemView, OrgKnowledge } from "../host/org-knowledge.ts";
import { apiError } from "./api-error.ts";

export interface OrgCorrectionRouteDeps {
  ledger: Pick<OrgKnowledge, "viewFor" | "unverify" | "retract" | "supersede" | "isAdmin">;
  readJson: () => Promise<Record<string, unknown>>;
  /** True when the caller may not read memory at all; the refusal is already sent. */
  refused: () => boolean;
  /** The caller; undefined is the operator. */
  principalId: string | undefined;
  nameOf: (principalId: string) => string;
  boxName: (boxId: string) => string | undefined;
  log: (line: string) => void;
}

const STATUS: Record<Extract<CorrectionResult, { ok: false }>["code"], number> = {
  "org-item-unknown": 404,
  "org-item-not-standing": 409,
  "org-correction-not-owner": 403,
  "org-correction-reason": 400,
  "org-correction-evidence": 400,
  "org-correction-text": 400,
};

export async function orgCorrectionRoute(route: string, deps: OrgCorrectionRouteDeps): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "GET /api/memory/org/items" && route !== "POST /api/memory/org/correct") return undefined;
  if (deps.refused()) return { status: 0, body: null };
  const admin = deps.ledger.isAdmin(deps.principalId);
  const row = (view: OrgItemView) => {
    const { item } = view;
    const owner = item.owner ?? "";
    const standing = view.state === "standing" || view.state === "unverified" || view.state === "stale";
    const mayReplace = standing && (admin || (deps.principalId !== undefined && deps.principalId === owner));
    const scope = item.scope ?? "";
    return {
      id: view.id, state: view.state, text: item.text, at: item.at, kind: item.kind,
      scope, scopeName: scope.startsWith("box:") ? deps.boxName(scope.slice(4)) ?? scope : scope,
      surface: item.surface ?? "recall", pinned: item.pinned === true,
      owner, ownerName: owner === "" ? "" : deps.nameOf(owner),
      evidence: item.evidence ?? [], verifiedBy: item.verifiedBy === undefined ? undefined : deps.nameOf(item.verifiedBy), verifiedAt: item.verifiedAt, reviewBy: item.reviewBy,
      supersedes: view.supersedes, supersededBy: view.supersededBy, validUntil: view.validUntil,
      correction: view.correction === undefined ? undefined : { ...view.correction, byName: view.correction.by === "operator" ? "operator" : deps.nameOf(view.correction.by) },
      may: { unverify: view.state === "standing" || view.state === "stale", retract: mayReplace, supersede: mayReplace },
    };
  };
  const list = () => ({ items: deps.ledger.viewFor(deps.principalId, admin).map(row).reverse() });
  if (route === "GET /api/memory/org/items") return { status: 200, body: list() };
  const body = await deps.readJson();
  const verb = String(body.verb ?? "");
  const id = String(body.id ?? "");
  const who = { principalId: deps.principalId };
  const reason = String(body.reason ?? "");
  const result = verb === "unverify" ? deps.ledger.unverify(id, who, reason)
    : verb === "retract" ? deps.ledger.retract(id, who, reason)
      : verb === "supersede" ? deps.ledger.supersede(id, who, String(body.text ?? ""), Array.isArray(body.evidence) ? body.evidence.map(String).map(ref => ref.trim()).filter(Boolean) : [])
        : undefined;
  if (result === undefined) return { status: 400, body: apiError("org-correction-verb") };
  if (!result.ok) {
    const owner = deps.ledger.viewFor(deps.principalId, admin).find(view => view.id === id)?.item.owner;
    return { status: STATUS[result.code], body: { ...apiError(result.code, { id, owner: owner === undefined ? "" : deps.nameOf(owner) }), ...list() } };
  }
  deps.log(`organisation knowledge: ${deps.principalId ?? "the operator"} ${verb === "unverify" ? "unverified" : verb === "retract" ? "retracted" : `superseded with ${result.view.id}`} ${id}${reason.trim() !== "" ? `: ${reason.trim()}` : ""}`);
  return { status: 200, body: { done: result.view.id, ...list() } };
}
