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

import { envNumber } from "../config.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  DEFAULT_DISPLAY_INDEX,
  NOVNC_BASE_PORT,
  NOVNC_VIEW_ONLY_BASE_PORT,
  type DisplayInfo,
} from "../protocol/index.ts";
import { detectDisplay, type DisplayDetectionResult } from "../cua/display.ts";
import { X11Executor } from "../cua/x11-executor.ts";
import { ComponentHealth, type ComponentStatus } from "./component-health.ts";

const execFileAsync = promisify(execFile);

/** Bringing up Xvfb, a WM, VNC and noVNC takes a moment on a loaded host. */
const START_TIMEOUT_MS = 90_000;

/** Guards against an agent id being turned into an unbounded desktop farm. */
const MAX_DISPLAY_INDEX = 32;

/** How often each live desktop is checked and repaired. */
const SUPERVISE_INTERVAL_MS = envNumber("BOXD_SUPERVISE_MS", 15_000);

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
  "x11vnc-ro",
  "novnc-ro",
];

export interface Desktop {
  index: number;
  display: string;
  executor: X11Executor;
  detection: DisplayDetectionResult;
  /** Restart bookkeeping for this desktop's components. */
  health: ComponentHealth;
  /** Set when the desktop was created on someone's behalf. See assertOwner. */
  owner?: string;
  /**
   * When its owner last touched it.
   *
   * The in-memory half of the same lease. Without it a claim held by an agent that stopped lasts as
   * long as the daemon does, which for a box running for days is indistinguishable from forever.
   */
  ownerAt?: number;
}

export class DisplayOwnershipError extends Error {}

/**
 * Where a desktop's owner is remembered, so a boxd restart does not orphan it.
 *
 * The X servers, the window manager and everything an agent opened are separate processes: they
 * survive boxd being restarted in place, and are reattached to rather than recreated. Ownership,
 * though, lived only in this process's map — so after a restart the first agent to name a desktop
 * adopted a colleague's live screen, with their browser and their session on it, and locked the
 * original out of it.
 *
 * `/tmp` on purpose: exactly as long-lived as the desktops themselves. A container recreate clears
 * both, which is correct — there is nothing to own by then.
 *
 * A **hash** of the owner's token, never the token. The agent has a shell as this same uid and can
 * read this file; storing the token would hand it a colleague's desktop credential, which is worse
 * than the problem being fixed. A hash compares just as well.
 */
function ownerFile(index: number): string {
  return `/tmp/agentbox-display-${index}.owner`;
}

function ownerHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

/**
 * How long a desktop stays claimed without its owner touching it.
 *
 * A claim with no expiry is a lock, and a lock held by an agent that no longer exists is a desktop
 * nobody can ever use again — one failure turned into a permanent one, fixable only by recreating
 * the container. That was the behaviour, and persisting the claim made it outlive the daemon too.
 *
 * An owner touches its desktop on every screenshot and every click, so an agent that is working
 * renews constantly and an agent that has stopped lets go on its own. Thirty minutes is the same
 * figure work claims use, and for the same reason: longer than any single stretch of real work,
 * shorter than a working day.
 */
// Floored at a minute: a zero or negative TTL configured by mistake would expire every lease
// instantly, turning the lease into no protection at all.
const OWNER_TTL_MS = Math.max(60_000, envNumber("BOXD_DISPLAY_OWNER_TTL_MS", 30 * 60_000));

function rememberOwner(index: number, token: string, log: (line: string) => void): void {
  const path = ownerFile(index);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    // Temp-plus-rename, so a reader never sees a half-written claim. In-place writing let a torn or
    // interrupted write leave an empty or partial file, which the reader below then took for "no
    // owner" — and handed a live desktop, with its browser session, to the next agent. A rename is
    // atomic on one filesystem, so the file is only ever absent, the old claim, or the new one.
    writeFileSync(temp, JSON.stringify({ hash: ownerHash(token), at: Date.now() }), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort
    }
    // Not fatal: the desktop works, it just loses its claim if this daemon restarts.
    log(`desktop ${index}: could not record its owner (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** What a lease file says, kept three-way so "unreadable" is not confused with "free". */
type OwnerState =
  | { status: "owned"; hash: string }
  | { status: "free" }
  | { status: "unknown" };

function recordedOwner(index: number, now = Date.now()): OwnerState {
  let text: string;
  try {
    text = readFileSync(ownerFile(index), "utf8").trim();
  } catch (error) {
    // Absent is free — no claim was ever made. Any other read error (EACCES, EIO) is *unknown*: we
    // cannot say the desktop is free, so we must not hand it to someone else. These differ because
    // "nobody owns it" and "we cannot tell who owns it" are opposite answers, and collapsing them
    // is what let a corrupt file read as an unclaimed desktop.
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "free" };
    return { status: "unknown" };
  }
  if (text === "") return { status: "unknown" }; // a torn write, not an absence
  let record: { hash?: string; at?: number };
  try {
    record = JSON.parse(text) as { hash?: string; at?: number };
  } catch {
    return { status: "unknown" };
  }
  if (typeof record.hash !== "string" || typeof record.at !== "number" || !Number.isFinite(record.at)) {
    return { status: "unknown" };
  }
  // A timestamp from the future is a clock that moved, not a valid age: treat it as fresh rather
  // than as expired, so a backward correction does not evict a live owner. A forward correction
  // past the TTL still expires it, which is the safe direction — the owner simply reclaims on its
  // next call.
  const age = record.at > now ? 0 : now - record.at;
  if (age > OWNER_TTL_MS) return { status: "free" };
  return { status: "owned", hash: record.hash };
}

/**
 * How a presented token relates to the recorded owner.
 *
 * `undefined` means "no live claim stands in the way" — free, or held by this same token. A string
 * is the refusal reason. Crucially, an *unknown* lease is a refusal, not a free pass: a file we
 * cannot read may be a live owner whose write was torn.
 */
function ownerConflict(index: number, token: string | undefined): string | undefined {
  const state = recordedOwner(index);
  if (state.status === "free") return undefined;
  if (state.status === "unknown") {
    return `Desktop ${index}'s ownership record could not be read, so it is not being handed over.`;
  }
  if (token !== undefined && ownerHash(token) === state.hash) return undefined;
  return `Desktop ${index} belongs to another agent — it was claimed before this daemon restarted.`;
}

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

      const desktop = this.desktops.get(index);
      if (!desktop) continue;

      try {
        // The skip list is how a decision made over time reaches a script that only sees
        // one moment: without it a crash-looping component is started again every pass.
        const blocked = desktop.health.blocked();
        const { stdout, stderr } = await execFileAsync(
          "/usr/local/bin/start-display",
          [String(index)],
          {
            timeout: START_TIMEOUT_MS,
            env: { ...process.env, SKIP_COMPONENTS: blocked.join(" ") },
          }
        );

        const output = `${stdout}${stderr}`;
        for (const name of startedComponents(output)) {
          const status = desktop.health.restarted(name);
          if (status.state === "disabled" || status.state === "crashloop") {
            this.log(`desktop ${index}: ${status.reason}`);
          } else {
            this.log(`desktop ${index}: restarted ${name}`);
          }
        }
        for (const line of output.trim().split("\n")) {
          if (line.includes("WARNING")) this.log(`repair: ${line}`);
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

  /** Per-component health for every live desktop, for the health endpoint. */
  health(): { index: number; degraded: boolean; components: ComponentStatus[] }[] {
    return [...this.desktops.values()]
      .sort((a, b) => a.index - b.index)
      .map(desktop => ({
        index: desktop.index,
        degraded: desktop.health.degraded(),
        components: desktop.health.report(),
      }));
  }

  /** The container path serving a desktop's noVNC. */
  static vncPath(index: number): string {
    return `/vnc/${index}/`;
  }

  static novncPort(index: number): number {
    return NOVNC_BASE_PORT + index;
  }

  /**
   * The noVNC port of the same desktop's view-only stack.
   *
   * A second x11vnc started with `-viewonly`, because a viewer must be able to watch without being
   * able to take over and RFB cannot be made read-only by a proxy after the fact — everything after
   * the handshake is framed, so filtering out key and pointer messages would mean writing an RFB
   * parser and failing closed on anything it did not recognise. Kept in step with `start-display`,
   * which is where the ports are actually chosen.
   */
  static novncViewOnlyPort(index: number): number {
    return NOVNC_VIEW_ONLY_BASE_PORT + index;
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
  /** Whether a claim held in memory has gone quiet long enough to be taken over. */
  private lapsed(desktop: Desktop | undefined, now = Date.now()): boolean {
    if (desktop?.owner === undefined) return true;
    return now - (desktop.ownerAt ?? 0) > OWNER_TTL_MS;
  }

  assertOwner(index: number, presented: string | undefined): void {
    // No token is the ungated, single-user path — one owner, everything allowed. Ownership only
    // means something once a gateway is putting an identity on the request.
    if (presented === undefined) return;

    const desktop = this.desktops.get(index);

    // A fresh in-memory owner that is someone else settles it without touching disk: this is the
    // concurrent case, where two agents reach an already-owned desktop in one process.
    if (desktop?.owner !== undefined && !this.lapsed(desktop) && desktop.owner !== presented) {
      throw new DisplayOwnershipError(
        `Desktop ${index} belongs to another agent. Use your own desktop, which is the one your ` +
          "tools already target."
      );
    }

    // Then the persisted lease, which is the source of truth across a restart — and where an
    // unreadable record is a refusal rather than a free desktop.
    const conflict = ownerConflict(index, presented);
    if (conflict !== undefined) {
      throw new DisplayOwnershipError(
        `${conflict} Use your own desktop, which is the one your tools already target.`
      );
    }

    // Free, or mine: take or renew. Every access moves the clock, which is what makes this a lease
    // rather than a lock — working renews it, stopping lets it lapse.
    rememberOwner(index, presented, this.log);
    if (desktop !== undefined) {
      desktop.owner = presented;
      desktop.ownerAt = Date.now();
    }
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
      if (owner && existing.owner && existing.owner !== owner && !this.lapsed(existing)) {
        throw new DisplayOwnershipError(
          `Desktop ${index} is already bound to another owner.`
        );
      }
      if (owner && (existing.owner === undefined || this.lapsed(existing))) {
        if (existing.owner !== undefined && existing.owner !== owner) {
          this.log(
            `desktop ${index}: its owner has not touched it for ` +
              `${Math.round(OWNER_TTL_MS / 60_000)} minutes; handing it over`
          );
        }
        existing.owner = owner;
      }
      // Renewed on every ensure by the owner, for the same reason.
      if (owner && existing.owner === owner) {
        existing.ownerAt = Date.now();
        rememberOwner(index, owner, this.log);
      }
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

    // A desktop this daemon did not start may already be claimed. Refused here rather than in
    // assertOwner alone, so adoption cannot quietly rebind someone else's screen. An unreadable
    // lease refuses too — it may be a live owner whose write was torn.
    const conflict = ownerConflict(index, owner);
    if (conflict !== undefined) {
      throw new DisplayOwnershipError(`${conflict} Use your own desktop.`);
    }
    if (owner !== undefined) rememberOwner(index, owner, this.log);

    const desktop: Desktop = {
      index,
      display,
      executor,
      detection,
      owner,
      ...(owner !== undefined ? { ownerAt: Date.now() } : {}),
      health: new ComponentHealth(),
    };
    this.desktops.set(index, desktop);
    this.log(
      `desktop ${index} ready at ${detection.resolutionString} ` +
        `(api ${detection.resolution.api.width}x${detection.resolution.api.height})`
    );
    return desktop;
  }
}

/**
 * The components start-display reports having started.
 *
 * It ends a repair with `ready (started: Xvfb xfwm4 …)`, which is the only record of what
 * was actually missing — parsed rather than re-derived, because the script is the thing
 * that looked.
 */
export function startedComponents(output: string): string[] {
  // Greedy to the last bracket on the line, not the first: autocutsel reports which
  // selection it serves — `autocutsel(PRIMARY)` — and stopping at that bracket silently
  // dropped every component after it from the accounting.
  const match = /started:\s*(.*)\)\s*$/m.exec(output);
  if (!match) return [];
  return match[1]!
    .split(/\s+/)
    .map(name => name.replace(/\(.*\)$/, "").trim())
    .filter(name => name !== "");
}
