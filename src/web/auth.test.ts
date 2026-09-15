/**
 * Tests for UI access.
 *
 * The case that matters is the one the in-box topology created: the UI binds 0.0.0.0 there,
 * and only Docker's publish address keeps it local. A rule that failed open would be the one
 * mistake that cannot be walked back, so these check the closed direction hardest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
COOKIE_NAME, authorize, isLoopback, parseCookies,
  callerOf,
  mayDrive,
  refusalToDrive,
} from "./auth.ts";

const TOKEN = "s3cret-token-value";

test("no token is only acceptable because the server bound loopback", () => {
  const decision = authorize({ host: "127.0.0.1" }, {});
  assert.equal(decision.allow, true);
  assert.equal(decision.allow && decision.reason, "loopback");
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
});

test("a request with nothing is refused once a token is configured", () => {
  const decision = authorize({ token: TOKEN, host: "0.0.0.0" }, {});
  assert.equal(decision.allow, false);
  assert.equal(!decision.allow && decision.reason, "missing");
});

test("the wrong token is refused, and distinguished from none", () => {
  const wrongHeader = authorize(
    { token: TOKEN, host: "0.0.0.0" },
    { authorization: "Bearer nope" }
  );
  assert.equal(wrongHeader.allow, false);
  assert.equal(!wrongHeader.allow && wrongHeader.reason, "wrong");

  const wrongCookie = authorize(
    { token: TOKEN, host: "0.0.0.0" },
    { cookie: `${COOKIE_NAME}=nope` }
  );
  assert.equal(wrongCookie.allow, false);

  // A prefix must not pass: the comparison is length-checked before it is timing-safe.
  const prefix = authorize(
    { token: TOKEN, host: "0.0.0.0" },
    { authorization: `Bearer ${TOKEN.slice(0, 5)}` }
  );
  assert.equal(prefix.allow, false);
});

test("a header, a cookie or a query token all work", () => {
  const config = { token: TOKEN, host: "0.0.0.0" };
  assert.equal(authorize(config, { authorization: `Bearer ${TOKEN}` }).allow, true);
  assert.equal(authorize(config, { cookie: `${COOKIE_NAME}=${TOKEN}` }).allow, true);
  assert.equal(authorize(config, { query: TOKEN }).allow, true);
});

test("a query token is turned into a cookie, because an iframe cannot send a header", () => {
  // The desktop is an iframe and a recording is a video element. Neither can carry an
  // Authorization header, so without this the API would be protected and the screen would
  // not.
  const decision = authorize({ token: TOKEN, host: "0.0.0.0" }, { query: TOKEN });
  assert.equal(decision.allow, true);
  const cookie = "setCookie" in decision ? decision.setCookie : undefined;
  assert.ok(cookie, "no cookie was issued to bootstrap from");
  assert.match(cookie, new RegExp(`^${COOKIE_NAME}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
});

test("cookies are parsed the way a browser sends them", () => {
  const cookies = parseCookies(`other=1; ${COOKIE_NAME}=abc%20def; trailing=x`);
  assert.equal(cookies.get(COOKIE_NAME), "abc def");
  assert.equal(cookies.get("other"), "1");
  assert.equal(parseCookies(undefined).size, 0);
  assert.equal(parseCookies("malformed").size, 0);
});

// ── who is asking, and what they may do ────────────────────────────────────────────────

test("identity is read only from a request authentication accepted", () => {
  const headers = { "x-agentbox-user": "u1", "x-agentbox-role": "viewer" };

  // A box reachable directly — a developer's laptop, a misconfigured publish — would otherwise
  // accept any claimed identity. The token is the proof the request came through the gateway.
  assert.deepEqual(callerOf(headers, false), { userId: undefined, role: undefined });
  assert.deepEqual(callerOf(headers, true), { userId: "u1", role: "viewer" });
});

test("the gateway's words are translated here and nowhere else; an absent role asserts nothing (INV-537)", () => {
  // Three cases, and conflating the last two is a privilege escalation.
  assert.equal(callerOf({}, true).role, undefined, "nobody asserted anything; the server decides what that means");
  assert.equal(callerOf({ "x-agentbox-role": "owner" }, true).role, "admin");
  assert.equal(callerOf({ "x-agentbox-role": "member" }, true).role, "driver");
  assert.equal(callerOf({ "x-agentbox-role": "viewer" }, true).role, "viewer");
  assert.equal(
    callerOf({ "x-agentbox-role": "superuser" }, true).role,
    "viewer",
    "something upstream is wrong, so the answer is least privilege, not most"
  );
  // And an unasserted caller — the installation's own credential — still drives.
  assert.equal(mayDrive(callerOf({}, true)), true);
});

test("a viewer may watch but not drive, and is told which role would", () => {
  const viewer = callerOf({ "x-agentbox-role": "viewer" }, true);
  const member = callerOf({ "x-agentbox-role": "member" }, true);

  const reason = refusalToDrive(viewer);
  assert.ok(reason, "a viewer cannot drive");
  assert.match(reason, /driver or an admin/, "a blank 403 generates a support conversation");
  assert.equal(refusalToDrive(member), undefined);
  assert.equal(mayDrive(viewer), false);
  assert.equal(mayDrive(member), true);
});

test("driving is not asked about the agent any more: authority lives on the box (INV-540)", () => {
  const alice = callerOf({ "x-agentbox-user": "u-alice", "x-agentbox-role": "member" }, true);
  const bob = callerOf({ "x-agentbox-user": "u-bob", "x-agentbox-role": "member" }, true);
  const viewer = callerOf({ "x-agentbox-user": "u-vic", "x-agentbox-role": "viewer" }, true);

  // Two drivers get the same answer about the same work, whoever created it — docs/22 §0's
  // uniformity, which the retired per-agent `visibility` check made false in the running
  // system for weeks. What separates two people now is two boxes with different members
  // (INV-538, `mayEnterBox`), asked by the same callers right after this.
  assert.equal(refusalToDrive(alice), undefined);
  assert.equal(refusalToDrive(bob), undefined);
  assert.ok(refusalToDrive(viewer), "the role still decides");
});

