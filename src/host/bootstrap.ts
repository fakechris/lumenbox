/**
 * The first admin, handed over by a code.
 *
 * A fresh installation has an empty roster, and a login page nobody can
 * trust yet cannot issue the first credential — the same corner the UI
 * token is in, solved the same way: the server prints a code to whoever can
 * read its output, and that person is by definition the operator (docs/36
 * §2, the owner's ruling: the log is the channel).
 *
 * The code is serialized redemption, not a race: minted only while the
 * roster is empty, one live at a time, valid for a day, spent by the first
 * redemption. The person who redeems it arrives through a door's OAuth
 * dance — the vendor has authenticated them — and leaves as the first
 * `admin` Principal, linked to the identity that door minted.
 *
 * `~/.agentbox/bootstrap-invite.json`, 0600 like the roster: it holds no
 * secret that outlives its purpose, but while it lives it *is* the
 * installation, and a world-readable one invites the question of who read
 * it. Redeemed invites stay on disk (marked, with the identity that spent
 * them) so "who bootstrapped this" survives restarts — the first audit row
 * an installation has.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentboxHome } from "../config.ts";

/** A day: long enough to reach the person the operator chose, short enough that a printed code is not a standing key. */
export const BOOTSTRAP_TTL_MS = 24 * 60 * 60_000;

export interface BootstrapInvite {
  code: string;
  expiresAt: number;
  redeemedAt?: number;
  /** The identity that spent the code, kept for the record. */
  redeemedBy?: string;
}

export function bootstrapPath(): string {
  return process.env.AGENTBOX_BOOTSTRAP ?? join(agentboxHome(), "bootstrap-invite.json");
}

function read(path: string): BootstrapInvite | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BootstrapInvite>;
    if (typeof parsed.code !== "string" || parsed.code === "" || typeof parsed.expiresAt !== "number") {
      return undefined;
    }
    return {
      code: parsed.code,
      expiresAt: parsed.expiresAt,
      ...(parsed.redeemedAt !== undefined ? { redeemedAt: parsed.redeemedAt } : {}),
      ...(typeof parsed.redeemedBy === "string" ? { redeemedBy: parsed.redeemedBy } : {}),
    };
  } catch {
    return undefined;
  }
}

function write(path: string, invite: BootstrapInvite): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(invite, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
}

/** The invite as it stands on disk, whatever shape it is in. */
export function loadBootstrap(path: string = bootstrapPath()): BootstrapInvite | undefined {
  return read(path);
}

/**
 * The invite a redemption may still spend: present, unexpired, unredeemed.
 * Everything else — absent, stale, spent — is the same answer, because to
 * the person at the knock page they all mean "there is no first-admin code
 * to type".
 */
export function pendingBootstrap(
  invite: BootstrapInvite | undefined,
  now: number,
): BootstrapInvite | undefined {
  if (invite === undefined || invite.redeemedAt !== undefined) return undefined;
  if (now >= invite.expiresAt) return undefined;
  return invite;
}

/** The same unambiguous alphabet as invite codes, one character class up in length — the two must not be mistakable in a voice call. */
export function newBootstrapCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  return Array.from(randomBytes(8), byte => alphabet[byte % alphabet.length]!).join("");
}

export function mintBootstrap(
  path: string,
  options: { code?: string; ttlMs?: number; now?: number } = {},
): BootstrapInvite {
  const now = options.now ?? Date.now();
  const invite: BootstrapInvite = {
    code: options.code ?? newBootstrapCode(),
    expiresAt: now + (options.ttlMs ?? BOOTSTRAP_TTL_MS),
  };
  write(path, invite);
  return invite;
}

/** Spends the code on disk, keeping the record for the audit question later. */
export function markRedeemed(
  path: string,
  invite: BootstrapInvite,
  spent: { identity: string; now: number },
): BootstrapInvite {
  const redeemed: BootstrapInvite = { ...invite, redeemedAt: spent.now, redeemedBy: spent.identity };
  write(path, redeemed);
  return redeemed;
}

/**
 * What the server runs at start: on an empty roster, exactly one live
 * invite exists. A fresh mint logs the code (the owner's channel ruling);
 * an outstanding one logs only its existence — the code does not repeat in
 * the log, the file beside the roster holds it for retrieval.
 *
 * Returns the live invite, or undefined when the roster is not empty — a
 * roster with a person in it needs no bootstrap, and minting one there
 * would be a second way to become admin that nobody decided on.
 */
export function ensureBootstrapAdmin(args: {
  rosterEmpty: boolean;
  path?: string;
  now?: () => number;
  log: (line: string) => void;
}): BootstrapInvite | undefined {
  const path = args.path ?? bootstrapPath();
  const now = args.now?.() ?? Date.now();
  if (!args.rosterEmpty) return undefined;
  const existing = pendingBootstrap(read(path), now);
  if (existing !== undefined) {
    const hours = Math.max(Math.round((existing.expiresAt - now) / 60_000 / 60), 1);
    args.log(`bootstrap: an admin invite is outstanding (~${hours}h left; the code is in ${path})`);
    return existing;
  }
  const invite = mintBootstrap(path, { now });
  args.log(`bootstrap: empty roster — first admin invite ${invite.code} (24h, one use; also in ${path})`);
  return invite;
}
