/**
 * SQLite-backed device token mapping for the Wake-Only Push Gateway (`node:sqlite`, zero external
 * dependencies, docs/109 §5.1, INV-2215).
 *
 * Invariants:
 * 1. Keyed on `(app_id, device_id)`: token rotations, environment flips, or re-registrations after
 *    `unregister` update the existing row in place and return the exact same `LumenPushToken[…]`.
 * 2. Single live install per `(provider, native_token)`: if the same native APNs/FCM token is
 *    registered under a new `device_id` (e.g. after an app reinstall), any previous active row for
 *    that native token is atomically marked inactive (`inactive_reason = 'superseded'`) so stale
 *    servers receive `DeviceNotRegistered` and prune their dead tokens.
 * 3. Race-safe provider deactivation: `deactivateIfMatchingNativeToken` only deactivates a row if
 *    its current `native_token` still matches the token that failed at APNs/FCM, preserving an
 *    in-flight fresh registration.
 */

import { DatabaseSync } from "node:sqlite";
import { formatLumenPushToken, generatePushTokenId } from "./tokens.ts";

export type PushPlatform = "ios" | "android";
export type PushProvider = "apns" | "fcm";
export type ApnsEnvironment = "production" | "development";

export interface RegisteredPushDevice {
  readonly tokenId: string;
  readonly appId: string;
  readonly deviceId: string;
  readonly platform: PushPlatform;
  readonly provider: PushProvider;
  readonly nativeToken: string;
  readonly environment: ApnsEnvironment;
  readonly active: boolean;
  readonly inactiveReason: string | null;
  readonly updatedAt: string;
}

export class PushDeviceStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_devices (
        token_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        provider TEXT NOT NULL,
        native_token TEXT NOT NULL,
        environment TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        inactive_reason TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(app_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS idx_push_devices_native
        ON push_devices(provider, native_token)
        WHERE active = 1;
    `);
  }

  register(input: {
    appId: string;
    deviceId: string;
    platform: PushPlatform;
    provider: PushProvider;
    nativeToken: string;
    environment: ApnsEnvironment;
    nowIso?: string;
  }): { token: string; tokenId: string } {
    const normalizedDeviceId = input.deviceId.toLowerCase();
    const normalizedNative =
      input.provider === "apns" ? input.nativeToken.toLowerCase() : input.nativeToken;
    const env: ApnsEnvironment = input.provider === "apns" ? input.environment : "production";
    const nowIso = input.nowIso ?? new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Supersede any other install currently holding the same (provider, native_token).
      this.db
        .prepare(
          `UPDATE push_devices
              SET active = 0, inactive_reason = 'superseded', updated_at = ?
            WHERE provider = ?
              AND native_token = ?
              AND active = 1
              AND NOT (app_id = ? AND device_id = ?)`,
        )
        .run(nowIso, input.provider, normalizedNative, input.appId, normalizedDeviceId);

      const existing = this.db
        .prepare(`SELECT token_id FROM push_devices WHERE app_id = ? AND device_id = ?`)
        .get(input.appId, normalizedDeviceId) as { token_id: string } | undefined;

      if (existing) {
        this.db
          .prepare(
            `UPDATE push_devices
                SET platform = ?,
                    provider = ?,
                    native_token = ?,
                    environment = ?,
                    active = 1,
                    inactive_reason = NULL,
                    updated_at = ?
              WHERE token_id = ?`,
          )
          .run(
            input.platform,
            input.provider,
            normalizedNative,
            env,
            nowIso,
            existing.token_id,
          );
        this.db.exec("COMMIT");
        return {
          tokenId: existing.token_id,
          token: formatLumenPushToken(existing.token_id),
        };
      }

      let tokenId = generatePushTokenId();
      while (
        this.db.prepare(`SELECT 1 FROM push_devices WHERE token_id = ?`).get(tokenId) !== undefined
      ) {
        tokenId = generatePushTokenId();
      }

      this.db
        .prepare(
          `INSERT INTO push_devices (
             token_id, app_id, device_id, platform, provider,
             native_token, environment, active, inactive_reason, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)`,
        )
        .run(
          tokenId,
          input.appId,
          normalizedDeviceId,
          input.platform,
          input.provider,
          normalizedNative,
          env,
          nowIso,
        );
      this.db.exec("COMMIT");
      return { tokenId, token: formatLumenPushToken(tokenId) };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  unregister(input: { appId: string; deviceId: string; nowIso?: string }): void {
    const nowIso = input.nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE push_devices
            SET active = 0, inactive_reason = 'unregistered', updated_at = ?
          WHERE app_id = ? AND device_id = ? AND active = 1`,
      )
      .run(nowIso, input.appId, input.deviceId.toLowerCase());
  }

  getByTokenId(tokenId: string): RegisteredPushDevice | undefined {
    const row = this.db
      .prepare(
        `SELECT token_id, app_id, device_id, platform, provider, native_token,
                environment, active, inactive_reason, updated_at
           FROM push_devices
          WHERE token_id = ?`,
      )
      .get(tokenId) as
      | {
          token_id: string;
          app_id: string;
          device_id: string;
          platform: PushPlatform;
          provider: PushProvider;
          native_token: string;
          environment: ApnsEnvironment;
          active: number;
          inactive_reason: string | null;
          updated_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      tokenId: row.token_id,
      appId: row.app_id,
      deviceId: row.device_id,
      platform: row.platform,
      provider: row.provider,
      nativeToken: row.native_token,
      environment: row.environment,
      active: row.active === 1,
      inactiveReason: row.inactive_reason,
      updatedAt: row.updated_at,
    };
  }

  deactivateIfMatchingNativeToken(
    tokenId: string,
    sentNativeToken: string,
    reason = "provider_unregistered",
    nowIso = new Date().toISOString(),
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE push_devices
            SET active = 0, inactive_reason = ?, updated_at = ?
          WHERE token_id = ? AND native_token = ? AND active = 1`,
      )
      .run(reason, nowIso, tokenId, sentNativeToken);
    return Number(res.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}
