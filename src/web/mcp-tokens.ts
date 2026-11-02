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
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export interface StoredToken {
  hash: string;
  principalId: string;
  label: string;
  createdAt: string;
}

const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export class McpTokenStore {
  private tokens: StoredToken[] = [];

  /** `path` undefined: memory only, as the tests and a home-less run want. */
  constructor(private readonly path?: string, warn: (line: string) => void = () => {}) {
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
  mint(principalId: string, label: string, now: Date = new Date()): { token: string; label: string; createdAt: string } {
    const token = `lmbx_${randomBytes(24).toString("hex")}`;
    const entry: StoredToken = { hash: hashOf(token), principalId, label: label.trim().slice(0, 60) || "unnamed", createdAt: now.toISOString() };
    this.tokens.push(entry);
    this.save();
    return { token, label: entry.label, createdAt: entry.createdAt };
  }

  principalFor(presented: string | undefined): string | undefined {
    if (presented === undefined || presented === "" || this.readOnly) return undefined;
    const hash = hashOf(presented);
    return this.tokens.find(entry => sameHash(entry.hash, hash))?.principalId;
  }

  /** Revoke the one made at `createdAt` that `may` allows; false when none matches. */
  revoke(createdAt: string, may: (entry: StoredToken) => boolean): boolean {
    const at = this.tokens.findIndex(entry => entry.createdAt === createdAt && may(entry));
    if (at < 0) return false;
    this.tokens.splice(at, 1);
    this.save();
    return true;
  }

  /** Whose, what and when: never the secret, never the hash. */
  list(): { principalId: string; label: string; createdAt: string }[] {
    return this.tokens.map(({ principalId, label, createdAt }) => ({ principalId, label, createdAt }));
  }
}
