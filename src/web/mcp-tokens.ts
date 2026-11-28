/**
 * Side-door tokens that outlive a restart (INV-1520).
 *
 * They lived in the web process's memory, on the reasoning that a token which dies with the
 * process is one nobody has to remember to revoke, and that persisting them should wait until
 * a client minded. A resident watchdog minds: the first app restart locked it out for good, and
 * every IDE with the door configured with it.
 *
 * What is kept is the sha256 of each token beside whose it is, its label and when it was made —
 * never the secret, which is still shown once, when it is issued. A presented token is hashed
 * and compared in constant time. The file is 0600 and replaced whole on every change.
 *
 * The client API's tokens live here too (docs/106 §4.3, INV-2213): a **personal** token (`lbxp_`)
 * for a person's script and a **service** token (`lbxs_`) an Admin mints for a named integration,
 * each with an id, scopes, an expiry, when it was last used and, for a service token, its view.
 * The side door takes only its own (`lmbx_`, no `kind`), and `/api/v1` only these.
 */

import type { TokenRecord } from "./token-ledger.ts";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Principals } from "../host/principals.ts";
import type { ClientTokenKind, Scope, ServiceView } from "./client-api/schema.ts";

export interface StoredToken {
  hash: string;
  principalId: string;
  /** What `principalId` is: a sign-in (absent on tokens older than the field) or a roster id, minted with nobody signed in. */
  via?: "sign-in" | "person";
  label: string;
  createdAt: string;
  /** A client API token; absent on a side-door token. The fields below are a client token's. */
  kind?: ClientTokenKind;
  /** What revoking it names; public, unlike the token. */
  id?: string;
  scopes?: Scope[];
  expiresAt?: string;
  /** To the minute: written at most once a minute per token. */
  lastUsedAt?: string;
  /** A service token's: what it may read. */
  view?: ServiceView;
}

/** A client token as its holder and the page see it: never the secret, never the hash. */
export interface ClientCredential {
  id: string;
  kind: ClientTokenKind;
  principalId: string;
  label: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  view?: ServiceView;
}

const CLIENT_PREFIX: Record<ClientTokenKind, string> = { personal: "lbxp_", service: "lbxs_" };
const credentialOf = (entry: StoredToken): ClientCredential => ({
  id: entry.id!, kind: entry.kind!, principalId: entry.principalId, label: entry.label, scopes: [...(entry.scopes ?? [])], createdAt: entry.createdAt, expiresAt: entry.expiresAt!,
  ...(entry.lastUsedAt !== undefined ? { lastUsedAt: entry.lastUsedAt } : {}), ...(entry.view !== undefined ? { view: entry.view } : {}),
});

const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export class McpTokenStore {
  private tokens: StoredToken[] = [];

  /**
   * `path` undefined: memory only, as the tests and a home-less run want. `record` is told of each
   * token minted and revoked — who for, which label, who did it — never the secret (token-ledger.ts).
   */
  constructor(private readonly path?: string, warn: (line: string) => void = () => {}, private readonly record: (record: TokenRecord) => void = () => {}) {
    if (path === undefined || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { tokens?: StoredToken[] };
      this.tokens = (parsed.tokens ?? []).filter(entry => typeof entry.hash === "string" && typeof entry.principalId === "string");
    } catch (error) {
      // Unreadable is not "no tokens, start over": that would silently lock every client out on a parse
      // error and then overwrite the evidence. Say so, keep the file, run with none until it is looked at.
      warn(`mcp tokens: ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); no side-door token is accepted until it is fixed`);
      this.readOnly = true;
    }
  }

  private readOnly = false;

  private save(): void {
    if (this.path === undefined || this.readOnly) return;
    const partial = `${this.path}.partial`;
    writeFileSync(partial, `${JSON.stringify({ tokens: this.tokens }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(partial, 0o600);
    renameSync(partial, this.path);
  }

  /** A new token for a person; the secret is in the answer and nowhere else. */
  mint(principalId: string, label: string, now: Date = new Date(), via: "sign-in" | "person" = "sign-in", by?: string): { token: string; label: string; createdAt: string } {
    const token = `lmbx_${randomBytes(24).toString("hex")}`;
    const entry: StoredToken = { hash: hashOf(token), principalId, via, label: label.trim().slice(0, 60) || "unnamed", createdAt: now.toISOString() };
    this.tokens.push(entry);
    this.save();
    this.record({ at: entry.createdAt, event: "minted", kind: "side-door", for: principalId, label: entry.label, via, by: by ?? principalId });
    return { token, label: entry.label, createdAt: entry.createdAt };
  }

  principalFor(presented: string | undefined): string | undefined {
    return this.entryFor(presented)?.principalId;
  }

  private entryFor(presented: string | undefined, client = false): StoredToken | undefined {
    if (presented === undefined || presented === "" || this.readOnly) return undefined;
    const hash = hashOf(presented);
    return this.tokens.find(entry => (entry.kind !== undefined) === client && sameHash(entry.hash, hash));
  }

  /**
   * A client API token for a person (INV-2213): shown once, kept as its hash. `principalId` is a roster
   * id — for a service token, the Admin it reads for. On the record with who minted it, never the secret.
   */
  mintClient(input: { kind: ClientTokenKind; principalId: string; label: string; scopes: readonly Scope[]; expiresAt: Date; view?: ServiceView; by: string; now?: Date }): { token: string; credential: ClientCredential } {
    const now = input.now ?? new Date();
    const token = `${CLIENT_PREFIX[input.kind]}${randomBytes(24).toString("hex")}`;
    const entry: StoredToken = {
      hash: hashOf(token), principalId: input.principalId, via: "person", label: input.label.trim().slice(0, 60) || "unnamed", createdAt: now.toISOString(),
      kind: input.kind, id: `tok_${randomBytes(8).toString("hex")}`, scopes: [...new Set(input.scopes)], expiresAt: input.expiresAt.toISOString(),
      ...(input.kind === "service" && input.view !== undefined ? { view: input.view } : {}),
    };
    this.tokens.push(entry);
    this.save();
    this.record({
      at: entry.createdAt, event: "minted", kind: input.kind, id: entry.id!, for: entry.principalId, label: entry.label, scopes: entry.scopes!, expiresAt: entry.expiresAt!,
      ...(entry.view !== undefined ? { view: entry.view } : {}), by: input.by,
    });
    return { token, credential: credentialOf(entry) };
  }

  /** The client token presented, or why none: a token this store does not hold (or holds revoked), or one whose time is over. */
  clientFor(presented: string | undefined, now: Date = new Date()): { credential: ClientCredential } | { refused: "invalid" | "expired" } {
    if (presented === undefined || !Object.values(CLIENT_PREFIX).some(prefix => presented.startsWith(prefix))) return { refused: "invalid" };
    const entry = this.entryFor(presented, true);
    if (entry === undefined) return { refused: "invalid" };
    if (Date.parse(entry.expiresAt ?? "") <= now.getTime()) return { refused: "expired" };
    return { credential: credentialOf(entry) };
  }

  /** Notes a use, to the minute, and answers that minute: the file is written at most once a minute per token. */
  touch(id: string, now: Date = new Date()): string {
    const entry = this.tokens.find(token => token.id === id && token.kind !== undefined);
    const minute = `${now.toISOString().slice(0, 16)}:00.000Z`;
    if (entry === undefined || entry.lastUsedAt === minute) return minute;
    entry.lastUsedAt = minute;
    this.save();
    return minute;
  }

  /** Every client token, as the page lists them. */
  listClient(): ClientCredential[] {
    return this.tokens.filter(entry => entry.kind !== undefined).map(credentialOf);
  }

  /** Revokes the client token `id` when `may` allows it; false when none matches. */
  revokeClient(id: string, may: (credential: ClientCredential) => boolean, by: string): boolean {
    const at = this.tokens.findIndex(entry => entry.kind !== undefined && entry.id === id && may(credentialOf(entry)));
    if (at < 0) return false;
    const [gone] = this.tokens.splice(at, 1);
    this.save();
    this.record({ at: new Date().toISOString(), event: "revoked", kind: gone!.kind!, id: gone!.id!, for: gone!.principalId, label: gone!.label, by, reason: "revoked" });
    return true;
  }

  /**
   * Who a token acts as (INV-2074): the doors inside judge the person, not the sign-in. A token
   * from a sign-in is whoever holds that sign-in now, and nobody once nobody does, even when the
   * sign-in is also somebody's roster id (a person who joined by invite). One minted for a roster
   * id is that person while they are on the roster. An older token without `via` is a roster id
   * only when it cannot be a sign-in (no door prefix).
   */
  personFor(presented: string | undefined, principals: Pick<Principals, "byId" | "isKnown" | "resolve">): string | undefined {
    const entry = this.entryFor(presented);
    if (entry === undefined) return undefined;
    const id = entry.principalId;
    if (entry.via === "person" || (entry.via === undefined && !id.includes(":"))) return principals.byId(id)?.id;
    return principals.isKnown(id) ? principals.resolve(id).id : undefined;
  }

  /** Revoke the one made at `createdAt` that `may` allows; false when none matches. */
  revoke(createdAt: string, may: (entry: StoredToken) => boolean, by = "operator"): boolean {
    const at = this.tokens.findIndex(entry => entry.kind === undefined && entry.createdAt === createdAt && may(entry));
    if (at < 0) return false;
    const [gone] = this.tokens.splice(at, 1);
    this.save();
    this.record({ at: new Date().toISOString(), event: "revoked", kind: "side-door", for: gone!.principalId, label: gone!.label, by, reason: "revoked" });
    return true;
  }

  /**
   * Tokens that end when the directory says somebody left (INV-2202). `signInOnly`: only those made from
   * that sign-in, for a person who keeps another way in; otherwise every token of these ids, whoever made it.
   */
  revokeFor(ids: readonly string[], signInOnly = false, by = "directory"): number {
    const before = this.tokens.length, at = new Date().toISOString();
    const ends = (entry: StoredToken) => ids.includes(entry.principalId) && !(signInOnly && entry.via === "person");
    const gone = this.tokens.filter(ends);
    this.tokens = this.tokens.filter(entry => !ends(entry));
    if (this.tokens.length !== before) this.save();
    for (const entry of gone) {
      if (entry.kind === undefined) this.record({ at, event: "revoked", kind: "side-door", for: entry.principalId, label: entry.label, by, reason: "access-ended" });
      else this.record({ at, event: "revoked", kind: entry.kind, id: entry.id!, for: entry.principalId, label: entry.label, by, reason: "access-ended" });
    }
    return before - this.tokens.length;
  }

  /** The side door's tokens — whose, what and when: never the secret, never the hash. */
  list(): { principalId: string; label: string; createdAt: string }[] {
    return this.tokens.filter(entry => entry.kind === undefined).map(({ principalId, label, createdAt }) => ({ principalId, label, createdAt }));
  }
}
