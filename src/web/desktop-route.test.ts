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
import { desktopUpstreamPath, injectDesktopNotice, wantsDesktopNotice } from "./server.ts";

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

test("the takeover page carries the box-class sentence; assets and sockets do not", () => {
  // v4 claims review, finding 5: the surface a person types a password into had no
  // badge and no notice. The banner rides inside noVNC's own HTML.
  const page = "<html><body><div id='screen'></div></body></html>";
  const labelled = injectDesktopNotice(page, "共享箱子 — 这是一台共享的箱子。");
  assert.match(labelled, /共享箱子/);
  assert.match(labelled, /pointer-events:none/, "labels without intercepting input");
  // The notice is escaped, never markup.
  assert.match(injectDesktopNotice(page, "<script>x</script>"), /&lt;script&gt;/);
  // Nothing to say, nothing injected; no </body>, nothing broken.
  assert.equal(injectDesktopNotice(page, ""), page);
  assert.equal(injectDesktopNotice("binarysoup", "note"), "binarysoup");
});

test("the banner rides standalone opens only; the main page's iframe already says it", () => {
  // The embedded frame sits directly under #boxnotice — the banner there said the
  // same sentence twice while covering the desktop's top edge.
  assert.ok(wantsDesktopNotice("/vnc/1/vnc.html?autoconnect=1&resize=scale"));
  assert.ok(!wantsDesktopNotice("/vnc/1/vnc.html?autoconnect=1&resize=scale&embedded=1"));
  // The flag counts wherever it sits in the query, not only at the end.
  assert.ok(!wantsDesktopNotice("/vnc/1/vnc.html?embedded=1&autoconnect=1"));
  // A query value that merely contains the text is not the flag.
  assert.ok(wantsDesktopNotice("/vnc/1/vnc.html?path=x%26embedded=1x"));
  // Assets and sockets never carry it.
  assert.ok(!wantsDesktopNotice("/vnc/1/websockify"));
  assert.ok(!wantsDesktopNotice("/vnc/1/app/styles.css"));
});
