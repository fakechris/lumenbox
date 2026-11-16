/**
 * UCP through Poppy (the `ucp` extension, version 1): where a Company's commerce services are, and
 * what every request to them carries.
 *
 * UCP is the business protocol; Poppy finds the Company and identifies the agent. A Company that
 * lists `ucp` in its poppy.json publishes a UCP profile at `https://{domain}/.well-known/ucp`, which
 * names its services — usually an MCP endpoint, often on another host (Allbirds's is on
 * myshopify.com). Those endpoints are the Company's destinations because its own profile lists them.
 *
 * Every UCP request names this agent's platform profile: in the `UCP-Agent` header, and for an MCP
 * `tools/call` also in `arguments.meta["ucp-agent"]`, the same URL in both. The profile describes the
 * agent, never a User, so it is one document for everyone (`platformProfile`). There is no payment
 * handler: a checkout is finished by the person at the Company's `continue_url`.
 */

import { poppyRequest } from "./http.ts";

/** The UCP version this agent speaks, and names in its platform profile's URL. */
export const UCP_VERSION = "2026-08-25";

export interface UcpService {
  /** The service's name, e.g. `dev.ucp.shopping`. */
  name: string;
  version: string;
  transport: string;
  endpoint: string;
}

export interface UcpProfile {
  version: string;
  services: UcpService[];
}

/**
 * The Company's UCP profile, or null when it has none we can use. Not followed through a redirect:
 * a profile from another host doesn't speak for this Company (ucp extension §3).
 */
export async function fetchUcpProfile(domain: string): Promise<UcpProfile | null> {
  let doc: Record<string, unknown>;
  try {
    const response = await poppyRequest(`https://${domain}/.well-known/ucp`, { headers: { Accept: "application/json" } }, domain);
    if (!response.ok) return null;
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const ucp = doc.ucp as { version?: unknown; services?: unknown } | undefined;
  if (typeof ucp?.version !== "string" || typeof ucp.services !== "object" || ucp.services === null) return null;
  const services: UcpService[] = [];
  for (const [name, entries] of Object.entries(ucp.services as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Record<string, unknown>[]) {
      if (typeof entry?.endpoint !== "string" || typeof entry.transport !== "string") continue;
      try {
        if (new URL(entry.endpoint).protocol !== "https:") continue;
      } catch {
        continue;
      }
      services.push({ name, version: String(entry.version ?? ucp.version), transport: entry.transport, endpoint: entry.endpoint });
    }
  }
  return { version: ucp.version, services };
}

/** The platform profile URL this host publishes, under its public origin. */
export function platformProfileUrl(origin: string): string {
  return `${origin}/poppy/ucp/${UCP_VERSION}.json`;
}

const spec = (path: string) => `https://ucp.dev/${UCP_VERSION}/${path}`;
const capability = (path: string, extendsCart = false) => [{
  version: UCP_VERSION,
  spec: spec(`specification/shopping/${path}/`),
  schema: spec(`schemas/shopping/${path.split("/").pop()}.json`),
  ...(extendsCart ? { extends: ["dev.ucp.shopping.checkout", "dev.ucp.shopping.cart"] } : {}),
}];

/** This agent's UCP platform profile: what it can negotiate, the same for every User (ucp extension §3). */
export function platformProfile(): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      services: { "dev.ucp.shopping": [{ version: UCP_VERSION, spec: spec("specification/overview/"), transport: "mcp", schema: spec("services/shopping/mcp.openrpc.json") }] },
      capabilities: {
        "dev.ucp.shopping.checkout": capability("checkout"),
        "dev.ucp.shopping.cart": capability("cart"),
        "dev.ucp.shopping.order": capability("order"),
        "dev.ucp.shopping.fulfillment": capability("extensions/fulfillment", true),
        "dev.ucp.shopping.discount": capability("extensions/discount", true),
      },
      // No payment handler: the person pays at the Company's continue_url.
      payment_handlers: {},
    },
  };
}

/** The `UCP-Agent` header: a Dictionary Structured Field naming the profile. */
export function ucpAgentHeader(profileUrl: string): string {
  return `profile="${profileUrl.replace(/["\\]/g, "")}"`;
}

/**
 * An MCP body with the profile in each `tools/call`'s `arguments.meta["ucp-agent"]`, as UCP's MCP
 * binding requires. Anything that isn't a JSON-RPC `tools/call` (or a batch of them) is left as it is.
 */
export function withUcpMeta(body: string, profileUrl: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const stamp = (message: unknown): unknown => {
    if (typeof message !== "object" || message === null) return message;
    const call = message as { method?: unknown; params?: { arguments?: Record<string, unknown> } };
    if (call.method !== "tools/call" || typeof call.params !== "object" || call.params === null) return message;
    const args = typeof call.params.arguments === "object" && call.params.arguments !== null ? call.params.arguments : {};
    const meta = typeof args.meta === "object" && args.meta !== null ? (args.meta as Record<string, unknown>) : {};
    return { ...call, params: { ...call.params, arguments: { ...args, meta: { ...meta, "ucp-agent": { profile: profileUrl } } } } };
  };
  return JSON.stringify(Array.isArray(parsed) ? parsed.map(stamp) : stamp(parsed));
}
