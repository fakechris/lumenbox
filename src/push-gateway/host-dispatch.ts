/**
 * Host-side mobile push registration store (`~/.agentbox/device-pushes.json`), localized pull
 * notification ledger (`GET /api/v1/notifications/{seq}`), `/api/v1/devices/self/push` handlers,
 * and Wake-Only push dispatcher with automatic `DeviceNotRegistered` cleanup (docs/109 §5, INV-2215).
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { z } from "zod";
import type { PushTicket } from "./gateway-server.ts";
import { parseLumenPushToken } from "./tokens.ts";

export const DEFAULT_PUSH_GATEWAY_URL = "https://push.lumenbox.com";
const MAX_STORED_NOTIFICATIONS = 2000;

export type DeviceNotificationMode = "needs-you" | "all" | "off";

export interface QuietHoursPreference {
  /** 0–23 local hour when quiet window starts. */
  readonly startHour: number;
  /** 0–23 local hour when quiet window ends. */
  readonly endHour: number;
  /** IANA timezone (e.g. `"Asia/Shanghai"`). Defaults to `"UTC"`. */
  readonly timezone?: string;
}

export interface DevicePushPreferences {
  readonly mode: DeviceNotificationMode;
  readonly quietHours?: QuietHoursPreference;
}

export interface StoredDevicePush {
  readonly principalId: string;
  readonly deviceId: string;
  readonly pushToken: string;
  readonly connId: string;
  readonly preferences: DevicePushPreferences;
  readonly updatedAt: string;
}

export type WakeEventKind = "needs-you" | "task-completed";

export interface StoredWakeNotification {
  readonly seq: number;
  readonly principalId: string;
  readonly kind: WakeEventKind;
  readonly title: string;
  readonly body: string;
  readonly ref?: string;
  readonly agentId?: string;
  readonly redactOnLockScreen?: boolean;
  readonly createdAt: string;
}

function writeAtomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Resolves the push gateway base URL, allowing white-label builds to override it via config or
 * `AGENTBOX_PUSH_GATEWAY_URL` passed from the entrypoint layer.
 */
export function resolvePushGatewayUrl(options?: {
  configUrl?: string;
  envUrl?: string;
}): string {
  const raw = (options?.envUrl || options?.configUrl || DEFAULT_PUSH_GATEWAY_URL).trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported push gateway protocol: ${parsed.protocol}`);
  }
  return parsed.origin;
}

export function isWithinQuietHours(quiet: QuietHoursPreference | undefined, date: Date): boolean {
  if (!quiet) return false;
  let hour: number;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: quiet.timezone ?? "UTC",
    });
    hour = Number(fmt.format(date)) % 24;
  } catch {
    hour = date.getUTCHours();
  }
  if (quiet.startHour === quiet.endHour) return false;
  if (quiet.startHour < quiet.endHour) {
    return hour >= quiet.startHour && hour < quiet.endHour;
  }
  return hour >= quiet.startHour || hour < quiet.endHour;
}

export class HostDevicePushStore {
  private readonly pushFile: string;
  private readonly notifFile: string;

  constructor(homeDir: string) {
    this.pushFile = path.join(homeDir, "device-pushes.json");
    this.notifFile = path.join(homeDir, "wake-notifications.json");
  }

  private readDevices(): StoredDevicePush[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.pushFile, "utf8")) as { devices?: unknown };
      return Array.isArray(parsed.devices) ? (parsed.devices as StoredDevicePush[]) : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  private writeDevices(devices: StoredDevicePush[]): void {
    writeAtomicJson(this.pushFile, { devices });
  }

  private readNotifications(): { lastSeq: number; items: StoredWakeNotification[] } {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.notifFile, "utf8")) as {
        lastSeq?: unknown;
        items?: unknown;
      };
      return {
        lastSeq: typeof parsed.lastSeq === "number" ? parsed.lastSeq : 0,
        items: Array.isArray(parsed.items) ? (parsed.items as StoredWakeNotification[]) : [],
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { lastSeq: 0, items: [] };
      throw err;
    }
  }

  private writeNotifications(state: { lastSeq: number; items: StoredWakeNotification[] }): void {
    writeAtomicJson(this.notifFile, state);
  }

  upsertDevicePush(entry: StoredDevicePush): StoredDevicePush {
    if (!parseLumenPushToken(entry.pushToken)) {
      throw new Error("Invalid LumenPushToken format");
    }
    const all = this.readDevices().filter(
      (d) => !(d.principalId === entry.principalId && d.deviceId === entry.deviceId),
    );
    all.push(entry);
    this.writeDevices(all);
    return entry;
  }

  removeDevicePush(principalId: string, deviceId: string): boolean {
    const all = this.readDevices();
    const kept = all.filter((d) => !(d.principalId === principalId && d.deviceId === deviceId));
    if (kept.length === all.length) return false;
    this.writeDevices(kept);
    return true;
  }

  removeByPushToken(pushToken: string): number {
    const all = this.readDevices();
    const kept = all.filter((d) => d.pushToken !== pushToken);
    const removed = all.length - kept.length;
    if (removed > 0) this.writeDevices(kept);
    return removed;
  }

  listForPrincipal(principalId: string): StoredDevicePush[] {
    return this.readDevices().filter((d) => d.principalId === principalId);
  }

  appendNotification(input: {
    principalId: string;
    kind: WakeEventKind;
    title: string;
    body: string;
    ref?: string;
    agentId?: string;
    redactOnLockScreen?: boolean;
    nowIso?: string;
  }): StoredWakeNotification {
    const cur = this.readNotifications();
    const seq = cur.lastSeq + 1;
    const item: StoredWakeNotification = {
      seq,
      principalId: input.principalId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.redactOnLockScreen !== undefined
        ? { redactOnLockScreen: input.redactOnLockScreen }
        : {}),
      createdAt: input.nowIso ?? new Date().toISOString(),
    };
    const items = [...cur.items, item].slice(-MAX_STORED_NOTIFICATIONS);
    this.writeNotifications({ lastSeq: seq, items });
    return item;
  }

  /**
   * Reads notification `seq` ONLY if it belongs to `principalId`; returns `undefined` otherwise so
   * callers answer `404` without leaking other principals' sequence contents (docs/106 §4.1).
   */
  getNotificationForPrincipal(principalId: string, seq: number): StoredWakeNotification | undefined {
    const { items } = this.readNotifications();
    const found = items.find((n) => n.seq === seq);
    if (!found || found.principalId !== principalId) return undefined;
    return found;
  }
}

export interface WakePushDispatcherOptions {
  readonly store: HostDevicePushStore;
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly redactOnLockScreen?: boolean;
  readonly now?: () => Date;
}

export class WakePushDispatcher {
  private readonly store: HostDevicePushStore;
  private readonly gatewayUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly redactOnLockScreen: boolean;
  private readonly now: () => Date;

  constructor(options: WakePushDispatcherOptions) {
    this.store = options.store;
    this.gatewayUrl = resolvePushGatewayUrl({ configUrl: options.gatewayUrl });
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.redactOnLockScreen = options.redactOnLockScreen ?? false;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Persists the localized summary locally on the host and dispatches a zero-content `{ to, connId,
   * seq }` wake signal to eligible devices, pruning any token that answers `DeviceNotRegistered`.
   */
  async dispatchEvent(event: {
    principalId: string;
    kind: WakeEventKind;
    title: string;
    body: string;
    ref?: string;
    agentId?: string;
  }): Promise<{ seq: number; sent: number; pruned: number }> {
    const nowDate = this.now();
    const stored = this.store.appendNotification({
      ...event,
      ...(this.redactOnLockScreen ? { redactOnLockScreen: true } : {}),
      nowIso: nowDate.toISOString(),
    });

    const devices = this.store.listForPrincipal(event.principalId).filter((d) => {
      if (d.preferences.mode === "off") return false;
      if (d.preferences.mode === "needs-you" && event.kind !== "needs-you") return false;
      if (isWithinQuietHours(d.preferences.quietHours, nowDate)) return false;
      return true;
    });

    if (devices.length === 0) {
      return { seq: stored.seq, sent: 0, pruned: 0 };
    }

    const payload = devices.map((d) => ({
      to: d.pushToken,
      connId: d.connId,
      seq: stored.seq,
    }));

    const res = await this.fetchImpl(`${this.gatewayUrl}/v1/push/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      return { seq: stored.seq, sent: 0, pruned: 0 };
    }

    const body = (await res.json()) as { data?: PushTicket[] };
    const tickets = Array.isArray(body.data) ? body.data : [];
    let sent = 0;
    let pruned = 0;
    for (let i = 0; i < tickets.length && i < devices.length; i++) {
      const ticket = tickets[i]!;
      const dev = devices[i]!;
      if (ticket.status === "ok") {
        sent += 1;
      } else if (ticket.details?.error === "DeviceNotRegistered") {
        pruned += this.store.removeByPushToken(dev.pushToken);
      }
    }

    return { seq: stored.seq, sent, pruned };
  }
}

// ── Ready-to-mount `/api/v1` push & notification pull route handler ──────────

const PutSelfPushSchema = z
  .object({
    pushToken: z.string().refine((s) => parseLumenPushToken(s) !== null, {
      message: "Expected LumenPushToken[…] capability token",
    }),
    connId: z.string().min(4).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    preferences: z
      .object({
        mode: z.enum(["needs-you", "all", "off"]).default("needs-you"),
        quietHours: z
          .object({
            startHour: z.number().int().min(0).max(23),
            endHour: z.number().int().min(0).max(23),
            timezone: z.string().min(1).max(64).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface PushRouteCaller {
  readonly principalId: string;
  readonly deviceId: string;
  readonly requestId: string;
}

function writeV1Json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readRouteJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let len = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    len += buf.byteLength;
    if (len > 64 * 1024) throw new Error("oversized");
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Handles:
 * - `PUT /api/v1/devices/self/push`
 * - `DELETE /api/v1/devices/self/push`
 * - `GET /api/v1/notifications/{seq}`
 * Returns `true` when matched and handled, `false` otherwise.
 */
export async function handleV1DevicePushRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  caller: PushRouteCaller,
  store: HostDevicePushStore,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

  if (pathname === "/api/v1/devices/self/push") {
    if (method === "PUT") {
      let body: unknown;
      try {
        body = await readRouteJson(req);
      } catch {
        writeV1Json(res, 400, {
          code: "invalid-request",
          error: "Malformed JSON request body.",
          requestId: caller.requestId,
        });
        return true;
      }
      const parsed = PutSelfPushSchema.safeParse(body);
      if (!parsed.success) {
        writeV1Json(res, 400, {
          code: "invalid-request",
          error: parsed.error.issues[0]?.message ?? "Invalid push registration payload.",
          requestId: caller.requestId,
        });
        return true;
      }
      const saved = store.upsertDevicePush({
        principalId: caller.principalId,
        deviceId: caller.deviceId,
        pushToken: parsed.data.pushToken,
        connId: parsed.data.connId,
        preferences: parsed.data.preferences ?? { mode: "needs-you" },
        updatedAt: new Date().toISOString(),
      });
      writeV1Json(res, 200, {
        deviceId: saved.deviceId,
        connId: saved.connId,
        preferences: saved.preferences,
        updatedAt: saved.updatedAt,
      });
      return true;
    }

    if (method === "DELETE") {
      store.removeDevicePush(caller.principalId, caller.deviceId);
      writeV1Json(res, 200, { removed: true });
      return true;
    }

    return false;
  }

  const notifMatch = /^\/api\/v1\/notifications\/(\d+)$/.exec(pathname);
  if (notifMatch && method === "GET") {
    const seq = Number(notifMatch[1]);
    const item = store.getNotificationForPrincipal(caller.principalId, seq);
    if (!item) {
      writeV1Json(res, 404, {
        code: "not-found",
        error: "Notification not found.",
        requestId: caller.requestId,
      });
      return true;
    }
    writeV1Json(res, 200, {
      seq: item.seq,
      kind: item.kind,
      title: item.title,
      body: item.body,
      ...(item.ref ? { ref: item.ref } : {}),
      ...(item.agentId ? { agentId: item.agentId } : {}),
      redactOnLockScreen: item.redactOnLockScreen === true,
      createdAt: item.createdAt,
    });
    return true;
  }

  return false;
}
