/**
 * A personal installation's phones, through the relay (docs/110 §3, INV-2327).
 *
 * A personal installation listens on 127.0.0.1 only (docs/95 §2), so a phone away from the Mac
 * cannot reach it. With `AGENTBOX_MOBILE_RELAY` set, the server connects out to that relay
 * (src/mobile-relay/) and a paired phone reaches it through an end-to-end encrypted channel:
 * `Noise_NK` once, to pair, then `Noise_IK` for every session.
 *
 * **One store of devices.** A phone paired here is a device of the client API's own store
 * (device-credentials.ts, `devices.json`), signed in by the pairing exactly as one that scanned an
 * organisation's code is: the same scopes, tokens, rotation, Phones list, removal and
 * `access-removed`. The store also keeps the phone's X25519 static key, which is what the relay
 * channel admits; nothing else is kept for it. The pairing answer, inside the `Noise_NK` channel,
 * carries the device's first token pair.
 *
 * **One frame.** The channel is a transport, not a credential: every request a phone sends through
 * it carries its bearer token and is answered by the client API's frame (client-api/frame.ts) in
 * this process — route table, credential, limits, scope, parameters, handler — over an in-memory
 * socket, never the network. Only `/api/v1` is carried. A stream (`/events`, a conversation's
 * stream, a read-only desktop) is a socket to this server for one request the host writes from the
 * phone's target and path: the phone reads the HTTP/1.1 answer (or the WebSocket) off it.
 *
 * **Removal.** Removing a phone ends its device: its tokens are refused, its relay sessions close
 * now (`recheck`, called whenever the client API ends a device) and its key is refused on reconnect.
 * Other phones are not touched.
 */

import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse, validateHeaderName, validateHeaderValue } from "node:http";
import { type Duplex, duplexPair } from "node:stream";
import { type Role, roleAtLeast } from "../host/principals.ts";
import { type ApiError, apiError } from "./api-error.ts";
import { deviceOf, tokensOf } from "./client-api/auth.ts";
import { Refused } from "./client-api/frame.ts";
import { DEVICE_SCOPES } from "./client-api/schema.ts";
import type { DeviceHolder, DeviceStore } from "./device-credentials.ts";
import type { PairingFor } from "./device-sign-in.ts";
import { QR_MAX_BYTES, qrSvg } from "./qr.ts";
import type { TokenRecord } from "./token-ledger.ts";
import {
  type DuplexRelayStream,
  type HostMuxHandlers,
  isCanonicalX25519PublicKey,
  loadOrCreateHostIdentity,
  NoiseError,
  type PairedDeviceRecord,
  type PairedDeviceStore,
  PairingOfferManager,
  type RunningHostConnector,
  startHostRelayConnector,
  toBase64Url,
  type VirtualHttpRequest,
  type VirtualHttpResponse,
  type VirtualStreamRequest,
} from "../mobile-relay/index.ts";

/** The relay's address, when it is one a phone may be sent to: `wss://`, or `ws://` on this machine (a local relay for a test). */
export function relayAddressOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    return url.protocol === "wss:" || (url.protocol === "ws:" && loopback) ? url.href.replace(/\/$/, "") : undefined;
  } catch {
    return undefined;
  }
}

export interface PhoneRelayDeps {
  relayUrl: string;
  home: string;
  /** The client API's device store, its `holds`, and what lets go of a device's streams and desktops (mount.ts `relayDevices`). */
  devices: { store: DeviceStore; holds(holder: DeviceHolder): boolean; ended(): void };
  /** The client API's frame: answers a request under `/api/v1`, false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** The server itself, for a read-only desktop: the upgrade on this socket is answered by its own desktop gate. */
  connection(socket: Duplex): void;
  record(record: TokenRecord): void;
  log(line: string): void;
  /** How long to wait before connecting again, after the `attempt`th failure in a row. */
  retryMs?(attempt: number): number;
}

export interface PhoneRelay {
  /** A QR code a phone pairs with, for two minutes, once, as `pairing`'s person; or why not. */
  pair(pairing: PairingFor, by: string): { link: string; expiresAt: string; qrSvg: string } | ApiError;
  /** The Mac is going to sleep: every connected phone is told now. False when the relay is not connected. */
  sleeping(reason: string): boolean;
  /** Ends the relay sessions of every phone whose device ended or whose person's access did. */
  recheck(): void;
  connected(): boolean;
  close(): Promise<void>;
}

/** Headers a phone may not set on a request the host makes for it: the connection's own, and any that would say where it came from. */
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length", "upgrade", "te", "trailer", "proxy-authorization",
  "cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]);

function phoneHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (HOP.has(lower) || lower.startsWith("x-agentbox-")) continue;
    validateHeaderName(lower);
    validateHeaderValue(lower, value);
    kept[lower] = value;
  }
  return kept;
}

/** An in-memory socket pair; the server's end says the request came through the relay, for this device, and from no address on this machine. */
function socketPair(deviceId: string): { near: Duplex; far: Duplex } {
  const [near, far] = duplexPair();
  for (const end of [near, far]) Object.assign(end, { remoteAddress: `relay:${deviceId}`, setTimeout: () => end, setNoDelay: () => end, setKeepAlive: () => end });
  return { near, far };
}

/** The path of a `/api/v1` request, or undefined: nothing else of this server is reachable through the relay. */
const apiPath = (path: string): string | undefined => (/^\/api\/v1(?:[/?]|$)/.test(path) && !/[\s#]/.test(path) ? path : undefined);
const desktopPath = (path: string): string | undefined => (/^\/vnc-ro\/\d+\/[\w./-]*(?:\?[\w=&%.-]*)?$/.test(path) ? path : undefined);

/** Joins a relay stream to an in-memory socket, both ways, waiting on the phone's window before reading more. */
function join(stream: DuplexRelayStream, socket: Duplex, upstream: boolean): void {
  socket.on("data", (chunk: Buffer) => {
    socket.pause();
    stream.send(chunk, true).then(() => socket.resume(), () => socket.destroy());
  });
  // The server's end said all it will (a refusal, an answer with `connection: close`): the stream ends with it.
  socket.on("end", () => socket.destroy());
  socket.on("close", () => stream.close());
  socket.on("error", () => stream.close());
  stream.onClose(() => socket.destroy());
  stream.onData(chunk => { if (upstream) socket.write(chunk); });
}

export function startPhoneRelay(deps: PhoneRelayDeps): PhoneRelay {
  const { store, holds } = deps.devices;
  const identity = loadOrCreateHostIdentity(deps.home);
  const offers = new PairingOfferManager();
  const retryMs = deps.retryMs ?? (attempt => Math.min(60_000, 1_000 * 2 ** attempt));
  /** The frame, behind a server that never listens: each request arrives on a socket of its own. */
  const inner = http.createServer((req, res) => {
    void deps.handle(req, res, new URL(req.url ?? "/", "http://relay.invalid")).then(done => { if (!done) { res.writeHead(404); res.end(); } }, (error: unknown) => {
      deps.log(`phone relay: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  // Who each live session is, and how to end it: removal closes them, and only them.
  const live = new Map<string, { key: string; closers: Set<() => void> }>();
  const keyOf = new Map<string, string>();
  const phones: PairedDeviceStore = {
    findByPublicKey(publicKey) {
      if (!isCanonicalX25519PublicKey(publicKey)) return undefined;
      const key = toBase64Url(publicKey), found = store.byRelayKey(key, holds);
      if (found === undefined) return undefined;
      keyOf.set(found.device.id, key);
      return { deviceId: found.device.id, connId: found.connId, publicKey: key, deviceName: found.device.name, platform: found.device.platform === "ios" || found.device.platform === "android" ? found.device.platform : "other",
        scopes: found.device.scopes, pairedAt: found.device.createdAt, lastSeenAt: found.device.lastUsedAt ?? found.device.createdAt };
    },
    touchLastSeen: id => { store.touch(id); },
    register(input): PairedDeviceRecord {
      const holder = input.holder as PairingFor | undefined;
      if (holder === undefined || !holds(holder)) throw new NoiseError("pair_holder_gone", "The person who showed this code has no access now");
      if (!isCanonicalX25519PublicKey(input.publicKey)) throw new NoiseError("invalid_device_key", "Device static public key is invalid");
      let described: ReturnType<typeof deviceOf>;
      try {
        const request = input.request ?? {};
        described = deviceOf({ deviceName: input.deviceName, platform: request.platform ?? input.platform, stepUpKeyId: request.stepUpKeyId, stepUpPublicKey: request.stepUpPublicKey });
      } catch (error) {
        if (error instanceof Refused) throw new NoiseError("invalid_pair_request", `${String(error.vars.name)}: ${String(error.vars.why)}`);
        throw error;
      }
      const key = toBase64Url(input.publicKey), before = store.byRelayKey(key, () => true);
      // The same phone paired again: its earlier sign-in ends, so one key is one device.
      if (before !== undefined) store.remove(before.device.id, "removed", holder.principalId);
      const connId = `conn_${randomBytes(9).toString("base64url")}`;
      const made = store.signIn({ ...holder, method: "pairing", ...described, scopes: DEVICE_SCOPES, relay: { publicKey: key, connId }, by: holder.principalId });
      if (before !== undefined) deps.devices.ended();
      return { deviceId: made.device.id, connId, publicKey: key, deviceName: made.device.name, platform: input.platform, scopes: made.device.scopes, pairedAt: made.device.createdAt,
        lastSeenAt: made.device.createdAt, reply: { tokens: tokensOf(made.tokens, new Date()) } };
    },
    trackLiveSession(deviceId, close) {
      const entry = live.get(deviceId) ?? { key: keyOf.get(deviceId) ?? "", closers: new Set<() => void>() };
      live.set(deviceId, entry);
      entry.closers.add(close);
      return () => { entry.closers.delete(close); if (entry.closers.size === 0) live.delete(deviceId); };
    },
  };

  const handlers: HostMuxHandlers = {
    onHttpRequest(req: VirtualHttpRequest, meta): Promise<VirtualHttpResponse> {
      const path = apiPath(req.path);
      if (meta.deviceId === undefined || path === undefined || !/^(GET|POST|PUT|DELETE)$/.test(req.method)) return Promise.resolve({ status: 404, headers: {} });
      const headers = phoneHeaders(req.headers), body = req.body ?? new Uint8Array(0);
      return new Promise((resolve, reject) => {
        const { near, far } = socketPair(meta.deviceId!);
        inner.emit("connection", far);
        // `host` is only a name: the connection is the in-memory socket above, never the network.
        const sent = { ...headers, host: "relay.invalid", connection: "close", "content-length": String(body.byteLength) };
        const out = http.request({ host: "localhost", createConnection: () => near as never, method: req.method, path, headers: sent }, res => {
          const answer: Record<string, string> = {};
          for (const [name, value] of Object.entries(res.headers)) if (value !== undefined && !HOP.has(name)) answer[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({ status: res.statusCode ?? 502, headers: answer, body: res });
        });
        out.on("error", reject);
        out.end(body);
      });
    },
    async onOpenStream(req: VirtualStreamRequest, stream, meta) {
      if (meta.deviceId === undefined) throw new Error("stream_refused");
      const headers = phoneHeaders(req.headers);
      const { near, far } = socketPair(meta.deviceId);
      if (req.target === "vnc-ro") {
        // Read-only, always: the path is `/vnc-ro/…`, and the desktop gate decides whether this phone may watch (INV-2214's view tickets).
        const path = desktopPath(req.path);
        if (path === undefined) throw new Error("stream_path_refused");
        const ws = ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"].filter(name => headers[name] !== undefined).map(name => `${name}: ${headers[name]}\r\n`).join("");
        deps.connection(far);
        near.write(`GET ${path} HTTP/1.1\r\nhost: relay.invalid\r\nconnection: Upgrade\r\nupgrade: websocket\r\n${ws}\r\n`);
        join(stream, near, true);
        return;
      }
      const path = apiPath(req.path);
      if (path === undefined) throw new Error("stream_path_refused");
      inner.emit("connection", far);
      near.write(`GET ${path} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}host: relay.invalid\r\nconnection: close\r\n\r\n`);
      join(stream, near, false);
    },
  };

  let running: RunningHostConnector | undefined, stopped = false, attempt = 0, timer: NodeJS.Timeout | undefined;
  const connect = async (): Promise<void> => {
    try {
      const connector = await startHostRelayConnector({ routeId: identity.routeId, hostKeypair: identity.keypair, relayUrl: deps.relayUrl, offerManager: offers, deviceStore: phones, handlers });
      if (stopped) { await connector.close(); return; }
      running = connector;
      attempt = 0;
      deps.log(`phone relay: connected to ${deps.relayUrl}`);
      await connector.relayClosed;
      running = undefined;
      if (!stopped) deps.log(`phone relay: ${deps.relayUrl} closed the connection; connecting again`);
    } catch (error) {
      if (attempt === 0) deps.log(`phone relay: cannot reach ${deps.relayUrl} (${error instanceof Error ? error.message : String(error)}); trying again`);
      attempt += 1;
    }
    if (stopped) return;
    timer = setTimeout(() => { void connect(); }, retryMs(attempt));
    timer.unref();
  };
  void connect();

  return {
    pair(pairing, by) {
      if (running === undefined) return apiError("phone-relay-offline", { relay: deps.relayUrl });
      const offer = offers.mintOffer({ hostPublicKey: identity.keypair.publicKey, relayUrl: deps.relayUrl, routeId: identity.routeId, holder: pairing });
      if (Buffer.byteLength(offer.uri) > QR_MAX_BYTES) return apiError("phone-relay-too-long", { bytes: QR_MAX_BYTES });
      deps.record({ at: new Date().toISOString(), event: "pairing-shown", kind: "device", for: pairing.principalId, by, expiresAt: offer.expiresAt, ...(pairing.signedInAt !== undefined ? { signedInAt: pairing.signedInAt } : {}) });
      return { link: offer.uri, expiresAt: offer.expiresAt, qrSvg: qrSvg(offer.uri) };
    },
    sleeping(reason) {
      running?.broadcastHostSleeping(reason);
      return running !== undefined;
    },
    recheck() {
      for (const [deviceId, entry] of [...live]) {
        if (store.get(deviceId) !== undefined && store.byRelayKey(entry.key, holds)?.device.id === deviceId) continue;
        live.delete(deviceId);
        for (const close of [...entry.closers]) close();
      }
    },
    connected: () => running !== undefined,
    async close() {
      stopped = true;
      clearTimeout(timer);
      await running?.close();
      inner.close();
    },
  };
}

/**
 * `POST /api/mobile-relay/sleeping` (`{ reason }`): the desktop app says the Mac is about to sleep
 * (electron/mobile-sleep.cjs), and every connected phone is told `host_sleeping` now. The installation's
 * own credential or an Admin; with phone access off it answers that nobody was told.
 */
export async function phoneRelayRoute(route: string, deps: { relay: PhoneRelay | undefined; role: Role; readJson(): Promise<Record<string, unknown>> }): Promise<{ status: number; body: unknown } | undefined> {
  if (route !== "POST /api/mobile-relay/sleeping") return undefined;
  if (!roleAtLeast(deps.role, "admin")) return { status: 403, body: apiError("role-needed", { need: "admin", role: deps.role }) };
  const body = await deps.readJson().catch(() => ({}) as Record<string, unknown>);
  const reason = typeof body.reason === "string" && /^[a-z-]{1,40}$/.test(body.reason) ? body.reason : "suspend";
  return { status: 200, body: { told: deps.relay?.sleeping(reason) === true } };
}

/** Phone access here: a personal installation with a relay address a phone may be sent to. A bad address is said, and phone access stays off. */
export function phoneRelayFor(mode: "single-machine" | "organisation", address: string | undefined, deps: Omit<PhoneRelayDeps, "relayUrl">): PhoneRelay | undefined {
  if (mode !== "single-machine" || address === undefined) return undefined;
  const relayUrl = relayAddressOf(address);
  if (relayUrl === undefined) deps.log(`phone relay: AGENTBOX_MOBILE_RELAY must be a wss:// address (ws:// only on this machine); phone access is off`);
  return relayUrl === undefined ? undefined : startPhoneRelay({ ...deps, relayUrl });
}

/** What the Phones section's pairing route is told (device-routes.ts `relay`): an organisation pairs through its public address. */
export const pairingRelay = (relay: PhoneRelay | undefined, mode: "single-machine" | "organisation") =>
  mode !== "single-machine" ? undefined : relay === undefined ? { on: false as const } : { on: true as const, pair: relay.pair };
