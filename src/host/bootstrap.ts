import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { withRosterLock } from "./roster-lock.ts";

interface BootstrapState { hash?: string; expiresAt?: number; disabled?: boolean; redeemedAt?: number; redeemedBy?: string }
interface Roster { principals: unknown[]; bootstrap?: BootstrapState }
const TTL = 24 * 60 * 60 * 1000;
const digest = (code: string) => createHash("sha256").update(code).digest("hex");
function read(path: string): Roster {
  if (!existsSync(path)) return { principals: [] };
  const value = JSON.parse(readFileSync(path, "utf8")) as Roster;
  if (!value || !Array.isArray(value.principals)) throw new Error("Repair the roster before bootstrap");
  if (value.bootstrap !== undefined && (!value.bootstrap || typeof value.bootstrap !== "object")) throw new Error("Repair bootstrap state");
  return value;
}
function write(path: string, value: Roster): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}
function live(roster: Roster, now: number): boolean {
  const state = roster.bootstrap;
  return roster.principals.length === 0 && state?.disabled !== true && state?.redeemedAt === undefined
    && typeof state?.hash === "string" && /^[a-f0-9]{64}$/.test(state.hash)
    && typeof state.expiresAt === "number" && Number.isFinite(state.expiresAt) && now < state.expiresAt;
}

/** Redemption and the first Principal share one atomic roster replacement. Codes never enter logs. */
export class BootstrapAdmins {
  constructor(private readonly path: string, readonly codePath: string) {}
  ensure(now = Date.now()): boolean {
    return withRosterLock(this.path, () => {
      const roster = read(this.path);
      if (roster.principals.length || roster.bootstrap?.disabled || roster.bootstrap?.redeemedAt !== undefined) return false;
      if (live(roster, now)) return true;
      // Corrupt state is not an invitation to re-arm a privileged credential.
      if (roster.bootstrap && (!roster.bootstrap.hash || typeof roster.bootstrap.expiresAt !== "number")) throw new Error("Repair bootstrap state");
      const code = randomBytes(32).toString("base64url");
      const temp = `${this.codePath}.${randomUUID()}.tmp`;
      writeFileSync(temp, `${code}\n`, { mode: 0o600 });
      renameSync(temp, this.codePath);
      chmodSync(this.codePath, 0o600);
      write(this.path, { ...roster, bootstrap: { hash: digest(code), expiresAt: now + TTL } });
      return true;
    });
  }
  pending(now = Date.now()): boolean { return live(read(this.path), now); }
  accepts(code: string, now = Date.now()): boolean {
    const roster = read(this.path);
    return live(roster, now) && roster.bootstrap!.hash === digest(code);
  }
  /** Caller must supply a vendor-authenticated identity; no HTTP body may choose this identity. */
  redeem(code: string, identity: string, name: string, incarnation: number, now = Date.now()): boolean {
    return withRosterLock(this.path, () => {
      const roster = read(this.path);
      if (!live(roster, now) || roster.bootstrap!.hash !== digest(code) || !identity || !name.trim() || !Number.isSafeInteger(incarnation) || incarnation < 1) return false;
      write(this.path, { principals: [{ id: identity, name: name.trim().slice(0, 60), role: "admin", identities: [{ identity, incarnation }] }],
        bootstrap: { disabled: true, redeemedAt: now, redeemedBy: identity } });
      // A crash before deletion leaves an unusable code, never a second admin path.
      rmSync(this.codePath, { force: true });
      return true;
    });
  }
}
