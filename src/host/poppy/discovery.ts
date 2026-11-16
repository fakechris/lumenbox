/**
 * Poppy discovery (spec section 3).
 *
 * A Company publishes its poppy.json at /.well-known/poppy.json over HTTPS.
 * This module fetches, validates, and caches the document.
 */

import { poppyGetFollowing } from "./http.ts";

export interface PoppyCompany {
  /** The protocol version the document declares. */
  protocolVersion: string;
  /** The Company's display name. */
  name: string;
  /** The domain that served the document. */
  domain: string;
  /** Logo URL, if any. */
  logoUri?: string;
  /** The Company's identifier: its issuer when it has one, else https://{domain}. */
  identifier: string;

  /** Auth configuration. */
  auth?: {
    issuer?: string;
    disabled?: boolean;
    scopes?: Record<string, string>;
    scopeHints?: Record<string, { changes: string; personalData: boolean }>;
  };

  /** Conversation protocols (agent.protocols). */
  agentProtocols?: Array<{ type: string; endpoint: string; description?: string; access?: string }>;

  /** APIs the Company offers. */
  apis?: Array<{ type: string; url: string; description?: string }>;

  /** Web configuration. */
  web?: { browserSessionEndpoint?: string; disabled?: boolean };

  /** Tasks endpoint. */
  tasksEndpoint?: string;

  /** Extensions the Company supports. */
  extensions?: Record<string, Array<{ version: string; endpoint?: string }>>;

  /** The raw document, for anything we didn't parse. */
  raw: Record<string, unknown>;
}

/** Versions we implement (spec 3.4). */
export const SUPPORTED_VERSIONS = ["1.0", "0.4"];

/** How long a cached document is used before re-fetching. */
const CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedCompany {
  company: PoppyCompany;
  fetchedAt: number;
}

const cache = new Map<string, CachedCompany>();

/**
 * Discovers a Company's Poppy document by domain.
 *
 * Returns null when the domain does not publish poppy.json or serves a version
 * we do not implement.
 */
export async function discoverCompany(
  domain: string,
  options?: { noCache?: boolean }
): Promise<PoppyCompany | null> {
  const key = domain.toLowerCase();
  if (!options?.noCache) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.company;
  }

  // Through the guarded door (http.ts): every hop https and resolved to an outside address.
  let response: Response;
  let finalUrl: URL;
  try {
    ({ response, url: finalUrl } = await poppyGetFollowing(`https://${domain}/.well-known/poppy.json`, { headers: { Accept: "application/json" } }, domain));
  } catch {
    return null;
  }

  if (!response.ok) return null;

  // Spec 3: the final URL's path must be exactly /.well-known/poppy.json with no query.
  if (finalUrl.pathname !== "/.well-known/poppy.json" || finalUrl.search !== "") return null;

  let doc: Record<string, unknown>;
  try {
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }

  const protocolVersion = String(doc.protocol_version ?? "");
  if (!SUPPORTED_VERSIONS.some(v => versionsCompatible(v, protocolVersion))) return null;

  const org = doc.organization as Record<string, unknown> | undefined;
  if (!org || typeof org.name !== "string" || typeof org.domain !== "string") return null;

  // Spec 3.1: organization.domain MUST be the host that served the document.
  const servedBy = finalUrl.hostname.toLowerCase();
  if (org.domain.toString().toLowerCase() !== servedBy) return null;

  const authRaw = doc.auth as Record<string, unknown> | undefined;
  const agentRaw = doc.agent as Record<string, unknown> | undefined;
  const webRaw = doc.web as Record<string, unknown> | undefined;
  const tasksRaw = doc.tasks as Record<string, unknown> | undefined;
  const apisRaw = doc.apis as unknown[] | undefined;
  const extRaw = doc.extensions as Record<string, unknown[]> | undefined;

  // Spec 3.1: at least one of agent, apis, or web.
  if (!agentRaw && !apisRaw && !webRaw) return null;

  const identifier = authRaw?.issuer
    ? String(authRaw.issuer)
    : `https://${org.domain.toString().toLowerCase()}`;

  const company: PoppyCompany = {
    protocolVersion,
    name: String(org.name),
    domain: String(org.domain),
    logoUri: typeof org.logo_uri === "string" ? org.logo_uri : undefined,
    identifier,
    raw: doc,
  };

  if (authRaw) {
    company.auth = {
      issuer: typeof authRaw.issuer === "string" ? authRaw.issuer : undefined,
      disabled: authRaw.disabled === true,
      scopes: isStringRecord(authRaw.scopes) ? authRaw.scopes : undefined,
      scopeHints: parseScopeHints(authRaw.scope_hints),
    };
  }

  if (agentRaw) {
    const protocols = agentRaw.protocols;
    if (Array.isArray(protocols)) {
      company.agentProtocols = protocols
        .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
        .filter(p => typeof p.type === "string" && typeof p.endpoint === "string")
        .map(p => ({
          type: String(p.type),
          endpoint: String(p.endpoint),
          description: typeof p.description === "string" ? p.description : undefined,
          access: typeof p.access === "string" ? p.access : undefined,
        }));
    }
  }

  if (Array.isArray(apisRaw)) {
    company.apis = apisRaw
      .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
      .filter(a => typeof a.type === "string" && typeof a.url === "string")
      .map(a => ({
        type: String(a.type),
        url: String(a.url),
        description: typeof a.description === "string" ? a.description : undefined,
      }));
  }

  if (webRaw) {
    company.web = {
      browserSessionEndpoint:
        typeof webRaw.browser_session_endpoint === "string"
          ? webRaw.browser_session_endpoint
          : undefined,
      disabled: webRaw.disabled === true,
    };
  }

  if (tasksRaw && typeof tasksRaw.endpoint === "string") {
    company.tasksEndpoint = tasksRaw.endpoint;
  }

  if (extRaw && typeof extRaw === "object") {
    company.extensions = {};
    for (const [name, entries] of Object.entries(extRaw)) {
      if (!Array.isArray(entries)) continue;
      company.extensions[name] = entries
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .filter(e => typeof e.version === "string")
        .map(e => ({
          version: String(e.version),
          endpoint: typeof e.endpoint === "string" ? e.endpoint : undefined,
        }));
    }
  }

  cache.set(key, { company, fetchedAt: Date.now() });
  return company;
}

/** Whether the Company has a UCP extension. */
export function hasUcpExtension(company: PoppyCompany): boolean {
  return company.extensions?.ucp?.some(e => e.version === "1") === true;
}

/** The UCP endpoint, from agent.protocols or extensions. */
export function ucpEndpoint(company: PoppyCompany): string | undefined {
  return company.agentProtocols?.find(p => p.type === "ucp")?.endpoint;
}

/** Clears the discovery cache (for tests). */
export function clearDiscoveryCache(): void {
  cache.clear();
}

/** Two versions are compatible when they share the same major (and, before 1.0, the same minor). */
function versionsCompatible(ours: string, theirs: string): boolean {
  const [ourMajor, ourMinor] = ours.split(".").map(Number);
  const [theirMajor, theirMinor] = theirs.split(".").map(Number);
  if (ourMajor !== theirMajor) return false;
  // Before 1.0, minor must also match.
  if (ourMajor === 0) return ourMinor === theirMinor;
  return true;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v).every(val => typeof val === "string");
}

function parseScopeHints(
  raw: unknown
): Record<string, { changes: string; personalData: boolean }> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const result: Record<string, { changes: string; personalData: boolean }> = {};
  for (const [scope, hint] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof hint !== "object" || hint === null) continue;
    const h = hint as Record<string, unknown>;
    if (typeof h.changes !== "string") continue;
    result[scope] = {
      changes: h.changes,
      personalData: h.personal_data === true,
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
