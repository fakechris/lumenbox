import type { ComputerProgress } from "../protocol/index.ts";

export function isComputerWrite(action: { action?: unknown } | null | undefined): boolean {
  return !["screenshot", "screenshot_window", "cursor_position", "list_windows", "list_elements", "wait", "wait_until"].includes(String(action?.action));
}

/**
 * Why an element action was refused before any input (INV-412, INV-1478). Each code says what to do
 * next, because the model reads the message and nothing else:
 * - STALE_OBSERVATION — the ref is not from the current outline (no observation_id, an older one, a
 *   write since, the window changed): observe again.
 * - STALE_REF — the outline is current but the control is not: it is gone, moved, renamed or
 *   disabled, as a deleted row's ref must never resolve to the row that took its place.
 * - AMBIGUOUS_TARGET — more than one control in the current tree answers to the ref's identity.
 * - UNSUPPORTED_ACTION / NATIVE_REFUSED — the native path cannot do it, and there is no fallback.
 */
export type DesktopTargetCode = "STALE_OBSERVATION" | "STALE_REF" | "AMBIGUOUS_TARGET" | "UNSUPPORTED_ACTION" | "NATIVE_REFUSED";

const TARGET_ADVICE: Record<DesktopTargetCode, string> = {
  STALE_OBSERVATION: "Take a new list_elements before acting",
  STALE_REF: "Take a new list_elements and pick the control again; nothing was clicked",
  AMBIGUOUS_TARGET: "Take a new list_elements and tell the controls apart by position or name; nothing was clicked",
  UNSUPPORTED_ACTION: "Use click_element, or a coordinate click from a screenshot",
  NATIVE_REFUSED: "Look at the screen before trying again",
};

export class DesktopTargetError extends Error {
  constructor(reason: string, readonly code: DesktopTargetCode = "STALE_OBSERVATION") { super(`${code}: ${reason}. ${TARGET_ADVICE[code]}.`); }
}

/** What a control is told apart by: its native identity, and what it looked like when observed. */
export interface TargetShape { identity?: string; role: string; name: string; x: number; y: number; width: number; height: number; states: readonly string[] }

/**
 * Whether the observed control is still the one control it was, in the tree as it is now
 * (INV-1478). Zero controls with its identity is STALE_REF — a deleted row's ref must not land
 * on the row that moved into its place; more than one is AMBIGUOUS_TARGET; one that moved,
 * changed or is disabled is STALE_REF. Undefined means it is there and may be acted on.
 */
export function targetVerdict(target: TargetShape, elements: readonly TargetShape[]): DesktopTargetError | undefined {
  const what = `${target.role} "${target.name}"`;
  const matches = elements.filter(element => element.identity === target.identity);
  if (matches.length === 0) return new DesktopTargetError(`${what} is no longer in the window`, "STALE_REF");
  if (matches.length > 1) return new DesktopTargetError(`${matches.length} controls in the window answer to ${what}`, "AMBIGUOUS_TARGET");
  const current = matches[0]!;
  const same = current.role === target.role && current.name === target.name &&
    current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height;
  if (!same) return new DesktopTargetError(`${what} moved or changed since the outline`, "STALE_REF");
  if (current.states.includes("disabled")) return new DesktopTargetError(`${what} is disabled now`, "STALE_REF");
  return undefined;
}

/** Keeps the executed prefix when an action, capture or authorization check throws. */
export class ComputerExecutionError extends Error {
  constructor(readonly original: unknown, readonly progress: ComputerProgress) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
  }
}
