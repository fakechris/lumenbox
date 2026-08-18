/**
 * The box's desktops.
 *
 * Each agent gets its own X display rather than sharing one, because a shared
 * display is not merely contended — it is corrupting. X delivers synthetic input to
 * whichever window holds focus, so two agents typing at once interleave into the
 * wrong window, and each screenshots the other's work and reasons from it. A person
 * trying to use the desktop competes with both.
 *
 * Separate displays make that impossible instead of discouraged, and they are what
 * lets the user drive one agent's screen while the others keep working.
 *
 * Desktops are created on demand: a box with one agent does not pay for idle ones.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_DISPLAY_INDEX,
  NOVNC_BASE_PORT,
  type DisplayInfo,
} from "../protocol/index.ts";
import { detectDisplay, type DisplayDetectionResult } from "../cua/display.ts";
import { X11Executor } from "../cua/x11-executor.ts";

const execFileAsync = promisify(execFile);

/** Bringing up Xvfb, a WM, VNC and noVNC takes a moment on a loaded host. */
const START_TIMEOUT_MS = 90_000;

/** Guards against an agent id being turned into an unbounded desktop farm. */
const MAX_DISPLAY_INDEX = 32;

export interface Desktop {
  index: number;
  display: string;
  executor: X11Executor;
  detection: DisplayDetectionResult;
}

export class DisplayManager {
  private readonly desktops = new Map<number, Desktop>();
  /** In-flight starts, so concurrent turns on one desktop start it once. */
  private readonly starting = new Map<number, Promise<Desktop>>();

  constructor(private readonly log: (line: string) => void) {}

  /** The container path serving a desktop's noVNC. */
  static vncPath(index: number): string {
    return `/vnc/${index}/`;
  }

  static novncPort(index: number): number {
    return NOVNC_BASE_PORT + index;
  }

  list(): DisplayInfo[] {
    return [...this.desktops.values()]
      .sort((a, b) => a.index - b.index)
      .map(desktop => ({
        index: desktop.index,
        display: desktop.display,
        resolution: desktop.detection.resolution,
        vnc_path: DisplayManager.vncPath(desktop.index),
      }));
  }

  has(index: number): boolean {
    return this.desktops.has(index);
  }

  /**
   * Returns the desktop for `index`, starting it if necessary.
   *
   * Concurrent callers share one start rather than racing two Xvfb processes onto
   * the same display number.
   */
  async ensure(index = DEFAULT_DISPLAY_INDEX): Promise<Desktop> {
    if (!Number.isInteger(index) || index < 1 || index > MAX_DISPLAY_INDEX) {
      throw new Error(
        `Display index must be an integer between 1 and ${MAX_DISPLAY_INDEX}, got ${index}`
      );
    }

    const existing = this.desktops.get(index);
    if (existing) return existing;

    const pending = this.starting.get(index);
    if (pending) return pending;

    const start = this.start(index).finally(() => this.starting.delete(index));
    this.starting.set(index, start);
    return start;
  }

  private async start(index: number): Promise<Desktop> {
    this.log(`bringing up desktop ${index}`);

    // The script is idempotent, so this also adopts a desktop that the entrypoint
    // (or a previous boxd) already started.
    const { stdout, stderr } = await execFileAsync(
      "/usr/local/bin/start-display",
      [String(index)],
      { timeout: START_TIMEOUT_MS }
    );
    for (const line of `${stdout}${stderr}`.trim().split("\n")) {
      if (line) this.log(line);
    }

    const display = `:${index}`;
    const detection = await detectDisplay(display);
    const executor = new X11Executor({
      display,
      resolution: detection.resolution,
    });

    const desktop: Desktop = { index, display, executor, detection };
    this.desktops.set(index, desktop);
    this.log(
      `desktop ${index} ready at ${detection.resolutionString} ` +
        `(api ${detection.resolution.api.width}x${detection.resolution.api.height})`
    );
    return desktop;
  }
}
