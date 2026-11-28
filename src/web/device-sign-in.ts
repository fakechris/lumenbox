/**
 * The two ways a device signs in (docs/110 §4, INV-2214), up to the moment a device credential is made.
 *
 * **Through a channel, with PKCE.** This server is the authorization server the app talks to; the vendor
 * (DingTalk, Feishu) is behind it, as for the page's own sign-in (door-sign-in.ts). The app sends a PKCE
 * challenge and its own `redirectUri` (`POST /api/v1/auth/oauth/start`) and opens the address it is
 * given — `/auth/<door>?device=<id>` on this server — in the system's authentication browser. The door
 * takes the start (once), hands the person to the vendor, and on the way back asks `finish` where to
 * send the browser: the app's `redirectUri` with a code that works once, for a minute, and only with the
 * verifier whose hash is the challenge. Only an app's own address is accepted as `redirectUri` (a
 * `lumenbox:` address, or a loopback one for a desktop client): a web address would let somebody start a
 * sign-in, send its link to a colleague, and collect the colleague's code.
 *
 * **With a pairing code.** A signed-in page — after a sign-in in the last ten minutes (recent-sign-in.ts)
 * — shows a QR code holding a code that works once, for two minutes, and signs the device in as that
 * person. It always goes from a signed-in screen to the phone, never the other way (docs/110 §4).
 *
 * Everything here is in memory and kept as hashes: a restart ends sign-ins in progress, which then start
 * again; nothing here outlives ten minutes anyway.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const START_TTL_MS = 10 * 60_000;
export const CODE_TTL_MS = 60_000;
export const PAIRING_TTL_MS = 2 * 60_000;
const MAX_PENDING = 10_000;

/** Who the vendor's answer let in, or did not. */
export type DoorOutcome =
  | { kind: "person"; principalId: string; identity: string }
  | { kind: "asked"; name: string }
  | { kind: "refused"; why: "not-a-member" | "not-linked" | "vendor-refused" };

/** Who a pairing code signs in as: the person who showed it, and the sign-in they showed it from. */
export interface PairingFor {
  principalId: string;
  identity: string;
  via: "sign-in" | "person";
  signedInAt?: string;
}

interface Start { providerId: string; challenge: string; redirectUri: string; state?: string; at: number; taken: boolean; finished: boolean }

const hashOf = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const secret = () => randomBytes(32).toString("base64url");

/**
 * Whether an address is an app's own, to be sent a code: a `lumenbox:` address (the iOS and Android apps'
 * scheme), or `http` on the loopback address with a port (RFC 8252 §7.3, a desktop client). Never a fragment.
 */
export function isAppRedirect(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "lumenbox:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") && url.port !== "";
}

/** `redirectUri` with these parameters added, keeping its own. */
function withParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

export class DeviceSignIns {
  private readonly starts = new Map<string, Start>();
  private readonly codes = new Map<string, { start: Start; outcome: DoorOutcome; at: number }>();
  private readonly pairings = new Map<string, { pairing: PairingFor; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  private sweep(): void {
    const now = this.now();
    for (const [key, start] of this.starts) if (now - start.at > START_TTL_MS) this.starts.delete(key);
    for (const [key, code] of this.codes) if (now - code.at > CODE_TTL_MS) this.codes.delete(key);
    for (const [key, pairing] of this.pairings) if (now - pairing.at > PAIRING_TTL_MS) this.pairings.delete(key);
    // A flood of starts nobody finishes must not become memory: the oldest go first.
    for (const map of [this.starts, this.codes, this.pairings] as Map<string, unknown>[]) for (const key of map.keys()) { if (map.size <= MAX_PENDING) break; map.delete(key); }
  }

  /** A sign-in through `providerId` begins; the id goes in the address the app opens. */
  start(input: { providerId: string; codeChallenge: string; redirectUri: string; state?: string }): { id: string; expiresAt: number } {
    this.sweep();
    const id = randomBytes(16).toString("hex");
    this.starts.set(id, { providerId: input.providerId, challenge: input.codeChallenge, redirectUri: input.redirectUri, ...(input.state !== undefined ? { state: input.state } : {}), at: this.now(), taken: false, finished: false });
    return { id, expiresAt: this.now() + START_TTL_MS };
  }

  /** The door's entry takes a start, once: the channel it was started for, or undefined (unknown, taken, or over). */
  take(id: string): { providerId: string } | undefined {
    this.sweep();
    const start = this.starts.get(id);
    if (start === undefined || start.taken) return undefined;
    start.taken = true;
    return { providerId: start.providerId };
  }

  /** Where the door sends the browser once the vendor has answered: the app's address with a code, or with why nobody was let in. */
  finish(id: string, outcome: DoorOutcome): string | undefined {
    const start = this.starts.get(id);
    if (start === undefined || !start.taken || start.finished || this.now() - start.at > START_TTL_MS) return undefined;
    start.finished = true;
    this.starts.delete(id);
    const state: Record<string, string> = start.state !== undefined ? { state: start.state } : {};
    if (outcome.kind === "refused") return withParams(start.redirectUri, { error: "access_denied", error_description: outcome.why, ...state });
    const code = secret();
    this.codes.set(hashOf(code), { start, outcome, at: this.now() });
    return withParams(start.redirectUri, { code, ...state });
  }

  /** A code and its verifier: who the sign-in let in, once; undefined for anything else (and the code is spent all the same). */
  exchange(code: string, verifier: string, check: { providerId?: string; redirectUri: string }): (DoorOutcome & { providerId: string }) | undefined {
    this.sweep();
    const key = hashOf(code), found = this.codes.get(key);
    if (found === undefined) return undefined;
    this.codes.delete(key);
    const challenge = Buffer.from(createHash("sha256").update(verifier, "ascii").digest("base64url")), expected = Buffer.from(found.start.challenge);
    if (challenge.length !== expected.length || !timingSafeEqual(challenge, expected)) return undefined;
    if (check.providerId !== undefined && check.providerId !== found.start.providerId) return undefined;
    // The address the code was sent to, exactly, as RFC 6749 §4.1.3 asks: a code taken from another app's address is refused.
    if (check.redirectUri !== found.start.redirectUri) return undefined;
    return { ...found.outcome, providerId: found.start.providerId };
  }

  /** A pairing code for a QR code: the code is in the answer and nowhere else. */
  showPairing(pairing: PairingFor): { code: string; expiresAt: number } {
    this.sweep();
    const code = secret();
    this.pairings.set(hashOf(code), { pairing, at: this.now() });
    return { code, expiresAt: this.now() + PAIRING_TTL_MS };
  }

  /**
   * Somebody's access ended: the pairing codes shown for them, and the sign-in codes waiting for them, stop now —
   * `signInOnly`, only those of these sign-ins. Otherwise a code shown a minute before a sign-out would still make a device.
   */
  dropFor(ids: readonly string[], signInOnly: boolean): void {
    const ends = (who: { principalId: string; identity: string; via?: "sign-in" | "person" }) =>
      (ids.includes(who.identity) && who.via !== "person") || (!signInOnly && ids.includes(who.principalId));
    for (const [key, { pairing }] of this.pairings) if (ends(pairing)) this.pairings.delete(key);
    for (const [key, { outcome }] of this.codes) if (outcome.kind === "person" && ends({ ...outcome, via: "sign-in" })) this.codes.delete(key);
  }

  /** Who a pairing code signs in as, once; undefined when it is not one, was used, or is over. */
  pair(code: string): PairingFor | undefined {
    this.sweep();
    const key = hashOf(code), found = this.pairings.get(key);
    if (found === undefined) return undefined;
    this.pairings.delete(key);
    return found.pairing;
  }
}
