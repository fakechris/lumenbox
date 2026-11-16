/**
 * Poppy Sessions (spec section 5).
 *
 * A Session belongs to one User, at one Company, through one Personal Agent.
 * This module manages:
 *   - Pairwise User IDs (per User per Company, stable and opaque)
 *   - Delegated keys (short-lived keys signed by the agent's long-lived key)
 *   - Session JWTs (fresh for every request)
 */

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

/** In-memory store, for development. Production should persist to encrypted disk. */
export class MemoryUserIdStore implements UserIdStore {
  private readonly ids = new Map<string, string>();
  get(companyIdentifier: string): string | undefined {
    return this.ids.get(companyIdentifier);
  }
  set(companyIdentifier: string, userId: string): void {
    this.ids.set(companyIdentifier, userId);
  }
}

/** Gets or creates a stable User ID for a Company. */
export function userIdFor(company: PoppyCompany, store: UserIdStore): string {
  const existing = store.get(company.identifier);
  if (existing) return existing;
  const id = `usr_${randomId()}`;
  store.set(company.identifier, id);
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

  constructor(
    private readonly identity: AgentIdentity,
    private readonly lifetime = DELEGATION_LIFETIME
  ) {}

  async getKey(): Promise<DelegatedKey> {
    if (this.current && nowSeconds() < this.current.exp - RENEW_MARGIN) {
      return this.current;
    }
    if (!this.issuing) {
      this.issuing = this.issue().then(key => {
        this.current = key;
        this.issuing = undefined;
        return key;
      });
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
