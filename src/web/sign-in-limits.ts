/**
 * How often a credential may be tried, off local (docs/106 §5 R4, INV-2204).
 *
 * Every way of presenting a credential to this installation — an invite code, the first Admin's
 * code, a door's sign-in callback, a side-door token, the installation token, and the control
 * plane's password form — asks one limiter, here, rather than keeping a counter each. A try is
 * counted against where it came from and, where the credential names one, against the account it
 * was for: the address stops one machine guessing at many accounts, the account stops many
 * machines guessing at one.
 *
 * **Back-off, not a window.** The first few wrong tries cost nothing, because people mistype.
 * After that each one doubles the wait, up to a ceiling; a quiet hour forgets the count. A source
 * that is waiting is refused before its credential is looked at, so a guess made while refused
 * learns nothing. Signing in clears the account's count and not the address's: one person's
 * success says nothing about the other tries from the same address.
 *
 * **In memory.** A restart clears every count. Nothing here was durable before — no route kept a
 * lock across a restart — and the credentials a restart could help against are either long random
 * tokens or codes that `CodeAttempts` already caps for the whole installation.
 *
 * **Local has none of this.** `signInGuard` with `enabled: false` waits for nobody and records no
 * failure: a personal installation on loopback behaves as it did. A sign-in that worked is
 * recorded at every level — who came in is the other half of the record (R8).
 */
import { BlockList, isIP } from "node:net";
import type { IncomingMessage } from "node:http";
import { appendLine } from "../host/jsonl.ts";

export interface Backoff {
  /** Wrong tries that cost nothing. */
  free: number;
  /** The wait after the first try past `free`; doubled by each one after. */
  baseMs: number;
  ceilingMs: number;
  /** A key nobody failed against for this long starts again from nothing. */
  forgetMs: number;
}

export const ADDRESS_BACKOFF: Backoff = { free: 5, baseMs: 2_000, ceilingMs: 15 * 60_000, forgetMs: 60 * 60_000 };
/** More patient per account: anyone can fail against somebody else's name, and the lock is theirs to wait out. */
export const ACCOUNT_BACKOFF: Backoff = { free: 10, baseMs: 2_000, ceilingMs: 15 * 60_000, forgetMs: 60 * 60_000 };

/** Keys held at once. Past it the oldest go: a flood of invented addresses must not become memory. */
const MAX_KEYS = 20_000;

interface Count { failures: number; lockedUntil: number; last: number; told: boolean }

/** Which way in was tried: the limiter's namespace and the audit line's `door`. */
export type SignInDoor = "invite-code" | "bootstrap" | "door" | "side-door" | "installation-token" | "gateway" | "client-api";

export interface Attempt {
  door: SignInDoor;
  /** Where it came from (`clientAddress`). */
  address: string;
  /** Who it was for, when the credential names somebody: a user name, `bootstrap`. Never the credential. */
  account?: string;
  /** The connection's own other end, for the record: where it differs from `address`, `address` is a proxy's word. */
  peer?: string;
}

export class SignInLimiter {
  private readonly counts = new Map<string, Count>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly address: Backoff = ADDRESS_BACKOFF,
    private readonly account: Backoff = ACCOUNT_BACKOFF,
  ) {}

  private keys(attempt: Attempt): [string, Backoff][] {
    const keys: [string, Backoff][] = [[`${attempt.door}|address|${attempt.address}`, this.address]];
    // The account as it was written: where names are compared exactly (the gateway's password list),
    // `alice` and `Alice` are two accounts, and one signing in must not clear the other's count.
    if (attempt.account !== undefined) keys.push([`${attempt.door}|account|${attempt.account}`, this.account]);
    return keys;
  }

  private live(key: string, policy: Backoff): Count | undefined {
    const count = this.counts.get(key);
    if (count === undefined) return undefined;
    if (this.now() - count.last > policy.forgetMs) { this.counts.delete(key); return undefined; }
    return count;
  }

  /** Whole seconds until this attempt may be made, or undefined when it may be made now. `first` is true once per wait, for the record. */
  waitFor(attempt: Attempt): { seconds: number; first: boolean } | undefined {
    const now = this.now();
    let until = 0, first = false;
    for (const [key, policy] of this.keys(attempt)) {
      const count = this.live(key, policy);
      if (count === undefined || count.lockedUntil <= now) continue;
      until = Math.max(until, count.lockedUntil);
      if (!count.told) { count.told = true; first = true; }
    }
    return until === 0 ? undefined : { seconds: Math.max(1, Math.ceil((until - now) / 1000)), first };
  }

  /** A wrong credential. Returns the wait it started, in whole seconds, when it started one. */
  failed(attempt: Attempt): number | undefined {
    const now = this.now();
    let longest = 0;
    for (const [key, policy] of this.keys(attempt)) {
      const count = this.live(key, policy) ?? { failures: 0, lockedUntil: 0, last: now, told: false };
      count.failures += 1;
      count.last = now;
      if (count.failures > policy.free) {
        const wait = Math.min(policy.ceilingMs, policy.baseMs * 2 ** Math.min(30, count.failures - policy.free - 1));
        count.lockedUntil = now + wait;
        count.told = false;
        longest = Math.max(longest, wait);
      }
      this.counts.delete(key); // re-inserted last, so the map's order is oldest first
      this.counts.set(key, count);
    }
    while (this.counts.size > MAX_KEYS) this.counts.delete(this.counts.keys().next().value!);
    return longest === 0 ? undefined : Math.ceil(longest / 1000);
  }

  /** A sign-in that worked: the account's count is cleared; the address keeps its own. */
  succeeded(attempt: Attempt): void {
    if (attempt.account !== undefined) this.counts.delete(`${attempt.door}|account|${attempt.account}`);
  }
}

/**
 * Where a request came from.
 *
 * Off local the server sits behind the TLS terminator it declared (exposure.ts), so the peer is the
 * proxy and the person's address is what the proxy wrote: the **last** entry of `X-Forwarded-For`,
 * the one the adjacent proxy appended. Never the first — the client writes that.
 *
 * Whose word that entry is depends on who connected. With the proxies declared
 * (`AGENTBOX_TRUSTED_PROXIES`, `trustedProxies`), it is believed only from one of them or from this
 * machine itself; anyone else who reaches the port is counted as the peer they are, whatever they
 * wrote. With none declared the server cannot tell its proxy from another machine, so the entry is
 * believed from any peer: then the port must be reachable only through the proxy (docs/06), and
 * the record keeps the peer beside the address so a forged one shows. With no usable
 * entry it is the peer, which is also the answer for a request that came with no proxy at all (the
 * CLI on the server: `isDirectLocal` reads the same headers). On local, and on a tenant's box
 * behind the gateway, it is the peer as it always was.
 */
export function clientAddress(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } }, behindProxy: boolean, trusted?: BlockList): string {
  const peer = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (!behindProxy) return peer;
  if (trusted !== undefined && peer !== "127.0.0.1" && peer !== "::1" && !(isIP(peer) !== 0 && trusted.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4"))) return peer;
  const header = req.headers["x-forwarded-for"];
  const last = (Array.isArray(header) ? header.join(",") : header ?? "").split(",").map(entry => entry.trim()).filter(entry => entry !== "").pop();
  return last !== undefined && isIP(last) !== 0 ? last : peer;
}

/**
 * The proxies whose `X-Forwarded-For` is believed: `AGENTBOX_TRUSTED_PROXIES`, addresses and
 * CIDR ranges separated by commas (`10.42.0.0/16, 192.0.2.10`). Undefined when unset. An entry
 * that is not an address or a range is an error, at start: a list nobody can read protects nothing.
 */
export function trustedProxies(value: string | undefined): BlockList | undefined {
  const entries = (value ?? "").split(",").map(entry => entry.trim()).filter(entry => entry !== "");
  if (entries.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, bits, ...rest] = entry.split("/");
    const family = isIP(address ?? "");
    const prefix = bits === undefined ? undefined : Number(bits);
    if (family === 0 || rest.length > 0 || (prefix !== undefined && (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)))) {
      throw new Error(`AGENTBOX_TRUSTED_PROXIES has "${entry}", which is not an address or a range like 10.42.0.0/16. Refusing to start with a proxy list that cannot be read.`);
    }
    if (prefix === undefined) list.addAddress(address!, family === 6 ? "ipv6" : "ipv4");
    else list.addSubnet(address!, prefix, family === 6 ? "ipv6" : "ipv4");
  }
  return list;
}

/** One line of `sign-ins.jsonl`: a try that did not get in. Who and from where; never what was presented. */
export interface SignInRecord {
  at: string;
  door: SignInDoor;
  /** `signed-in` is a sign-in that worked, recorded at every level (R8); the other two are off local only. */
  outcome: "failed" | "limited" | "signed-in";
  address: string;
  /**
   * The connection's other end, when it is not `address`. Off local `address` is what the last
   * `X-Forwarded-For` entry said, and a request that reached the server around its proxy wrote that
   * itself: a peer that is not the proxy's is how a reader tells.
   */
  peer?: string;
  account?: string;
  /** Why, in a word a reader can search for: `wrong-code`, `state-mismatch`, `not-activated`. */
  reason?: string;
  /** With `limited`: how long the wait is. */
  seconds?: number;
}

export const SIGN_INS_LEDGER = "sign-ins.jsonl";

/** Appends to the installation's sign-in record (`<home>/sign-ins.jsonl`, in `audit export`). A failed write is said, not thrown: a full disk must not turn a refusal into a 500. */
export function signInLedger(path: string, log: (line: string) => void): (record: SignInRecord) => void {
  return record => {
    try { appendLine(path, JSON.stringify(record)); } catch (error) { log(`sign-ins: could not record a ${record.outcome} attempt: ${error instanceof Error ? error.message : String(error)}`); }
  };
}

export interface SignInGuard {
  readonly enabled: boolean;
  /** Before the credential is looked at: the seconds to wait (answer 429 with `Retry-After`), or undefined. */
  blocked(attempt: Attempt): number | undefined;
  /** The credential was wrong, or the sign-in was refused. `counts: false` records it without counting it (a real person an Admin has not let in yet). */
  failed(attempt: Attempt, reason: string, counts?: boolean): void;
  /** A sign-in that worked: recorded at every level with who it was (`account`), and the account's count cleared. */
  succeeded(attempt: Attempt): void;
}

/** The limiter and the record behind one call per outcome. Disabled — local — it does nothing at all. */
export function signInGuard(options: { enabled: boolean; limiter?: SignInLimiter; record: (record: SignInRecord) => void; log: (line: string) => void; now?: () => Date }): SignInGuard {
  const limiter = options.limiter ?? new SignInLimiter();
  const line = (attempt: Attempt, outcome: SignInRecord["outcome"], more: Partial<SignInRecord>): SignInRecord => ({
    at: (options.now?.() ?? new Date()).toISOString(), door: attempt.door, outcome, address: attempt.address,
    ...(attempt.peer !== undefined && attempt.peer !== attempt.address ? { peer: attempt.peer } : {}),
    ...(attempt.account !== undefined ? { account: attempt.account.slice(0, 80) } : {}), ...more,
  });
  return {
    enabled: options.enabled,
    blocked(attempt) {
      if (!options.enabled) return undefined;
      const wait = limiter.waitFor(attempt);
      if (wait === undefined) return undefined;
      // Once per wait: a flood of refused tries is one line, not a file.
      if (wait.first) {
        options.record(line(attempt, "limited", { seconds: wait.seconds }));
        options.log(`sign-in limited: ${attempt.door} from ${attempt.address}${attempt.account !== undefined ? ` for ${JSON.stringify(attempt.account.slice(0, 80))}` : ""}; refused for ${wait.seconds}s`);
      }
      return wait.seconds;
    },
    failed(attempt, reason, counts = true) {
      if (!options.enabled) return;
      options.record(line(attempt, "failed", { reason }));
      if (counts) limiter.failed(attempt);
    },
    succeeded(attempt) {
      // Who got in, at every level: the record of sign-ins is not only the ones that failed (R8).
      options.record(line(attempt, "signed-in", {}));
      if (options.enabled) limiter.succeeded(attempt);
    },
  };
}
