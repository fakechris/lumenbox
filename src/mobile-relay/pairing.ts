/**
 * Host identity key, one-time `#fragment` QR pairing offers, what the connector needs of the paired
 * phones, and direct LAN/tailnet candidate probing (docs/109 §3.1–3.2).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  generateX25519Keypair,
  isCanonicalX25519PublicKey,
  X25519_KEY_BYTES,
  type X25519Keypair,
  x25519KeypairFromPrivate,
} from "./noise.ts";

export const DEFAULT_PAIR_OFFER_TTL_MS = 2 * 60 * 1000;
export const MDNS_SERVICE_TYPE = "_lumenbox._tcp";

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function fromBase64Url(encoded: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new PairingError("invalid_encoding", "Expected base64url string");
  }
  return new Uint8Array(Buffer.from(encoded, "base64url"));
}

export class PairingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PairingError";
    this.code = code;
  }
}

function writeAtomicJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

export interface HostRelayIdentity {
  readonly routeId: string;
  readonly keypair: X25519Keypair;
}

/**
 * Loads or creates `~/.agentbox/relay-host-key.json` (mode `0600`).
 */
export function loadOrCreateHostIdentity(homeDir: string): HostRelayIdentity {
  const filePath = path.join(homeDir, "relay-host-key.json");
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      routeId?: unknown;
      privateKey?: unknown;
    };
    if (typeof raw.routeId === "string" && typeof raw.privateKey === "string") {
      const priv = fromBase64Url(raw.privateKey);
      const keypair = x25519KeypairFromPrivate(priv);
      return { routeId: raw.routeId, keypair };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const keypair = generateX25519Keypair();
  const routeId = `host_${randomBytes(12).toString("base64url")}`;
  writeAtomicJson(filePath, {
    routeId,
    privateKey: toBase64Url(keypair.privateKey),
    publicKey: toBase64Url(keypair.publicKey),
    createdAt: new Date().toISOString(),
  });
  return { routeId, keypair };
}

export interface PairedDeviceRecord {
  readonly deviceId: string;
  readonly connId: string;
  readonly publicKey: string;
  readonly deviceName: string;
  readonly platform: "ios" | "android" | "other";
  readonly scopes: readonly string[];
  readonly pairedAt: string;
  readonly lastSeenAt: string;
  /** More for the phone in the pairing answer, inside the `Noise_NK` channel: its `/api/v1` credential (src/web/phone-relay.ts). */
  readonly reply?: Readonly<Record<string, unknown>>;
}

/**
 * What the connector needs of the paired phones: the installation keeps them in the client API's
 * device store (src/web/phone-relay.ts), so a phone paired here is listed, removed and refused as
 * every other device is (docs/110 §3.2).
 */
export interface PairedDeviceStore {
  findByPublicKey(publicKey: Uint8Array): PairedDeviceRecord | undefined;
  touchLastSeen(deviceId: string, at?: string): void;
  register(input: {
    publicKey: Uint8Array;
    deviceName: string;
    platform: "ios" | "android" | "other";
    /** Whom the redeemed offer was minted for (`PairingOfferManager.mintOffer`'s `holder`). */
    holder?: unknown;
    /** The phone's whole pairing request, as it sent it inside the channel. */
    request?: Readonly<Record<string, unknown>>;
  }): PairedDeviceRecord;
  /** Notes a live session, and how to end it the moment the device is removed. Returns the undo, for when it ends on its own. */
  trackLiveSession(deviceId: string, closeSession: () => void): () => void;
}

export interface ParsedPairingOffer {
  readonly hostPublicKey: Uint8Array;
  readonly relayUrl: string;
  readonly routeId: string;
  readonly pairSecret: Uint8Array;
  readonly directUrls: readonly string[];
}

interface StoredOffer {
  readonly secret: Buffer;
  readonly expiresAtMs: number;
  readonly holder: unknown;
}

/**
 * Mints and redeems single-use 2-minute QR pairing secrets carried strictly in URL `#fragment`
 * (`lumenbox://pair#hostPub=…&relay=…&route=…&pairSecret=…`).
 */
export class PairingOfferManager {
  private readonly offers = new Map<string, StoredOffer>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = options?.ttlMs ?? DEFAULT_PAIR_OFFER_TTL_MS;
    this.now = options?.now ?? (() => Date.now());
  }

  private pruneExpired(nowMs: number): void {
    for (const [id, offer] of this.offers) {
      if (offer.expiresAtMs <= nowMs) {
        offer.secret.fill(0);
        this.offers.delete(id);
      }
    }
  }

  mintOffer(input: {
    hostPublicKey: Uint8Array;
    relayUrl: string;
    routeId: string;
    directUrls?: readonly string[];
    /** Whom a phone paired with this offer acts for: handed back by `redeem`, never put in the URI. */
    holder?: unknown;
  }): { uri: string; expiresAt: string } {
    const nowMs = this.now();
    this.pruneExpired(nowMs);
    const offerId = randomBytes(8).toString("base64url");
    const secret = randomBytes(32);
    const secretWithId = Buffer.concat([Buffer.from(offerId, "utf8"), Buffer.from(":"), secret]);
    const expiresAtMs = nowMs + this.ttlMs;
    this.offers.set(offerId, { secret, expiresAtMs, holder: input.holder });

    const params = new URLSearchParams();
    params.set("hostPub", toBase64Url(input.hostPublicKey));
    params.set("relay", input.relayUrl);
    params.set("route", input.routeId);
    params.set("pairSecret", toBase64Url(secretWithId));
    if (input.directUrls && input.directUrls.length > 0) {
      params.set("direct", input.directUrls.join(","));
    }
    return {
      uri: `lumenbox://pair#${params.toString()}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  consumeSecret(pairSecretBytes: Uint8Array): boolean {
    return this.redeem(pairSecretBytes) !== undefined;
  }

  /** Spends the secret, once, in its time: whom its offer was minted for; undefined when it is not one, was used, or is over. */
  redeem(pairSecretBytes: Uint8Array): { holder: unknown } | undefined {
    const nowMs = this.now();
    this.pruneExpired(nowMs);
    const decoded = Buffer.from(pairSecretBytes).toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep <= 0) return undefined;
    const offerId = decoded.slice(0, sep);
    const candidate = Buffer.from(pairSecretBytes).subarray(sep + 1);
    const stored = this.offers.get(offerId);
    if (!stored || stored.expiresAtMs <= nowMs) return undefined;
    if (candidate.byteLength !== stored.secret.byteLength) return undefined;
    if (!timingSafeEqual(candidate, stored.secret)) return undefined;
    stored.secret.fill(0);
    this.offers.delete(offerId);
    return { holder: stored.holder };
  }
}

/**
 * Parses a `lumenbox://pair#...` (or `https://.../pair#...`) offer URI. Refuses secrets placed in
 * the URL query string so sensitive pairing material can never leak to HTTP access logs.
 */
export function parsePairingOfferUri(uri: string): ParsedPairingOffer {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new PairingError("invalid_uri", "Malformed pairing URI");
  }
  if (parsed.searchParams.has("pairSecret") || parsed.searchParams.has("hostPub")) {
    throw new PairingError(
      "secret_in_query_refused",
      "Pairing secrets must be carried in the URL #fragment, never in query parameters",
    );
  }
  const rawHash = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
  if (!rawHash) {
    throw new PairingError("missing_fragment", "Pairing URI has no #fragment parameters");
  }
  const params = new URLSearchParams(rawHash);
  const hostPubStr = params.get("hostPub");
  const relayUrl = params.get("relay");
  const routeId = params.get("route");
  const pairSecretStr = params.get("pairSecret");
  if (!hostPubStr || !relayUrl || !routeId || !pairSecretStr) {
    throw new PairingError("incomplete_offer", "Pairing fragment lacks required fields");
  }
  const hostPublicKey = fromBase64Url(hostPubStr);
  if (!isCanonicalX25519PublicKey(hostPublicKey)) {
    throw new PairingError("invalid_host_key", "Host static public key in pairing offer is invalid");
  }
  if (hostPublicKey.byteLength !== X25519_KEY_BYTES) {
    throw new PairingError("invalid_host_key", "Unexpected host public key length");
  }
  const pairSecret = fromBase64Url(pairSecretStr);
  const directRaw = params.get("direct") ?? "";
  const directUrls = directRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\//i.test(s));

  return { hostPublicKey, relayUrl, routeId, pairSecret, directUrls };
}

/**
 * Probes candidate direct WebSocket endpoints (discovered via `_lumenbox._tcp` mDNS or advertised
 * tailnet address) with a short TCP connect timeout and picks the first reachable direct candidate,
 * falling back to the untrusted relay URL when off-network (docs/109 §3.1).
 */
export async function probeTcpReachable(wsUrl: string, timeoutMs = 450): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return false;
  }
  const port = url.port ? Number(url.port) : url.protocol === "wss:" ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");

  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function selectCandidateTransportUrl(options: {
  directUrls: readonly string[];
  relayUrl: string;
  probe?: (wsUrl: string, timeoutMs: number) => Promise<boolean>;
  probeTimeoutMs?: number;
}): Promise<{ url: string; mode: "direct" | "relay" }> {
  const probe = options.probe ?? probeTcpReachable;
  const timeoutMs = options.probeTimeoutMs ?? 450;
  for (const candidate of options.directUrls) {
    if (await probe(candidate, timeoutMs)) {
      return { url: candidate, mode: "direct" };
    }
  }
  return { url: options.relayUrl, mode: "relay" };
}
