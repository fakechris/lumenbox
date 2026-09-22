import type { ComputerProgress } from "../protocol/index.ts";

export function isComputerWrite(action: { action?: unknown } | null | undefined): boolean {
  return !["screenshot", "screenshot_window", "cursor_position", "list_windows", "list_elements", "wait"].includes(String(action?.action));
}

export class DesktopTargetError extends Error {
  constructor(reason: string, readonly code = "STALE_OBSERVATION") { super(`${code}: ${reason}. Take a new list_elements before acting.`); }
}

/** Keeps the executed prefix when an action, capture or authorization check throws. */
export class ComputerExecutionError extends Error {
  constructor(readonly original: unknown, readonly progress: ComputerProgress) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
  }
}
