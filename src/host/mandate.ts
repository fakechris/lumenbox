/**
 * A task's mandate: who may have it done, on what footing, and under which rules (INV-1457).
 *
 * The policy answers "may this tool call run"; nothing answered "may this work go on". A task
 * recorded who asked for it, and every later wake — a /continue, a /recover, a goal
 * continuation — took that record as authority without asking whether it still held: the
 * requester may have lost the driver role since, the operator's rules may have changed under
 * it, the person may have said stop and meant the work, not the turn.
 *
 * So a task carries a mandate it was granted with, immutable in its grant, and every wake
 * checks it against the world as it is now. A check that fails does not cancel anything that
 * runs; it marks the task stale, writes the audit row, and asks a person. A stop withdraws
 * it, and a withdrawn mandate never comes back: new work needs a new task.
 *
 * `explicit` is a person's own request; `inferred` is work the harness or an agent started on a
 * rule — a routine, a listener, a proposal — which is why an inferred mandate also needs its
 * source still enabled.
 */

import type { Task } from "./tasks.ts";

export type MandateStrength = "explicit" | "inferred";

export type StaleReason = "requester-cannot-drive" | "rules-changed" | "source-disabled";

export interface Mandate {
  /** The principal whose authority this is. */
  by: string;
  strength: MandateStrength;
  grantedAt: string;
  /** The operator's rule set at the grant, so a change since is visible. */
  rulesHash?: string;
  /** For an inferred mandate: the routine, listener or proposal it rests on. */
  source?: string;
  /** Set by a failed revalidation; cleared when a person re-authorises. */
  stale?: { at: string; reasons: StaleReason[] };
  /** Set by a person's stop; final. */
  withdrawn?: { at: string; by: string; reason: string };
}

/** The world a mandate is checked against, as the host sees it now. */
export interface MandateWorld {
  /** Whether this principal may command work at all (the door's driver gate). */
  mayDrive: (principalId: string) => boolean;
  /** The operator's rule set now; undefined when there is no rule store to ask. */
  rulesHash?: string;
  /** Whether an inferred mandate's source is still on; undefined treats every source as on. */
  sourceEnabled?: (source: string) => boolean;
}

export type Revalidation = { ok: true } | { ok: false; reasons: StaleReason[] };

/** The mandate a new task gets, from how it was asked for. */
export function grantMandate(input: { by: string; proposedBy?: string; source?: string; rulesHash?: string; now: Date }): Mandate {
  const inferred = input.proposedBy !== undefined || input.source !== undefined;
  return {
    by: input.by,
    strength: inferred ? "inferred" : "explicit",
    grantedAt: input.now.toISOString(),
    ...(input.rulesHash !== undefined ? { rulesHash: input.rulesHash } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
  };
}

/**
 * Whether the mandate still holds. Every reason is reported, not just the first, so the
 * person re-authorising sees everything that changed.
 */
export function revalidateMandate(mandate: Mandate, world: MandateWorld): Revalidation {
  const reasons: StaleReason[] = [];
  if (!world.mayDrive(mandate.by)) reasons.push("requester-cannot-drive");
  if (mandate.rulesHash !== undefined && world.rulesHash !== undefined && mandate.rulesHash !== world.rulesHash) reasons.push("rules-changed");
  if (mandate.strength === "inferred" && mandate.source !== undefined && world.sourceEnabled?.(mandate.source) === false) reasons.push("source-disabled");
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/**
 * Whether a person's word on a stale task re-authorises it: only the one whose mandate it is,
 * and only for what their word can settle. A requester who can no longer drive cannot talk
 * their way back in; a rule change or a switched-off source is theirs to accept.
 */
export function reauthorisedBy(mandate: Mandate, principalId: string, world: MandateWorld): boolean {
  if (mandate.withdrawn !== undefined || mandate.by !== principalId) return false;
  return world.mayDrive(principalId);
}

const REASON_TEXT: Record<StaleReason, string> = {
  "requester-cannot-drive": "the person who asked for it can no longer command work here",
  "rules-changed": "the operator's rules changed since it was granted",
  "source-disabled": "the routine or proposal it rests on is no longer enabled",
};

export function describeStale(reasons: readonly StaleReason[]): string {
  return reasons.map(reason => REASON_TEXT[reason]).join("; ");
}

export interface RevalidationResult { status: "ok" | "stale" | "withdrawn" | "unknown"; reasons?: StaleReason[]; reauthorised?: StaleReason[] }

/** The task's mandate as on file, or the one a pre-mandate task is read with: the requester's explicit word. */
const mandateOf = (task: Task): Mandate => task.mandate ?? grantMandate({ by: task.requester, now: new Date(task.createdAt) });

/**
 * A wake's check of a task's mandate (INV-1457), as a new task record when something changed.
 * A failed check marks the task stale and says why; the person whose mandate it is, still able
 * to drive, re-authorises it with that same word, for what their word can settle. A withdrawn
 * mandate is final. A task from before mandates gets its mandate written on its first check.
 */
export function applyRevalidation(task: Task, principalId: string, world: MandateWorld, now: Date): { result: RevalidationResult; task?: Task } {
  const mandate = mandateOf(task);
  if (mandate.withdrawn !== undefined) return { result: { status: "withdrawn" } };
  const at = now.toISOString();
  const check = revalidateMandate(mandate, world);
  const renewed = (note: string): Task => ({
    ...task,
    mandate: { ...mandate, stale: undefined, ...(world.rulesHash !== undefined ? { rulesHash: world.rulesHash } : {}) },
    updatedAt: at,
    history: [...task.history, { at, by: principalId, note }],
  });
  if (check.ok) {
    if (mandate.stale !== undefined) return { result: { status: "ok" }, task: renewed("re-authorised") };
    return { result: { status: "ok" }, ...(task.mandate === undefined ? { task: { ...task, mandate } } : {}) };
  }
  // The requester's own word settles what their word can: a changed rule set or a switched-off
  // source. It cannot restore a driver role they no longer have.
  if (check.reasons.every(reason => reason !== "requester-cannot-drive") && reauthorisedBy(mandate, principalId, world)) {
    return { result: { status: "ok", reauthorised: check.reasons }, task: renewed(`re-authorised after: ${check.reasons.join(", ")}`) };
  }
  const result: RevalidationResult = { status: "stale", reasons: check.reasons };
  if (mandate.stale !== undefined && mandate.stale.reasons.join() === check.reasons.join()) return { result };
  return { result, task: { ...task, mandate: { ...mandate, stale: { at, reasons: check.reasons } }, updatedAt: at, history: [...task.history, { at, by: "host", note: `mandate stale: ${check.reasons.join(", ")}` }] } };
}

/** The task with its mandate withdrawn by a person's stop, or undefined when it already was. */
export function applyWithdrawal(task: Task | undefined, by: string, reason: string, now: Date): Task | undefined {
  if (task === undefined) return undefined;
  const mandate = mandateOf(task);
  if (mandate.withdrawn !== undefined) return undefined;
  return { ...task, mandate: { ...mandate, withdrawn: { at: now.toISOString(), by, reason } } };
}
