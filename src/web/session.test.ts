/**
 * Session cookies: the identity must be unforgeable, and must not survive a token
 * rotation — an old session outliving the credential it was derived from is the one
 * failure that would be silent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSession, newWebIdentity, readSession, sessionCookie, sessionKey } from "./session.ts";

test("a session round-trips, and a tampered one is nobody", () => {
  const key = sessionKey("the-ui-token");
  const cookie = makeSession("web:abc123", key);
  assert.equal(readSession(cookie, key), "web:abc123");

  // The identity cannot be edited without the signature falling apart.
  assert.equal(readSession(cookie.replace("web:abc123", "web:someoneelse"), key), undefined);
  assert.equal(readSession("web:abc123.deadbeef", key), undefined);
  assert.equal(readSession("web:abc123", key), undefined, "unsigned is not a session");
  assert.equal(readSession(undefined, key), undefined);

  // An identity containing dots still round-trips: the signature is after the last one.
  const dotted = makeSession("feishu:ou_a.b.c", key);
  assert.equal(readSession(dotted, key), "feishu:ou_a.b.c");
});

test("rotating the UI token invalidates every session issued under the old one", () => {
  const before = sessionKey("old-token");
  const after = sessionKey("new-token");
  const cookie = makeSession("web:abc123", before);
  assert.equal(readSession(cookie, before), "web:abc123");
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
  assert.notEqual(newWebIdentity(), newWebIdentity());
  assert.match(newWebIdentity(), /^web:[0-9a-f]{12}$/);
});
