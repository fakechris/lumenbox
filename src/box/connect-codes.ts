/**
 * Connection codes and runner credentials (INV-434): how a machine somewhere else
 * becomes one of this installation's boxes without anyone pasting a daemon token
 * into a form.
 *
 * The lifecycle, in the words the states use:
 *
 *   pending   — an admin minted a code here; nothing has redeemed it. Fifteen minutes.
 *   connected — a runner redeemed it: its boxd is registered, reachable, answering.
 *   offline   — registered, not answering now. The runner reconnects with its own
 *               credential, which is idempotent: the same box, a new address if moved.
 *   revoked   — an admin cut it off. New connections and new work are refused; work
 *               already running on that machine is *not* known to have stopped, and
 *               nothing here claims it has.
 *
 * A code is one-time, bound to this installation (it carries the installation's own
 * box id), and expires. Redeeming it yields a runner credential that is not the code
 * and not the daemon token: it identifies the registration, and it is what a reconnect
 * presents. Codes and credentials are stored hashed; a list shows when a code expires
 * and who minted it, never the code.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CONNECT_CODE_TTL_MS = 15 * 60_000;

export interface PendingCode {
  hash: string;
  by: string;
  mintedAt: string;
  expiresAt: string;
  /** A name the admin chose for the box, when they did; the runner may still name itself. */
  name?: string;
}

export interface Registration {
  boxId: string;
  name: string;
  /** Hash of the runner credential; the credential itself is the runner's alone. */
  runnerHash: string;
  registeredAt: string;
  lastSeenAt: string;
  version?: string;
  revoked?: { at: string; by: string };
}

interface ConnectFile {
  pending: PendingCode[];
  registrations: Registration[];
}

export type BoxConnectionState = "pending" | "connected" | "offline" | "revoked";

const hashOf = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/** The installation prefix a code carries: the first eight characters of its own box id. */
export function installationPrefix(ownBoxId: string): string {
  return ownBoxId.replace(/^box_/, "").slice(0, 8);
}

export class ConnectCodeStore {
  private pending: PendingCode[] = [];
  private registrations: Registration[] = [];

  constructor(
    private readonly path: string,
    private readonly ownBoxId: string,
    private readonly now: () => Date = () => new Date()
  ) {
    this.reload();
  }

  private reload(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ConnectFile>;
      this.pending = Array.isArray(parsed.pending) ? parsed.pending : [];
      this.registrations = Array.isArray(parsed.registrations) ? parsed.registrations : [];
    } catch {
      // A broken file is an empty store: every code is unknown, which is the safe direction.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ pending: this.pending, registrations: this.registrations }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.path);
  }

  /** Mints a one-time code. The code is returned once and never stored. */
  mint(input: { by: string; name?: string; ttlMs?: number }): { code: string; expiresAt: string } {
    const at = this.now();
    const expiresAt = new Date(at.getTime() + (input.ttlMs ?? CONNECT_CODE_TTL_MS)).toISOString();
    const code = `lbx-${installationPrefix(this.ownBoxId)}-${randomBytes(12).toString("base64url")}`;
    this.pending = [...this.pending.filter(entry => Date.parse(entry.expiresAt) > at.getTime()), { hash: hashOf(code), by: input.by, mintedAt: at.toISOString(), expiresAt, ...(input.name !== undefined ? { name: input.name } : {}) }];
    this.persist();
    return { code, expiresAt };
  }

  /** Pending codes as a list may show them: expiry and who, never the code. */
  listPending(): { by: string; mintedAt: string; expiresAt: string; name?: string }[] {
    const now = this.now().getTime();
    return this.pending.filter(entry => Date.parse(entry.expiresAt) > now).map(({ hash: _hash, ...rest }) => rest);
  }

  /**
   * Spends a code. Refusals are named: a code from another installation is not "unknown"
   * — it is somebody's, pointed at the wrong place, and the runner should hear that.
   */
  redeem(code: string): { ok: true; name?: string } | { ok: false; why: "unknown" | "expired" | "used" | "wrong-installation" } {
    const match = /^lbx-([A-Za-z0-9]+)-/.exec(code.trim());
    if (match !== undefined && match !== null && match[1] !== installationPrefix(this.ownBoxId)) return { ok: false, why: "wrong-installation" };
    const hash = hashOf(code.trim());
    const entry = this.pending.find(candidate => candidate.hash === hash);
    if (entry === undefined) return { ok: false, why: this.spentHashes.has(hash) ? "used" : "unknown" };
    if (Date.parse(entry.expiresAt) <= this.now().getTime()) {
      this.pending = this.pending.filter(candidate => candidate !== entry);
      this.persist();
      return { ok: false, why: "expired" };
    }
    this.pending = this.pending.filter(candidate => candidate !== entry);
    this.spentHashes.add(hash);
    this.persist();
    return { ok: true, ...(entry.name !== undefined ? { name: entry.name } : {}) };
  }

  /** Codes spent in this process, so a replay is told "used" rather than "unknown". */
  private readonly spentHashes = new Set<string>();

  /** Records a registration and issues the runner its credential (returned once). */
  register(input: { boxId: string; name: string; version?: string }): string {
    const credential = `lbxr_${randomBytes(24).toString("base64url")}`;
    const at = this.now().toISOString();
    this.registrations = [
      ...this.registrations.filter(entry => entry.boxId !== input.boxId),
      { boxId: input.boxId, name: input.name, runnerHash: hashOf(credential), registeredAt: at, lastSeenAt: at, ...(input.version !== undefined ? { version: input.version } : {}) },
    ];
    this.persist();
    return credential;
  }

  /** The registration a runner credential names, or a refusal: unknown, or revoked. */
  verifyRunner(credential: string): { ok: true; registration: Registration } | { ok: false; why: "unknown" | "revoked" } {
    const entry = this.registrations.find(candidate => candidate.runnerHash === hashOf(credential.trim()));
    if (entry === undefined) return { ok: false, why: "unknown" };
    if (entry.revoked !== undefined) return { ok: false, why: "revoked" };
    return { ok: true, registration: entry };
  }

  /** A reconnect: the same registration, seen again, possibly a new version. */
  seen(boxId: string, version?: string): void {
    const entry = this.registrations.find(candidate => candidate.boxId === boxId);
    if (entry === undefined) return;
    entry.lastSeenAt = this.now().toISOString();
    if (version !== undefined) entry.version = version;
    this.persist();
  }

  revoke(boxId: string, by: string): boolean {
    const entry = this.registrations.find(candidate => candidate.boxId === boxId);
    if (entry === undefined) return false;
    entry.revoked = { at: this.now().toISOString(), by };
    this.persist();
    return true;
  }

  registrationOf(boxId: string): Registration | undefined {
    const entry = this.registrations.find(candidate => candidate.boxId === boxId);
    return entry === undefined ? undefined : { ...entry };
  }

  isRevoked(boxId: string): boolean {
    return this.registrations.find(candidate => candidate.boxId === boxId)?.revoked !== undefined;
  }

  /** The state a list shows, given whether the box is answering right now. */
  stateOf(boxId: string, connected: boolean): BoxConnectionState | undefined {
    const entry = this.registrations.find(candidate => candidate.boxId === boxId);
    if (entry === undefined) return undefined;
    if (entry.revoked !== undefined) return "revoked";
    return connected ? "connected" : "offline";
  }
}
