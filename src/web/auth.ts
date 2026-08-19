/**
 * Who may drive the agents.
 *
 * The UI had no authentication, and the justification was that it binds loopback: anything
 * able to reach it can already drive the agents. That held while the orchestrator ran on
 * someone's own machine. It does not hold now that it runs inside the box and binds
 * 0.0.0.0, with only Docker's publish address keeping it local — one flag, or a Kubernetes
 * Service, and the UI is open.
 *
 * So the rule is: a configured token is required; no token is allowed only on loopback; and
 * no token on a non-loopback bind gets one generated rather than being served openly.
 * Failing open there would be the one mistake that cannot be walked back.
 *
 * The mechanism is a cookie, not a header, because of what the page loads. The desktop is an
 * iframe and a recording is a video element, and neither can carry an Authorization header —
 * so a scheme that only understood headers would authenticate the API and leave the screen
 * unprotected. A token in the query string is accepted once, to bootstrap the cookie, and
 * the page then replaces the URL so it does not sit in history.
 */

import { timingSafeEqual } from "node:crypto";

export const COOKIE_NAME = "agentbox_ui";

export interface AuthConfig {
  /** Undefined means no token was configured. */
  token?: string;
  /** What the server bound to, which decides whether no token is acceptable. */
  host: string;
}

export type AuthDecision =
  /** No token configured and bound to loopback: the old justification, still true. */
  | { allow: true; reason: "loopback" }
  | { allow: true; reason: "token"; setCookie?: string }
  | { allow: false; reason: "missing" | "wrong" };

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Constant-time, because this compares a secret against attacker-supplied input. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    cookies.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim()));
  }
  return cookies;
}

/**
 * Whether this request may proceed.
 *
 * Takes the pieces rather than the request, so the rule is testable without a server and
 * so the WebSocket upgrade path — which has headers but no response to write — can use the
 * same decision as an ordinary request.
 */
export function authorize(
  config: AuthConfig,
  request: {
    authorization?: string;
    cookie?: string;
    query?: string | null;
  }
): AuthDecision {
  if (!config.token) {
    // Only reachable when the server chose to run without one, which it does only on
    // loopback: startWebServer generates a token otherwise.
    return { allow: true, reason: "loopback" };
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(request.authorization ?? "")?.[1]?.trim();
  if (bearer && sameToken(bearer, config.token)) return { allow: true, reason: "token" };

  const cookie = parseCookies(request.cookie).get(COOKIE_NAME);
  if (cookie && sameToken(cookie, config.token)) return { allow: true, reason: "token" };

  const query = request.query?.trim();
  if (query && sameToken(query, config.token)) {
    // Bootstrapping: the query token is accepted once and turned into a cookie, so the
    // iframe and video requests that follow are authenticated without it in every URL.
    // HttpOnly, because nothing in the page needs to read it; SameSite=Lax so a normal
    // navigation carries it. Not Secure: this is served over plain HTTP on a loopback
    // publish, and marking it Secure would stop the cookie being stored at all.
    return {
      allow: true,
      reason: "token",
      setCookie:
        `${COOKIE_NAME}=${encodeURIComponent(config.token)}; Path=/; HttpOnly; SameSite=Lax`,
    };
  }

  return { allow: false, reason: cookie || bearer || query ? "wrong" : "missing" };
}
