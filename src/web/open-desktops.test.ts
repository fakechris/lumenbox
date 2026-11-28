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

test("sign-out, removal and changes to box access close open desktops; a sign-in's token acts as its person", async () => {
  const home = mkdtempSync(join(tmpdir(), "open-desktops-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const upstreams: Socket[] = [];
  const upstreamClosed: Promise<void>[] = [];
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
    socket.resume();
    upstreamClosed.push(new Promise(done => socket.once("end", () => done()).once("close", () => done())));
    socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const clients: Socket[] = [];
  let stop: (() => void) | undefined;
  try {
    await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
    const address = daemon.address();
    assert.ok(address && typeof address !== "string");
    const daemonUrl = `http://127.0.0.1:${address.port}`;
    const chris = { id: "chris", name: "Chris", role: "admin" as const, identities: [] };
    const bob = { id: "bob", name: "Bob", role: "driver" as const, identities: [] };
    new Principals().save([chris, bob, { id: "cara", name: "Cara", role: "driver", identities: [] }]);
    const registry = new AgentRegistry();
    registry.updateBox(registry.defaultBox().id, { members: ["bob", "cara"] });
    const worker = registry.create({ name: "Worker" });
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", onLog: () => {},
      boxProvisioner: new AttachedBoxProvisioner({ baseUrl: daemonUrl, token: "daemon" }),
      personalBoxDriver: { start: async () => daemonUrl, remove: async () => {} },
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
    const openDesktop = (cookie: string, path = `/desktop/${index}/websockify`, status = 101) => new Promise<{ socket: Socket; closed: Promise<void> }>((resolve, reject) => {
      const socket = connect(Number(host.port), host.hostname, () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host.host}\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      clients.push(socket);
      const closed = new Promise<void>(done => socket.once("close", () => done()));
      socket.once("error", reject);
      socket.once("data", data => {
        if (!data.toString().startsWith(`HTTP/1.1 ${status} `)) reject(new Error(`Unexpected desktop response: ${data}`));
        else resolve({ socket, closed });
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
    await within(upstreamClosed[0]!, "Bob's connection to the box daemon");
    assert.ok(await stillOpen(caraScreen.socket), "nobody else's screen is touched");

    // Taken off the box's members while still on the roster: the box is no longer his to watch.
    const bobAgain = await openDesktop(await signIn("bob"));
    const narrowed = await post("/api/boxes/update", { name: registry.defaultBox().name, members: ["cara"] });
    assert.equal(narrowed.status, 200, await narrowed.text());
    await within(bobAgain.closed, "Bob's desktop after the box stopped being his");
    assert.ok(await stillOpen(caraScreen.socket), "a member who stays keeps her screen");

    // Cara's token comes from her browser's sign-in, and the box is for Bob and Cara by name.
    const minted = await post("/api/mcp/tokens", { label: "Cara's IDE" }, { "content-type": "application/json", cookie: caraCookie });
    const { token } = (await minted.json()) as { token: string };
    const startGoal = (key: string) => post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "goal_start", arguments: { objective: "Ship the weekly digest" } } },
      { "content-type": "application/json", authorization: `Bearer ${token}`, "idempotency-key": key });
    const started = (await (await startGoal("first")).json()) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: { message: string } };
    assert.equal(started.error, undefined, String(started.error?.message));
    assert.notEqual(started.result?.isError, true, String(started.result?.content?.[0]?.text));
    assert.match(started.result?.content?.[0]?.text ?? "", /^t\d+/, "a goal on the box she is a member of");

    assert.equal((await post("/api/principals/remove", { principalId: "cara" })).status, 200);
    await within(caraScreen.closed, "Cara's desktop after she was removed");
    assert.equal((await startGoal("second")).status, 401, "and her token went with her");

    const bobOwnerCookie = await signIn("bob");
    const chrisCookie = await signIn("chris");
    const created = await post("/api/personal-boxes/create", { requestId: "personal", name: "Personal desk" },
      { "content-type": "application/json", cookie: bobOwnerCookie });
    assert.equal(created.status, 200, await created.clone().text());
    const { boxId } = await created.json() as { boxId: string };
    const personalDesktop = `/desktop/b/${boxId}/1/websockify`;
    const oldOwner = await openDesktop(bobOwnerCookie, personalDesktop);
    const oldUpstream = upstreamClosed.at(-1)!;
    // Bob can still sign in, so the hand-over waits for his yes (INV-2298).
    const asked = await post("/api/personal-boxes/admin", { action: "transfer", id: boxId, recipient: "chris" });
    assert.equal(asked.status, 202, await asked.text());
    const transferred = await post("/api/personal-boxes/transfer-answer", { id: boxId, agree: true }, { "content-type": "application/json", cookie: bobOwnerCookie });
    assert.equal(transferred.status, 200, await transferred.text());
    await within(oldOwner.closed, "Bob's desktop after his personal computer was transferred");
    await within(oldUpstream, "Bob's connection to the transferred computer");
    assert.equal((await fetch(`${base}/api/me`, { headers: { cookie: bobOwnerCookie } })).status, 200, "Bob was not signed out");
    await openDesktop(bobOwnerCookie, personalDesktop, 403);
    const newOwner = await openDesktop(chrisCookie, personalDesktop);
    assert.ok(await stillOpen(newOwner.socket), "the new owner can open the same computer's desktop");
  } finally {
    for (const socket of [...clients, ...upstreams]) socket.destroy();
    stop?.();
    daemon.closeAllConnections();
    await new Promise<void>(resolve => daemon.close(() => resolve()));
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
