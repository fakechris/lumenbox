/**
 * Minimal JOSE helpers for the Personal Agent Protocol (Poppy).
 *
 * Signing, verification and JWK thumbprints only. Uses the Web Crypto API
 * that Node 22 exposes globally so nothing outside the standard library is
 * needed. Only ES256 (P-256) is used for Session JWTs and delegations, as
 * the spec requires.
 */

const encoder = new TextEncoder();

/** base64url without padding (RFC 7515 §2). */
export function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256, returned as raw bytes. */
export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const input = typeof data === "string" ? encoder.encode(data) : data;
  // The view, not `input.buffer`: a subarray's buffer is the whole parent, and hashing it hashes the wrong bytes.
  const buf = await crypto.subtle.digest("SHA-256", input as Uint8Array<ArrayBuffer>);
  return new Uint8Array(buf);
}

/** SHA-256, returned as base64url (for ath claim and JWK thumbprint). */
export async function sha256Base64url(data: string): Promise<string> {
  return base64url(await sha256(data));
}

/** ES256 algorithm parameters for Web Crypto. */
export const ES256: EcKeyGenParams & EcdsaParams = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
};

/** The public half of an EC key, as a JWK with only the members the spec allows. */
export interface EcPublicJwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export async function exportPublicJwk(key: CryptoKey): Promise<EcPublicJwk> {
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return { kty: "EC", crv: "P-256", x: jwk.x!, y: jwk.y! };
}

/**
 * JWK Thumbprint (RFC 7638) of an EC public key.
 * Members in lexicographic order: crv, kty, x, y.
 */
export async function jwkThumbprint(jwk: EcPublicJwk): Promise<string> {
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return base64url(await sha256(canonical));
}

/** A 22-character URL-safe random ID, as the spec uses for sid, jti, etc. */
export function randomId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

/** Unix seconds, now. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Signs a JWT with ES256 (the only algorithm the spec requires). */
export async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  privateKey: CryptoKey
): Promise<string> {
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Web Crypto returns the signature in IEEE P1363 format, which is what JWS needs.
  const signature = await crypto.subtle.sign(ES256, privateKey, encoder.encode(signingInput));
  return `${signingInput}.${base64url(signature)}`;
}

/** Generates a new ES256 key pair. The private key is non-extractable. */
export async function generateKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ES256, false, ["sign", "verify"]);
}

/**
 * Generates a key pair where the private key IS extractable.
 * Used only for the agent's long-lived signing key, which must be persisted to disk.
 */
export async function generateExtractableKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(ES256, true, ["sign", "verify"]);
}

/** Exports a private key as JWK for storage. Only for the long-lived agent key. */
export async function exportPrivateJwk(key: CryptoKey): Promise<JsonWebKey> {
  return crypto.subtle.exportKey("jwk", key);
}

/** Imports a private key from a stored JWK. */
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, ES256, false, ["sign"]);
}
