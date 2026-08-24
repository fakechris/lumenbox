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

function sign(identity: string, key: string): string {
  return createHmac("sha256", key).update(identity).digest("hex").slice(0, 32);
}

/** The cookie value for an identity: the identity itself, and proof it was issued here. */
export function makeSession(identity: string, key: string): string {
  return `${identity}.${sign(identity, key)}`;
}

/** The identity a cookie carries, or undefined when it was not issued by this key. */
export function readSession(value: string | undefined, key: string): string | undefined {
  if (value === undefined) return undefined;
  const at = value.lastIndexOf(".");
  if (at <= 0) return undefined;
  const identity = value.slice(0, at);
  const presented = Buffer.from(value.slice(at + 1), "utf8");
  const expected = Buffer.from(sign(identity, key), "utf8");
  if (presented.length !== expected.length) return undefined;
  return timingSafeEqual(presented, expected) ? identity : undefined;
}

/** The Set-Cookie line for a fresh session. HttpOnly: nothing in the page reads it. */
export function sessionCookie(identity: string, key: string): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(makeSession(identity, key))}; Path=/; HttpOnly; SameSite=Lax`;
}

/** A web identity for somebody who has only ever arrived through a browser. */
export function newWebIdentity(): string {
  return `web:${randomBytes(6).toString("hex")}`;
}
