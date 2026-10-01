import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

test("web startup and state reads leave 12 desktops dormant; authenticated page demand starts only its desktop", async () => {
  const home = mkdtempSync(join(tmpdir(), "desktop-demand-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const starts: { index: number; owner: string }[] = [];
  const running = new Set<number>();
  const mirrored = new Set<string>();
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/fs/write" && String(body.path).endsWith("/HEARTBEAT.md")) mirrored.add(body.path);
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/displays/ensure") {
      starts.push(body);
      running.add(body.index);
      res.end(JSON.stringify({ index: body.index })); return;
    }
    if (req.url?.startsWith("/vnc/")) {
      const index = Number(req.url.split("/")[2]);
      res.statusCode = running.has(index) ? 200 : 404;
      res.setHeader("content-type", "text/html");
      res.end(running.has(index) ? "<html>desktop ready</html>" : "not running"); return;
    }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  daemon.on("upgrade", (req, socket) => {
    const index = Number(req.url?.split("/")[2]);
    socket.end(running.has(index)
      ? "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"
      : "HTTP/1.1 404 Not Found\r\n\r\n");
  });
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const provisioner = new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${address.port}`, token: "test-daemon" });
    const registry = new AgentRegistry();
    const agents = Array.from({ length: 12 }, (_, i) => registry.create({ name: `Worker ${i}` }));
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "test-ui", boxProvisioner: provisioner, onReady: url => { base = url; }, onLog: () => {} });
    const headers = { authorization: "Bearer test-ui" };
    assert.equal(starts.length, 0, "boot must not prewarm desktops");
    await fetch(`${base}/api/state`, { headers });
    assert.equal(starts.length, 0, "listing is not demand");
    const index = registry.displayIndexFor(agents[4]!.id);
    const path = `${base}/desktop/${index}/vnc.html`;
    const denied = await fetch(path);
    assert.notEqual(denied.status, 200);
    assert.equal(starts.length, 0, "unauthenticated demand cannot start resources");
    const pending = await fetch(path, { headers });
    assert.equal(pending.status, 503);
    assert.match(await pending.text(), /Starting desktop/);
    let page = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(path, { headers });
      page = await response.text();
      if (response.ok) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(page, /desktop ready/);
    assert.deepEqual(starts.map(entry => entry.index), [index]);
    assert.equal(starts[0]!.owner, registry.boxOwnerTokenFor(agents[4]!.id));
    running.clear(); // Recreated daemon/container, same URL, no remembered desktop.
    const lost = await fetch(path, { headers });
    assert.equal(lost.status, 503);
    await lost.text();
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(path, { headers });
      await response.text();
      if (response.ok) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(starts.map(entry => entry.index), [index, index], "recovery only starts the requested desktop");
    running.clear();
    const host = new URL(base);
    const handshake = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(host.port), host.hostname, () => {
        socket.write(`GET /desktop/${index}/websockify HTTP/1.1\r\nHost: ${host.host}\r\nAuthorization: Bearer test-ui\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      socket.setTimeout(3000, () => socket.destroy(new Error("upgrade timeout")));
      socket.once("error", reject);
      socket.once("data", data => { resolve(data.toString()); socket.destroy(); });
    });
    assert.match(handshake, /101 Switching Protocols/);
    assert.deepEqual(starts.map(entry => entry.index), [index, index, index], "socket-only reconnect restores its desktop");
    // Let the startup mirror finish against the fixture before removing its temporary home.
    for (let attempt = 0; attempt < 100 && mirrored.size < 12; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(mirrored.size, 12);
    await new Promise(resolve => setTimeout(resolve, 10));
  } finally {
    stop?.();
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
