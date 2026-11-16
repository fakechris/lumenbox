/**
 * Browser Join (spec section 8.3).
 *
 * When a Company publishes `web.browser_session_endpoint`, the agent can
 * "join" its browser session to the Poppy Session. The Company then
 * recognises the browser as the same user/agent and can serve authenticated
 * pages without a full OAuth redirect.
 *
 * Flow:
 *   1. Agent POSTs to browser_session_endpoint with its Poppy-Session JWT
 *   2. Company returns a one-time URL or a cookie-setting redirect
 *   3. Agent navigates the box browser to that URL
 *   4. The browser is now part of the Poppy Session
 */

import type { PoppyCompany } from "./discovery.ts";
import type { PoppySession } from "./session.ts";

export interface BrowserJoinResult {
  /** The URL the browser should navigate to. */
  url: string;
  /** How long the join URL is valid (seconds). */
  expiresIn?: number;
  /** Extra instructions from the Company. */
  instructions?: string;
  raw: Record<string, unknown>;
}

/**
 * Requests a browser join URL from the Company.
 *
 * The response is a URL the box's browser should navigate to; the Company's
 * server will set cookies or otherwise associate the browser with the Session.
 */
export async function requestBrowserJoin(
  company: PoppyCompany,
  session: PoppySession,
  accessToken?: string,
): Promise<BrowserJoinResult | null> {
  const endpoint = company.web?.browserSessionEndpoint;
  if (!endpoint || company.web?.disabled) return null;

  const headers = await session.headers("POST", endpoint, accessToken);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      session_id: session.sid,
      user_id: session.userId,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return null;

  const doc = (await response.json()) as Record<string, unknown>;
  const url = typeof doc.url === "string" ? doc.url : typeof doc.redirect_uri === "string" ? doc.redirect_uri : undefined;
  if (!url) return null;

  return {
    url,
    expiresIn: typeof doc.expires_in === "number" ? doc.expires_in : undefined,
    instructions: typeof doc.instructions === "string" ? doc.instructions : undefined,
    raw: doc,
  };
}
