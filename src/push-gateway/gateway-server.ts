/**
 * Stateless Wake-Only Push Gateway HTTP server (docs/109 §5, INV-2215).
 *
 * Endpoints:
 * - `GET /health` -> `200 { ok: true }`
 * - `POST /v1/devices/register` -> `200 { token: "LumenPushToken[…]" }`
 * - `POST /v1/devices/unregister` -> `200 { ok: true }`
 * - `POST /v1/push/send` -> `200 { data: PushTicket[] }`
 *
 * Security & privacy invariants:
 * - Strict schema validation rejects any unknown or plaintext content fields (`title`, `body`,
 *   `subtitle`, `alert`, `message`, `data`) with `400 VALIDATION_ERROR`: only `{ to, connId, seq,
 *   ttl? }` is accepted, guaranteeing zero business content passes through the gateway.
 * - iOS receives `apns-push-type: alert`, `apns-priority: 10`, `mutable-content: 1`, and a fixed
 *   generic fallback string so `UNNotificationServiceExtension` wakes reliably without silent-push
 *   throttling and pulls the real notification text directly from the user's Mac or org server.
 * - Android receives a `HIGH` priority FCM v1 data message carrying `{ kind: "wake", connId, seq }`.
 * - Rate limits apply per client IP on register/unregister and per recipient token on send.
 */

import { randomUUID } from "node:crypto";
import http from "node:http";
import type net from "node:net";
import { z } from "zod";
import { PushDeviceStore, type RegisteredPushDevice } from "./store.ts";
import { type FcmServiceAccount, ProviderTokenCache, parseLumenPushToken } from "./tokens.ts";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_BATCH_RECIPIENTS = 100;
const GENERIC_WAKE_TITLE = "LumenBox";
const GENERIC_WAKE_BODY = "New activity waiting";

const RegisterRequestSchema = z
  .object({
    deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    appId: z.string().min(3).max(128).regex(/^[A-Za-z0-9._-]+$/),
    platform: z.enum(["ios", "android"]),
    provider: z.enum(["apns", "fcm"]).optional(),
    pushToken: z.string().min(16).max(4096),
    environment: z.enum(["production", "development"]).optional(),
  })
  .strict();

const UnregisterRequestSchema = z
  .object({
    deviceId: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    appId: z.string().min(3).max(128).regex(/^[A-Za-z0-9._-]+$/),
  })
  .strict();

const WakeSendMessageSchema = z
  .object({
    to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(MAX_BATCH_RECIPIENTS)]),
    connId: z.string().min(4).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    seq: z.number().int().nonnegative(),
    ttl: z.number().int().min(0).max(2_419_200).optional(),
  })
  .strict();

const WakeSendRequestSchema = z.union([
  WakeSendMessageSchema,
  z.array(WakeSendMessageSchema).min(1).max(MAX_BATCH_RECIPIENTS),
]);

export type PushTicketErrorCode =
  | "DeviceNotRegistered"
  | "InvalidCredentials"
  | "MessageTooBig"
  | "MessageRateExceeded"
  | "MismatchSenderId";

export type PushTicket =
  | { readonly status: "ok"; readonly id: string }
  | {
      readonly status: "error";
      readonly message: string;
      readonly details?: {
        readonly error?: PushTicketErrorCode;
        readonly provider?: "apns" | "fcm";
        readonly reason?: string;
      };
    };

export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  readonly privateKeyPem: string;
  readonly productionOrigin?: string;
  readonly sandboxOrigin?: string;
}

export interface PushGatewayOptions {
  readonly store?: PushDeviceStore;
  readonly dbPath?: string;
  readonly allowedAppIds?: readonly string[];
  readonly trustedProxies?: readonly string[];
  readonly apns?: ApnsCredentials;
  readonly fcm?: FcmServiceAccount & { readonly apiOrigin?: string };
  readonly registerRateLimitPerMinute?: number;
  readonly sendRateLimitPerRecipientPerMinute?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface RunningPushGateway {
  readonly server: http.Server;
  readonly store: PushDeviceStore;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

class SlidingMinuteLimiter {
  private readonly counts = new Map<string, { count: number; resetAtMs: number }>();
  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit: number, now: () => number) {
    this.limit = limit;
    this.now = now;
  }

  allow(key: string): boolean {
    const nowMs = this.now();
    const cur = this.counts.get(key);
    if (!cur || cur.resetAtMs <= nowMs) {
      this.counts.set(key, { count: 1, resetAtMs: nowMs + 60_000 });
      return true;
    }
    if (cur.count >= this.limit) return false;
    cur.count += 1;
    return true;
  }
}

function normalizeIp(ip: string): string {
  const trimmed = ip.trim();
  return trimmed.startsWith("::ffff:") ? trimmed.slice(7) : trimmed;
}

function extractCallerIp(req: http.IncomingMessage, trustedProxies: ReadonlySet<string>): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? "unknown");
  if (!trustedProxies.has(peer)) return peer;
  const xff = req.headers["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : (xff ?? "");
  if (!raw) return peer;
  const parts = raw
    .split(",")
    .map((p) => normalizeIp(p))
    .filter((p) => p.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!trustedProxies.has(parts[i]!)) return parts[i]!;
  }
  return peer;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { errors: [{ code, message }] });
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new Error("BODY_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

const APNS_UNREGISTERED_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "ExpiredToken",
  "DeviceTokenNotForTopic",
]);

export async function startPushGatewayServer(
  port = 0,
  host = "127.0.0.1",
  options?: PushGatewayOptions,
): Promise<RunningPushGateway> {
  const ownsStore = !options?.store;
  const store = options?.store ?? new PushDeviceStore(options?.dbPath ?? ":memory:");
  const allowedApps =
    options?.allowedAppIds && options.allowedAppIds.length > 0
      ? new Set(options.allowedAppIds)
      : null;
  const trustedProxies = new Set((options?.trustedProxies ?? []).map(normalizeIp));
  const now = options?.now ?? (() => Date.now());
  const fetchFn = options?.fetchImpl ?? fetch;

  const registerLimiter = new SlidingMinuteLimiter(
    options?.registerRateLimitPerMinute ?? 60,
    now,
  );
  const sendLimiter = new SlidingMinuteLimiter(
    options?.sendRateLimitPerRecipientPerMinute ?? 60,
    now,
  );
  const tokenCache = new ProviderTokenCache();

  async function deliverApnsWake(
    device: RegisteredPushDevice,
    wake: { connId: string; seq: number; ttl: number },
  ): Promise<PushTicket> {
    if (!options?.apns) {
      return {
        status: "error",
        message: "APNs credentials are not configured",
        details: { error: "InvalidCredentials", provider: "apns" },
      };
    }
    const apnsId = randomUUID();
    const payloadStr = JSON.stringify({
      aps: {
        alert: { title: GENERIC_WAKE_TITLE, body: GENERIC_WAKE_BODY },
        "mutable-content": 1,
        sound: "default",
      },
      body: { connId: wake.connId, seq: wake.seq },
    });
    if (Buffer.byteLength(payloadStr, "utf8") > 4096) {
      return {
        status: "error",
        message: "Payload exceeds 4096 bytes",
        details: { error: "MessageTooBig", provider: "apns" },
      };
    }

    const nowSec = Math.floor(now() / 1000);
    const jwt = tokenCache.getApnsJwt({
      keyId: options.apns.keyId,
      teamId: options.apns.teamId,
      privateKeyPem: options.apns.privateKeyPem,
      nowSec,
    });
    const baseOrigin =
      device.environment === "development"
        ? (options.apns.sandboxOrigin ?? "https://api.sandbox.push.apple.com")
        : (options.apns.productionOrigin ?? "https://api.push.apple.com");
    const expiration = wake.ttl === 0 ? "0" : String(nowSec + wake.ttl);

    let res: Response;
    try {
      res = await fetchFn(`${baseOrigin}/3/device/${device.nativeToken}`, {
        method: "POST",
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-id": apnsId,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-topic": device.appId,
          "apns-expiration": expiration,
          "content-type": "application/json",
        },
        body: payloadStr,
      });
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "APNs request failed",
      };
    }

    if (res.status === 200) {
      return { status: "ok", id: apnsId };
    }

    let reason = "";
    try {
      const errJson = (await res.json()) as { reason?: unknown };
      if (typeof errJson.reason === "string") reason = errJson.reason;
    } catch {}

    if (res.status === 410 || APNS_UNREGISTERED_REASONS.has(reason)) {
      store.deactivateIfMatchingNativeToken(
        device.tokenId,
        device.nativeToken,
        "provider_unregistered",
        new Date(now()).toISOString(),
      );
      return {
        status: "error",
        message: reason || "Device unregistered at APNs",
        details: {
          error: "DeviceNotRegistered",
          provider: "apns",
          ...(reason ? { reason } : {}),
        },
      };
    }

    if (res.status === 403 && reason.includes("ProviderToken")) {
      tokenCache.invalidateApns();
      return {
        status: "error",
        message: reason,
        details: { error: "InvalidCredentials", provider: "apns", reason },
      };
    }

    if (res.status === 413) {
      return {
        status: "error",
        message: reason || "Payload too large",
        details: { error: "MessageTooBig", provider: "apns" },
      };
    }

    if (res.status === 429) {
      return {
        status: "error",
        message: reason || "APNs rate limit exceeded",
        details: { error: "MessageRateExceeded", provider: "apns" },
      };
    }

    return {
      status: "error",
      message: reason || `APNs HTTP ${res.status}`,
      details: { provider: "apns", ...(reason ? { reason } : {}) },
    };
  }

  async function deliverFcmWake(
    device: RegisteredPushDevice,
    wake: { connId: string; seq: number; ttl: number },
  ): Promise<PushTicket> {
    if (!options?.fcm) {
      return {
        status: "error",
        message: "FCM service account is not configured",
        details: { error: "InvalidCredentials", provider: "fcm" },
      };
    }
    const nowSec = Math.floor(now() / 1000);
    let accessToken: string;
    try {
      accessToken = await tokenCache.getFcmAccessToken({
        serviceAccount: options.fcm,
        nowSec,
        fetchImpl: fetchFn,
      });
    } catch (err) {
      tokenCache.invalidateFcm();
      return {
        status: "error",
        message: err instanceof Error ? err.message : "FCM auth failed",
        details: { error: "InvalidCredentials", provider: "fcm" },
      };
    }

    const bodyObj = {
      message: {
        token: device.nativeToken,
        android: {
          priority: "HIGH",
          ttl: `${wake.ttl}s`,
        },
        data: {
          kind: "wake",
          connId: wake.connId,
          seq: String(wake.seq),
        },
      },
    };
    const bodyStr = JSON.stringify(bodyObj);
    if (Buffer.byteLength(bodyStr, "utf8") > 4096) {
      return {
        status: "error",
        message: "Payload exceeds 4096 bytes",
        details: { error: "MessageTooBig", provider: "fcm" },
      };
    }

    const apiOrigin = options.fcm.apiOrigin ?? "https://fcm.googleapis.com";
    let res: Response;
    try {
      res = await fetchFn(
        `${apiOrigin}/v1/projects/${encodeURIComponent(options.fcm.project_id)}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: bodyStr,
        },
      );
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "FCM request failed",
      };
    }

    if (res.ok) {
      let msgId: string = randomUUID();
      try {
        const okJson = (await res.json()) as { name?: unknown };
        if (typeof okJson.name === "string" && okJson.name) msgId = okJson.name;
      } catch {}
      return { status: "ok", id: msgId };
    }

    let fcmErrorCode = "";
    let fcmStatus = "";
    try {
      const errJson = (await res.json()) as {
        error?: { status?: string; details?: Array<{ errorCode?: string }> };
      };
      fcmStatus = errJson.error?.status ?? "";
      for (const detail of errJson.error?.details ?? []) {
        if (detail.errorCode) fcmErrorCode = detail.errorCode;
      }
    } catch {}

    if (
      res.status === 404 ||
      fcmErrorCode === "UNREGISTERED" ||
      fcmStatus === "NOT_FOUND" ||
      fcmStatus === "INVALID_ARGUMENT"
    ) {
      store.deactivateIfMatchingNativeToken(
        device.tokenId,
        device.nativeToken,
        "provider_unregistered",
        new Date(now()).toISOString(),
      );
      return {
        status: "error",
        message: fcmErrorCode || fcmStatus || "FCM token unregistered",
        details: {
          error: "DeviceNotRegistered",
          provider: "fcm",
          reason: fcmErrorCode || fcmStatus || "UNREGISTERED",
        },
      };
    }

    if (res.status === 401 || res.status === 403) {
      if (fcmErrorCode === "SENDER_ID_MISMATCH") {
        return {
          status: "error",
          message: "FCM sender ID mismatch",
          details: { error: "MismatchSenderId", provider: "fcm" },
        };
      }
      tokenCache.invalidateFcm();
      return {
        status: "error",
        message: "FCM credentials rejected",
        details: { error: "InvalidCredentials", provider: "fcm" },
      };
    }

    if (res.status === 429 || fcmErrorCode === "QUOTA_EXCEEDED") {
      return {
        status: "error",
        message: "FCM quota exceeded",
        details: { error: "MessageRateExceeded", provider: "fcm" },
      };
    }

    return {
      status: "error",
      message: `FCM HTTP ${res.status}`,
      details: { provider: "fcm" },
    };
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (method === "GET" && pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "POST" && (pathname === "/v1/devices/register" || pathname === "/v1/devices/unregister")) {
      const callerIp = extractCallerIp(req, trustedProxies);
      if (!registerLimiter.allow(callerIp)) {
        sendError(res, 429, "RATE_LIMITED", "Too many registration requests from this IP");
        return;
      }

      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req);
      } catch {
        sendError(res, 400, "INVALID_JSON", "Malformed or oversized JSON body");
        return;
      }

      if (pathname === "/v1/devices/unregister") {
        const parsed = UnregisterRequestSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request");
          return;
        }
        store.unregister({
          appId: parsed.data.appId,
          deviceId: parsed.data.deviceId,
          nowIso: new Date(now()).toISOString(),
        });
        sendJson(res, 200, { ok: true });
        return;
      }

      const parsed = RegisterRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        sendError(res, 400, "VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request");
        return;
      }
      const data = parsed.data;
      if (allowedApps && !allowedApps.has(data.appId)) {
        sendError(res, 403, "APP_NOT_ALLOWED", `App ID ${data.appId} is not allowed`);
        return;
      }
      const provider = data.provider ?? (data.platform === "ios" ? "apns" : "fcm");
      if (
        (data.platform === "ios" && provider !== "apns") ||
        (data.platform === "android" && provider !== "fcm")
      ) {
        sendError(res, 400, "VALIDATION_ERROR", "Provider does not match platform");
        return;
      }
      if (provider === "apns" && !/^[0-9a-fA-F]{32,512}$/.test(data.pushToken)) {
        sendError(res, 400, "VALIDATION_ERROR", "APNs device token must be hex");
        return;
      }

      const { token } = store.register({
        appId: data.appId,
        deviceId: data.deviceId,
        platform: data.platform,
        provider,
        nativeToken: data.pushToken,
        environment: data.environment ?? "production",
        nowIso: new Date(now()).toISOString(),
      });
      sendJson(res, 200, { token });
      return;
    }

    if (method === "POST" && pathname === "/v1/push/send") {
      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(req);
      } catch {
        sendError(res, 400, "INVALID_JSON", "Malformed or oversized JSON body");
        return;
      }

      const parsed = WakeSendRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        sendError(
          res,
          400,
          "VALIDATION_ERROR",
          "Wake-only push accepts strictly { to, connId, seq, ttl? } and refuses plaintext content fields",
        );
        return;
      }

      const items = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      const expanded: Array<{ to: string; connId: string; seq: number; ttl: number }> = [];
      for (const item of items) {
        const recipients = Array.isArray(item.to) ? item.to : [item.to];
        const ttl = item.ttl ?? 3600;
        for (const recipient of recipients) {
          expanded.push({ to: recipient, connId: item.connId, seq: item.seq, ttl });
        }
      }
      if (expanded.length > MAX_BATCH_RECIPIENTS) {
        sendError(
          res,
          400,
          "PUSH_TOO_MANY_NOTIFICATIONS",
          `At most ${MAX_BATCH_RECIPIENTS} recipients per request`,
        );
        return;
      }

      const tickets: PushTicket[] = [];
      for (const entry of expanded) {
        const tokenId = parseLumenPushToken(entry.to);
        if (!tokenId) {
          tickets.push({
            status: "error",
            message: "Unknown or malformed LumenPushToken",
            details: { error: "DeviceNotRegistered" },
          });
          continue;
        }
        const device = store.getByTokenId(tokenId);
        if (!device?.active) {
          tickets.push({
            status: "error",
            message: "Device token is inactive or not registered",
            details: {
              error: "DeviceNotRegistered",
              ...(device?.inactiveReason ? { reason: device.inactiveReason } : {}),
            },
          });
          continue;
        }
        if (!sendLimiter.allow(`send:${tokenId}`)) {
          tickets.push({
            status: "error",
            message: "Per-recipient send rate limit exceeded",
            details: { error: "MessageRateExceeded", reason: "RecipientRateLimited" },
          });
          continue;
        }

        if (device.provider === "apns") {
          tickets.push(await deliverApnsWake(device, entry));
        } else {
          tickets.push(await deliverFcmWake(device, entry));
        }
      }

      sendJson(res, 200, { data: tickets });
      return;
    }

    sendError(res, 404, "NOT_FOUND", "Route not found");
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    server,
    store,
    port: addr.port,
    url: `http://${host}:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (ownsStore) store.close();
          resolve();
        });
      }),
  };
}
