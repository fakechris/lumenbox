/**
 * The desktop socket is authenticated, and stays that way.
 *
 * `main.ts` is a script that binds a port on import, so it cannot be imported here. The
 * property is pinned against the source instead — which is the right shape anyway,
 * because what must not come back is the *pattern*: an upgrade handler that starts
 * serving pixels before checking anything.
 *
 * History, both halves measured on 2026-08-28 rather than reasoned about. The handler
 * was deliberately open, justified by "only the host's loopback proxy can reach this
 * port". The daemon was in fact published on every interface, so any machine on the LAN
 * could open a desktop with no credential — verified by fetching /health from the LAN
 * address and completing a WebSocket upgrade to /vnc/1/websockify, which returned 101.
 * After that was fixed, a container on Docker's default bridge still reached the daemon
 * at the box's private-network address, because Docker 29's DOCKER-FORWARD chain accepts
 * forwarding out of every bridge — per-container networks do not isolate on that engine,
 * however widely they are believed to.
 *
 * A premise that has been false twice is not a premise; the hop carries the token now.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

test("the upgrade handler authorises before it does anything else", () => {
  const handler = source.slice(source.indexOf('server.on("upgrade"'));
  assert.ok(handler.length > 0, "the upgrade handler must exist to be checked");
  const check = handler.indexOf("authorized(req)");
  assert.ok(check > 0, "the upgrade handler must consult authorized()");
  // Before the path is parsed, before a display is looked up, before an upstream socket
  // is opened. An auth check that happens after the first side effect is decoration.
  const firstUpstream = handler.indexOf("netConnect");
  assert.ok(
    firstUpstream < 0 || check < firstUpstream,
    "authorisation must come before any upstream connection is opened"
  );
  const refusal = handler.slice(check, check + 400);
  assert.match(refusal, /401/, "an unauthorised upgrade must be refused, not dropped silently");
});

test("the host puts the box token on the hop it makes itself", () => {
  // The browser cannot set a header on a WebSocket and does not have to: it connects to
  // the host, which checks the person, and the host writes this request. If this stops
  // carrying the token, every desktop in the app goes dark — a loud failure, which is
  // the right direction for this one to fail in.
  const server = readFileSync(new URL("../web/server.ts", import.meta.url), "utf8");
  const proxy = server.slice(server.indexOf("async function openUpgrade"));
  assert.match(
    proxy.slice(0, 2_000),
    /authorization: Bearer \$\{origin\.token\}/,
    "the host's upstream upgrade must carry the box token"
  );
  // And it must not forward the browser's own Authorization: what authorises this hop is
  // being the host, not being the person — the person was already checked.
  assert.match(proxy.slice(0, 2_000), /!== "authorization"/);
});
