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
import { copyFileSync, statSync, truncateSync } from "node:fs";
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

/** How often each live desktop is checked and repaired. */
const SUPERVISE_INTERVAL_MS = Number(process.env.BOXD_SUPERVISE_MS ?? 15_000);

/** A desktop component's log is rotated past this. */
const LOG_LIMIT_BYTES = 2 * 1024 * 1024;

/** Named after the log files start-display writes. */
const LOG_COMPONENTS = [
  "xvfb",
  "xfwm4",
  "picom",
  "plank",
  "pcmanfm",
  "autocutsel",
  "x11vnc",
  "novnc",
];

export interface Desktop {
  index: number;
  display: string;
  executor: X11Executor;
  detection: DisplayDetectionResult;
  /** Set when the desktop was created on someone's behalf. See assertOwner. */
  owner?: string;
}

export class DisplayOwnershipError extends Error {}

export class DisplayManager {
  private readonly desktops = new Map<number, Desktop>();
  /** In-flight starts, so concurrent turns on one desktop start it once. */
  private readonly starting = new Map<number, Promise<Desktop>>();

  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly log: (line: string) => void) {}

  /**
   * Re-checks every live desktop on a timer, and repairs what died.
   *
   * Without this, a component that crashes is gone until someone recreates the
   * container: x11vnc dying means the user's screen goes dead while the agent keeps
   * working, which reads as "the box is broken" and is invisible from the agent's
   * side. start-display is idempotent per component, so repair is the same code path
   * as bringup — there is no second implementation to keep in step.
   *
   * The interval is unref'd so it never holds the daemon open by itself.
   */
  startSupervisor(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.superviseOnce();
    }, SUPERVISE_INTERVAL_MS);
    this.timer.unref();
    this.log(`supervising desktops every ${Math.round(SUPERVISE_INTERVAL_MS / 1000)}s`);
  }

  stopSupervisor(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One supervision pass. Exposed for the tests and the smoke test. */
  async superviseOnce(): Promise<void> {
    for (const index of [...this.desktops.keys()]) {
      // A desktop being started right now is not a desktop to repair.
      if (this.starting.has(index)) continue;

      try {
        const { stdout, stderr } = await execFileAsync(
          "/usr/local/bin/start-display",
          [String(index)],
          { timeout: START_TIMEOUT_MS }
        );
        // Silent unless something was actually restarted: start-display only reports
        // components it had to start, so a healthy desktop logs nothing.
        for (const line of `${stdout}${stderr}`.trim().split("\n")) {
          if (line.includes("starting") || line.includes("started:") || line.includes("WARNING")) {
            this.log(`repair: ${line}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`desktop ${index} could not be repaired: ${message}`);
      }

      this.rotateLogs(index);
    }
  }

  /**
   * Keeps a desktop's logs bounded.
   *
   * Copy-then-truncate rather than rename: the components hold these files open, and a
   * renamed inode would keep receiving every later line while the visible file stayed
   * empty. They open in append mode, so truncating in place makes the next write land
   * at zero.
   */
  private rotateLogs(index: number): void {
    for (const component of LOG_COMPONENTS) {
      const path = `/tmp/${component}-${index}.log`;
      try {
        if (statSync(path).size <= LOG_LIMIT_BYTES) continue;
        copyFileSync(path, `${path}.1`);
        truncateSync(path, 0);
        this.log(`rotated ${path}`);
      } catch {
        // No log yet, or a component that never wrote one. Nothing to do.
      }
    }
  }

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
  /**
   * Refuses input aimed at someone else's desktop.
   *
   * Fails closed on a mismatch, and deliberately does not fail on an unbound desktop:
   * the CLI and the smoke test drive displays without claiming them, and locking them out
   * would trade a real capability for a guard that agents can bypass anyway — they share
   * a filesystem and can kill each other's processes. What this stops is the silent case:
   * an agent naming a display that is not its own and typing into another agent's work.
   */
  assertOwner(index: number, presented: string | undefined): void {
    const desktop = this.desktops.get(index);
    const owner = desktop?.owner;
    if (!owner) return;
    if (presented === owner) return;

    throw new DisplayOwnershipError(
      `Desktop ${index} belongs to another agent. ` +
        "Use your own desktop, which is the one your tools already target."
    );
  }

  async ensure(index = DEFAULT_DISPLAY_INDEX, owner?: string): Promise<Desktop> {
    if (!Number.isInteger(index) || index < 1 || index > MAX_DISPLAY_INDEX) {
      throw new Error(
        `Display index must be an integer between 1 and ${MAX_DISPLAY_INDEX}, got ${index}`
      );
    }

    const existing = this.desktops.get(index);
    if (existing) {
      // Claiming an unclaimed desktop is allowed — that is how the first caller takes
      // ownership — but taking one that is already claimed is not.
      if (owner && existing.owner && existing.owner !== owner) {
        throw new DisplayOwnershipError(
          `Desktop ${index} is already bound to another owner.`
        );
      }
      if (owner && !existing.owner) existing.owner = owner;
      return existing;
    }

    const pending = this.starting.get(index);
    if (pending) return pending;

    const start = this.start(index, owner).finally(() => this.starting.delete(index));
    this.starting.set(index, start);
    return start;
  }

  private async start(index: number, owner?: string): Promise<Desktop> {
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

    const desktop: Desktop = { index, display, executor, detection, owner };
    this.desktops.set(index, desktop);
    this.log(
      `desktop ${index} ready at ${detection.resolutionString} ` +
        `(api ${detection.resolution.api.width}x${detection.resolution.api.height})`
    );
    return desktop;
  }
}
