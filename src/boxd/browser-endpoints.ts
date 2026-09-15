/**
 * Per-desktop attachment to an externally owned CDP browser. The box administrator
 * registers an address reachable from this box, an opaque instance identity, and
 * monotonically increasing endpoint epochs. Address reuse is not identity reuse.
 *
 * The registry never launches, restarts or retries an external application. Exact
 * registration replays preserve CDP sessions. A replacement invalidates cached pages.
 * A daemon restart retains identity floors but requires a current-boot administrator
 * snapshot before driving managed desktops. No heartbeat interval is prescribed.
 * Unregistered desktops retain the built-in browser path on a fresh installation.
 * See docs/55-external-desktops.md for authority and recovery boundaries.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_DISPLAY_INDEX } from "./displays.ts";

/** Where the registry persists per-desktop high-water marks. Overridable for tests. */
export const ENDPOINT_DATA_DIR = process.env.BOXD_DATA_DIR ?? "/home/box/work/.boxd";

const PERSIST_FILE = "endpoints.json";

/** Refused registrations and unregistrations: answered as HTTP 409. */
export class EndpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointConflictError";
  }
}

/**
 * The registry could not persist a state it was about to publish. Answered as HTTP 500:
 * the in-memory half is deliberately NOT advanced, so a restart can never forget a high
 * water the disk does not hold — controller's retry re-arrives at the prior, consistent state.
 */
export class EndpointPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointPersistenceError";
  }
}

export interface BrowserEndpoint {
  host: string;
  port: number;
  generation: number;
  browserInstanceId: string;
  endpointEpoch: number;
  /** Last registration touch, for freshness bookkeeping on an idempotent refresh. */
  at: number;
}

/**
 * The identity a browser connection is bound to — what the registry knew when the socket
 * opened. A cached page is valid only while the registry still names this exact
 * incarnation: the same host:port can front a newer browser (a successor reuses the
 * service address), so an address comparison cannot tell them apart.
 */
export interface EndpointBinding {
  host: string;
  port: number;
  generation: number;
  browserInstanceId: string;
  endpointEpoch: number;
}

export function sameEndpointBinding(a: EndpointBinding, b: EndpointBinding): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.generation === b.generation &&
    a.browserInstanceId === b.browserInstanceId &&
    a.endpointEpoch === b.endpointEpoch
  );
}

/** What is written to disk: the high water and the identity behind it, outliving boxd. */
interface PersistedDisplay {
  highWaterEpoch: number;
  generation: number;
  browserInstanceId: string;
  host: string;
  port: number;
  /** controller confirmed this instance terminated; the high water still stands. */
  terminated: boolean;
}

type PersistedFile = {
  displays: Record<string, PersistedDisplay>;
  /**
   * True while the managed set is known to be incomplete: the file was rebuilt after
   * corruption, and desktops absent from `displays` are unknown, not unmanaged. A boot
   * over a partial file keeps unlisted desktops blocked until controller's trusted scope
   * confirmation (a reconcile-token-bearing call with scope_complete) rewrites it.
   */
  partial?: boolean;
};

/** How a registration request was judged; the caller acts on "replaced" only. */
export type EndpointOutcome = "registered" | "refreshed" | "restored" | "replaced";

export interface EndpointRegistration {
  outcome: EndpointOutcome;
  endpoint: BrowserEndpoint;
}

export interface UnregisterResult {
  cleared: boolean;
}

/**
 * Where a desktop's browser lives right now, as /browser and teach snapshots must see it.
 * "endpoint" is an externally registered (or env-seeded) browser — never auto-spawned.
 * "blocked" is the external world with nothing usable yet: a restart whose gate controller has
 * not reconciled, or a terminated instance awaiting its successor. "local" is the box's
 * own Chromium on 127.0.0.1:9222+N, started on demand as before.
 */
export type EndpointResolution =
  | { kind: "endpoint"; endpoint: BrowserEndpoint }
  | { kind: "blocked"; reason: string }
  | { kind: "local" };

interface RegisterInput {
  index: number;
  host: string;
  port: number;
  generation: number;
  browserInstanceId: string;
  endpointEpoch: number;
  reconcileToken?: string;
  /** controller's trusted confirmation that the managed set named on disk is complete. */
  scopeComplete?: boolean;
}

function sameIdentity(a: PersistedDisplay, b: RegisterInput): boolean {
  return (
    a.generation === b.generation &&
    a.browserInstanceId === b.browserInstanceId &&
    a.host === b.host &&
    a.port === b.port
  );
}

function fiveTupleEquals(endpoint: BrowserEndpoint, input: RegisterInput): boolean {
  return (
    endpoint.host === input.host &&
    endpoint.port === input.port &&
    endpoint.generation === input.generation &&
    endpoint.browserInstanceId === input.browserInstanceId &&
    endpoint.endpointEpoch === input.endpointEpoch
  );
}

/** A plain object used as a map — never null, never an array. */
function isPlainMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses the startup-env fallback: BOXD_CDP_DISPLAY_<N>=host:port seeds desktop N's
 * endpoint when controller has registered nothing. Explicit configuration, so it suppresses
 * the box-chrome auto-launch exactly like a registration does.
 */
export function envEndpoints(env: NodeJS.ProcessEnv = process.env): Map<number, { host: string; port: number }> {
  const parsed = new Map<number, { host: string; port: number }>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^BOXD_CDP_DISPLAY_(\d+)$/.exec(key);
    if (match === null || value === undefined) continue;
    const index = Number(match[1]);
    const cut = value.lastIndexOf(":");
    if (!Number.isInteger(index) || index < 1 || index > MAX_DISPLAY_INDEX || cut <= 0) continue;
    const host = value.slice(0, cut);
    const port = Number(value.slice(cut + 1));
    if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    parsed.set(index, { host, port });
  }
  return parsed;
}

export class BrowserEndpointRegistry {
  private readonly live = new Map<number, BrowserEndpoint>();
  private readonly persisted = new Map<number, PersistedDisplay>();
  /**
   * The reconciliation gate, per desktop that has persisted state. Absent means open:
   * a desktop controller never touched has nothing to reconcile. Present and false means a
   * restart just happened and only a trusted controller snapshot may reopen it.
   */
  private readonly gateOpen = new Map<number, boolean>();
  private readonly env: Map<number, { host: string; port: number }>;
  /**
   * This boot's reconciliation token, minted fresh on every start (or shared with the
   * display guard's — one token per boot). Only a registration or unregister carrying
   * it counts as controller's *current* snapshot: the bridge reads it from this boxd each
   * cycle, so it can never ride in a delayed message from before the restart. A delayed
   * replay — at the high water or above it — without the token is an ordinary late
   * registration and is refused like one; a higher stale value sorts after the high
   * water but does not prove the message is current.
   */
  private readonly bootToken: string;
  /**
   * The persisted state file exists but could not be parsed. Unlike "absent" (a box
   * controller never touched), this is an anomaly we refuse to silently read as "fresh
   * system". Recovery is per-desktop: a desktop controller registers (and whose write
   * therefore lands) becomes known again; every other desktop stays blocked — one
   * display's clean write proves nothing about the lost records of the others
   *.
   */
  private degraded = false;
  /**
   * True while the managed set is known to be incomplete (loaded from a partial file,
   * or saved while recovering from one). Desktops with neither a live endpoint nor a
   * persisted record are unknown, not unmanaged: they resolve "blocked" until controller's
   * trusted scope confirmation clears the flag.
   */
  private partial = false;
  /** Desktops re-established by a successful registration while degraded. */
  private readonly healed = new Set<number>();

  constructor(
    private readonly log: (line: string) => void = () => {},
    private readonly dataDir: string = ENDPOINT_DATA_DIR,
    env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = () => Date.now(),
    bootToken?: string
  ) {
    this.bootToken = bootToken ?? randomUUID();
    this.env = envEndpoints(env);
    this.load();
  }

  /** Presented by the bridge to bind its reconciliation calls to this boxd boot. */
  get reconcileToken(): string {
    return this.bootToken;
  }

  private persistPath(): string {
    return join(this.dataDir, PERSIST_FILE);
  }

  private load(): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.persistPath(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return; // never persisted: fresh box
      this.degraded = true;
      this.log(
        `endpoint registry: ${this.persistPath()} could not be read or parsed ` +
          `(${error instanceof Error ? error.message : String(error)}); refusing to guess which desktops are unmanaged`
      );
      return;
    }
    // Structural validation, exhaustively: a file this daemon wrote is always a plain
    // object with a displays map; anything else — array, null, missing or mistyped
    // maps — is corruption, and corruption must fail closed, never read as unmanaged
    // and never crash the boot.
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed) ||
      !isPlainMap((parsed as PersistedFile).displays) ||
      ((parsed as PersistedFile).partial !== undefined && typeof (parsed as PersistedFile).partial !== "boolean")
    ) {
      this.degraded = true;
      this.log(`endpoint registry: ${this.persistPath()} is structurally invalid; failing closed per desktop`);
      return;
    }
    const file = parsed as PersistedFile;
    for (const [key, record] of Object.entries(file.displays)) {
      const index = Number(key);
      if (
        !Number.isInteger(index) ||
        index < 1 ||
        index > MAX_DISPLAY_INDEX ||
        !isPlainMap(record) ||
        typeof record.highWaterEpoch !== "number" ||
        !Number.isFinite(record.highWaterEpoch) ||
        typeof record.generation !== "number" ||
        !Number.isFinite(record.generation) ||
        typeof record.browserInstanceId !== "string" ||
        typeof record.host !== "string" ||
        typeof record.port !== "number"
      ) {
        // A corrupt record must not silently disappear — its desktop would read as
        // unmanaged. The whole file fails closed instead, and per-desktop trusted
        // recovery can heal it.
        this.persisted.clear();
        this.gateOpen.clear();
        this.degraded = true;
        this.log(`endpoint registry: ${this.persistPath()} has a corrupt record for ${JSON.stringify(key)}; failing closed`);
        return;
      }
      this.persisted.set(index, { ...record, terminated: record.terminated === true });
      this.gateOpen.set(index, false);
    }
    // A partial file names a known-incomplete managed set: desktops absent from it are
    // unknown, and stay blocked until controller's trusted scope confirmation.
    this.partial = file.partial === true;
    if (this.persisted.size > 0 || this.partial) {
      this.log(
        `endpoint registry: ${this.persisted.size} desktop(s) have a persisted epoch high water` +
          (this.partial ? " (partial set — unlisted desktops unknown)" : "") +
          "; their external-operation gate stays closed until controller's registration reconciles them"
      );
    }
  }

  /**
   * Writes the candidate state and returns only once it is on disk. The caller commits
   * it to memory after this succeeds; a failure leaves both the disk and the published
   * state at the prior generation, so a restart can never accept an epoch the box had
   * accepted only in memory. A successful write heals a degraded state file.
   */
  private save(candidate: Map<number, PersistedDisplay>, partial: boolean): void {
    const displays: Record<string, PersistedDisplay> = {};
    for (const [index, record] of candidate) displays[String(index)] = record;
    const temp = `${this.persistPath()}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dataDir, { recursive: true });
      // Temp-plus-rename, the same discipline as the desktop owner files: a reader never
      // sees a half-written record, and a torn write leaves the previous record intact.
      writeFileSync(
        temp,
        `${JSON.stringify({ displays, ...(partial ? { partial: true } : {}) } satisfies PersistedFile, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
      renameSync(temp, this.persistPath());
    } catch (error) {
      try {
        rmSync(temp, { force: true });
      } catch {
        // best effort
      }
      throw new EndpointPersistenceError(
        `endpoint registry could not persist to ${this.dataDir}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // A successful write does not clear the global degraded or partial flags: one
    // display's clean record cannot restore what the corrupt file lost for the others.
    // They lift when controller's trusted scope confirmation arrives, or a boot loads a
    // complete file.
  }

  /** Every save while the set is incomplete keeps the partial marker on disk. */
  private nextPartial(): boolean {
    return this.degraded || this.partial;
  }

  /**
   * controller's trusted scope confirmation: the managed set named on disk is complete again.
   * The only thing that clears degraded/partial — one boot's healthy write proves its
   * own state, but only controller can say no desktop is still missing.
   */
  private completeScope(): void {
    this.degraded = false;
    this.partial = false;
    this.log("endpoint registry: controller confirmed the managed scope; recovery complete");
  }

  /** Persist the accepted target and scope confirmation together before publishing either. */
  private persistCandidate(candidate: Map<number, PersistedDisplay>, scopeComplete = false): void {
    this.save(candidate, scopeComplete ? false : this.nextPartial());
    const committed = new Map(candidate);
    this.persisted.clear();
    for (const [index, state] of committed) this.persisted.set(index, state);
    if (scopeComplete) this.completeScope();
  }

  private assertIndex(index: number): void {
    if (!Number.isInteger(index) || index < 1 || index > MAX_DISPLAY_INDEX) {
      throw new EndpointConflictError(`Display index must be an integer between 1 and ${MAX_DISPLAY_INDEX}.`);
    }
  }

  /**
   * Registers or reconciles a desktop's endpoint. The decision order preserves identity before freshness:
   * five-tuple identical → idempotent refresh; epoch below the known → session_superseded;
   * same epoch with a different instance or endpoint → conflict; higher epoch → replace.
   * While the restart gate is closed only controller's snapshot is trusted: below the high
   * water is refused outright, equal restores only the still-valid same identity, higher
   * replaces and reopens the gate.
   */
  register(input: RegisterInput): EndpointRegistration {
    this.assertIndex(input.index);
    if (
      input.host === "" ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65535 ||
      !Number.isFinite(input.generation) ||
      input.browserInstanceId === "" ||
      !Number.isFinite(input.endpointEpoch)
    ) {
      throw new EndpointConflictError(
        "endpoint registration needs host, port, generation, browserInstanceId and endpointEpoch"
      );
    }
    const { index } = input;
    const trusted = input.reconcileToken !== undefined && input.reconcileToken === this.bootToken;
    // Recovery from a corrupt or partial state is itself trusted work: only a message
    // bound to this boot may (re)establish any desktop while the managed set is
    // unknown — a stale epoch-1 registration is a delayed message, not the current
    // snapshot.
    if ((this.degraded || this.partial) && !trusted) {
      throw new EndpointConflictError(
        "the managed set is being recovered; a registration without this boot's reconcile token " +
          "is a delayed message, not controller's current snapshot"
      );
    }
    if (input.scopeComplete === true && !trusted) {
      throw new EndpointConflictError("scope confirmation requires this boot's reconcile token");
    }
    const persisted = this.persisted.get(index);
    const live = this.live.get(index);

    if (live !== undefined && fiveTupleEquals(live, input)) {
      // controller's heartbeat: same five-tuple. Touch and leave sessions and caches alone.
      if (input.scopeComplete) this.persistCandidate(this.persisted, true);
      live.at = this.now();
      return { outcome: "refreshed", endpoint: { ...live } };
    }

    if (this.gateOpen.get(index) === false) {
      // Restart reconciliation: the persisted high water is the only truth until controller's
      // *current* snapshot speaks — and only a message carrying this boot's reconcile
      // token can be that. Without it, ANY registration is a delayed message, at the
      // high water or above it: a higher stale value sorts after the high water but
      // does not prove freshness: ordinary late registrations cannot complete reconciliation.
      const trusted = input.reconcileToken !== undefined && input.reconcileToken === this.bootToken;
      if (!trusted) {
        throw new EndpointConflictError(
          `session_superseded: desktop ${index} is awaiting controller's current snapshot; a registration ` +
            "without this boot's reconcile token is a late message, not the trusted snapshot"
        );
      }
      if (input.endpointEpoch < persisted!.highWaterEpoch) {
        throw new EndpointConflictError(
          `session_superseded: desktop ${index} knows endpointEpoch ${persisted!.highWaterEpoch}; ` +
            `${input.endpointEpoch} is a late registration from an older browser incarnation`
        );
      }
      if (input.endpointEpoch === persisted!.highWaterEpoch) {
        if (persisted!.terminated) {
          throw new EndpointConflictError(
            `session_superseded: the instance registered on desktop ${index} was terminated; ` +
              "its registrations are not restored"
          );
        }
        if (!sameIdentity(persisted!, input)) {
          throw new EndpointConflictError(
            `session_superseded: desktop ${index} already knows epoch ${input.endpointEpoch} from ` +
              "another instance"
          );
        }
        if (input.scopeComplete) this.persistCandidate(this.persisted, true);
        const restored: BrowserEndpoint = { ...input, at: this.now() };
        this.live.set(index, restored);
        this.gateOpen.set(index, true);
        this.log(`desktop ${index}: endpoint restored at ${input.host}:${input.port} (epoch ${input.endpointEpoch})`);
        return { outcome: "restored", endpoint: { ...restored } };
      }
      // Strictly newer than the high water, and trusted as this boot's current snapshot:
      // the current incarnation, replacing whatever the restart orphaned.
      const endpoint = this.replace(index, input, persisted!);
      this.gateOpen.set(index, true);
      return { outcome: "replaced", endpoint };
    }

    if (live !== undefined) {
      if (input.endpointEpoch < live.endpointEpoch) {
        throw new EndpointConflictError(
          `session_superseded: desktop ${index} knows endpointEpoch ${live.endpointEpoch}; ` +
            `${input.endpointEpoch} is a late registration from an older browser incarnation`
        );
      }
      if (input.endpointEpoch === live.endpointEpoch) {
        throw new EndpointConflictError(
          `session_superseded: desktop ${index} already knows epoch ${input.endpointEpoch} from ` +
            "another instance or endpoint"
        );
      }
      // Strictly newer epoch: the sole path that swaps the live endpoint. The caller
      // closes the old CDP session and clears the page caches on this outcome.
      const endpoint = this.replace(index, input, persisted);
      return { outcome: "replaced", endpoint };
    }

    if (persisted !== undefined) {
      if (input.endpointEpoch < persisted.highWaterEpoch) {
        throw new EndpointConflictError(
          `session_superseded: desktop ${index} knows endpointEpoch ${persisted.highWaterEpoch}; ` +
            `${input.endpointEpoch} is a late registration from an older browser incarnation`
        );
      }
      if (input.endpointEpoch === persisted.highWaterEpoch) {
        if (persisted.terminated) {
          throw new EndpointConflictError(
            `session_superseded: the instance registered on desktop ${index} was terminated; ` +
              "its registrations are not restored"
          );
        }
        if (!sameIdentity(persisted, input)) {
          throw new EndpointConflictError(
            `session_superseded: desktop ${index} already knows epoch ${input.endpointEpoch} from ` +
              "another instance"
          );
        }
        if (input.scopeComplete) this.persistCandidate(this.persisted, true);
        const restored: BrowserEndpoint = { ...input, at: this.now() };
        this.live.set(index, restored);
        this.log(`desktop ${index}: endpoint restored at ${input.host}:${input.port} (epoch ${input.endpointEpoch})`);
        return { outcome: "restored", endpoint: { ...restored } };
      }
    }

    // First registration this desktop has ever taken (or the first since termination).
    // Write the high water before publishing anything: a failed persist must leave the
    // box exactly as if the registration had never arrived.
    const endpoint: BrowserEndpoint = { ...input, at: this.now() };
    const candidate = new Map(this.persisted);
    candidate.set(index, {
      highWaterEpoch: input.endpointEpoch,
      generation: input.generation,
      browserInstanceId: input.browserInstanceId,
      host: input.host,
      port: input.port,
      terminated: false,
    });
    this.persistCandidate(candidate, input.scopeComplete);
    this.healed.add(index);
    this.live.set(index, endpoint);

    this.log(
      `desktop ${index}: endpoint registered at ${input.host}:${input.port} ` +
        `(instance ${input.browserInstanceId}, epoch ${input.endpointEpoch})`
    );
    return { outcome: "registered", endpoint: { ...endpoint } };
  }

  /** Stores the new live endpoint and raises the persisted high water. */
  private replace(index: number, input: RegisterInput, persisted: PersistedDisplay | undefined): BrowserEndpoint {
    const endpoint: BrowserEndpoint = { ...input, at: this.now() };
    const candidate = new Map(this.persisted);
    candidate.set(index, {
      highWaterEpoch: Math.max(persisted?.highWaterEpoch ?? 0, input.endpointEpoch),
      generation: input.generation,
      browserInstanceId: input.browserInstanceId,
      host: input.host,
      port: input.port,
      terminated: false,
    });
    this.persistCandidate(candidate, input.scopeComplete);
    this.healed.add(index);
    this.live.set(index, endpoint);

    this.log(
      `desktop ${index}: endpoint replaced → ${input.host}:${input.port} ` +
        `(instance ${input.browserInstanceId}, epoch ${input.endpointEpoch}${persisted ? `, was ${persisted.highWaterEpoch}` : ""})`
    );
    return endpoint;
  }

  /**
   * Conditional unregister (controller closing a context, or confirming an instance's death).
   * Executes only when the presented browserInstanceId matches what stands — a late
   * unregister from a replaced instance must never delete the new registration. The high
   * water and a termination marker are kept: a successor registers with a higher epoch.
   * While the restart gate is closed, an unregister counts only when it carries this
   * boot's reconcile token — an unauthenticated-by-freshness termination claim is just
   * another late message.
   */
  unregister(
    index: number,
    browserInstanceId: string,
    endpointEpoch?: number,
    reconcileToken?: string,
    scopeComplete = false
  ): UnregisterResult {
    this.assertIndex(index);
    const persisted = this.persisted.get(index);
    const live = this.live.get(index);
    const gateClosed = this.gateOpen.get(index) === false;
    const trusted = reconcileToken !== undefined && reconcileToken === this.bootToken;

    if ((this.degraded || this.partial) && !trusted) {
      throw new EndpointConflictError(
        "the managed set is being recovered; an unregister without this boot's reconcile token " +
          "is a delayed message, not controller's current snapshot"
      );
    }
    if (scopeComplete && !trusted) {
      throw new EndpointConflictError("scope confirmation requires this boot's reconcile token");
    }

    if (gateClosed && !trusted) {
      throw new EndpointConflictError(
        `session_superseded: desktop ${index} is awaiting controller's current snapshot; an unregister without ` +
          "this boot's reconcile token is a late message, not the trusted confirmation"
      );
    }

    if (endpointEpoch !== undefined && persisted !== undefined && endpointEpoch < persisted.highWaterEpoch) {
      throw new EndpointConflictError(
        `session_superseded: desktop ${index} knows endpointEpoch ${persisted.highWaterEpoch}; ` +
          `${endpointEpoch} is a late unregister from an older browser incarnation`
      );
    }

    if (live !== undefined) {
      if (live.browserInstanceId !== browserInstanceId) {
        throw new EndpointConflictError(
          `desktop ${index}'s registration belongs to another browser instance; ` +
            "the unregister does not apply to it"
        );
      }
      const candidate = new Map(this.persisted);
      candidate.set(index, {
        highWaterEpoch: live.endpointEpoch,
        generation: live.generation,
        browserInstanceId: live.browserInstanceId,
        host: live.host,
        port: live.port,
        terminated: true,
      });
      this.persistCandidate(candidate, scopeComplete);
      this.healed.add(index);
      this.live.delete(index);
      this.gateOpen.set(index, true);
      this.log(`desktop ${index}: endpoint cleared (instance ${browserInstanceId} terminated)`);
      return { cleared: true };
    }

    if (persisted !== undefined) {
      if (persisted.browserInstanceId !== browserInstanceId) {
        throw new EndpointConflictError(
          `desktop ${index}'s recorded instance is another one; the unregister does not apply to it`
        );
      }
      // controller confirms the instance is gone. No live endpoint to clear (typically after a
      // boxd restart); what matters is the termination marker that keeps a late heartbeat
      // from resurrecting it.
      const candidate = new Map(this.persisted);
      candidate.set(index, { ...persisted, terminated: true });
      this.persistCandidate(candidate, scopeComplete);
      this.healed.add(index);
      this.gateOpen.set(index, true);
      this.log(`desktop ${index}: instance ${browserInstanceId} recorded as terminated`);
      return { cleared: false };
    }

    if (scopeComplete) this.persistCandidate(this.persisted, true);
    return { cleared: false }; // Nothing was registered: already the desired state.
  }

  /** Whether controller's snapshot has reconciled this desktop after a restart. */
  externalOpsOpen(index: number): boolean {
    return this.gateOpen.get(index) !== false;
  }

  /** The incarnation the desktop's live endpoint names, for connection binding checks. */
  currentBinding(index: number): EndpointBinding | undefined {
    const live = this.live.get(index);
    if (live === undefined) return undefined;
    const { host, port, generation, browserInstanceId, endpointEpoch } = live;
    return { host, port, generation, browserInstanceId, endpointEpoch };
  }

  /**
   * Resolves where desktop `index`'s browser lives. This is the single place /browser
   * and teach snapshots consult; it never invents an endpoint and it never consults the
   * box-chrome default when an external registration stands (or stood) for the desktop.
   */
  resolve(index: number): EndpointResolution {
    const live = this.live.get(index);
    if (live !== undefined) return { kind: "endpoint", endpoint: { ...live } };

    const persisted = this.persisted.get(index);
    if (persisted !== undefined) {
      if (this.gateOpen.get(index) === false) {
        return {
          kind: "blocked",
          reason:
            `Desktop ${index}'s browser endpoint is awaiting reconciliation after a boxd restart ` +
            "(controller's next registration heartbeat restores it); not driving anything else meanwhile.",
        };
      }
      return {
        kind: "blocked",
        reason:
          `Desktop ${index}'s registered browser endpoint is gone (its instance was terminated or ` +
          "unregistered); waiting for controller to register the current one.",
      };
    }

    if (this.partial) {
      // The managed set on disk is known to be incomplete: a desktop absent from it is
      // unknown, not unmanaged, and stays blocked until controller's trusted scope
      // confirmation rewrites the file.
      return {
        kind: "blocked",
        reason:
          `Desktop ${index}'s management state is partially known (recovery in progress); refusing ` +
          "to guess where its browser lives until controller confirms the managed scope.",
      };
    }

    if (this.degraded) {
      // The persisted state existed but could not be read: we cannot prove this desktop
      // is unmanaged, so we do not fall back to driving a local browser for it. Recovery
      // is per-desktop — a desktop controller re-registered is known again; the rest stay
      // blocked until their own trusted registration (or a restart over a healed file).
      if (!this.healed.has(index)) {
        return {
          kind: "blocked",
          reason:
            `Desktop ${index}'s endpoint state file is unreadable; refusing to guess where its browser ` +
            "lives until controller re-registers this desktop.",
        };
      }
      return { kind: "local" };
    }

    const seeded = this.env.get(index);
    if (seeded !== undefined) {
      return {
        kind: "endpoint",
        endpoint: {
          host: seeded.host,
          port: seeded.port,
          generation: 0,
          browserInstanceId: "",
          endpointEpoch: 0,
          at: 0,
        },
      };
    }

    return { kind: "local" };
  }
}
