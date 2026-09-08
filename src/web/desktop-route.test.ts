/**
 * Tests for which desktop stream a person is joined to.
 *
 * This is the one place the difference between watching and driving is enforced on the screen
 * itself. Every HTTP route refused a viewer's mutations, and the screen socket was proxied to
 * anyone with a session — so a viewer could type into the desktop over RFB while every mutation
 * check passed. The role has to decide the upstream, not just the routes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NOVNC_BASE_PORT, NOVNC_VIEW_ONLY_BASE_PORT } from "../protocol/index.ts";
import { DisplayManager } from "../boxd/displays.ts";
import { desktopUpstreamPath, desktopWaitingPage } from "./server.ts";

test("someone who may only watch is joined to the view-only stack", () => {
  assert.equal(desktopUpstreamPath("/desktop/1/websockify", "", true), "/vnc/1/websockify");
  assert.equal(desktopUpstreamPath("/desktop/1/websockify", "", false), "/vnc-ro/1/websockify");

  // The page and the socket it opens must come from the same stack, or a viewer is served a page
  // pointing at a stream they are refused.
  assert.equal(desktopUpstreamPath("/desktop/2", "", false), "/vnc-ro/2/");
  assert.equal(desktopUpstreamPath("/desktop/2", "", true), "/vnc/2/");

  // The browser's URL is the same either way, so a viewer cannot reach the driving stream by
  // editing an address — the choice is made here, from the identity the gateway asserted.
  assert.equal(desktopUpstreamPath("/vnc/1/websockify", "", false), undefined);
  assert.equal(desktopUpstreamPath("/desktop/", "", true), undefined);
});

test("the two stacks cannot land on the same port for any desktop", () => {
  // They are derived independently here and in start-display, so an overlap would silently join a
  // viewer to the driving stream — the failure would look like the feature working.
  const driving = new Set<number>();
  const watching = new Set<number>();
  for (let index = 1; index <= 32; index++) {
    driving.add(DisplayManager.novncPort(index));
    watching.add(DisplayManager.novncViewOnlyPort(index));
  }
  assert.equal(driving.size, 32);
  assert.equal(watching.size, 32);
  for (const port of watching) assert.ok(!driving.has(port), `${port} is in both ranges`);
  assert.ok(NOVNC_VIEW_ONLY_BASE_PORT > NOVNC_BASE_PORT + 32);
});


test("a desktop that is not up yet is shown as a page, never as JSON", () => {
  // Before the display exists boxd answers the page request with a JSON error. Passed
  // through, Chromium rendered it in its JSON viewer — a white box with a "Pretty-print"
  // checkbox — and the frame's src never changed, so the pane stayed that way.
  const page = desktopWaitingPage('Desktop 3 is not running. Ensure it first. <script>');
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /http-equiv="refresh" content="2"/);
  assert.match(page, /Desktop 3 is not running/);
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /background:#000/);
});
