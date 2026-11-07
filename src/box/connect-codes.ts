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
 *
 * An organisation's **node** (INV-1697, docs/96 §4) is the other way in: a machine the
 * organisation owns, enrolled when an Admin signs in to the organisation on it. Enrolling
 * issues one node credential (returned once, stored hashed); the node registers each of its
 * boxes with it, and a registration remembers its node. Enrolling the same node again issues a
 * new credential and the old one stops working; revoking the node revokes every box on it, and
 * a revoked node's credential is refused from then on.
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
  /** The organisation node this box is on (INV-1697); absent for a box that joined by a code. */
  nodeId?: string;
}

/** An organisation's node (INV-1697): who enrolled it, when it was last heard, whether it is cut off. */
export interface NodeRecord {
  id: string;
  name: string;
  /** Hash of the current node credential; the credential itself is the node's alone. */
  credentialHash: string;
  enrolledBy: string;
  enrolledAt: string;
  lastSeenAt?: string;
  version?: string;
  revoked?: { at: string; by: string };
}

/** A node as a list shows it: never the credential's hash. */
export type NodeView = Omit<NodeRecord, "credentialHash">;

interface ConnectFile {
  pending: PendingCode[];
  registrations: Registration[];
  nodes: NodeRecord[];
}

export type BoxConnectionState = "pending" | "connected" | "offline" | "revoked";

const hashOf = (secret: string): string => createHash("sha256").update(secret).digest("hex");

function nodeView(node: NodeRecord): NodeView {
  const { credentialHash: _hash, ...view } = node;
  return { ...view };
}

/** The installation prefix a code carries: the first eight characters of its own box id. */
export function installationPrefix(ownBoxId: string): string {
  return ownBoxId.replace(/^box_/, "").slice(0, 8);
}

export class ConnectCodeStore {
  private pending: PendingCode[] = [];
  private registrations: Registration[] = [];
  private nodes: NodeRecord[] = [];

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
      this.nodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
    } catch {
      // A broken file is an empty store: every code is unknown, which is the safe direction.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ pending: this.pending, registrations: this.registrations, nodes: this.nodes }, null, 2)}\n`, { mode: 0o600 });
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

  /**
   * Records a registration and issues the runner its credential (returned once). A node's box
   * carries its node instead: the node credential is what it reconnects with.
   */
  register(input: { boxId: string; name: string; version?: string; nodeId?: string }): string {
    const credential = `lbxr_${randomBytes(24).toString("base64url")}`;
    const at = this.now().toISOString();
    this.registrations = [
      ...this.registrations.filter(entry => entry.boxId !== input.boxId),
      { boxId: input.boxId, name: input.name, runnerHash: hashOf(credential), registeredAt: at, lastSeenAt: at, ...(input.version !== undefined ? { version: input.version } : {}), ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}) },
    ];
    this.persist();
    return credential;
  }

  /**
   * Enrols a node, or enrols the same node again: a new credential either way (returned once,
   * stored hashed), and the one it replaces stops working. A revoked node stays revoked and keeps
   * its name, so a machine that was cut off cannot sign its way back under the same name by
   * accident: enrolling it again is a new node, under a new name.
   */
  enrolNode(input: { name: string; by: string }): { ok: true; node: NodeView; credential: string } | { ok: false; why: "revoked" } {
    const existing = this.nodes.find(node => node.name === input.name);
    if (existing?.revoked !== undefined) return { ok: false, why: "revoked" };
    const credential = `lbxn_${randomBytes(24).toString("base64url")}`;
    const at = this.now().toISOString();
    const node: NodeRecord = existing !== undefined
      ? { ...existing, credentialHash: hashOf(credential), enrolledBy: input.by, enrolledAt: at }
      : { id: `node_${randomBytes(8).toString("hex")}`, name: input.name, credentialHash: hashOf(credential), enrolledBy: input.by, enrolledAt: at };
    this.nodes = [...this.nodes.filter(entry => entry.id !== node.id), node];
    this.persist();
    return { ok: true, node: nodeView(node), credential };
  }

  /** The node a node credential names, or a refusal: unknown (never issued, or replaced), or revoked. */
  verifyNode(credential: string): { ok: true; node: NodeView } | { ok: false; why: "unknown" | "revoked" } {
    const node = this.nodes.find(entry => entry.credentialHash === hashOf(credential.trim()));
    if (node === undefined) return { ok: false, why: "unknown" };
    if (node.revoked !== undefined) return { ok: false, why: "revoked" };
    return { ok: true, node: nodeView(node) };
  }

  /** A node was heard from: a box registration or a heartbeat. */
  nodeSeen(nodeId: string, version?: string): void {
    const node = this.nodes.find(entry => entry.id === nodeId);
    if (node === undefined) return;
    node.lastSeenAt = this.now().toISOString();
    if (version !== undefined) node.version = version;
    this.persist();
  }

  /** The registration of the box `name` on node `nodeId`, if it registered before. */
  nodeBox(nodeId: string, name: string): Registration | undefined {
    const entry = this.registrations.find(candidate => candidate.nodeId === nodeId && candidate.name === name);
    return entry === undefined ? undefined : { ...entry };
  }

  /** Revokes a node and every box on it; answers the boxes' ids, so the caller can cut each one off. */
  revokeNode(nodeId: string, by: string): string[] | undefined {
    const node = this.nodes.find(entry => entry.id === nodeId || entry.name === nodeId);
    if (node === undefined) return undefined;
    const at = this.now().toISOString();
    node.revoked ??= { at, by };
    const boxes = this.registrations.filter(entry => entry.nodeId === node.id);
    for (const entry of boxes) entry.revoked ??= { at, by };
    this.persist();
    return boxes.map(entry => entry.boxId);
  }

  /** Every node, with the boxes registered from it. */
  listNodes(): (NodeView & { boxes: Registration[] })[] {
    return this.nodes.map(node => ({ ...nodeView(node), boxes: this.registrations.filter(entry => entry.nodeId === node.id).map(entry => ({ ...entry })) }));
  }

  /** The boxes revoked here, so a restart cuts them off again before anything reconnects them. */
  revokedBoxIds(): string[] {
    return this.registrations.filter(entry => entry.revoked !== undefined).map(entry => entry.boxId);
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
