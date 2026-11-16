/**
 * Poppy's web routes (docs/poppy.md), answered before sign-in because their callers are not signed in:
 * a Company fetches this agent's metadata and public keys to verify the sessions it signs and its UCP
 * platform profile to negotiate commerce, and the Company's sign-in page sends the person's browser
 * back to the callback.
 *
 * Nothing else is here on purpose. What the agent holds — sessions, tokens, the domains it has
 * looked at — is not public, and is read through the PoppyStatus tool by somebody already signed in.
 * The callback answers in plain text: it repeats a value the Company chose (its name) and one
 * anybody can put in a link (`error`), and as HTML on this origin either would run as the page.
 */

import type { PoppyManager } from "../host/poppy/manager.ts";
import { platformProfile, UCP_VERSION } from "../host/poppy/ucp.ts";
import { apiError } from "./api-error.ts";

export async function poppyRoute(route: string, url: URL, poppy: PoppyManager | undefined): Promise<{ status: number; body: unknown; type?: string } | undefined> {
  if (poppy?.ready !== true || !route.startsWith("GET /poppy/")) return undefined;
  if (route === "GET /poppy/agent.json") return { status: 200, body: poppy.clientMetadata() };
  if (route === "GET /poppy/jwks.json") return { status: 200, body: poppy.jwks() };
  // The UCP platform profile every UCP request names; it describes the agent, never a User (ucp extension §3).
  if (route === `GET /poppy/ucp/${UCP_VERSION}.json`) return { status: 200, body: platformProfile() };
  if (route !== "GET /poppy/callback") return undefined;
  const declined = url.searchParams.get("error");
  if (declined !== null) return { status: 200, body: `Sign-in declined: ${declined}`, type: "text/plain" };
  const code = url.searchParams.get("code"), state = url.searchParams.get("state");
  if (!code || !state) return { status: 400, body: apiError("poppy-callback-incomplete") };
  try {
    const result = await poppy.handleCallback(code, state);
    return { status: 200, body: `Connected to ${result.companyName} (${result.scopes}). You can close this window.`, type: "text/plain" };
  } catch (error) {
    return { status: 400, body: apiError("sign-in-failed", { detail: error instanceof Error ? error.message : String(error) }) };
  }
}
