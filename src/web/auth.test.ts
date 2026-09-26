/**
 * Tests for UI access.
 *
 * The case that matters is the one the in-box topology created: the UI binds 0.0.0.0 there,
 * and only Docker's publish address keeps it local. A rule that failed open would be the one
 * mistake that cannot be walked back, so these check the closed direction hardest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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


test("a published installation refuses plain HTTP unless somebody says they mean it (INV-578)", async () => {
  // docs/10 S-2 said "use TLS" for months, which is the kind of advice that is read after
  // the incident. A person's session is a person's work, and anybody on the path has it.
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "agentbox-https-"));
  const previous = { home: process.env.AGENTBOX_HOME, url: process.env.AGENTBOX_PUBLIC_URL, insecure: process.env.AGENTBOX_INSECURE };
  process.env.AGENTBOX_HOME = home;
  delete process.env.AGENTBOX_PUBLIC_URL;
  delete process.env.AGENTBOX_INSECURE;
  let stop: (() => void) | undefined;
  try {
    await assert.rejects(
      () => startWebServer({ port: 7951, host: "0.0.0.0", token: "t0k", useBox: false, onLog: () => {} }),
      /Refusing to serve .* without TLS/,
      "a non-loopback bind with no https address does not start"
    );

    // The deliberate escape, which says so on every start rather than once.
    process.env.AGENTBOX_INSECURE = "1";
    const lines: string[] = [];
    stop = await startWebServer({ port: 7951, host: "0.0.0.0", token: "t0k", useBox: false, onLog: line => lines.push(line) });
    assert.ok(lines.some(line => /without TLS because AGENTBOX_INSECURE=1/.test(line)), "and it says it out loud");
  } finally {
    stop?.();
    for (const [key, value] of Object.entries({ AGENTBOX_HOME: previous.home, AGENTBOX_PUBLIC_URL: previous.url, AGENTBOX_INSECURE: previous.insecure })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("a login's next is a path on this origin or nothing, as a browser would resolve it (INV-724)", async () => {
  const { safeNext } = await import("./auth.ts");
  for (const ok of ["/", "/ok", "/?import=z7xup0Ax1SBl2K84PELqF", "/agents/ada?tab=chat#bottom"]) {
    assert.equal(safeNext(ok), ok, ok);
  }
  // Each of these reaches another origin in a browser, or is only ever written by an attempt.
  // `/\` and `/<TAB>/` are the ones the old `startsWith("//")` check let through.
  for (const bad of [
    "//evil.example/", "/\\evil.example", "/\\/evil.example", "/\t/evil.example", "/\n/evil.example",
    "/\r/evil.example", "/x\u007f", "https://evil.example/", "/foo://x", "evil.example", "", "/".padEnd(600, "a"),
  ]) {
    assert.equal(safeNext(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(safeNext(null), undefined);
  assert.equal(safeNext(undefined), undefined);
});
