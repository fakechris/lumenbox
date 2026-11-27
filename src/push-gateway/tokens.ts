/**
 * Opaque ~131-bit `LumenPushToken[…]` capability tokens and ES256 (APNs) / RS256 (FCM) provider
 * JWT signing over Node's built-in `node:crypto` (docs/109 §5, INV-2215).
 */

import { createPrivateKey, createSign, randomBytes } from "node:crypto";

export const LUMEN_PUSH_TOKEN_PREFIX = "LumenPushToken[";
export const LUMEN_PUSH_TOKEN_ID_LENGTH = 22;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Largest multiple of 62 <= 256 (62 * 4 = 248) for unbiased rejection sampling. */
const BASE62_MAX_UNBIASED = 248;

/** Generates a 22-character base62 identifier (~131.0 bits of entropy). */
export function generatePushTokenId(): string {
  const chars: string[] = [];
  while (chars.length < LUMEN_PUSH_TOKEN_ID_LENGTH) {
    const bytes = randomBytes(32);
    for (let i = 0; i < bytes.byteLength && chars.length < LUMEN_PUSH_TOKEN_ID_LENGTH; i++) {
      const b = bytes[i]!;
      if (b < BASE62_MAX_UNBIASED) {
        chars.push(BASE62_ALPHABET[b % 62]!);
      }
    }
  }
  return chars.join("");
}

export function formatLumenPushToken(tokenId: string): string {
  return `${LUMEN_PUSH_TOKEN_PREFIX}${tokenId}]`;
}

export function parseLumenPushToken(token: string): string | null {
  if (typeof token !== "string") return null;
  if (!token.startsWith(LUMEN_PUSH_TOKEN_PREFIX) || !token.endsWith("]")) return null;
  const inner = token.slice(LUMEN_PUSH_TOKEN_PREFIX.length, -1);
  if (inner.length !== LUMEN_PUSH_TOKEN_ID_LENGTH || !/^[0-9A-Za-z]{22}$/.test(inner)) {
    return null;
  }
  return inner;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Signs an Apple APNs provider authentication token (ES256, `ieee-p1363` raw `r || s` 64-byte
 * signature as required by RFC 7518 §3.4).
 */
export function signApnsJwt(options: {
  keyId: string;
  teamId: string;
  privateKeyPem: string;
  issuedAtSec: number;
}): string {
  const pem = options.privateKeyPem.replace(/\\n/g, "\n");
  const header = base64UrlJson({ alg: "ES256", kid: options.keyId });
  const payload = base64UrlJson({ iss: options.teamId, iat: options.issuedAtSec });
  const signingInput = `${header}.${payload}`;
  const keyObj = createPrivateKey(pem);
  const sig = createSign("SHA256")
    .update(signingInput)
    .sign({ key: keyObj, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${sig.toString("base64url")}`;
}

export interface FcmServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri?: string;
}

/**
 * Signs a Google OAuth 2.0 service-account JWT assertion (RS256) scoped to Firebase Cloud Messaging.
 */
export function signFcmServiceAccountAssertion(options: {
  serviceAccount: FcmServiceAccount;
  issuedAtSec: number;
}): { assertion: string; tokenUri: string } {
  const tokenUri = options.serviceAccount.token_uri ?? "https://oauth2.googleapis.com/token";
  const pem = options.serviceAccount.private_key.replace(/\\n/g, "\n");
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iss: options.serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUri,
    iat: options.issuedAtSec,
    exp: options.issuedAtSec + 3600,
  });
  const signingInput = `${header}.${payload}`;
  const keyObj = createPrivateKey(pem);
  const sig = createSign("RSA-SHA256").update(signingInput).sign(keyObj);
  return {
    assertion: `${signingInput}.${sig.toString("base64url")}`,
    tokenUri,
  };
}

/**
 * Caches APNs ES256 provider JWTs (for 50 minutes; Apple rejects refreshes more often than every
 * 20 minutes) and FCM OAuth2 access tokens (until 5 minutes before expiry).
 */
export class ProviderTokenCache {
  private apnsCached: { jwt: string; expiresAtSec: number } | null = null;
  private fcmCached: { accessToken: string; expiresAtSec: number } | null = null;

  getApnsJwt(options: {
    keyId: string;
    teamId: string;
    privateKeyPem: string;
    nowSec: number;
  }): string {
    if (this.apnsCached && this.apnsCached.expiresAtSec > options.nowSec) {
      return this.apnsCached.jwt;
    }
    const jwt = signApnsJwt({
      keyId: options.keyId,
      teamId: options.teamId,
      privateKeyPem: options.privateKeyPem,
      issuedAtSec: options.nowSec,
    });
    this.apnsCached = { jwt, expiresAtSec: options.nowSec + 50 * 60 };
    return jwt;
  }

  invalidateApns(): void {
    this.apnsCached = null;
  }

  async getFcmAccessToken(options: {
    serviceAccount: FcmServiceAccount;
    nowSec: number;
    fetchImpl?: typeof fetch;
  }): Promise<string> {
    if (this.fcmCached && this.fcmCached.expiresAtSec > options.nowSec) {
      return this.fcmCached.accessToken;
    }
    const { assertion, tokenUri } = signFcmServiceAccountAssertion({
      serviceAccount: options.serviceAccount,
      issuedAtSec: options.nowSec,
    });
    const fetchFn = options.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });
    const res = await fetchFn(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`FCM OAuth token exchange failed with HTTP ${res.status}`);
    }
    const json = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error("FCM OAuth response missing access_token");
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    this.fcmCached = {
      accessToken: json.access_token,
      expiresAtSec: options.nowSec + Math.max(60, expiresIn - 300),
    };
    return json.access_token;
  }

  invalidateFcm(): void {
    this.fcmCached = null;
  }
}
