/**
 * Stateless zero-knowledge WebSocket relay server (docs/109 §3.2, INV-2216).
 *
 * The relay stores no database, user keys, or transcripts. It pairs one Mac host per `routeId`
 * with any number of multiplexed phone sessions, validates X25519 public-key canonical encoding
 * and rejects low-order points on handshake envelopes, enforces trusted-proxy-aware per-IP rate
 * limits, bounds per-socket queued bytes, and sheds load under memory pressure.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { isCanonicalX25519PublicKey } from "./noise.ts";
import { fromBase64Url } from "./pairing.ts";
import { type MinimalWebSocket, upgradeServerSocket } from "./ws-wire.ts";

const MAX_ROUTE_ID_LENGTH = 128;

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

export function extractClientIp(
  req: http.IncomingMessage,
  trustedProxies: ReadonlySet<string>,
): string {
  const directPeer = normalizeIp(req.socket.remoteAddress ?? "unknown");
  if (!trustedProxies.has(directPeer)) return directPeer;

  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : (xff ?? "");
  if (!raw) return directPeer;

  const chain = raw
    .split(",")
    .map((entry) => normalizeIp(entry))
    .filter((entry) => entry.length > 0);
  for (let i = chain.length - 1; i >= 0; i--) {
    const candidate = chain[i]!;
    if (!trustedProxies.has(candidate)) return candidate;
  }
  return directPeer;
}

class PerIpRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();
  private readonly limitPerMinute: number;
  private readonly now: () => number;

  constructor(limitPerMinute: number, now: () => number) {
    this.limitPerMinute = limitPerMinute;
    this.now = now;
  }

  allow(ip: string): boolean {
    const nowMs = this.now();
    const cur = this.buckets.get(ip);
    if (!cur || cur.resetAtMs <= nowMs) {
      this.buckets.set(ip, { count: 1, resetAtMs: nowMs + 60_000 });
      return true;
    }
    if (cur.count >= this.limitPerMinute) return false;
    cur.count += 1;
    return true;
  }
}

export interface RelayServerOptions {
  readonly trustedProxies?: readonly string[];
  readonly maxConnectionsPerIpPerMinute?: number;
  readonly maxTotalSockets?: number;
  readonly maxFrameBytes?: number;
  readonly maxOutboundQueueBytes?: number;
  readonly memoryWatermarkBytes?: number;
  readonly memoryUsageBytes?: () => number;
  readonly now?: () => number;
}

export interface RunningRelayServer {
  readonly server: http.Server;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Validates the unencrypted Noise handshake envelope at the relay before forwarding it:
 * checks message1/message2's leading 32-byte ephemeral X25519 key for canonical encoding and
 * rejects low-order points without inspecting or holding any static keys or secrets.
 */
function validateHandshakeEnvelopeText(text: string): boolean {
  const msg = parseJsonObject(text);
  if (!msg) return false;
  if (
    msg.type !== "pair_hello" &&
    msg.type !== "pair_ready" &&
    msg.type !== "ik_hello" &&
    msg.type !== "ik_ready"
  ) {
    return false;
  }
  if (typeof msg.message !== "string") return false;
  try {
    const raw = fromBase64Url(msg.message);
    if (raw.byteLength < 48) return false;
    const ephemeralPub = raw.subarray(0, 32);
    return isCanonicalX25519PublicKey(ephemeralPub);
  } catch {
    return false;
  }
}

interface HostSlot {
  readonly routeId: string;
  readonly ws: MinimalWebSocket;
  readonly sessions: Map<string, MinimalWebSocket>;
}

export async function startRelayServer(
  port = 0,
  host = "127.0.0.1",
  options?: RelayServerOptions,
): Promise<RunningRelayServer> {
  const trustedProxies = new Set((options?.trustedProxies ?? []).map(normalizeIp));
  const now = options?.now ?? (() => Date.now());
  const rateLimiter = new PerIpRateLimiter(options?.maxConnectionsPerIpPerMinute ?? 120, now);
  const maxTotalSockets = options?.maxTotalSockets ?? 10_000;
  const maxFrameBytes = options?.maxFrameBytes ?? 2 * 1024 * 1024;
  const maxOutboundQueueBytes = options?.maxOutboundQueueBytes ?? 8 * 1024 * 1024;
  const watermarkBytes = options?.memoryWatermarkBytes ?? 0;
  const readMemory = options?.memoryUsageBytes ?? (() => process.memoryUsage().rss);

  const hosts = new Map<string, HostSlot>();
  const allSockets = new Set<MinimalWebSocket>();
  const underMemoryPressure = (): boolean => watermarkBytes > 0 && readMemory() >= watermarkBytes;

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/ready") {
      const overloaded = underMemoryPressure() || allSockets.size >= maxTotalSockets;
      res.writeHead(overloaded ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: overloaded ? "unready" : "ready" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    if (underMemoryPressure() || allSockets.size >= maxTotalSockets) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const clientIp = extractClientIp(req, trustedProxies);
    if (!rateLimiter.allow(clientIp)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      return;
    }

    const ws = upgradeServerSocket(req, socket, head, { maxFrameBytes, maxOutboundQueueBytes });
    if (!ws) return;
    allSockets.add(ws);
    ws.onClose(() => allSockets.delete(ws));

    let role: "unassigned" | "host" | "client" = "unassigned";
    let boundSlot: HostSlot | null = null;
    let clientSessionId = "";
    let clientHandshakeDone = false;

    ws.onText((text) => {
      if (underMemoryPressure()) {
        ws.close(1013, "Relay memory pressure");
        return;
      }

      if (role === "unassigned") {
        const init = parseJsonObject(text);
        if (!init) {
          ws.close(4001, "Invalid routing JSON");
          return;
        }
        const routeId = typeof init.routeId === "string" ? init.routeId : "";
        if (!routeId || routeId.length > MAX_ROUTE_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(routeId)) {
          ws.close(4001, "Invalid routeId");
          return;
        }

        if (init.type === "host_register") {
          const prev = hosts.get(routeId);
          if (prev) prev.ws.close(4000, "Replaced by newer host connection");
          role = "host";
          const slot: HostSlot = { routeId, ws, sessions: new Map() };
          boundSlot = slot;
          hosts.set(routeId, slot);
          ws.sendText(JSON.stringify({ type: "host_registered", routeId }));
          ws.onClose(() => {
            if (hosts.get(routeId) === slot) hosts.delete(routeId);
            for (const clientWs of slot.sessions.values()) {
              clientWs.sendText(JSON.stringify({ type: "host_offline", routeId }));
              clientWs.close(4004, "Host disconnected");
            }
            slot.sessions.clear();
          });
          return;
        }

        if (init.type === "client_connect") {
          const slot = hosts.get(routeId);
          if (!slot?.ws.isOpen) {
            ws.sendText(JSON.stringify({ type: "relay_error", reason: "host_offline" }));
            ws.close(4004, "Host offline");
            return;
          }
          role = "client";
          boundSlot = slot;
          clientSessionId = `s_${randomBytes(8).toString("base64url")}`;
          slot.sessions.set(clientSessionId, ws);
          slot.ws.sendText(JSON.stringify({ type: "session_open", sessionId: clientSessionId }));
          ws.sendText(JSON.stringify({ type: "client_connected", sessionId: clientSessionId }));
          ws.onClose(() => {
            slot.sessions.delete(clientSessionId);
            if (slot.ws.isOpen) {
              slot.ws.sendText(JSON.stringify({ type: "session_close", sessionId: clientSessionId }));
            }
          });
          return;
        }

        ws.close(4001, "Expected host_register or client_connect");
        return;
      }

      if (role === "client" && boundSlot) {
        if (!clientHandshakeDone) {
          if (!validateHandshakeEnvelopeText(text)) {
            ws.close(4003, "Invalid handshake public key or envelope");
            return;
          }
          clientHandshakeDone = true;
        }
        boundSlot.ws.sendText(
          JSON.stringify({ type: "session_text", sessionId: clientSessionId, payload: text }),
        );
        return;
      }

      if (role === "host" && boundSlot) {
        const env = parseJsonObject(text);
        if (!env) {
          ws.close(4001, "Invalid host envelope");
          return;
        }
        const sid = typeof env.sessionId === "string" ? env.sessionId : "";
        const target = boundSlot.sessions.get(sid);
        if (!target) return;
        if (env.type === "session_text" && typeof env.payload === "string") {
          if (!validateHandshakeEnvelopeText(env.payload)) {
            target.close(4003, "Invalid responder handshake envelope");
            return;
          }
          target.sendText(env.payload);
        } else if (env.type === "session_reject") {
          boundSlot.sessions.delete(sid);
          target.close(4003, typeof env.reason === "string" ? env.reason : "Rejected by host");
        }
      }
    });

    ws.onBinary((bytes) => {
      if (underMemoryPressure()) {
        ws.close(1013, "Relay memory pressure");
        return;
      }
      if (role === "client" && boundSlot) {
        if (!clientHandshakeDone) {
          ws.close(4003, "Binary frame before Noise handshake");
          return;
        }
        const sidBytes = Buffer.from(clientSessionId, "ascii");
        const wrapped = new Uint8Array(1 + sidBytes.byteLength + bytes.byteLength);
        wrapped[0] = sidBytes.byteLength;
        wrapped.set(sidBytes, 1);
        wrapped.set(bytes, 1 + sidBytes.byteLength);
        boundSlot.ws.sendBinary(wrapped);
      } else if (role === "host" && boundSlot) {
        if (bytes.byteLength < 2) return;
        const sidLen = bytes[0] ?? 0;
        if (bytes.byteLength < 1 + sidLen) return;
        const sid = Buffer.from(bytes.subarray(1, 1 + sidLen)).toString("ascii");
        const target = boundSlot.sessions.get(sid);
        if (target) target.sendBinary(bytes.subarray(1 + sidLen));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    server,
    port: addr.port,
    url: `ws://${host}:${addr.port}/ws`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of allSockets) ws.close(1001, "Server shutting down");
        server.close(() => resolve());
      }),
  };
}
