/**
 * The agent's Poppy identity (spec 4.1).
 *
 * A Personal Agent's client_id is an HTTPS URL that returns its metadata document.
 * This module manages the key pair and the documents a Company fetches to learn who
 * the agent is:
 *
 *   client_id   → the metadata document (client_name, jwks_uri, redirect_uris)
 *   jwks_uri    → the public key set the agent signs delegations and client
 *                 assertions with
 *
 * The key pair is generated once and persisted to disk. The metadata and JWKS are
 * served by the host's web server at paths under /poppy/.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exportPrivateJwk,
  exportPublicJwk,
  generateExtractableKeyPair,
  importExtractablePrivateKey,
  jwkThumbprint,
  type EcPublicJwk,
} from "./jose.ts";

const KEY_FILENAME = "poppy-agent-key.json";

export interface AgentIdentity {
  /** The HTTPS URL of the client metadata document (spec 4.1). */
  clientId: string;
  /** The HTTPS URL of the JWKS endpoint. */
  jwksUri: string;
  /** The private key for signing delegations and client assertions. */
  privateKey: CryptoKey;
  /** kid = JWK thumbprint of the public key. */
  kid: string;
  /** The public key as JWK, for the JWKS endpoint. */
  publicJwk: EcPublicJwk & { kid: string; use: "sig"; alg: "ES256" };
}

/** Where the agent key lives on disk. */
function keyPath(home: string): string {
  return join(home, KEY_FILENAME);
}

/**
 * Loads or creates the agent's long-lived ES256 key pair.
 *
 * @param home   The agentbox home directory (~/.agentbox).
 * @param origin The HTTPS origin where this host serves (e.g. https://agent.example.com).
 */
export async function loadOrCreateIdentity(
  home: string,
  origin: string
): Promise<AgentIdentity> {
  const path = keyPath(home);
  let privateKey: CryptoKey;
  let publicJwk: EcPublicJwk;

  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as JsonWebKey;
    const extractable = await importExtractablePrivateKey(stored);
    publicJwk = { kty: "EC", crv: "P-256", x: stored.x!, y: stored.y! };
    // Re-import as non-extractable for daily use.
    privateKey = await importExtractablePrivateKey(stored);
    // Actually use the extractable one since we might need to re-export for delegation
    privateKey = extractable;
  } else {
    const pair = await generateExtractableKeyPair();
    publicJwk = await exportPublicJwk(pair.publicKey);
    const jwk = await exportPrivateJwk(pair.privateKey);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify(jwk, null, 2), { mode: 0o600 });
    privateKey = pair.privateKey;
  }

  const kid = await jwkThumbprint(publicJwk);
  const clientId = `${origin}/poppy/agent.json`;
  const jwksUri = `${origin}/poppy/jwks.json`;

  return {
    clientId,
    jwksUri,
    privateKey,
    kid,
    publicJwk: { ...publicJwk, kid, use: "sig", alg: "ES256" },
  };
}

/** The client metadata document a Company fetches (spec 4.1 CIMD). */
export function clientMetadataDocument(identity: AgentIdentity): Record<string, unknown> {
  return {
    client_id: identity.clientId,
    client_name: "LumenBox Agent",
    logo_uri: identity.clientId.replace("/poppy/agent.json", "/assets/logo.png"),
    jwks_uri: identity.jwksUri,
    redirect_uris: [identity.clientId.replace("/poppy/agent.json", "/poppy/callback")],
    token_endpoint_auth_method: "private_key_jwt",
  };
}

/** The JWKS document a Company fetches to verify delegations and client assertions. */
export function jwksDocument(identity: AgentIdentity): { keys: Array<Record<string, unknown>> } {
  return { keys: [identity.publicJwk] };
}
