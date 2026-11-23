/**
 * A screen already open is not grandfathered (INV-2071), and a token issued from a sign-in
 * is the person's own (INV-2074): both are about who the installation thinks you are after
 * the moment it first checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AttachedBoxProvisioner } from "../box/provisioner.ts";
import { Principals } from "../host/principals.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";
import { startWebServer } from "./server.ts";

test("removing a person or signing them out closes the desktops they have open; their sign-in's token acts as them", async () => {
  const home = mkdtempSync(join(tmpdir(), "open-desktops-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const upstreams: Socket[] = [];
  const daemon = createServer(async (req, res) => {
    for await (const _ of req) { /* drained */ }
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/displays/ensure") { res.end(JSON.stringify({ index: 1 })); return; }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  // The screen stays open, as a real one does, until somebody closes it.
  daemon.on("upgrade", (_req, socket: Socket) => {
    upstreams.push(socket);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const clients: Socket[] = [];
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const chris = { id: "chris", name: "Chris", role: "admin" as const, identities: [] };
    const bob = { id: "bob", name: "Bob", role: "driver" as const, identities: [] };
    new Principals().save([chris, bob, { id: "cara", name: "Cara", role: "driver", identities: [] }]);
    const registry = new AgentRegistry();
    registry.updateBox(registry.defaultBox().id, { members: ["bob", "cara"] });
    const worker = registry.create({ name: "Worker" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${address.port}`, token: "daemon" }),
      onReady: url => { base = url; },
    });
    const ui = { "content-type": "application/json", authorization: "Bearer t0k" };
    const post = (path: string, body: unknown, headers: Record<string, string> = ui) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

    // Each signs in on a browser of their own: a code for them, so the browser is a second sign-in, not a second person.
    const signIn = async (principalId: string) => {
      const { code } = (await (await post("/api/channels/invite", { principalId })).json()) as { code: string };
      const login = await post("/api/login", { code }, { "content-type": "application/json" });
      assert.equal(login.status, 200);
      return login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
    };
    const host = new URL(base);
    const index = registry.displayIndexFor(worker.id);
    const openDesktop = (cookie: string) => new Promise<{ socket: Socket; closed: Promise<void> }>((resolve, reject) => {
      const socket = connect(Number(host.port), host.hostname, () => {
        socket.write(`GET /desktop/${index}/websockify HTTP/1.1\r\nHost: ${host.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      clients.push(socket);
      const closed = new Promise<void>(done => socket.once("close", () => done()));
      socket.once("error", reject);
      socket.once("data", data => {
        assert.match(data.toString(), /101 Switching Protocols/);
        resolve({ socket, closed });
      });
    });
    const within = (closed: Promise<void>, what: string) => Promise.race([
      closed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} is still open`)), 2000)),
    ]);
    const stillOpen = async (socket: Socket) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return !socket.destroyed;
    };

    const bobCookie = await signIn("bob");
    const caraCookie = await signIn("cara");
    const bobScreen = await openDesktop(bobCookie);
    const caraScreen = await openDesktop(caraCookie);

    assert.equal((await post("/api/principals/logout", { principalId: "bob" })).status, 200);
    await within(bobScreen.closed, "Bob's desktop after Sign out everywhere");
    assert.ok(await stillOpen(caraScreen.socket), "nobody else's screen is touched");

    // Cara's token comes from her browser's sign-in, and the box is for Bob and Cara by name.
    const minted = await post("/api/mcp/tokens", { label: "Cara's IDE" }, { "content-type": "application/json", cookie: caraCookie });
    const { token } = (await minted.json()) as { token: string };
    const startGoal = (key: string) => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "goal_start", arguments: { objective: "Ship the weekly digest" } } },
      { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key });
    const started = (await (await startGoal("first")).json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: { message: string } };
    assert.equal(started.error, undefined, String(started.error?.message));
    assert.notEqual(started.result?.isError, true, String(started.result?.content?.[0]?.text));
    assert.match(started.result?.content?.[0]?.text ?? "", /^t\d+/, "a goal on the box she is a member of");

    assert.equal((await post("/api/principals", { principals: [chris, bob] })).status, 200);
    await within(caraScreen.closed, "Cara's desktop after she was removed");
    assert.equal((await startGoal("second")).status, 401, "and her token went with her");
  } finally {
    for (const socket of [...clients, ...upstreams]) socket.destroy();
    stop?.();
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
