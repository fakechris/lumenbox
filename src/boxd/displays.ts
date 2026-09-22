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
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_DISPLAY_INDEX,
  MAX_DISPLAY_INDEX,
  isDisplayIndex,
  NOVNC_BASE_PORT,
  NOVNC_VIEW_ONLY_BASE_PORT,
  type DisplayInfo,
} from "../protocol/index.ts";
import { detectDisplay, type DisplayDetectionResult } from "../cua/display.ts";
import { X11Executor } from "../cua/x11-executor.ts";
import { ComponentHealth, type ComponentStatus } from "./component-health.ts";

/**
 * Where the desktop script lives. /usr/local/bin in our own image; as a drop-in on somebody
 * else's machine (docs/29 is not the only thing that runs beside Grok Bot) it is wherever the
 * archive was unpacked, and the daemon is told.
 */
const START_DISPLAY = process.env.BOXD_START_DISPLAY ?? "/usr/local/bin/start-display";

/**
 * Where the desktop components' logs live — the same directory start-display writes
 * them to. Overridable for the same reason the launcher is: a spawned test daemon must
 * not touch a live box's files, and rotation is copy-then-truncate (destructive), not a
 * read. Production always uses the default.
 */
const COMPONENT_LOG_DIR = process.env.BOXD_COMPONENT_LOG_DIR ?? "/tmp";

const execFileAsync = promisify(execFile);

/** Bringing up Xvfb, a WM, VNC and noVNC takes a moment on a loaded host. */
const START_TIMEOUT_MS = 90_000;

/** Guards against an agent id being turned into an unbounded desktop farm. */
export { MAX_DISPLAY_INDEX } from "../protocol/index.ts";

/**
 * The in-memory half of the external control guard, per desktop. `reconciled` is per-boot:
 * it flips true only when a trusted entry has carried controller's projection to this process.
 */
interface GuardState {
  epoch: number;
  opToken?: string;
  /** controller revoked and no grant stands; ordinary calls are refused until re-armed. */
  revoked: boolean;
  /** This boot has seen controller's projection for the desktop (never persisted). */
  reconciled: boolean;
}

/** What survives a restart: the generation and the revoked marker — never the token. */
interface PersistedControl {
  displays: Record<string, { epoch: number; revoked: boolean }>;
  /** Applied revocation ids, for outbox-retried revocations to dedup against. */
  revocations?: string[];
  /**
   * True while the managed set is known to be incomplete: the file was rebuilt after
   * corruption, and desktops absent from `displays` are unknown, not unmanaged. A boot
   * over a partial file keeps unlisted desktops closed until controller's trusted scope
   * confirmation (a reconcile-token-bearing call with scope_complete) rewrites it.
   */
  partial?: boolean;
}

/** Applied revocation ids kept for dedup; bounded so the file cannot grow without end. */
const REVOCATION_REMEMBER = 200;

function assertGuardIndex(index: number): void {
  if (!isDisplayIndex(index)) {
    throw new DisplayGuardError(`Display index must be an integer between 1 and ${MAX_DISPLAY_INDEX}.`);
  }
}

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
   * A person has taken this desktop over (INV-404, docs/49 C1). While set and unexpired,
   * every write from the agent — computer input, browser actions, a shell with a display —
   * is refused as USER_IN_CONTROL rather than typed into the person's hands. A lease with
   * an end, not a flag: a takeover tab closed without handing back must not lock the agent
   * out for the life of the daemon.
   */
  userControl?: { since: number; until: number };
  /**
   * When its owner last touched it.
   *
   * The in-memory half of the same lease. Without it a claim held by an agent that stopped lasts as
   * long as the daemon does, which for a box running for days is indistinguishable from forever.
   */
  ownerAt?: number;
}

export class DisplayOwnershipError extends Error {}

/** The desktop is a person's right now. Answered as HTTP 423; the host reads it as refused. */
export class UserInControlError extends Error {}

/**
 * The external control guard refused a display-scoped call: either the
 * request's displayEpoch is older than the desktop's current one (a late hand-back or
 * stop from a superseded incarnation), or its operation token is not the projection controller
 * currently stands behind. Answered as HTTP 409; the host reads it as refused, not failed.
 */
export class DisplayGuardError extends Error {}

/** How long a takeover lasts unless renewed or handed back. */
export const USER_CONTROL_TTL_MS = 20 * 60_000;

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

  /**
   * The external control guard, per desktop. One home for the
   * whole state machine, persisted so a boxd restart cannot forget that a desktop is
   * controller-managed:
   *
   *  - absent      — never managed: the unmanaged callers keep their ungated path.
   *  - managed, unreconciled — this daemon booted over persisted state and has not yet
   *                  seen controller's projection for it. Every ordinary display-scoped call is
   *                  refused; only the trusted projection entries (ensure/control/revoke)
   *                  can reconcile.
   *  - active      — a generation is bound: ordinary calls must present exactly the bound
   *                  epoch (only the trusted entries advance a generation, so a higher
   *                  epoch on an ordinary call is someone trying to move the generation
   *                  through the wrong door) and the standing op token when one stands.
   *  - revoked     — controller revoked and no grant stands: ordinary calls are refused until a
   *                  new projection arms the desktop again.
   *
   * The op token itself is never written to disk: it is a credential projection, and the
   * agent has a shell as this uid. Only the generation and the revoked marker persist.
   *
   * boxd is the enforcement point, not the authority: it does not judge whether a grant
   * is valid, only whether the request carries the projection controller last relayed. Honest
   * residue, stated in the design: a process derived before the revocation (a background
   * job, an already-open shell) is not terminated by this — in-flight calls fail on their
   * *next* request, not retroactively.
   */
  private readonly control = new Map<number, GuardState>();
  private appliedRevocations: string[] = [];
  /**
   * The guard state file existed but could not be read or parsed. Unlike "absent"
   * (nothing was ever managed), this is an anomaly we refuse to read as "fresh system":
   * every desktop is treated as possibly-managed and stays closed to ordinary calls
   * until a trusted projection both re-arms and re-persists the file.
   */
  private guardDegraded = false;
  /**
   * True while the managed set is known to be incomplete (loaded from a partial file,
   * or saved while recovering from one). Desktops absent from `control` are unknown,
   * not unmanaged: they stay closed to ordinary calls and projectionless trusted
   * entries until controller's trusted scope confirmation clears the flag.
   */
  private partial = false;
  /**
   * This boot's reconciliation token, minted fresh on every start. A desktop that booted
   * managed-but-unreconciled only accepts a projection carrying this token — the bridge
   * reads it from this boxd each cycle, so a delayed message from before the restart
   * cannot pose as controller's current state. The endpoint registry shares it,
   * one token per boot for both halves of the desktop control state.
   */
  readonly reconcileToken: string = randomUUID();

  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: (line: string) => void,
    private readonly dataDir: string = process.env.BOXD_DATA_DIR ?? "/home/box/work/.boxd"
  ) {
    this.loadControl();
  }

  // ── persistence ─────────────────────────────────────────────────────────────────────

  private controlPath(): string {
    return join(this.dataDir, "guard.json");
  }

  private loadControl(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.controlPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return; // never persisted
      this.guardDegraded = true;
      this.log(
        `guard: ${this.controlPath()} could not be read or parsed ` +
          `(${error instanceof Error ? error.message : String(error)}); every desktop stays closed ` +
          "to ordinary calls until a trusted projection re-arms and heals the file"
      );
      return;
    }
    // Structural validation, exhaustively: a file this daemon wrote is always a plain
    // object with a displays map; anything else — array, null, missing or mistyped
    // maps — is corruption, and corruption must fail closed, never read as unmanaged
    // and never crash the boot. Optional fields are validated too: a
    // `partial` that is present but not a boolean is corruption, not "complete" — a
    // wrong-typed marker must never read as the healthy state.
    const record = parsed as PersistedControl;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !DisplayManager.isPlainMap(record.displays) ||
      (record.partial !== undefined && typeof record.partial !== "boolean")
    ) {
      this.guardDegraded = true;
      this.log(`guard: ${this.controlPath()} is structurally invalid; failing closed until re-armed`);
      return;
    }
    // Validate the ENTIRE file into candidate maps before publishing anything: a corrupt
    // record anywhere — even after valid ones — fails the whole load closed, with no
    // half-populated state that a later recovery would trip over.
    const candidate = new Map<number, GuardState>();
    for (const [key, entry] of Object.entries(record.displays)) {
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 1 ||
        index > MAX_DISPLAY_INDEX ||
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry) ||
        typeof entry.epoch !== "number" ||
        !Number.isFinite(entry.epoch)
      ) {
        // A corrupt record must not silently disappear — its desktop would read as
        // unmanaged. The whole file fails closed instead, and per-desktop trusted
        // recovery can heal it.
        this.guardDegraded = true;
        this.log(`guard: ${this.controlPath()} has a corrupt record for ${JSON.stringify(key)}; failing closed`);
        return;
      }
      // Managed, but this boot has not seen controller's projection for it: refuse ordinary
      // calls until the trusted entries reconcile (bridge re-projects on its next call).
      candidate.set(index, {
        epoch: entry.epoch,
        revoked: entry.revoked === true,
        reconciled: false,
      });
    }
    const revocations: string[] = [];
    if (record.revocations !== undefined) {
      if (!Array.isArray(record.revocations) || record.revocations.some(id => typeof id !== "string")) {
        this.guardDegraded = true;
        this.log(`guard: ${this.controlPath()} has a corrupt revocation record; failing closed`);
        return;
      }
      revocations.push(...record.revocations.slice(-REVOCATION_REMEMBER));
    }
    // The whole file is valid: publish it at once.
    this.control.clear();
    for (const [index, state] of candidate) this.control.set(index, state);
    this.appliedRevocations = revocations;
    // A partial file names a known-incomplete managed set: desktops absent from it are
    // unknown, and stay closed until controller's trusted scope confirmation.
    this.partial = record.partial === true;
    if (this.control.size > 0 || this.partial) {
      this.log(
        `guard: ${this.control.size} desktop(s) are externally managed` +
          (this.partial ? " (partial set — unlisted desktops unknown)" : "") +
          "; their gates stay closed until controller's projection reconciles them"
      );
    }
  }

  /** A plain object used as a map — never null, never an array. */
  private static isPlainMap(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  /**
   * Writes the candidate guard state — displays, the revocation-dedup record, and the
   * partial marker, together, as one transaction — and only then returns. The caller
   * commits to memory after this succeeds; a failed write publishes nothing, so a retry
   * cannot be swallowed by a dedup record the disk never received and a
   * restart never forgets a generation the disk does not hold.
   *
   * `partial` records that the managed set is known to be incomplete: any save made
   * while recovering from corruption or a partial file keeps it set, so a reboot cannot
   * turn "unknown desktops" into "unmanaged desktops".
   */
  private saveControl(candidate: Map<number, GuardState>, revocations: string[], partial: boolean): void {
    const displays: Record<string, { epoch: number; revoked: boolean }> = {};
    for (const [index, state] of candidate) {
      displays[String(index)] = { epoch: state.epoch, revoked: state.revoked };
    }
    const temp = `${this.controlPath()}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(
        temp,
        `${JSON.stringify({ displays, revocations: revocations.slice(-REVOCATION_REMEMBER), ...(partial ? { partial: true } : {}) } satisfies PersistedControl, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      renameSync(temp, this.controlPath());
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // best effort
      }
      throw new DisplayGuardError(
        `guard persist failed for ${this.dataDir}: ${error instanceof Error ? error.message : String(error)}; ` +
          "refusing to publish a generation the disk does not hold"
      );
    }
  }

  /** Every save while the set is incomplete keeps the partial marker on disk. */
  private nextPartial(): boolean {
    return this.guardDegraded || this.partial;
  }

  /**
   * controller's trusted scope confirmation: the managed set named on disk is complete again.
   * Validates the confirmation's credentials only — the caller must fold it into the
   * SAME candidate it persists, and clear the degraded/partial markers only after the
   * write succeeds. Memory must never read "complete" while the disk says otherwise
   *.
   */
  private validateScopeConfirmation(scopeComplete: boolean, reconcileToken?: string): void {
    if (scopeComplete && reconcileToken !== this.reconcileToken) {
      throw new DisplayGuardError("scope confirmation requires this boot's reconcile token");
    }
  }

  /**
   * Commits a persisted transaction: the candidate state, the revocation-dedup record,
   * and the partial marker (false when the same request carried controller's scope
   * confirmation) were written as one; only now may memory move. `partialAfter ===
   * false` from a scope confirmation clears the recovery markers here — after the disk
   * holds the complete file, never before.
   */
  private commitControl(
    candidate: Map<number, GuardState>,
    revocations: string[],
    partialAfter: boolean
  ): void {
    const committed = new Map(candidate);
    for (const [index, state] of committed) {
      const previous = this.control.get(index);
      if (previous?.epoch !== state.epoch || previous?.opToken !== state.opToken || previous?.revoked !== state.revoked) {
        this.desktops.get(index)?.executor?.invalidateElements();
      }
    }
    this.control.clear();
    for (const [index, state] of committed) this.control.set(index, state);
    // The human lease belongs to the revoked authority too. Clear it only after
    // persistence commits, so the internal teach reaper finishes the abandoned
    // recording instead of recording an empty desktop until the old lease expires.
    for (const [index, state] of committed) {
      if (state.revoked) this.handBack(index);
    }
    this.appliedRevocations = revocations;
    if (!partialAfter) {
      this.guardDegraded = false;
      this.partial = false;
    }
  }

  private static boundedRevocations(revocations: string[], extra: string): string[] {
    const next = revocations.includes(extra) ? [...revocations] : [...revocations, extra];
    return next.slice(-REVOCATION_REMEMBER);
  }

  // ── the trusted entries: only these move the guard ──────────────────────────────────

  /**
   * Arms or re-arms a desktop's generation — a trusted entry, called from ensure/control
   * when the relay carries controller's projection.
   *
   * A desktop that booted managed-but-unreconciled only opens for a projection bound to
   * THIS boot (reconcileToken): an old equal-value relay, however legitimate it once was,
   * is a delayed message and cannot mark itself current. A genuinely never-managed
   * desktop takes its first arm on the relay's authority alone. After a restart the
   * previous boot's token is gone with the process: a reconciling projection arms the
   * desktop with exactly the token it carried — possibly none — never a resurrected one.
   */
  armControl(index: number, epoch: number, opToken?: string, reconcileToken?: string, scopeComplete = false): void {
    assertGuardIndex(index);
    this.validateScopeConfirmation(scopeComplete, reconcileToken);
    // Recovery from a corrupt or partial state is itself trusted work: only a message
    // bound to this boot may re-establish any desktop while the managed set is unknown
    //.
    if ((this.guardDegraded || this.partial) && reconcileToken !== this.reconcileToken) {
      throw new DisplayGuardError(
        "the managed set is being recovered; a projection without this boot's reconcile token " +
          "is a delayed message, not controller's current state"
      );
    }
    // The scope confirmation rides THIS write: partial clears on disk and in memory
    // together, only after the write succeeds.
    const partialAfter = scopeComplete ? false : this.nextPartial();
    const existing = this.control.get(index);
    if (existing !== undefined && !existing.reconciled) {
      if (reconcileToken === undefined || reconcileToken !== this.reconcileToken) {
        throw new DisplayGuardError(
          `desktop ${index} is awaiting reconciliation; a projection without this boot's reconcile ` +
            "token is a delayed message, not controller's current state"
        );
      }
      if (epoch < existing.epoch) {
        throw new DisplayGuardError(
          `epoch_mismatch: desktop ${index} stands at displayEpoch ${existing.epoch}; ` +
            `refusing to arm an older epoch ${epoch}`
        );
      }
      const candidate = new Map(this.control);
      candidate.set(index, { epoch, opToken, revoked: false, reconciled: true });
      this.saveControl(candidate, this.appliedRevocations, partialAfter);
      this.commitControl(candidate, this.appliedRevocations, partialAfter);
      if (scopeComplete) this.log("guard: controller confirmed the managed scope; recovery complete");
      this.log(`desktop ${index}: reconciled and armed at displayEpoch ${epoch}`);
      return;
    }
    const bound = existing?.epoch ?? 0;
    if (epoch < bound) {
      throw new DisplayGuardError(
        `epoch_mismatch: desktop ${index} stands at displayEpoch ${bound}; ` +
          `refusing to arm an older epoch ${epoch}`
      );
    }
    const standingToken =
      existing?.reconciled === true && epoch === existing.epoch ? existing.opToken : undefined;
    const candidate = new Map(this.control);
    candidate.set(index, {
      epoch,
      // The presented token wins; otherwise the standing projection survives only on a
      // retry at the same generation. A new generation takes exactly what the relay
      // carried — the previous boot's credential never survives a restart.
      opToken: opToken ?? standingToken,
      revoked: false,
      reconciled: true,
    });
    this.saveControl(candidate, this.appliedRevocations, partialAfter);
    this.commitControl(candidate, this.appliedRevocations, partialAfter);
    if (scopeComplete) this.log("guard: controller confirmed the managed scope; recovery complete");
  }

  /**
   * controller's revocation, relayed by the bridge with the generation controller is
   * revoking from and an idempotency key for the outbox retry. Applies only while the
   * desktop stands at exactly `from_epoch` — a retry landing after controller has moved on
   * (a newer grant established) finds a different generation and changes nothing, so a
   * late A-era revocation can never bump a B-era grant into oblivion.
   *
   * The state change and the dedup record are built as one candidate and persisted
   * together before either is published: a failed write leaves both the live state and
   * the dedup list at the prior transaction, so a retry after the filesystem recovers is
   * judged against what the disk actually holds. A revocation that arrives before any
   * arm leaves a persisted tombstone — the revoked generation's lower bound — so a late
   * arm of the already-revoked generation is refused instead of resurrecting it.
   */
  revokeControl(
    index: number,
    revokeId: string,
    fromEpoch: number,
    reconcileToken?: string,
    scopeComplete = false
  ): { epoch: number; applied: boolean } {
    assertGuardIndex(index);
    this.validateScopeConfirmation(scopeComplete, reconcileToken);
    if ((this.guardDegraded || this.partial) && reconcileToken !== this.reconcileToken) {
      throw new DisplayGuardError(
        "the managed set is being recovered; a revocation without this boot's reconcile token " +
          "is a delayed message, not controller's current state"
      );
    }
    // The scope confirmation rides THIS write (even when the revocation itself is a
    // no-op): partial clears on disk and in memory together, only after the write.
    const partialAfter = scopeComplete ? false : this.nextPartial();
    const existing = this.control.get(index);
    if (existing !== undefined && !existing.reconciled) {
      if (reconcileToken === undefined || reconcileToken !== this.reconcileToken) {
        throw new DisplayGuardError(
          `desktop ${index} is awaiting reconciliation; a revocation without this boot's reconcile ` +
            "token is a delayed message, not controller's current state"
        );
      }
      if (fromEpoch < existing.epoch) {
        // Stale revocation against a generation newer than controller claims: superseded. If
        // it carried a scope confirmation, that still has to land — save the unchanged
        // candidate complete rather than dropping the confirmation with the no-op.
        if (scopeComplete) this.persistUnchangedScope(partialAfter);
        return { epoch: existing.epoch, applied: false };
      }
      const candidate = new Map(this.control);
      candidate.set(index, { epoch: fromEpoch + 1, revoked: true, reconciled: true });
      const revocations = DisplayManager.boundedRevocations(this.appliedRevocations, revokeId);
      this.saveControl(candidate, revocations, partialAfter);
      this.commitControl(candidate, revocations, partialAfter);
      this.log(`desktop ${index}: control revoked from epoch ${fromEpoch}; displayEpoch is now ${fromEpoch + 1}`);
      return { epoch: fromEpoch + 1, applied: true };
    }
    if (existing !== undefined && existing.epoch === fromEpoch && !this.appliedRevocations.includes(revokeId)) {
      const candidate = new Map(this.control);
      candidate.set(index, { epoch: existing.epoch + 1, revoked: true, reconciled: true });
      const revocations = DisplayManager.boundedRevocations(this.appliedRevocations, revokeId);
      this.saveControl(candidate, revocations, partialAfter);
      this.commitControl(candidate, revocations, partialAfter);
      this.log(`desktop ${index}: control revoked; displayEpoch is now ${existing.epoch + 1}`);
      return { epoch: existing.epoch + 1, applied: true };
    }
    if (existing === undefined || existing.epoch < fromEpoch) {
      // The arm for the revoked generation has not reached this box yet (or was lost),
      // and the local projection, if any, is older than what controller is revoking. controller is
      // the revocation authority: leave a persisted tombstone at from_epoch + 1 so a
      // late arm of the already-revoked generation is refused instead of resurrecting
      // it. A genuinely newer grant arms above the bound and is untouched; a bound
      // newer than from_epoch (existing.epoch > fromEpoch) is left alone — the
      // revocation is already superseded.
      const candidate = new Map(this.control);
      candidate.set(index, { epoch: fromEpoch + 1, revoked: true, reconciled: true });
      const revocations = DisplayManager.boundedRevocations(this.appliedRevocations, revokeId);
      this.saveControl(candidate, revocations, partialAfter);
      this.commitControl(candidate, revocations, partialAfter);
      this.log(`desktop ${index}: revocation ahead of the local projection; tombstone at displayEpoch ${fromEpoch + 1}`);
      return { epoch: fromEpoch + 1, applied: true };
    }
    // existing.epoch > fromEpoch: a newer generation already stands, or this exact
    // revocation was already applied — the state controller would have produced is already
    // superseded, and a late arm of the older generation is refused by the bound. A
    // safe no-op — but a scope confirmation riding it must still be persisted.
    if (scopeComplete) this.persistUnchangedScope(partialAfter);
    return { epoch: existing.epoch, applied: false };
  }

  /**
   * Persists an UNCHANGED guard state when the request itself was a no-op but carried
   * controller's scope confirmation: the confirmation has to land on disk, or a reboot would
   * resurrect the partial marker and re-close the desktops it just freed.
   */
  private persistUnchangedScope(partialAfter: boolean): void {
    this.saveControl(this.control, this.appliedRevocations, partialAfter);
    this.commitControl(this.control, this.appliedRevocations, partialAfter);
  }


  /** The epoch a desktop is guarded by, or undefined when the desktop is not managed. */
  controlEpoch(index: number): number | undefined {
    return this.control.get(index)?.epoch;
  }

  /**
   * Whether controller manages this desktop. A corrupt state file degrades the answer to
   * "possibly" for every desktop, and a partial file says it for every desktop absent
   * from the known set: routes then refuse projectionless ensure/control, and ordinary
   * calls stay closed until a trusted projection heals the file.
   */
  isManaged(index: number): boolean {
    return this.control.has(index) || this.guardDegraded || this.partial;
  }

  /**
   * The single check every ordinary display-scoped channel passes through (computer,
   * exec with a display, browser, teach begin/finish, record start/stop). Trusted
   * entries do not pass through here — they move the guard instead.
   */
  assertControl(index: number, presented: { epoch?: number; op_token?: string }): void {
    const standing = this.control.get(index);
    if (standing === undefined) {
      if (this.guardDegraded || this.partial) {
        throw new DisplayGuardError(
          `the managed set is ${this.guardDegraded ? "unreadable" : "partially known"}, so desktop ${index} ` +
            "cannot be proven unmanaged; ordinary calls stay closed until a trusted projection heals it"
        );
      }
      return;
    }
    if (!standing.reconciled) {
      throw new DisplayGuardError(
        `desktop ${index} is externally managed and awaiting reconciliation after a boxd restart; ` +
          "ordinary calls are closed until controller's projection update reopens it"
      );
    }
    if (presented.epoch !== standing.epoch) {
      throw new DisplayGuardError(
        `epoch_mismatch: desktop ${index} is bound to displayEpoch ${standing.epoch}; ` +
          (presented.epoch === undefined
            ? "this call carries no epoch"
            : presented.epoch < standing.epoch
              ? `epoch ${presented.epoch} is from a superseded control incarnation`
              : `epoch ${presented.epoch} is ahead of this box's bound generation; refetch the projection`) +
          ". Refetch the desktop control state and retry with the current epoch."
      );
    }
    if (standing.revoked) {
      throw new DisplayGuardError(
        `grant_revoked: desktop ${index}'s operation grant was revoked and none stands; ` +
          "ordinary calls are refused until a new projection arms it"
      );
    }
    if (standing.opToken !== undefined && presented.op_token !== standing.opToken) {
      throw new DisplayGuardError(
        `op_token revoked: desktop ${index}'s standing operation grant was revoked; ` +
          "presented token does not match (or is absent)"
      );
    }
  }

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
          START_DISPLAY,
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
      const path = join(COMPONENT_LOG_DIR, `${component}-${index}.log`);
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
      .map(desktop => {
        const user = this.userInControl(desktop.index);
        return {
          index: desktop.index,
          display: desktop.display,
          resolution: desktop.detection?.resolution,
          vnc_path: DisplayManager.vncPath(desktop.index),
          controller: user === undefined ? ("agent" as const) : ("user" as const),
          ...(user !== undefined ? { user_until: new Date(user.until).toISOString() } : {}),
        };
      });
  }

  /**
   * A person takes the desktop. Renewable: clicking Take over again extends the lease.
   * The desktop must exist — there is nothing to take over on a screen nobody started.
   */
  takeOver(index: number, ttlMs = USER_CONTROL_TTL_MS): { since: number; until: number } {
    const desktop = this.desktops.get(index);
    if (desktop === undefined) throw new Error(`Desktop ${index} is not running, so there is nothing to take over.`);
    const now = Date.now();
    const since = desktop.userControl !== undefined && desktop.userControl.until > now ? desktop.userControl.since : now;
    desktop.userControl = { since, until: now + Math.max(1_000, ttlMs) };
    desktop.executor?.invalidateElements();
    this.log(`desktop ${index}: a person took over (until ${new Date(desktop.userControl.until).toISOString()})`);
    return desktop.userControl;
  }

  /** The person hands the desktop back. Idempotent. */
  handBack(index: number): void {
    const desktop = this.desktops.get(index);
    if (desktop?.userControl === undefined) return;
    desktop.executor?.invalidateElements();
    delete desktop.userControl;
    this.log(`desktop ${index}: handed back to the agent`);
  }

  /** The current takeover, or undefined once it lapsed or was handed back. */
  userInControl(index: number): { since: number; until: number } | undefined {
    const desktop = this.desktops.get(index);
    if (desktop?.userControl === undefined) return undefined;
    if (desktop.userControl.until <= Date.now()) {
      desktop.executor?.invalidateElements();
      delete desktop.userControl;
      return undefined;
    }
    return desktop.userControl;
  }

  /** Refuses an agent's write while a person holds the desktop. */
  assertAgentControls(index: number): void {
    const user = this.userInControl(index);
    if (user === undefined) return;
    const minutes = Math.max(1, Math.round((user.until - Date.now()) / 60_000));
    throw new UserInControlError(
      `USER_IN_CONTROL: a person has taken over desktop ${index} (since ${new Date(user.since).toISOString()}). ` +
        `It returns to you when they hand it back, or in about ${minutes} min. Wait with WaitForControl, ` +
        "or do work that needs no screen — bash and the file tools still work."
    );
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

  /**
   * Whether an agent currently holds this desktop, by the record that outlives a restart.
   * What boot consults before bringing up the default desktop: one that is an agent's is left
   * to that agent, who presents its token on its next call.
   */
  isClaimed(index: number): boolean {
    return recordedOwner(index).status === "owned";
  }

  async ensure(index = DEFAULT_DISPLAY_INDEX, owner?: string): Promise<Desktop> {
    if (!isDisplayIndex(index)) {
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
        existing.executor?.invalidateElements();
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
      START_DISPLAY,
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
