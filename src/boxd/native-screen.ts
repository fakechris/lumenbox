/**
 * An organisation node's native environment with its screen open (INV-1707, docs/96 §8 Q2).
 *
 * A native-environment box (INV-438) has no desktop: every desktop route answers 409. A node an
 * organisation owns may open the machine's own screen to the `computer` tool, for the case
 * docs/96 names: the organisation's Mac that runs a business desktop application. It is opened at
 * the machine (`agentbox node run --screen`, which sets `BOXD_NATIVE_SCREEN=1`); a personal `host
 * up` never sets it, because a personal machine's screen is not an organisation's (docs/96 §0.3).
 *
 * The screen is not a new kind of desktop with rules of its own. It is desktop 1 of the box's
 * DisplayManager, made by the injected `create` instead of `start-display`, so everything a Linux
 * desktop answers to applies unchanged: one owner at a time (a second agent is refused), a
 * person's takeover lease refusing every agent write as USER_IN_CONTROL, the control guard's
 * epochs and revocation, the per-desktop queue, the authority rechecked before every input. What
 * differs is what can never happen to it:
 *
 *   - it is never started, reaped or stopped — it is the machine's screen, and it was there before
 *     the daemon; `adopted` says so, which retains it, and `stop` refuses;
 *   - only desktop 1 exists: the machine has one screen, and an index of its own per agent would
 *     be two agents on one screen under two names;
 *   - a takeover is not recorded as a demonstration (boxd main.ts): a person at the organisation's
 *     machine is not filmed;
 *   - `close()` (the daemon stopping) refuses every later input and kills the helper in flight
 *     at its next authority check, so a stopped node sends nothing more.
 *
 * Only macOS in this version: an organisation's Linux machine runs the Docker box for a desktop.
 */

import type { DesktopCapabilities } from "../protocol/index.ts";
import { DEFAULT_DISPLAY_INDEX } from "../protocol/index.ts";
import { MacExecutor, macResolution, macScreenPorts, MACOS_DESKTOP_CAPABILITIES, type MacScreenPorts } from "../cua/macos-executor.ts";
import { ComponentHealth } from "./component-health.ts";
import type { DesktopResourceRuntime } from "./desktop-resources.ts";
import { type Desktop, DisplayOwnershipError } from "./displays.ts";

/** The one desktop a native screen is. */
export const NATIVE_SCREEN_INDEX = DEFAULT_DISPLAY_INDEX;

export interface NativeScreen {
  readonly index: number;
  /** What the DisplayManager creates the desktop with, instead of starting X. */
  readonly runtime: DesktopResourceRuntime;
  readonly capabilities: DesktopCapabilities;
  /** No more input from now on: the batch running stops at its next action, the helper in flight is killed. */
  close(): void;
  /** For the start-up line. */
  describe(): string;
}

export interface NativeScreenOptions {
  headless: boolean;
  /** `BOXD_NATIVE_SCREEN=1`, set by `agentbox node run --screen` only. */
  enabled: boolean;
  platform?: NodeJS.Platform;
  /** A helper program speaking the input requests, instead of the default JXA (`BOXD_NATIVE_SCREEN_HELPER`). */
  helper?: string | undefined;
  /** Replaced in tests, which never touch a real screen. */
  ports?: MacScreenPorts;
  screenshotDelayMs?: number;
  log: (line: string) => void;
  /** Where the daemon says it is stopping; replaced in tests. Default: SIGTERM and SIGINT. */
  onStop?: (close: () => void) => void;
}

/** The machine's screen as this daemon's desktop 1, or undefined where it stays closed. */
export function nativeScreenFor(options: NativeScreenOptions): NativeScreen | undefined {
  if (!options.headless || !options.enabled) return undefined;
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin") {
    options.log(`screen: not opened: the machine's own screen opens on macOS only in this version (this is ${platform}); the box keeps its shell and files`);
    return undefined;
  }
  let closed = false;
  const open = () => {
    if (closed) throw new DisplayOwnershipError("The machine's screen is closed: this box daemon is stopping, so nothing more is sent to it.");
  };
  const inner = options.ports ?? macScreenPorts({ ...(options.helper !== undefined ? { helper: options.helper } : {}), log: options.log });
  // Every native call rechecks that the screen is still open, before it starts and while it runs (native-helper.ts polls it).
  const ports: MacScreenPorts = {
    helper: (request, authorize) => { open(); return inner.helper(request, () => { open(); authorize(); }); },
    capture: (width, authorize) => { open(); return inner.capture(width, () => { open(); authorize(); }); },
  };
  const executor = new MacExecutor({ ports, ...(options.screenshotDelayMs !== undefined ? { screenshotDelayMs: options.screenshotDelayMs } : {}) });
  const runtime: DesktopResourceRuntime = {
    now: Date.now,
    idleMs: 0,
    // The machine's screen was there before this daemon: retained, never reaped.
    adopted: () => true,
    async create(index: number): Promise<Desktop> {
      if (index !== NATIVE_SCREEN_INDEX) {
        throw new DisplayOwnershipError(`This box has one screen, the machine's own, as desktop ${NATIVE_SCREEN_INDEX}; there is no desktop ${index} here.`);
      }
      open();
      // The geometry is read again at every batch; this is only what the desktop record shows until then.
      const state = await executor.state().catch(error => {
        options.log(`screen: the helper did not answer yet (${error instanceof Error ? error.message : String(error)}); every batch reads the screen again`);
        return { width: 1280, height: 800 };
      });
      const resolution = macResolution(state);
      options.log(`screen: the machine's own screen is desktop ${index} (${state.width}x${state.height} points)`);
      return {
        index,
        display: "native",
        executor,
        detection: { display: { width: state.width, height: state.height, refreshRate: 60 }, resolution, resolutionString: `${state.width}x${state.height}` },
        health: new ComponentHealth(),
      };
    },
    capture: async () => ({ processes: [], reason: "the machine's own screen" }),
    stop: async () => ({ stopped: false, reason: "the machine's own screen is never stopped" }),
  };
  const close = () => {
    if (closed) return;
    closed = true;
    options.log("screen: closed; nothing more is sent to the machine's screen");
  };
  (options.onStop ?? (stop => { process.once("SIGTERM", stop); process.once("SIGINT", stop); }))(close);
  return {
    index: NATIVE_SCREEN_INDEX,
    runtime,
    capabilities: MACOS_DESKTOP_CAPABILITIES,
    close,
    describe: () =>
      `the machine's own screen is open as desktop ${NATIVE_SCREEN_INDEX} to the computer tool, one agent at a time; ` +
      "it needs Screen Recording and Accessibility for the app that started the node, read and never asked for; no browser tool, recording or clipboard",
  };
}
