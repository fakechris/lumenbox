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

/**
 * Who the gateway says this is.
 *
 * Read only from a request that also presented a valid token, because the token is the proof that
 * the request came through the gateway — and the gateway strips these headers off whatever the
 * client sent before setting them. A box reachable directly (a developer's laptop, a misconfigured
 * publish) would otherwise accept any claimed identity, so the check is not optional.
 *
 * The trust this creates is real and one-directional: the box believes the gateway completely. That
 * is the same dependency the UI token already establishes. A box verifying a signed assertion itself
 * would be better and is deliberately deferred; the seam for it is that identity is read here and
 * nowhere else.
 */
export const USER_HEADER = "x-agentbox-user";
export const ROLE_HEADER = "x-agentbox-role";

export type Role = "owner" | "member" | "viewer";

export interface Caller {
  /** Opaque; the box never learns a name or a tenant, and does not need to. */
  userId: string | undefined;
  /**
   * What this person may do.
   *
   * `owner` when nothing was asserted, which is the single-user case: a box driven directly by whoever
   * holds its token has always been able to do everything, and inventing a lesser role for them here
   * would break every existing deployment. A box behind a gateway always gets a header.
   */
  role: Role;
}

const ROLE_VALUES: readonly string[] = ["owner", "member", "viewer"];

/**
 * The caller, from headers that only count when the request was authorised by token.
 *
 * `allowedByToken` is passed rather than re-derived so there is exactly one place that decides
 * whether a request was authenticated, and this cannot disagree with it.
 */
export function callerOf(
  headers: { [key: string]: string | string[] | undefined },
  allowedByToken: boolean
): Caller {
  if (!allowedByToken) return { userId: undefined, role: "owner" };
  const first = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const claimedRole = first(ROLE_HEADER);
  // Three cases, and conflating the last two is a privilege escalation. Absent means nobody is
  // asserting anything, which is the direct single-user case and has always been able to do
  // everything. Present and recognised is what the gateway sends. Present and *unrecognised* means
  // something upstream is wrong, and the answer there is the least privilege, not the most — a typo
  // in a header must not become an accidental owner.
  const role: Role =
    claimedRole === undefined
      ? "owner"
      : ROLE_VALUES.includes(claimedRole)
        ? (claimedRole as Role)
        : "viewer";
  return { userId: first(USER_HEADER), role };
}

/** Whether this caller may change things, as opposed to watching them. */
export function mayDrive(caller: Caller): boolean {
  return caller.role === "owner" || caller.role === "member";
}

/**
 * Whether this caller may drive this particular agent, and why not if not.
 *
 * One function, called from every route that changes something, rather than a check per handler —
 * which is how one handler ends up missing it. A refusal names the role that would be needed,
 * because a permission system returning a blank 403 generates a support conversation every time.
 *
 * **This is accident prevention, not a security boundary.** Everyone in a tenant shares a box, a
 * filesystem and passwordless sudo inside it, so a member who wants another member's transcript can
 * read it from a shell. What this buys is that ordinary use does not cross wires, and that "whose
 * agent is this" has an answer. A real boundary between two people is two tenants and two boxes.
 */
export function refusalToDrive(
  caller: Caller,
  agent: { ownerUserId?: string; visibility?: "shared" | "private" } | undefined
): string | undefined {
  if (!mayDrive(caller)) {
    return "This account can watch but not drive. A member or an owner can act on this.";
  }
  if (agent === undefined) return undefined;
  const isPrivate = agent.visibility === "private";
  if (!isPrivate) return undefined;
  // An owner is not exempt: the point is "whose agent is this", and an owner reaching into a private
  // agent by accident is the same accident. Deliberate access is a shell away, and visible.
  if (agent.ownerUserId !== undefined && agent.ownerUserId === caller.userId) return undefined;
  return "That agent is private to the person who created it.";
}

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
      // Durable, for the same reason the identity cookie is: a person who closes the
      // window should not need the ?token= URL again to come back. Rotating the token
      // is what ends these, which is the revocation story either way.
      setCookie:
        `${COOKIE_NAME}=${encodeURIComponent(config.token)}; Path=/; ` +
        `Max-Age=${30 * 24 * 3_600}; HttpOnly; SameSite=Lax`,
    };
  }

  return { allow: false, reason: cookie || bearer || query ? "wrong" : "missing" };
}
