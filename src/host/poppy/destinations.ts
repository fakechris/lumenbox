/**
 * Where a signed request may go at a Company — its destinations — and what kind each one is.
 *
 * A request carries the agent's Session, so it goes only where the Company itself says: pages on
 * exactly its domain, and the endpoints its own documents list — the conversation protocols,
 * Browser Join, tasks and extension endpoints in poppy.json and the paths under them, the hosts its
 * APIs are described on, and the services in its UCP profile.
 * A listed endpoint may be on another host (a UCP service on myshopify.com for allbirds.com),
 * because the document that lists it is served by the Company's domain. Anything else is refused:
 * the agent uses ordinary web tools there, without the header.
 */

import type { PoppyCompany } from "./discovery.ts";
import type { PoppyScope } from "./http.ts";
import type { UcpProfile } from "./ucp.ts";

export type DestinationKind = "page" | "listed" | "ucp";

export interface Destinations extends PoppyScope {
  /** What a URL is to this Company, or undefined when it is not a destination. */
  kindOf(url: URL): DestinationKind | undefined;
  /** The UCP service endpoints, which get the platform profile on every request. */
  ucp: string[];
}

/** An endpoint covers itself and the paths under it (a `/mcp` endpoint, an `/api` base). */
function covers(endpoint: string, url: URL): boolean {
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return false;
  }
  if (base.protocol !== "https:" || base.host !== url.host) return false;
  const prefix = base.pathname.replace(/\/+$/, "");
  return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`) || prefix === "";
}

export function destinationsOf(company: PoppyCompany, ucp: UcpProfile | null): Destinations {
  const listed = [
    ...(company.agentProtocols ?? []).map(protocol => protocol.endpoint),
    // An API's description (an OpenAPI document, an MCP URL) speaks for the host it is on.
    ...(company.apis ?? []).flatMap(api => {
      try {
        return [new URL(api.url).origin];
      } catch {
        return [];
      }
    }),
    ...(company.web?.browserSessionEndpoint ? [company.web.browserSessionEndpoint] : []),
    ...(company.tasksEndpoint ? [company.tasksEndpoint] : []),
    ...Object.values(company.extensions ?? {}).flatMap(entries => entries.flatMap(entry => (entry.endpoint ? [entry.endpoint] : []))),
  ];
  const ucpEndpoints = (ucp?.services ?? []).map(service => service.endpoint);
  const domain = company.domain.toLowerCase();
  const kindOf = (url: URL): DestinationKind | undefined => {
    if (url.protocol !== "https:") return undefined;
    if (ucpEndpoints.some(endpoint => covers(endpoint, url))) return "ucp";
    if (listed.some(endpoint => covers(endpoint, url))) return "listed";
    if (url.hostname.toLowerCase() === domain) return "page";
    return undefined;
  };
  return { name: company.domain, kindOf, allows: url => kindOf(url) !== undefined, ucp: ucpEndpoints };
}
