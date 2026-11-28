/**
 * Device credentials: a person's phone or desktop client (docs/106 §4.3, docs/110 §4, INV-2214).
 *
 * A device signs in once — through an organisation's DingTalk or Feishu door with PKCE, or by
 * scanning a pairing code a signed-in page shows — and from then on holds two tokens:
 *
 * - an **access token** (`lbxd_`), fifteen minutes, which the app keeps in memory and sends as
 *   `Authorization: Bearer` to `/api/v1`;
 * - a **refresh token** (`lbxr_`), which the app keeps in the phone's hardware-held keychain and
 *   trades at `POST /api/v1/auth/refresh` for a new pair. **Every refresh rotates it**: the one
 *   presented is spent, and a new one is issued in the same family.
 *
 * A spent refresh token presented again means two holders of one token — the device and somebody
 * who copied it — and the server cannot tell which is which, so it ends them both: the device is
 * removed with the reason `refresh-reuse`, and both get `access-removed`. Two exceptions keep a
 * device's own retry from signing it out. Within **30 seconds** of a token being spent, presenting it
 * again is answered `refresh-superseded` and ends nothing: the device's other process (the
 * notification extension, docs/110 §4) won the race and holds the new pair. And a retry that carries
 * the first request's `Idempotency-Key` within those 30 seconds gets the first answer again (the
 * frame's memory-only replay for answers that hold a secret, frame.ts).
 *
 * Kept: `<home>/devices.json`, 0600, replaced whole on every change, holding for each device who it
 * acts for, the sign-in it came from, its name and platform, its scopes, and the SHA-256 of every
 * token it holds — never a token. Spent refresh tokens are kept as hashes for 30 days (at most 200
 * per device) so a reuse is recognised; a removed device is kept until its last token's time is
 * over, so a phone that calls later is told `access-removed` (wipe what you cached) rather than
 * "unknown token". Every sign-in, rotation, family revoke and removal is a line of `tokens.jsonl`
 * with who did it (token-ledger.ts).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Scope } from "./client-api/schema.ts";
import type { ClientCredential } from "./mcp-tokens.ts";
import type { TokenRecord } from "./token-ledger.ts";

export const ACCESS_TTL_MS = 15 * 60_000;
/** A refresh token not used for this long is over: the device signs in again. Each rotation starts it anew. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60_000;
/** However often it rotates, a device's sign-in ends a year after it was made, as the longest token this installation mints. */
export const FAMILY_TTL_MS = 365 * 24 * 60 * 60_000;
/** How long a spent refresh token may come back without ending the device: one process of the device lost the race to another. */
export const REFRESH_OVERLAP_MS = 30_000;
const SPENT_KEPT_MS = 30 * 24 * 60 * 60_000;
const SPENT_KEPT = 200;

export const ACCESS_PREFIX = "lbxd_";
export const REFRESH_PREFIX = "lbxr_";

/** Why a device stopped: removed by its person or an Admin, signed out from itself, its person's access ended, or its refresh token used twice. */
export type DeviceEnd = "removed" | "signed-out" | "access-ended" | "refresh-reuse";

interface StoredDevice {
  id: string;
  /** The roster person it acts for. */
  principalId: string;
  /** The sign-in it was made from (`dingtalk:<userid>`, a page session's identity), or the roster id when nobody signed in (`via: person`). */
  identity: string;
  via: "sign-in" | "person";
  method: "oauth" | "pairing";
  /** The door it signed in through, for `oauth`. */
  providerId?: string;
  name: string;
  platform: string;
  scopes: Scope[];
  createdAt: string;
  /** To the minute. */
  lastUsedAt?: string;
  familyId: string;
  familyExpiresAt: string;
  /** The device's own signing key for step-up proofs (docs/110 §4): an id it names and a P-256 public key (SPKI, base64url). */
  stepUpKey?: { id: string; publicKey: string };
  access: { hash: string; expiresAt: string }[];
  refresh: { hash: string; issuedAt: string; expiresAt: string; spentAt?: string }[];
  endedAt?: string;
  endedBy?: string;
  endedWhy?: DeviceEnd;
}

/** A device as its person and the page see it: never a token, never a hash. */
export interface DeviceView {
  id: string;
  principalId: string;
  name: string;
  platform: string;
  method: "oauth" | "pairing";
  providerId?: string;
  scopes: Scope[];
  createdAt: string;
  lastUsedAt?: string;
  hasStepUpKey: boolean;
}

/** Who a device acts for and the sign-in it came from: what `holds` is asked about. */
export type DeviceHolder = { principalId: string; identity: string; via: "sign-in" | "person" };
type Refreshed = { tokens: IssuedTokens; device: DeviceView } | { refused: "invalid" | "expired" | "removed" | "superseded" | "reused" };

export interface IssuedTokens {
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  scopes: Scope[];
}

const hashOf = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
const same = (a: string, b: string) => { const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex"); return left.length === right.length && left.length > 0 && timingSafeEqual(left, right); };
const at = (ms: number) => new Date(ms).toISOString();
const viewOf = (device: StoredDevice): DeviceView => ({
  id: device.id, principalId: device.principalId, name: device.name, platform: device.platform, method: device.method,
  ...(device.providerId !== undefined ? { providerId: device.providerId } : {}), scopes: [...device.scopes], createdAt: device.createdAt,
  ...(device.lastUsedAt !== undefined ? { lastUsedAt: device.lastUsedAt } : {}), hasStepUpKey: device.stepUpKey !== undefined,
});

export interface DeviceSignInInput {
  principalId: string;
  identity: string;
  via: "sign-in" | "person";
  method: "oauth" | "pairing";
  providerId?: string;
  name: string;
  platform: string;
  scopes: readonly Scope[];
  stepUpKey?: { id: string; publicKey: string };
  /** Who made it, for the record: the person, or who showed the pairing code. */
  by: string;
  /** The sign-in the pairing code was shown after (recent-sign-in.ts), for the record. */
  signedInAt?: string;
}

export class DeviceStore {
  private devices: StoredDevice[] = [];
  private readOnly = false;

  constructor(private readonly path?: string, warn: (line: string) => void = () => {}, private readonly record: (record: TokenRecord) => void = () => {}, private readonly now: () => Date = () => new Date()) {
    if (path === undefined || !existsSync(path)) return;
    try {
      this.devices = ((JSON.parse(readFileSync(path, "utf8")) as { devices?: StoredDevice[] }).devices ?? []).filter(device => typeof device.id === "string" && Array.isArray(device.refresh));
    } catch (error) {
      // Unreadable is not "no devices": every phone would be told its access was removed and wipe itself. Say so, accept none, keep the file.
      warn(`devices: ${path} is unreadable (${error instanceof Error ? error.message : String(error)}); no device is accepted until it is fixed`);
      this.readOnly = true;
    }
  }

  private save(): void {
    if (this.path === undefined || this.readOnly) return;
    const now = this.now().getTime();
    // A device ended or out of time is kept while any of its tokens could still be presented, then forgotten.
    this.devices = this.devices.filter(device => [...device.access, ...device.refresh].some(token => Date.parse(token.expiresAt) > now) || (device.endedAt === undefined && Date.parse(device.familyExpiresAt) > now));
    const partial = `${this.path}.partial`;
    writeFileSync(partial, `${JSON.stringify({ devices: this.devices }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(partial, 0o600);
    renameSync(partial, this.path);
  }

  /** A new pair for a device: the tokens are in the answer and nowhere else. */
  private mintPair(device: StoredDevice, now: number): IssuedTokens {
    const accessToken = `${ACCESS_PREFIX}${randomBytes(32).toString("hex")}`, refreshToken = `${REFRESH_PREFIX}${randomBytes(32).toString("hex")}`;
    const accessTokenExpiresAt = at(now + ACCESS_TTL_MS), refreshTokenExpiresAt = at(Math.min(now + REFRESH_TTL_MS, Date.parse(device.familyExpiresAt)));
    device.access = [...device.access.filter(token => Date.parse(token.expiresAt) > now), { hash: hashOf(accessToken), expiresAt: accessTokenExpiresAt }];
    device.refresh.push({ hash: hashOf(refreshToken), issuedAt: at(now), expiresAt: refreshTokenExpiresAt });
    return { deviceId: device.id, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, scopes: [...device.scopes] };
  }

  /** A device signed in: a new device, a new family, its first pair. */
  signIn(input: DeviceSignInInput): { device: DeviceView; tokens: IssuedTokens } {
    if (this.readOnly) throw new Error("devices.json is unreadable: no device can sign in until it is fixed");
    const now = this.now().getTime();
    const device: StoredDevice = {
      id: `dev_${randomBytes(8).toString("hex")}`, principalId: input.principalId, identity: input.identity, via: input.via, method: input.method,
      ...(input.providerId !== undefined ? { providerId: input.providerId } : {}), name: input.name.trim().slice(0, 60) || "unnamed", platform: input.platform,
      scopes: [...new Set(input.scopes)], createdAt: at(now), familyId: `fam_${randomBytes(8).toString("hex")}`, familyExpiresAt: at(now + FAMILY_TTL_MS),
      ...(input.stepUpKey !== undefined ? { stepUpKey: input.stepUpKey } : {}), access: [], refresh: [],
    };
    const tokens = this.mintPair(device, now);
    this.devices.push(device);
    this.save();
    this.record({
      at: device.createdAt, event: "minted", kind: "device", id: device.id, for: device.principalId, label: device.name, scopes: device.scopes, expiresAt: device.familyExpiresAt,
      method: device.method, ...(device.providerId !== undefined ? { provider: device.providerId } : {}), family: device.familyId, by: input.by,
      ...(input.signedInAt !== undefined ? { signedInAt: input.signedInAt } : {}),
    });
    return { device: viewOf(device), tokens };
  }

  private byAccess(presented: string): StoredDevice | undefined {
    const hash = hashOf(presented);
    return this.devices.find(device => device.access.some(token => same(token.hash, hash)));
  }

  /**
   * The device credential an access token is, or why not. `holds` says whether the sign-in the device was
   * made from is still its person's: a sign-in an Admin took away ends the device with it.
   */
  clientFor(presented: string | undefined, holds: (device: DeviceHolder) => boolean): { credential: ClientCredential } | { refused: "invalid" | "expired" | "removed" } {
    if (presented === undefined || !presented.startsWith(ACCESS_PREFIX) || this.readOnly) return { refused: "invalid" };
    const device = this.byAccess(presented);
    if (device === undefined) return { refused: "invalid" };
    if (device.endedAt !== undefined || !holds(device)) return { refused: "removed" };
    const token = device.access.find(entry => same(entry.hash, hashOf(presented)))!;
    if (Date.parse(token.expiresAt) <= this.now().getTime()) return { refused: "expired" };
    return { credential: {
      id: device.id, kind: "device", principalId: device.principalId, label: device.name, scopes: [...device.scopes], createdAt: device.createdAt, expiresAt: token.expiresAt,
      ...(device.lastUsedAt !== undefined ? { lastUsedAt: device.lastUsedAt } : {}),
    } };
  }

  /**
   * A refresh token for a new pair, or why not: `invalid` (not one this store issued), `expired`, `removed`
   * (the device ended), `superseded` (spent within the last 30 seconds: nothing ends), `reused` (spent
   * longer ago: the device ends now, for both holders).
   */
  refresh(presented: string, holds: (device: DeviceHolder) => boolean): Refreshed {
    if (!presented.startsWith(REFRESH_PREFIX) || this.readOnly) return { refused: "invalid" };
    const hash = hashOf(presented), now = this.now().getTime();
    const device = this.devices.find(entry => entry.refresh.some(token => same(token.hash, hash)));
    if (device === undefined) return { refused: "invalid" };
    if (device.endedAt !== undefined || !holds(device)) return { refused: "removed" };
    const token = device.refresh.find(entry => same(entry.hash, hash))!;
    if (token.spentAt !== undefined) {
      if (now - Date.parse(token.spentAt) <= REFRESH_OVERLAP_MS) return { refused: "superseded" };
      this.end(device, "refresh-reuse", "refresh-reuse");
      return { refused: "reused" };
    }
    if (Date.parse(token.expiresAt) <= now) return { refused: "expired" };
    token.spentAt = at(now);
    device.lastUsedAt = `${at(now).slice(0, 16)}:00.000Z`;
    const tokens = this.mintPair(device, now);
    // What is spent is kept as a hash for a while, to know it again; the newest first.
    const spent = device.refresh.filter(entry => entry.spentAt !== undefined && now - Date.parse(entry.spentAt) < SPENT_KEPT_MS).slice(-SPENT_KEPT);
    device.refresh = [...spent, ...device.refresh.filter(entry => entry.spentAt === undefined && Date.parse(entry.expiresAt) > now)];
    this.save();
    this.record({ at: at(now), event: "rotated", kind: "device", id: device.id, for: device.principalId, family: device.familyId, by: device.principalId });
    return { tokens, device: viewOf(device) };
  }

  /** Notes a use, to the minute, and answers that minute: the file is written at most once a minute per device. */
  touch(id: string): string {
    const minute = `${this.now().toISOString().slice(0, 16)}:00.000Z`;
    const device = this.devices.find(entry => entry.id === id);
    if (device === undefined || device.lastUsedAt === minute) return minute;
    device.lastUsedAt = minute;
    this.save();
    return minute;
  }

  /** A person's devices that still sign in, newest first. */
  list(principalId: string): DeviceView[] {
    const now = this.now().getTime();
    return this.devices.filter(device => device.principalId === principalId && device.endedAt === undefined && Date.parse(device.familyExpiresAt) > now).reverse().map(viewOf);
  }

  /** The device `id`, live, when `may` allows it. */
  get(id: string, may: (device: DeviceView) => boolean = () => true): DeviceView | undefined {
    const device = this.devices.find(entry => entry.id === id && entry.endedAt === undefined);
    return device !== undefined && may(viewOf(device)) ? viewOf(device) : undefined;
  }

  /** The step-up key a device registered, for checking its proofs (INV-2214 part 2). */
  stepUpKeyOf(id: string): { id: string; publicKey: string } | undefined {
    return this.devices.find(entry => entry.id === id && entry.endedAt === undefined)?.stepUpKey;
  }

  private end(device: StoredDevice, why: DeviceEnd, by: string): void {
    device.endedAt = at(this.now().getTime());
    device.endedBy = by;
    device.endedWhy = why;
    this.save();
    this.record({ at: device.endedAt, event: "revoked", kind: "device", id: device.id, for: device.principalId, label: device.name, family: device.familyId, by, reason: why });
  }

  /** Ends the device `id` when `may` allows it: its tokens stop at once. False when none matches. */
  remove(id: string, why: Exclude<DeviceEnd, "refresh-reuse" | "access-ended">, by: string, may: (device: DeviceView) => boolean = () => true): boolean {
    const device = this.devices.find(entry => entry.id === id && entry.endedAt === undefined && may(viewOf(entry)));
    if (device === undefined) return false;
    this.end(device, why, by);
    return true;
  }

  /**
   * Devices that end when somebody's access does (a directory sync's *left*, an Admin removing them, a
   * sign-out everywhere). `signInOnly`: only those made from these sign-ins, for a person who keeps another
   * way in; otherwise every device of these people or sign-ins. How many ended.
   */
  endFor(ids: readonly string[], signInOnly: boolean, by: string, why: DeviceEnd = "access-ended"): number {
    const ending = this.devices.filter(device => device.endedAt === undefined && ((ids.includes(device.identity) && device.via === "sign-in") || (!signInOnly && ids.includes(device.principalId))));
    for (const device of ending) this.end(device, why, by);
    return ending.length;
  }
}
