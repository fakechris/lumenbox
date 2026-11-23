import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

for (const backend of ["docker", "kubernetes"]) test(`${backend}: an open page is notified when the own box starts externally and when it stops`, { timeout: 15_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "setup-connectivity-"));
  let online = false;
  const daemon = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      if (!online) res.statusCode = 503;
      res.end(JSON.stringify(online ? { ok: true, protocol: BOXD_PROTOCOL } : { error: "offline" }));
    } else res.end("{}");
  });
  const abort = new AbortController();
  let stop: (() => void) | undefined;
  const env = ["AGENTBOX_HOME", "AGENTBOX_BOX_BACKEND", "AGENTBOX_BOX_WATCH_MS", "AGENTBOX_BOXD_URL", "AGENTBOX_TOKEN"] as const;
  const previous = env.map(name => process.env[name]);
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.AGENTBOX_HOME = home;
    process.env.AGENTBOX_BOX_BACKEND = backend;
    process.env.AGENTBOX_BOX_WATCH_MS = "100";
    process.env.AGENTBOX_BOXD_URL = baseUrl;
    process.env.AGENTBOX_TOKEN = "test-daemon";
    let base = "";
    const provisioner = new AttachedBoxProvisioner({ baseUrl, token: "test-daemon" });
    stop = await startWebServer({
      port: 0, host: "127.0.0.1", token: "test-ui", onReady: url => { base = url; }, onLog: () => {},
      ...(backend === "docker" ? { boxProvisioner: provisioner } : {
        personalBoxDriver: { start: async () => { throw new Error("unexpected personal box start"); }, remove: async () => {} },
      }),
    });
    const headers = { authorization: "Bearer test-ui" };
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    const get = (path: string) => fetch(base + path, { headers, signal });
    const check = async (connected: boolean) => {
      const setup = await (await get("/api/setup")).json() as { box: boolean; established: boolean };
      const computers = await (await get("/api/boxes")).json() as { backend: string; own: string; boxes: { id: string; connected: boolean; kind: string }[] };
      assert.equal(setup.established, false);
      assert.equal(setup.box, connected);
      assert.equal(computers.boxes.find(box => box.id === computers.own)?.connected, connected);
      assert.equal(computers.backend, backend);
      if (backend === "kubernetes") assert.equal(computers.boxes.find(box => box.id === computers.own)?.kind, "attached");
      return computers.own;
    };
    const stream = await get("/api/events");
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    const changed = async (boxId: string) => {
      for (;;) {
        const end = pending.indexOf("\n\n");
        if (end >= 0) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          const event = data ? JSON.parse(data.slice(6)) : undefined;
          if (event?.type === "box_status") {
            assert.equal(event.boxId, boxId);
            return;
          }
        } else {
          const next = await reader.read();
          assert.equal(next.done, false, "the event stream closed before the connectivity notification");
          pending += decoder.decode(next.value, { stream: true });
        }
      }
    };
    const own = await check(false);
    online = true;
    await changed(own);
    await check(true);
    online = false;
    await changed(own);
    await check(false);
  } finally {
    abort.abort();
    stop?.();
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    env.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    rmSync(home, { recursive: true, force: true });
  }
});
