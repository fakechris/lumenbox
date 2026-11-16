/**
 * Poppy OAuth client (spec sections 6 and 7).
 *
 * Companies that support account access publish an OAuth authorization server.
 * This module handles:
 *
 *   1. Authorization server metadata discovery (RFC 8414)
 *   2. Authorization Code with PKCE (spec 6.2.1 Direct Sign-In)
 *   3. Device Authorization Grant (spec 6.2.2 Device Sign-In, RFC 8628)
 *   4. Token refresh
 *   5. Client authentication via private_key_jwt (spec 6.4)
 *
 * Tokens never leave the host — the manager injects them as Authorization
 * headers on outbound requests (spec 10.1).
 */

import { signJwt, randomId, ES256 } from "./jose.ts";
import type { AgentIdentity } from "./identity.ts";
import { poppyRequest, poppyUrl } from "./http.ts";

// ── Authorization Server Metadata (RFC 8414) ──────────────────

export interface AuthServerMeta {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  jwksUri?: string;
  scopesSupported?: string[];
  responseTypesSupported?: string[];
  grantTypesSupported?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  dpopSigningAlgValuesSupported?: string[];
}

const metaCache = new Map<string, { meta: AuthServerMeta; at: number }>();
const META_TTL_MS = 30 * 60 * 1000;

/**
 * Discovers the authorization server for a Company's issuer.
 * Follows RFC 8414 — fetches `{issuer}/.well-known/oauth-authorization-server`.
 */
export async function discoverAuthServer(issuer: string): Promise<AuthServerMeta | null> {
  const key = issuer.toLowerCase();
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.meta;

  let response: Response;
  let site: string;
  try {
    site = poppyUrl(issuer).hostname;
    response = await poppyRequest(`${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`, { headers: { Accept: "application/json" }, timeoutMs: 10_000 }, site);
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let doc: Record<string, unknown>;
  try {
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof doc.issuer !== "string" || typeof doc.token_endpoint !== "string") return null;
  // RFC 8414 §3.3: the document names the issuer it was asked for, or it is not that issuer's.
  if (doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) return null;
  // What the host calls is on the issuer's site; what the person's browser opens is at least https.
  const onSite = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    try { return poppyUrl(value, site).toString(); } catch { return undefined; }
  };
  if (onSite(doc.token_endpoint) === undefined) return null;
  if (typeof doc.authorization_endpoint === "string") {
    try { poppyUrl(doc.authorization_endpoint); } catch { return null; }
  }

  const meta: AuthServerMeta = {
    issuer: String(doc.issuer),
    authorizationEndpoint: typeof doc.authorization_endpoint === "string" ? doc.authorization_endpoint : "",
    tokenEndpoint: String(doc.token_endpoint),
    deviceAuthorizationEndpoint: onSite(doc.device_authorization_endpoint),
    revocationEndpoint: onSite(doc.revocation_endpoint),
    jwksUri: typeof doc.jwks_uri === "string" ? doc.jwks_uri : undefined,
    scopesSupported: Array.isArray(doc.scopes_supported) ? doc.scopes_supported.filter((s): s is string => typeof s === "string") : undefined,
    responseTypesSupported: Array.isArray(doc.response_types_supported) ? doc.response_types_supported.filter((s): s is string => typeof s === "string") : undefined,
    grantTypesSupported: Array.isArray(doc.grant_types_supported) ? doc.grant_types_supported.filter((s): s is string => typeof s === "string") : undefined,
    tokenEndpointAuthMethodsSupported: Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported.filter((s): s is string => typeof s === "string") : undefined,
    dpopSigningAlgValuesSupported: Array.isArray(doc.dpop_signing_alg_values_supported) ? doc.dpop_signing_alg_values_supported.filter((s): s is string => typeof s === "string") : undefined,
  };

  metaCache.set(key, { meta, at: Date.now() });
  return meta;
}

export function clearAuthServerCache(): void {
  metaCache.clear();
}

// ── Client Assertion (private_key_jwt, spec 6.4) ──────────────

/**
 * Signs a `client_assertion` JWT for the token endpoint.
 *
 * This is how the agent authenticates itself to the Company's authorization
 * server, proving it holds the private key whose public half is at `jwks_uri`.
 */
export async function clientAssertion(
  identity: AgentIdentity,
  audience: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    { alg: "ES256", kid: identity.kid, typ: "JWT" },
    {
      iss: identity.clientId,
      sub: identity.clientId,
      aud: audience,
      jti: randomId(),
      iat: now,
      exp: now + 120,
    },
    identity.privateKey,
  );
}

// ── PKCE (RFC 7636) ───────────────────────────────────────────

function base64urlRandom(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64urlRandom(32);
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier).buffer as ArrayBuffer);
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { verifier, challenge };
}

// ── Token Types ───────────────────────────────────────────────

export interface TokenSet {
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

// ── Authorization Code Flow (spec 6.2.1) ──────────────────────

export interface AuthCodeRequest {
  /** The Company's auth server metadata. */
  server: AuthServerMeta;
  /** The agent's identity. */
  identity: AgentIdentity;
  /** Where the callback lands (our /poppy/callback). */
  redirectUri: string;
  /** Scopes to request. */
  scopes: string[];
}

/**
 * Builds the authorization URL the user's browser should open.
 *
 * Returns the URL and the PKCE verifier (which must be kept until the callback).
 */
export async function buildAuthorizationUrl(
  req: AuthCodeRequest,
): Promise<{ url: string; state: string; verifier: string }> {
  const { verifier, challenge } = await pkceChallenge();
  const state = randomId();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: req.identity.clientId,
    redirect_uri: req.redirectUri,
    scope: req.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return {
    url: `${req.server.authorizationEndpoint}?${params.toString()}`,
    state,
    verifier,
  };
}

/**
 * Exchanges an authorization code for tokens.
 */
export async function exchangeCode(
  server: AuthServerMeta,
  identity: AgentIdentity,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenSet> {
  const assertion = await clientAssertion(identity, server.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await poppyRequest(server.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 15_000,
  }, siteOf(server));

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthError(`Token exchange failed: HTTP ${response.status}`, text);
  }

  return parseTokenResponse(await response.json() as Record<string, unknown>);
}

// ── Device Authorization Grant (spec 6.2.2, RFC 8628) ─────────

/**
 * Starts a device authorization flow.
 *
 * Returns a device code and a URL+code the user must visit on another device.
 */
export async function startDeviceAuth(
  server: AuthServerMeta,
  identity: AgentIdentity,
  scopes: string[],
): Promise<DeviceCodeResponse> {
  if (!server.deviceAuthorizationEndpoint) {
    throw new OAuthError("Company does not support device authorization", "no device_authorization_endpoint");
  }

  const assertion = await clientAssertion(identity, server.deviceAuthorizationEndpoint);

  const body = new URLSearchParams({
    client_id: identity.clientId,
    scope: scopes.join(" "),
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await poppyRequest(server.deviceAuthorizationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 15_000,
  }, siteOf(server));

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthError(`Device authorization failed: HTTP ${response.status}`, text);
  }

  const doc = (await response.json()) as Record<string, unknown>;
  return {
    deviceCode: String(doc.device_code ?? ""),
    userCode: String(doc.user_code ?? ""),
    verificationUri: String(doc.verification_uri ?? ""),
    verificationUriComplete: typeof doc.verification_uri_complete === "string" ? doc.verification_uri_complete : undefined,
    expiresIn: Number(doc.expires_in ?? 300),
    interval: Number(doc.interval ?? 5),
  };
}

/**
 * Polls the token endpoint for a device code (RFC 8628 §3.4).
 *
 * Returns `null` when the user has not yet authorized (authorization_pending),
 * throws on errors (expired, access_denied, etc.).
 */
export async function pollDeviceToken(
  server: AuthServerMeta,
  identity: AgentIdentity,
  deviceCode: string,
): Promise<TokenSet | null> {
  const assertion = await clientAssertion(identity, server.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode,
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await poppyRequest(server.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 15_000,
  }, siteOf(server));

  if (!response.ok) {
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* */ }

    const error = String(parsed.error ?? "");
    if (error === "authorization_pending") return null;
    if (error === "slow_down") return null;
    throw new OAuthError(`Device token poll failed: ${error || `HTTP ${response.status}`}`, text);
  }

  return parseTokenResponse(await response.json() as Record<string, unknown>);
}

// ── Token Refresh ─────────────────────────────────────────────

/**
 * Refreshes an access token using a refresh token.
 */
export async function refreshToken(
  server: AuthServerMeta,
  identity: AgentIdentity,
  refreshTokenValue: string,
): Promise<TokenSet> {
  const assertion = await clientAssertion(identity, server.tokenEndpoint);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  const response = await poppyRequest(server.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
    timeoutMs: 15_000,
  }, siteOf(server));

  if (!response.ok) {
    const text = await response.text();
    throw new OAuthError(`Token refresh failed: HTTP ${response.status}`, text, response.status);
  }

  return parseTokenResponse(await response.json() as Record<string, unknown>);
}

// ── Token Revocation ──────────────────────────────────────────

/**
 * Revokes a token at the Company's revocation endpoint (best-effort).
 */
export async function revokeToken(
  server: AuthServerMeta,
  identity: AgentIdentity,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token" = "refresh_token",
): Promise<void> {
  if (!server.revocationEndpoint) return;

  const assertion = await clientAssertion(identity, server.revocationEndpoint);

  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: identity.clientId,
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
  });

  try {
    await poppyRequest(server.revocationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      timeoutMs: 10_000,
    }, siteOf(server));
  } catch {
    // Best-effort; the token will expire regardless.
  }
}

// ── Helpers ───────────────────────────────────────────────────

function parseTokenResponse(doc: Record<string, unknown>): TokenSet {
  const accessToken = String(doc.access_token ?? "");
  if (!accessToken) throw new OAuthError("No access_token in response", JSON.stringify(doc));

  const expiresIn = Number(doc.expires_in ?? 3600);
  return {
    accessToken,
    tokenType: String(doc.token_type ?? "Bearer"),
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken: typeof doc.refresh_token === "string" ? doc.refresh_token : undefined,
    scope: typeof doc.scope === "string" ? doc.scope : undefined,
  };
}

export class OAuthError extends Error {
  constructor(message: string, readonly detail: string, readonly status?: number) {
    super(message);
  }

  /** Whether the server said this grant is finished (RFC 6749 §5.2), as opposed to failing for now. */
  get grantGone(): boolean {
    if (this.status === undefined || this.status < 400 || this.status >= 500) return false;
    try {
      return (JSON.parse(this.detail) as { error?: unknown }).error === "invalid_grant";
    } catch {
      return false;
    }
  }
}

/** The site an authorization server's endpoints must be on: its issuer's host. */
function siteOf(server: AuthServerMeta): string {
  return new URL(server.issuer).hostname;
}
