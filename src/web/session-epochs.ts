/**
 * Signing one person out of everywhere (INV-537).
 *
 * A session cookie is signed, not looked up, which is what makes it cheap — and what
 * makes revoking one person's sessions impossible without somewhere to record that it
 * happened. This is that somewhere: one number per principal, carried in the cookie and
 * compared on every request. Bump it and that person's browsers stop being served; every
 * other session is untouched, which is why an admin will actually use this instead of
 * rotating the installation token and signing out the whole company.
 *
 * Deliberately not in `principals.json`: that file is the access-control list, read on
 * every request and edited by people; a counter that changes when somebody loses a laptop
 * does not belong in it. Same directory, same 0600, its own concern.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

export class SessionEpochs {
  private epochs = new Map<string, number>();

  constructor(private readonly path: string = join(agentboxHome(), "session-epochs.json")) {
    this.reload();
  }

  reload(): void {
    this.epochs = new Map();
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === "number" && Number.isFinite(value)) this.epochs.set(id, value);
      }
    } catch {
      // An unreadable file is an empty one: everybody's sessions verify at generation zero,
      // which is where they started. Failing closed here would lock the installation out
      // over a torn write.
    }
  }

  of(principalId: string): number {
    return this.epochs.get(principalId) ?? 0;
  }

  /** Everything this person holds stops working on their next request. Returns the new generation. */
  bump(principalId: string): number {
    const next = this.of(principalId) + 1;
    this.epochs.set(principalId, next);
    this.save();
    return next;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.epochs), null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Best effort, as with the roster beside it.
    }
  }
}
