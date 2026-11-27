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
import { desktopUpstreamPath } from "./server.ts";
import { desktopWaitingPage } from "./server-pages.ts";

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
  const page = desktopWaitingPage('Desktop 3 is not running. Ensure it first. <script>', "en", true);
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /http-equiv="refresh" content="2"/);
  assert.match(page, /Desktop 3 is not running/);
  assert.doesNotMatch(page, /<script>/);
  assert.match(page, /background:#000/);
});

test("a failed desktop replaces the starting state and offers retry without polling", () => {
  const page = desktopWaitingPage("Cannot start the desktop. Check the box connection and retry.");
  assert.match(page, /data-desktop-state="failed"/);
  assert.match(page, /Could not open the desktop/);
  assert.match(page, /<a href="">Retry<\/a>/);
  assert.doesNotMatch(page, /Desktop is starting|http-equiv="refresh"/);
});

test("the stream a signed-in person gets is their roster role's; a gateway's word can lower it and never raise it (INV-2228)", async t => {
  // A roster viewer who signed in with an invite code was joined to the driving stream: the
  // stream was chosen from the gateway's role header alone, and with no gateway there is no
  // header, which read as "may drive". Every HTTP route refused the same person's changes.
  const { createServer } = await import("node:http");
  const { connect } = await import("node:net");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { AttachedBoxProvisioner } = await import("../box/provisioner.ts");
  const { Principals } = await import("../host/principals.ts");
  const { BOXD_PROTOCOL } = await import("../protocol/index.ts");
  const { startWebServer } = await import("./server.ts");

  const home = mkdtempSync(join(tmpdir(), "desktop-role-"));
  const keys = ["AGENTBOX_HOME", "AGENTBOX_TRUST_GATEWAY_IDENTITY", "AGENTBOX_UI_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.AGENTBOX_HOME = home;
  const sockets: import("node:net").Socket[] = [];
  // A stand-in for the box's daemon that says which stream it was asked for.
  const asked: string[] = [];
  const daemon = createServer(async (req, res) => {
    for await (const _ of req) { /* drained */ }
    if (req.url?.startsWith("/vnc")) { asked.push(req.url); res.setHeader("content-type", "text/html"); res.end("<html>desktop</html>"); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/displays/ensure") { res.end(JSON.stringify({ index: 1 })); return; }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  daemon.on("upgrade", (req, socket) => { asked.push(req.url ?? ""); sockets.push(socket as import("node:net").Socket); socket.resume(); socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); });
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
  const daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
  let stop: (() => void) | undefined;
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    stop?.(); daemon.closeAllConnections(); daemon.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  });

  new Principals().save([
    { id: "ann", name: "Ann", role: "admin", identities: [] },
    { id: "dee", name: "Dee", role: "driver", identities: [] },
    { id: "vic", name: "Vic", role: "viewer", identities: [] },
  ]);
  const registry = new AgentRegistry();
  const index = registry.displayIndexFor(registry.create({ name: "Worker" }).id);
  let base = "";
  stop = await startWebServer({
    port: 0, host: "127.0.0.1", token: "t0k", onLog: () => {},
    boxProvisioner: new AttachedBoxProvisioner({ baseUrl: daemonUrl, token: "daemon" }),
    personalBoxDriver: { start: async () => daemonUrl, remove: async () => {} },
    onReady: url => { base = url; },
  });
  const host = new URL(base);
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const signIn = async (principalId: string) => {
    const { code } = await (await post("/api/channels/invite", { principalId }, { authorization: "Bearer t0k" })).json() as { code: string };
    const login = await post("/api/login", { code }, {});
    assert.equal(login.status, 200);
    return login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  };
  /** Opens the desktop's socket as that caller; the stream the daemon was asked for, and the socket. */
  const open = async (headers: Record<string, string>) => {
    const before = asked.length;
    const socket = connect(Number(host.port), host.hostname, () => {
      socket.write(`GET /desktop/${index}/websockify HTTP/1.1\r\nHost: ${host.host}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    sockets.push(socket);
    const status = await new Promise<string>((resolve, reject) => { socket.once("data", data => resolve(String(data).split("\r\n")[0]!)); socket.once("error", reject); socket.once("close", () => resolve("closed")); });
    assert.equal(status, "HTTP/1.1 101 Switching Protocols");
    return { stream: asked[before], socket };
  };
  const driving = `/vnc/${index}/websockify`, viewOnly = `/vnc-ro/${index}/websockify`;

  const vic = await signIn("vic"), dee = await signIn("dee");
  assert.equal((await open({ cookie: vic })).stream, viewOnly, "a viewer watches");
  const deeDriving = await open({ cookie: dee });
  assert.equal(deeDriving.stream, driving, "a driver drives");
  assert.equal((await open({ cookie: await signIn("ann") })).stream, driving, "an admin drives");
  assert.equal((await open({ authorization: "Bearer t0k" })).stream, driving, "the installation's own credential — the Owner's app — drives, as it always has");

  // The page and the socket it opens come from the same stack.
  const pageFor = async (cookie: string) => { const before = asked.length; await (await fetch(`${base}/desktop/${index}/app/ui.js`, { headers: { cookie } })).text(); return asked[before]; };
  assert.equal(await pageFor(vic), `/vnc-ro/${index}/app/ui.js`);
  assert.equal(await pageFor(dee), `/vnc/${index}/app/ui.js`);

  // A driver made a viewer while driving loses the driving stream, and the next one is view-only.
  const closed = new Promise<void>(resolve => deeDriving.socket.once("close", () => resolve()));
  const demoted = await post("/api/principals", { principals: new Principals().list().map(person => (person.id === "dee" ? { ...person, role: "viewer" } : person)) }, { authorization: "Bearer t0k" });
  assert.equal(demoted.status, 200);
  await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the demoted driver's stream is still open")), 2000))]);
  assert.equal((await open({ cookie: dee })).stream, viewOnly);

  // Behind the control plane's gateway its word is the role, as before; where a session of this
  // installation's is there too, the lower of the two holds.
  process.env.AGENTBOX_TRUST_GATEWAY_IDENTITY = "1";
  const viaGateway = (role: string, more: Record<string, string> = {}) => open({ authorization: "Bearer t0k", "x-agentbox-user": "u-1", "x-agentbox-role": role, ...more });
  assert.equal((await viaGateway("owner")).stream, driving);
  assert.equal((await viaGateway("member")).stream, driving);
  assert.equal((await viaGateway("viewer")).stream, viewOnly);
  assert.equal((await viaGateway("owner", { cookie: vic })).stream, viewOnly, "a gateway cannot raise what the roster gives");
  assert.equal((await viaGateway("viewer", { cookie: await signIn("ann") })).stream, viewOnly, "and can lower it");
});
