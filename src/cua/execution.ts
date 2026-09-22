import type { ComputerAction, ComputerProgress } from "../protocol/index.ts";

export function isComputerWrite(action: ComputerAction): boolean {
  return !["screenshot", "screenshot_window", "cursor_position", "list_windows", "list_elements", "wait"].includes(action.action);
}

export class DesktopTargetError extends Error {
  readonly code = "STALE_OBSERVATION";
  constructor(reason: string) { super(`STALE_OBSERVATION: ${reason}. Take a new list_elements before acting.`); }
}

/** Keeps the executed prefix when an action, capture or authorization check throws. */
export class ComputerExecutionError extends Error {
  constructor(readonly original: unknown, readonly progress: ComputerProgress) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
  }
}
