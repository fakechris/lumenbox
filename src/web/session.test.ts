/**
 * Session cookies: the identity must be unforgeable, must not survive a token rotation —
 * an old session outliving the credential it was derived from is the one failure that
 * would be silent — and must carry the generation that lets one person be signed out of
 * everywhere without signing out everybody (INV-537).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeSession, newWebIdentity, readSession, sessionCookie, sessionKey } from "./session.ts";

test("a session round-trips, and a tampered one is nobody", () => {
  const key = sessionKey("the-ui-token");
  const cookie = makeSession("web:abc123", key, 0, 1_795_000_000);
  assert.deepEqual(readSession(cookie, key), { identity: "web:abc123", epoch: 0, signedAt: 1_795_000_000 });

  // The identity cannot be edited without the signature falling apart.
  assert.equal(readSession(cookie.replace("web:abc123", "web:someoneelse"), key), undefined);
  assert.equal(readSession("web:abc123.deadbeef", key), undefined);
  assert.equal(readSession("web:abc123", key), undefined, "unsigned is not a session");
  assert.equal(readSession(undefined, key), undefined);

  // An identity containing dots still round-trips: the signature is after the last one.
  const dotted = makeSession("feishu:ou_a.b.c", key, 0, 1_795_000_000);
  assert.deepEqual(readSession(dotted, key), { identity: "feishu:ou_a.b.c", epoch: 0, signedAt: 1_795_000_000 });

  // A cookie from before generations, or before the sign-in time (INV-2318), still reads: an upgrade signs
  // nobody out. It carries no sign-in time, so it is never a recent sign-in (recent-sign-in.ts).
  const signed = (payload: string) => `${payload}.${createHmac("sha256", key).update(payload).digest("hex").slice(0, 32)}`;
  assert.deepEqual(readSession(signed("web:abc123"), key), { identity: "web:abc123", epoch: 0 });
  assert.deepEqual(readSession(signed("web:abc123|2"), key), { identity: "web:abc123", epoch: 2 });
  // The time is signed with the rest: a fresher one written by hand is nobody.
  assert.equal(readSession(cookie.replace("|1795000000.", `|${1_795_000_000 + 3_600}.`), key), undefined);
});

test("a generation travels in the cookie, and only that person's sessions move with it", () => {
  const key = sessionKey("the-ui-token");
  const first = makeSession("feishu:ou_dana", key, 0, 1_795_000_000);
  const second = makeSession("feishu:ou_dana", key, 1, 1_795_000_000);
  assert.deepEqual(readSession(first, key), { identity: "feishu:ou_dana", epoch: 0, signedAt: 1_795_000_000 });
  assert.deepEqual(readSession(second, key), { identity: "feishu:ou_dana", epoch: 1, signedAt: 1_795_000_000 });
  // The generation is signed with the identity: raising it by hand does not verify.
  const forged = first.replace("|0|", "|9|");
  assert.equal(readSession(forged, key), undefined);
  assert.match(sessionCookie("feishu:ou_dana", key, 3, false, 1_795_000_000), /agentbox_who=feishu%3Aou_dana%7C3%7C1795000000\./);
});

test("rotating the UI token invalidates every session issued under the old one", () => {
  const before = sessionKey("old-token");
  const after = sessionKey("new-token");
  const cookie = makeSession("web:abc123", before, 0, 1_795_000_000);
  assert.deepEqual(readSession(cookie, before), { identity: "web:abc123", epoch: 0, signedAt: 1_795_000_000 });
  assert.equal(readSession(cookie, after), undefined);
});

test("without a token every process gets its own key, so sessions die at restart", () => {
  const first = sessionKey(undefined);
  const second = sessionKey(undefined);
  assert.notEqual(first, second);
  assert.equal(readSession(makeSession("web:x", first), second), undefined);
});

test("the cookie is HttpOnly and scoped to the whole app; web identities are distinct", () => {
  const line = sessionCookie("web:abc", sessionKey("t"));
  assert.match(line, /^agentbox_who=/);
  assert.match(line, /HttpOnly/);
  assert.match(line, /Path=\//);
  assert.match(line, /SameSite=Lax/);
  // Durable, because a one-use fifteen-minute code plus a cookie that dies with the
  // window is a lockout with a login page in front of it.
  assert.match(line, /Max-Age=\d{6,}/, "a sign-in outlives the browser window");
  assert.notEqual(newWebIdentity(), newWebIdentity());
  assert.match(newWebIdentity(), /^web:[0-9a-f]{12}$/);
});
