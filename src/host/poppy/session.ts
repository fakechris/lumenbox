/**
 * Poppy Sessions (spec section 5).
 *
 * A Session belongs to one User, at one Company, through one Personal Agent.
 * This module manages:
 *   - Pairwise User IDs (per User per Company, stable and opaque)
 *   - Delegated keys (short-lived keys signed by the agent's long-lived key)
 *   - Session JWTs (fresh for every request)
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentIdentity } from "./identity.ts";
import type { PoppyCompany } from "./discovery.ts";
import {
  ES256,
  base64url,
  exportPublicJwk,
  generateKeyPair,
  jwkThumbprint,
  nowSeconds,
  randomId,
  sha256Base64url,
  signJwt,
  type EcPublicJwk,
} from "./jose.ts";

/** How long a delegation lasts (spec 5.2: at most 24 hours). We use 1 hour. */
const DELEGATION_LIFETIME = 3600;
/** Renew this many seconds before expiry so the Company never sees an expired one. */
const RENEW_MARGIN = 300;
/** How long one Session JWT is good for. It is made fresh for every request. */
const SESSION_JWT_LIFETIME = 60;

// ── User IDs ──────────────────────────────────────────────────────

/**
 * Per-User per-Company identifier store.
 *
 * User IDs are stable (the Company sees the same User across Sessions),
 * opaque, and different for each Company (spec 5.1). They MUST NOT contain
 * or be derived from personal information.
 */
export interface UserIdStore {
  get(companyIdentifier: string): string | undefined;
  set(companyIdentifier: string, userId: string): void;
}

/**
 * User IDs on disk, so a Company sees the same User after a restart (spec 5.1). Owner-only, like
 * the agent key; the IDs are random and carry nothing about the person. The key is the caller's:
 * the manager makes it from whom the agent acts for and the Company's domain.
 */
export class FileUserIdStore implements UserIdStore {
  private readonly ids: Map<string, string>;

  constructor(private readonly path: string) {
    let saved: Record<string, string> = {};
    try {
      saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    } catch {
      // Not there yet, or unreadable: start empty rather than refuse to talk to anyone.
    }
    this.ids = new Map(Object.entries(saved).filter(([, id]) => typeof id === "string"));
  }

  get(key: string): string | undefined {
    return this.ids.get(key);
  }

  set(key: string, userId: string): void {
    this.ids.set(key, userId);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.ids), null, 2), { mode: 0o600 });
  }
}

/** In-memory store, for tests. */
export class MemoryUserIdStore implements UserIdStore {
  private readonly ids = new Map<string, string>();
  get(companyIdentifier: string): string | undefined {
    return this.ids.get(companyIdentifier);
  }
  set(companyIdentifier: string, userId: string): void {
    this.ids.set(companyIdentifier, userId);
  }
}

/** Gets or creates a stable User ID under `key` (who the agent acts for, at which Company). */
export function userIdFor(key: string, store: UserIdStore): string {
  const existing = store.get(key);
  if (existing) return existing;
  const id = `usr_${randomId()}`;
  store.set(key, id);
  return id;
}

// ── Delegated keys ────────────────────────────────────────────────

interface DelegatedKey {
  privateKey: CryptoKey;
  kid: string;
  delegation: string;
  exp: number;
}

/**
 * Manages delegated keys for one User ID (spec 5.2).
 *
 * Each key signs only this User ID's Session JWTs, so Companies cannot match
 * the User across Companies by key (spec 10.7).
 */
export class DelegatedKeyManager {
  private current: DelegatedKey | undefined;
  private issuing: Promise<DelegatedKey> | undefined;
  private readonly identity: AgentIdentity;
  private readonly lifetime: number;

  constructor(identity: AgentIdentity, lifetime = DELEGATION_LIFETIME) {
    this.identity = identity;
    this.lifetime = lifetime;
  }

  async getKey(): Promise<DelegatedKey> {
    if (this.current && nowSeconds() < this.current.exp - RENEW_MARGIN) {
      return this.current;
    }
    if (!this.issuing) {
      // Cleared on failure too: one failed issue must not make every later request fail with it.
      this.issuing = this.issue().then(
        key => {
          this.current = key;
          this.issuing = undefined;
          return key;
        },
        (error: unknown) => {
          this.issuing = undefined;
          throw error;
        },
      );
    }
    return this.issuing;
  }

  private async issue(): Promise<DelegatedKey> {
    const pair = await generateKeyPair();
    const publicJwk: EcPublicJwk = await exportPublicJwk(pair.publicKey);
    const iat = nowSeconds();
    const exp = iat + this.lifetime;

    // The delegation names no User or Company (spec 5.2).
    const delegation = await signJwt(
      { typ: "poppy-delegation+jwt", alg: "ES256", kid: this.identity.kid },
      {
        iss: this.identity.clientId,
        cnf: { jwk: publicJwk },
        iat,
        exp,
        jti: randomId(),
      },
      this.identity.privateKey
    );

    const kid = await jwkThumbprint(publicJwk);
    return { privateKey: pair.privateKey, kid, delegation, exp };
  }
}

// ── Session ───────────────────────────────────────────────────────

export interface PoppySession {
  /** The Company this Session is with. */
  company: PoppyCompany;
  /** The Session ID (random, unguessable). */
  sid: string;
  /** The User ID for this Company. */
  userId: string;
  /** The protocol version being used. */
  version: string;
  /** Signs a fresh Session JWT for the given request. */
  sessionJwt(method: string, url: string, accessToken?: string): Promise<string>;
  /** The headers to add to a request in this Session. */
  headers(method: string, url: string, accessToken?: string): Promise<Record<string, string>>;
}

/** Creates a new Session for a User at a Company. */
export function createSession(
  identity: AgentIdentity,
  company: PoppyCompany,
  userId: string,
  delegatedKeys: DelegatedKeyManager
): PoppySession {
  const sid = randomId();
  const version = company.protocolVersion;

  return {
    company,
    sid,
    userId,
    version,

    async sessionJwt(method: string, url: string, accessToken?: string): Promise<string> {
      const key = await delegatedKeys.getKey();
      const parsedUrl = new URL(url);
      const htu = `${parsedUrl.origin}${parsedUrl.pathname}`;
      const iat = nowSeconds();

      const payload: Record<string, unknown> = {
        iss: identity.clientId,
        aud: company.identifier,
        sid,
        sub: userId,
        htm: method.toUpperCase(),
        htu,
        iat,
        // Signed per request: a minute is enough for it to arrive and too short to be worth replaying.
        exp: iat + SESSION_JWT_LIFETIME,
        jti: randomId(),
      };
      if (accessToken !== undefined) {
        payload.ath = await sha256Base64url(accessToken);
      }

      return signJwt(
        { typ: "poppy-session+jwt", alg: "ES256", kid: key.kid, poppy_dlg: key.delegation },
        payload,
        key.privateKey
      );
    },

    async headers(method: string, url: string, accessToken?: string): Promise<Record<string, string>> {
      const jwt = await this.sessionJwt(method, url, accessToken);
      const result: Record<string, string> = {
        "Poppy-Session": jwt,
        "Poppy-Version": version,
      };
      if (accessToken) {
        result["Authorization"] = `Bearer ${accessToken}`;
      }
      return result;
    },
  };
}
