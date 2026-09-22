import type { DesktopCapabilities, ComputerAction, ComputerProgress, DesktopExpectation, ActionVerification, DesktopObservation, ElementInfo, WindowInfo, Effect } from "../protocol/index.ts";

export interface DesktopDriver {
  readonly capabilities: DesktopCapabilities;
  execute(actions: readonly ComputerAction[], options?: DesktopExecutionOptions): Promise<DesktopExecutionResult>;
  invalidateElements(): void;
  takeScreenshot(): Promise<string>;
  pointerWithWindow(): Promise<{ x: number; y: number; window?: string; title?: string }>;
}

export interface DesktopExecutionOptions {
  expect?: DesktopExpectation;
  /** Rechecked after waits and before each new native input operation. */
  authorize?: () => void;
  /**
   * Bind a keycode for each character with no key before typing it, rather than
   * letting `xdotool type` remap one per character and lose it. See
   * `typeWithBorrowedKeys`.
   */
  bindUnmappedCharacters?: boolean;
}

export interface DesktopExecutionResult {
  verification?: ActionVerification;
  observation?: DesktopObservation;
  elementsObservationId?: string;
  progress?: ComputerProgress;
  success: boolean;
  screenshot: string;
  /** The weakest measured effect among the batch's writes; absent when nothing was measured. */
  effect?: Effect;
  /** One line per measured write. */
  effectDetail?: string;
  cursorPosition?: { x: number; y: number };
  /** Present when the batch included list_windows. */
  windows?: readonly WindowInfo[];
  /** Present when list_elements found a tree (INV-412). */
  elements?: readonly ElementInfo[];
  /** Why there are none, when list_elements was asked and there was no tree. */
  elementsNote?: string;
  elementsWindow?: { title: string; app: string; truncated: boolean };
  actionCount: number;
  durationMs: number;
  error?: string;
}

