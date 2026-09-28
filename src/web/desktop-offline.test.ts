/**
 * An attached box that does not answer must not hold the desktop pane hostage.
 *
 * Measured 2026-09-28: the grok VM was off the tailnet and a request for one of its desktops
 * hung for 75 seconds before the TCP connect gave up. The browser keeps showing the previous
 * document until a navigation commits, so for those 75 seconds the pane showed the *own* box's
 * Linux desktop under the attached agent's name. The proxy has to give up in seconds and hand
 * the waiting page over, so the frame shows "not reachable" instead of somebody else's screen.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { startWebServer } from "./server.ts";

const PORT = 7934;
const BASE = `http://127.0.0.1:${PORT}`;

test("a desktop on an unreachable attached box becomes the waiting page within seconds", async () => {
  // Accepts the connection and never says a word: the shape of a host that is there on the
  // network but not answering, which is worse than a refused connection.
  const silent = createServer(() => { /* hold the socket open, say nothing */ });
  await new Promise<void>(resolve => silent.listen(0, "127.0.0.1", resolve));
  const silentPort = (silent.address() as AddressInfo).port;

  const home = mkdtempSync(join(tmpdir(), "agentbox-desktop-offline-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  let stop: (() => void) | undefined;
  try {
    stop = await startWebServer({ port: PORT, host: "127.0.0.1", token: "t0k", useBox: false, onLog: () => {} });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const minted = (await (await fetch(`${BASE}/api/boxes/connect-codes`, { method: "POST", headers: ui, body: JSON.stringify({ name: "grok" }) })).json()) as { code: string };
    const registered = (await (await fetch(`${BASE}/api/boxes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: minted.code, baseUrl: `http://127.0.0.1:${silentPort}/`, token: "daemon-token-0123456789", version: "0.2.1" }),
    })).json()) as { boxId: string };

    const started = Date.now();
    const page = await fetch(`${BASE}/desktop/b/${registered.boxId}/10/vnc.html?autoconnect=1`, { headers: ui });
    const elapsed = Date.now() - started;
    const body = await page.text();
    assert.equal(page.status, 503, body);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(body, /Cannot reach the box desktop/);
    assert.ok(elapsed < 8_000, `the pane waited ${elapsed}ms for a box that will never answer`);
  } finally {
    stop?.();
    silent.close();
    process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
