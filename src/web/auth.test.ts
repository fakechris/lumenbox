/**
 * Tests for UI access.
 *
 * The case that matters is the one the in-box topology created: the UI binds 0.0.0.0 there,
 * and only Docker's publish address keeps it local. A rule that failed open would be the one
 * mistake that cannot be walked back, so these check the closed direction hardest.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {authorize, 
COOKIE_NAME, 
  callerOf,isLoopback, 
  mayDrive,parseCookies,
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
  assert.deepEqual(callerOf(headers, false), { userId: undefined, role: "owner" });
  assert.deepEqual(callerOf(headers, true), { userId: "u1", role: "viewer" });
});

test("an absent role is owner, an unrecognised one is not", () => {
  // Three cases, and conflating the last two is a privilege escalation.
  assert.equal(callerOf({}, true).role, "owner", "nobody asserting anything: the single-user case");
  assert.equal(callerOf({ "x-agentbox-role": "member" }, true).role, "member");
  assert.equal(
    callerOf({ "x-agentbox-role": "superuser" }, true).role,
    "viewer",
    "something upstream is wrong, so the answer is least privilege, not most"
  );
});

test("a viewer may watch but not drive, and is told which role would", () => {
  const viewer = callerOf({ "x-agentbox-role": "viewer" }, true);
  const member = callerOf({ "x-agentbox-role": "member" }, true);

  const reason = refusalToDrive(viewer, undefined);
  assert.ok(reason, "a viewer cannot drive");
  assert.match(reason, /member or an owner/, "a blank 403 generates a support conversation");
  assert.equal(refusalToDrive(member, undefined), undefined);
  assert.equal(mayDrive(viewer), false);
  assert.equal(mayDrive(member), true);
});

test("per-agent visibility is not a gate: the box is the boundary (docs/22 §3)", () => {
  const bob = callerOf({ "x-agentbox-user": "u-bob", "x-agentbox-role": "member" }, true);

  // A driver the box admits may drive any agent in it — including one still
  // carrying the retired `private` label from before the box boundary existed.
  // Whose agent it is stays an attribution fact (`ownerUserId`), never an
  // authority; two workers of one box may never differ in what they may reach.
  assert.equal(
    refusalToDrive(bob, { visibility: "private" as const, ownerUserId: "u-alice" }),
    undefined,
    "the box decides, not the agent's label"
  );
  assert.equal(refusalToDrive(bob, { visibility: "shared" as const }), undefined);
  assert.equal(refusalToDrive(bob, {}), undefined);
  assert.equal(refusalToDrive(bob, undefined), undefined);

  // And a viewer still cannot drive anything — that half was never about agents.
  const viewer = callerOf({ "x-agentbox-user": "u-bob", "x-agentbox-role": "viewer" }, true);
  assert.ok(refusalToDrive(viewer, undefined), "watch but not drive stands");
});
