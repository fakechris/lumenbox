/**
 * Invitation codes that outlive a restart (INV-2082).
 *
 * They lived in the web process's memory, which was harmless while a code lasted fifteen minutes. A
 * code may now last a week (INV-2056), and its card says "works once, until {when}": a Save & restart,
 * a door change or an upgrade in that week killed it without a word, and the person holding it was
 * turned away.
 *
 * What is kept is the sha256 of each code beside what it admits — the role, whose code it is, the
 * admin's note, when it expires — never the code itself, which is shown once, to the admin who made
 * it, and listed afterwards only by the process that made it. A redeemed code is deleted before the
 * roster is written, and the deletion is saved, so a code still works once. Expired codes are dropped
 * on load. The file is 0600 and replaced whole on every change.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PendingInvite } from "./people-routes.ts";

interface StoredInvite extends PendingInvite { hash: string }

const hashOf = (code: string) => createHash("sha256").update(code, "utf8").digest("hex");
const ROLES = new Set(["admin", "driver", "viewer"]);

function valid(entry: Partial<StoredInvite> | null): entry is StoredInvite {
  return typeof entry?.hash === "string" && /^[0-9a-f]{64}$/.test(entry.hash) && ROLES.has(String(entry.role)) && typeof entry.expiresAt === "number" &&
    (entry.principalId === undefined || typeof entry.principalId === "string") && (entry.note === undefined || typeof entry.note === "string");
}

export class InviteStore {
  /** By hash. `code` is known only for the codes this process made. */
  private readonly invites = new Map<string, { invite: PendingInvite; code?: string }>();
  private readOnly = false;

  /** `path` undefined: memory only, as a test wants. */
  constructor(private readonly path?: string, warn: (line: string) => void = () => {}, now: number = Date.now()) {
    if (path === undefined || !existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as { invites?: Partial<StoredInvite>[] };
      for (const { hash, ...invite } of (parsed.invites ?? []).filter(valid)) if (invite.expiresAt >= now) this.invites.set(hash, { invite });
      if (this.invites.size !== (parsed.invites ?? []).length) this.save();
    } catch (error) {
      // Not "no codes, start over": overwriting would destroy the evidence. Codes made now still work until a restart.
      warn(`invites: ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); codes made before the restart do not work until it is fixed`);
      this.readOnly = true;
    }
  }

  private save(): void {
    if (this.path === undefined || this.readOnly) return;
    const invites = [...this.invites].map(([hash, { invite }]) => ({ hash, ...invite }));
    const partial = `${this.path}.partial`;
    writeFileSync(partial, `${JSON.stringify({ invites }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(partial, 0o600);
    renameSync(partial, this.path);
  }

  get(code: string): PendingInvite | undefined {
    return this.invites.get(hashOf(code))?.invite;
  }

  set(code: string, invite: PendingInvite): this {
    this.invites.set(hashOf(code), { invite, code });
    this.save();
    return this;
  }

  delete(code: string): boolean {
    const gone = this.invites.delete(hashOf(code));
    if (gone) this.save();
    return gone;
  }

  /** Drops every code `drop` says to: the expired ones, or a removed person's. */
  dropWhere(drop: (invite: PendingInvite) => boolean): void {
    let changed = false;
    for (const [hash, { invite }] of this.invites) if (drop(invite)) changed = this.invites.delete(hash) || changed;
    if (changed) this.save();
  }

  /** The live codes; `code` is absent for one made before this process started, which nobody can show again. */
  list(): (PendingInvite & { code?: string })[] {
    return [...this.invites.values()].map(({ invite, code }) => ({ ...(code !== undefined ? { code } : {}), ...invite }));
  }
}
