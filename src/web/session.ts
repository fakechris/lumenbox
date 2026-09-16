/**
 * Who the person at the browser is, as opposed to whether they may be here at all.
 *
 * The UI token answers the second question and has always been the whole story: one
 * token, one operator, everything allowed. A second person in the same installation
 * needs the first question answered too — their tasks should say who asked, their
 * spend should be theirs, and their role should be the one the roster gives them.
 * That is exactly what the channels already do for a person in a chat, so the web
 * borrows the same objects: an invite code redeems into a `Principal`, and the
 * session cookie carries that principal's identity.
 *
 * **Signed, not looked up.** The cookie holds `identity.signature`, verified against
 * a key derived from the UI token. Deriving rather than minting a second secret means
 * there is nothing new to store, and rotating the token invalidates every session —
 * which is the correct behaviour for a token rotation and would otherwise have to be
 * remembered as a separate step.
 *
 * The session is only ever read on a request the token already authorised, the same
 * rule the gateway identity headers follow: a claimed identity on an unauthenticated
 * request must not become an identity.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "agentbox_who";

/**
 * The signing key for sessions.
 *
 * Derived from the UI token when there is one. Without a token the server is on
 * loopback with no authentication at all, where a session means nothing anyway — a
 * per-process random key keeps the code path uniform and lets those sessions die at
 * restart, which is honest for a mode that has no persistent identity to begin with.
 */
export function sessionKey(token: string | undefined): string {
  if (token !== undefined && token !== "") {
    return createHmac("sha256", token).update("agentbox-web-session").digest("hex");
  }
  return randomBytes(32).toString("hex");
}

function sign(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("hex").slice(0, 32);
}

export interface Session {
  identity: string;
  /**
   * Which generation of this person's sign-ins it belongs to (INV-537).
   *
   * Signing somebody out everywhere used to mean rotating the installation's token, which
   * signs everybody out — so in practice nobody did it. The generation is bumped for one
   * person, their cookies stop verifying, and everyone else keeps working.
   */
  epoch: number;
}

/** The cookie value: who, which generation, and proof it was issued here. */
export function makeSession(identity: string, key: string, epoch = 0): string {
  const payload = `${identity}|${epoch}`;
  return `${payload}.${sign(payload, key)}`;
}

/** What a cookie carries, or undefined when it was not issued by this key. */
export function readSession(value: string | undefined, key: string): Session | undefined {
  if (value === undefined) return undefined;
  const at = value.lastIndexOf(".");
  if (at <= 0) return undefined;
  const payload = value.slice(0, at);
  const presented = Buffer.from(value.slice(at + 1), "utf8");
  const expected = Buffer.from(sign(payload, key), "utf8");
  if (presented.length !== expected.length) return undefined;
  if (!timingSafeEqual(presented, expected)) return undefined;
  // Cookies issued before generations existed carry no bar and are generation zero, so a
  // browser signed in yesterday is not signed out by an upgrade.
  const bar = payload.lastIndexOf("|");
  if (bar <= 0) return { identity: payload, epoch: 0 };
  const epoch = Number(payload.slice(bar + 1));
  return Number.isFinite(epoch) ? { identity: payload.slice(0, bar), epoch } : { identity: payload, epoch: 0 };
}

/**
 * How long a sign-in lasts.
 *
 * Long, and deliberately: an invite code works once and expires in fifteen minutes, so
 * a session that died with the browser window would lock a person out the moment they
 * closed it — with no way back in that does not involve interrupting an admin. That is
 * not a security posture, it is an outage with a login page in front of it.
 *
 * What makes the length safe is that revocation does not depend on it: removing somebody
 * from the roster stops their session authenticating at all on the very next request,
 * signing one person out everywhere bumps their generation, and rotating the UI token
 * invalidates every session at once, because the signing key is derived from that token
 * rather than stored beside it.
 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3_600;

/** The Set-Cookie line for a fresh session. HttpOnly: nothing in the page reads it. */
export function sessionCookie(identity: string, key: string, epoch = 0, secure = false): string {
  return (
    `${SESSION_COOKIE}=${encodeURIComponent(makeSession(identity, key, epoch))}; Path=/; ` +
    // Under TLS the cookie says so, and the browser stops offering it over plain HTTP —
    // which is the case this flag exists for (INV-578). Not set on a loopback or an
    // explicitly insecure publish, where marking it Secure would stop it being stored.
    (secure ? "Secure; " : "") +
    `Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax`
  );
}

/** A web identity for somebody who has only ever arrived through a browser. */
export function newWebIdentity(): string {
  return `web:${randomBytes(6).toString("hex")}`;
}
