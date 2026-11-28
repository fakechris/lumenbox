/**
 * The administration ledger (docs/111 §3 and §8 item 3, INV-2298): `<home>/administration.jsonl`.
 *
 * One line per audit act, meaning an act that changes who may do what or reaches into somebody
 * else's box. It says who did it, what they did, to which box, from whom to whom, when, and the
 * reason given. It is written **before** the act takes effect, and a write that fails throws:
 * the caller refuses the act, so an act with no line never happens. It never holds a credential
 * or what is in a box. It is append-only, never compacted, and `audit export` carries it.
 *
 * The personal-box acts write it first. Any other Admin route can write here too: name its act
 * `<area>.<verb>` and fill the fields that apply.
 */

import { join } from "node:path";
import { appendLineDurably } from "./jsonl.ts";

export const ADMINISTRATION_LEDGER = "administration.jsonl";

export interface AdminAct {
  /** What was done, as `<area>.<verb>`: `personal-box.transfer`, `personal-box.delete`. */
  act: string;
  /** Who did it: a roster id, or `operator` for the installation's own credential. */
  by: string;
  box?: string;
  boxName?: string;
  /** The roster id the act takes something from, and the one it gives it to. */
  from?: string;
  to?: string;
  /** For a transfer the owner agreed to: who asked for it. */
  askedBy?: string;
  reason?: string;
}

/** Writes one act, durably. Throws when it cannot: refuse the act. */
export type WriteAdminAct = (act: AdminAct) => void;

export function administrationLedger(home: string, now: () => Date = () => new Date()): WriteAdminAct {
  const path = join(home, ADMINISTRATION_LEDGER);
  return act => appendLineDurably(path, JSON.stringify({ at: now().toISOString(), ...act, ...(act.reason !== undefined ? { reason: act.reason.slice(0, 300) } : {}) }));
}
