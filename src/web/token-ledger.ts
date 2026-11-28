/**
 * Every credential this installation hands out or takes back, on the record (docs/106 §5 R8, INV-2204).
 *
 * `<home>/tokens.jsonl`, one line per event, appended and never rewritten: a side-door token minted
 * for a person (the watchdog's, the supervisor's, `agentbox mcp`'s, one made in Settings) or revoked
 * — by its holder, by an Admin, by a directory sync or a removal that took the person's access —, a
 * client API token (personal or service, docs/106 §4.3) minted or revoked the same ways, and
 * a box's token rotated. Who did it and for whom, never the token or its hash. `audit export`
 * includes the file.
 *
 * Sign-ins are in `sign-ins.jsonl` (sign-in-limits.ts), desktop sessions in
 * `desktop-sessions.jsonl` (desktop-streams.ts), decisions on approvals in `policy.jsonl`.
 */
import { appendLine } from "../host/jsonl.ts";
import type { ClientTokenKind, Scope, ServiceView } from "./client-api/schema.ts";

export const TOKENS_LEDGER = "tokens.jsonl";

export type TokenRecord =
  | { at: string; event: "minted"; kind: "side-door"; for: string; label: string; via: "sign-in" | "person"; by: string }
  | { at: string; event: "revoked"; kind: "side-door"; for: string; label: string; by: string; reason: "revoked" | "access-ended" }
  // A client API token (INV-2213): personal or service, named by its public id; a service token's view as minted.
  | { at: string; event: "minted"; kind: ClientTokenKind; id: string; for: string; label: string; scopes: Scope[]; expiresAt: string; view?: ServiceView; by: string }
  | { at: string; event: "revoked"; kind: ClientTokenKind; id: string; for: string; label: string; by: string; reason: "revoked" | "access-ended" }
  | { at: string; event: "rotated"; kind: "box"; box: string; boxName: string; by: string; confirmed: boolean; overlapUntil?: string }
  | { at: string; event: "rotation-refused"; kind: "box"; box: string; boxName: string; by: string; reason: string };

/** Appends to `<home>/tokens.jsonl`; a failed write is said, not thrown: a full disk must not undo a revocation. */
export function tokenLedger(path: string, log: (line: string) => void): (record: TokenRecord) => void {
  return record => {
    try { appendLine(path, JSON.stringify(record)); } catch (error) { log(`tokens: could not record a ${record.event} ${record.kind} token: ${error instanceof Error ? error.message : String(error)}`); }
  };
}
