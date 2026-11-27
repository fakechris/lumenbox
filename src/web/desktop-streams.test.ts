/**
 * A desktop stream opens with a ticket off local, closes when nothing moves, and leaves a record
 * of who watched (docs/106 §5 R6, R8; INV-2204). The arithmetic first, then a real server with a
 * stand-in for the box's daemon behind it, which says what it was asked for.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DESKTOP_IDLE_MS, DesktopStreams, DesktopTickets, InputWatch, TICKET_TTL_MS, grantedMode, pageAddressWith, ticketIn, withReopenNotice, withoutTicket,
  type DesktopSessionRecord,
} from "./desktop-streams.ts";

/** A WebSocket frame as a browser sends one: binary, masked. */
function masked(payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const head = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length]) : Buffer.from([0x82, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i += 1) body[i]! ^= mask[i & 3]!;
  return Buffer.concat([head, mask, body]);
}
/** noVNC's side of the RFB handshake to a desktop with no password: version, security choice, ClientInit. */
const HANDSHAKE = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1]), Buffer.from([1])]);
const UPDATE_REQUEST = Buffer.from([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const POINTER_MOVE = Buffer.from([5, 0, 0, 10, 0, 20]);
const POINTER_CLICK = Buffer.from([5, 1, 0, 10, 0, 20]);
const KEY_DOWN = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);

test("a ticket opens one desktop for one person in one mode, once, within a minute", () => {
  let now = 1_000_000;
  const tickets = new DesktopTickets(() => now);
  const ticket = tickets.issue("ann", "box-1/1", "control");
  assert.match(ticket, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(tickets.good(ticket, "ann", "box-1/1"), true, "the page's own request may look without spending it");
  assert.deepEqual(tickets.redeem(ticket, "bob", "box-1/1"), { refused: "ticket-other-person" }, "presented by somebody else");
  assert.deepEqual(tickets.redeem(ticket, "ann", "box-1/2"), { refused: "ticket-other-desktop" }, "for another desktop");
  assert.deepEqual(tickets.redeem(ticket, "ann", "box-1/1"), { mode: "control" }, "a refused try does not spend it for the person it is for");
  assert.deepEqual(tickets.redeem(ticket, "ann", "box-1/1"), { refused: "ticket-used" }, "it answers yes once");
  assert.equal(tickets.good(ticket, "ann", "box-1/1"), false);

  const late = tickets.issue("ann", "box-1/1", "view");
  now += TICKET_TTL_MS;
  assert.deepEqual(tickets.redeem(late, "ann", "box-1/1"), { refused: "ticket-expired" });
  assert.deepEqual(tickets.redeem(undefined, "ann", "box-1/1"), { refused: "ticket-missing" });
  assert.deepEqual(tickets.redeem("made-up", "ann", "box-1/1"), { refused: "ticket-unknown" });
  now += 3 * TICKET_TTL_MS;
  tickets.issue("ann", "box-1/1", "view");
  assert.deepEqual(tickets.redeem(late, "ann", "box-1/1"), { refused: "ticket-unknown" }, "and a dead one is forgotten");

  // The mode is the lower of what was asked and what the role allows.
  assert.equal(grantedMode(null, true), "control");
  assert.equal(grantedMode("view", true), "view");
  assert.equal(grantedMode(null, false), "view");
  assert.equal(grantedMode("control", false), "view", "asking does not raise it");
});

test("the ticket rides where noVNC reads its socket's path, and is in no address that is passed on", () => {
  const page = pageAddressWith("/desktop/1/vnc.html", "?autoconnect=1&resize=scale&path=desktop/1/websockify", "desktop/1", "T1");
  assert.equal(new URLSearchParams(page.split("?")[1]).get("path"), "desktop/1/websockify?ticket=T1", "noVNC opens exactly this path");
  assert.equal(ticketIn(`?${page.split("?")[1]}`), "T1", "the page's own request finds it there");
  assert.equal(ticketIn("?ticket=T1"), "T1", "and the socket's request finds it on its own address");
  assert.equal(ticketIn("?autoconnect=1"), undefined);
  assert.equal(pageAddressWith("/desktop/b/box-9/2/vnc.html", "", "desktop/b/box-9/2", "T2"), "/desktop/b/box-9/2/vnc.html?path=desktop%2Fb%2Fbox-9%2F2%2Fwebsockify%3Fticket%3DT2", "a page with no path gets the desktop's own");
  // A reload carries the spent ticket; the new one replaces it rather than joining it.
  assert.equal(ticketIn(`?${pageAddressWith("/desktop/1/vnc.html", `?${page.split("?")[1]}`, "desktop/1", "T3").split("?")[1]}`), "T3");
  assert.ok(!withoutTicket(`?${page.split("?")[1]}`).includes("T1"));
  assert.equal(new URLSearchParams(withoutTicket(`?${page.split("?")[1]}`)).get("path"), "desktop/1/websockify");
  assert.equal(withoutTicket("?ticket=T1"), "");
  assert.equal(withoutTicket("?a=1&ticket=T1"), "?a=1");
  assert.equal(withoutTicket(""), "");
});

test("a key or a button pressed is input; watching, or a pointer crossing the picture, is not; what it cannot read it does not guess", () => {
  const watching = new InputWatch();
  for (const message of [HANDSHAKE, UPDATE_REQUEST, POINTER_MOVE, UPDATE_REQUEST]) watching.feed(masked(message));
  assert.equal(watching.state, false);
  watching.feed(masked(POINTER_CLICK));
  assert.equal(watching.state, true, "a button down");

  const typing = new InputWatch();
  // Split across reads the way a socket splits them, mid-frame and mid-message.
  const bytes = Buffer.concat([masked(HANDSHAKE), masked(Buffer.concat([UPDATE_REQUEST, KEY_DOWN.subarray(0, 3)])), masked(KEY_DOWN.subarray(3))]);
  for (let at = 0; at < bytes.length; at += 5) typing.feed(bytes.subarray(at, at + 5));
  assert.equal(typing.state, true, "a key");

  const compressed = new InputWatch();
  compressed.feed(Buffer.from([0xc2, 0x80, 1, 2, 3, 4]));
  assert.equal(compressed.state, "unknown", "a compressed frame is not read");
  const strange = new InputWatch();
  strange.feed(masked(Buffer.concat([HANDSHAKE, Buffer.from([99, 0, 0, 0])])));
  assert.equal(strange.state, "unknown", "nor is a message it does not know");
});

test("a stream is recorded when it opens and when it ends, once, with why; quiet for too long, it is closed with words the page shows", async () => {
  const lines: DesktopSessionRecord[] = [];
  let now = Date.parse("2026-11-27T10:00:00Z");
  const fake = () => { const written: Buffer[] = []; return { written, destroyed: false, write(chunk: Buffer) { written.push(chunk); return true; }, destroy() { this.destroyed = true; } }; };

  const streams = new DesktopStreams({ record: line => lines.push(line), now: () => now });
  const socket = fake();
  const driving = streams.opened({ person: "ann", box: "box-1", display: 1, agent: "agent-7", mode: "control", by: "session" }, socket as unknown as Socket);
  driving.moved("up", masked(HANDSHAKE));
  driving.moved("up", masked(KEY_DOWN));
  now += 90_000;
  driving.end("left");
  driving.end("box-gone");
  assert.deepEqual(lines.map(({ stream: _stream, ...line }) => line), [
    { at: "2026-11-27T10:00:00.000Z", event: "opened", person: "ann", box: "box-1", display: 1, agent: "agent-7", mode: "control", by: "session" },
    { at: "2026-11-27T10:01:30.000Z", event: "closed", person: "ann", box: "box-1", display: 1, agent: "agent-7", mode: "control", by: "session", reason: "left", seconds: 90, input: true },
  ], "who, whose desktop, which mode; then why, how long, and whether anything was pressed — and the first reason is the reason");
  assert.equal(lines[0]!.stream, lines[1]!.stream, "the two lines are one stream");
  assert.ok(!JSON.stringify(lines).includes("61"), "never the key");

  // Without a limit — local — nothing is closed for being quiet.
  now += 10 * DESKTOP_IDLE_MS;
  assert.equal(socket.destroyed, false);

  // With one, a stream nothing moved on is ended, and the socket is told why before it goes.
  lines.length = 0;
  const limited = new DesktopStreams({ record: line => lines.push(line), idleMs: 40 });
  const quiet = fake();
  const busy = fake();
  limited.opened({ person: "vic", box: "box-1", display: 1, mode: "view", by: "ticket" }, quiet as unknown as Socket);
  const moving = limited.opened({ person: "ann", box: "box-1", display: 2, mode: "control", by: "ticket" }, busy as unknown as Socket);
  const keepMoving = setInterval(() => moving.moved("down", Buffer.from([0])), 10);
  await new Promise(resolve => setTimeout(resolve, 1_200));
  clearInterval(keepMoving);
  assert.equal(quiet.destroyed, true);
  assert.equal(busy.destroyed, false, "a stream something moves on is left alone");
  const closed = lines.find(line => line.event === "closed")!;
  assert.deepEqual([closed.person, closed.reason, closed.input], ["vic", "idle", undefined], "a view-only stream has no input to speak of");
  const frame = quiet.written[0]!;
  assert.equal(frame[0], 0x88, "a close frame");
  assert.equal(frame.readUInt16BE(2), 4408);
  assert.match(frame.subarray(4).toString("utf8"), /nothing happening.*Reload/);
  moving.end("left");
  assert.equal(DESKTOP_IDLE_MS, 15 * 60_000, "the limit a deployment has is fifteen minutes");
});

test("the desktop page gains a way back for when its stream ends, and nothing else", () => {
  const html = "<html><body><canvas></canvas></body></html>";
  const out = withReopenNotice(html, { closed: "Closed </script><b>x", idle: "Idle", reopen: "Reopen" });
  assert.ok(out.startsWith("<html><body><canvas></canvas><script>") && out.endsWith("</script></body></html>"));
  const script = out.slice(out.indexOf("<script>") + 8, out.lastIndexOf("</script>"));
  assert.ok(!script.includes("</script>"), "words cannot end the script early");
  assert.match(script, /window\.WebSocket=Watched/, "it watches the socket itself, whatever the page's markup is");
  assert.match(script, /event\.code===4408/, "and tells an idle close from the others");
  assert.match(script, /location\.reload\(\)/);
  assert.ok(!/setTimeout|setInterval/.test(script), "it waits for the person: a page that reopened itself would undo the idle limit");
  // The script is what a browser runs: a socket that opened and then closed shows the notice once; one that never opened does not.
  const made: { listeners: Record<string, ((event: { code: number }) => void)[]> }[] = [];
  const appended: { id?: string; children: { textContent?: string }[] }[] = [];
  const element = () => { const node = { style: {}, children: [] as { textContent?: string }[], appendChild(child: { textContent?: string }) { node.children.push(child); } }; return node; };
  const window = { WebSocket: function (this: unknown) { const socket = { listeners: {} as Record<string, ((event: { code: number }) => void)[]>, addEventListener(name: string, fn: (event: { code: number }) => void) { socket.listeners[name] = [...(socket.listeners[name] ?? []), fn]; } }; made.push(socket); return socket; } as unknown as { new (url: string): unknown } };
  const document = { createElement: element, body: { appendChild: (node: { id?: string; children: { textContent?: string }[] }) => appended.push(node) } };
  new Function("window", "document", "location", script)(window, document, { reload() {} });
  new window.WebSocket("wss://x/never-opens");
  made[0]!.listeners.close![0]!({ code: 1006 });
  assert.equal(appended.length, 0, "a socket that never opened is noVNC's to report");
  new window.WebSocket("wss://x/opens");
  made[1]!.listeners.open![0]!({ code: 0 });
  made[1]!.listeners.close![0]!({ code: 4408 });
  made[1]!.listeners.close![0]!({ code: 4408 });
  assert.equal(appended.length, 1);
  assert.deepEqual([appended[0]!.id, appended[0]!.children[0]!.textContent, appended[0]!.children[1]!.textContent], ["lumenbox-desktop-closed", "Idle", "Reopen"]);
  assert.equal(withReopenNotice("no body here", { closed: "x", idle: "i", reopen: "y" }), "no body here");
});

// ── a real server, a stand-in daemon ────────────────────────────────────────────────────────────

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_INSECURE", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUST_GATEWAY_IDENTITY", "AGENTBOX_TRUSTED_PROXIES"] as const;

async function installation(t: TestContext, env: Partial<Record<(typeof KEYS)[number], string>>, host: string) {
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { AttachedBoxProvisioner } = await import("../box/provisioner.ts");
  const { Principals } = await import("../host/principals.ts");
  const { BOXD_PROTOCOL } = await import("../protocol/index.ts");
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "desktop-streams-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env, { AGENTBOX_HOME: home });
  /** What the box's daemon was asked for, in order: pages and sockets. */
  const asked: string[] = [];
  const sockets: Socket[] = [];
  const upstreams: Socket[] = [];
  const daemon = createServer(async (req, res) => {
    for await (const _ of req) { /* drained */ }
    if (req.url?.startsWith("/vnc")) { asked.push(`${req.url} referer=${req.headers.referer ?? ""}`); res.setHeader("content-type", "text/html"); res.end("<html><body>desktop</body></html>"); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/displays/ensure") { res.end(JSON.stringify({ index: 1 })); return; }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  daemon.on("upgrade", (req, socket: Socket) => { asked.push(req.url ?? ""); upstreams.push(socket); sockets.push(socket); socket.resume(); socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); });
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
  const daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
  let stop: (() => void) | undefined;
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    stop?.(); daemon.closeAllConnections(); daemon.close();
    for (const key of KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  });
  new Principals().save([
    { id: "ann", name: "Ann", role: "admin", identities: [] },
    { id: "dee", name: "Dee", role: "driver", identities: [] },
    { id: "vic", name: "Vic", role: "viewer", identities: [] },
  ]);
  const registry = new AgentRegistry();
  const worker = registry.create({ name: "Worker" });
  const index = registry.displayIndexFor(worker.id);
  const logs: string[] = [];
  let base = "";
  stop = await startWebServer({
    port: 0, host, token: "t0k", onLog: line => logs.push(line),
    boxProvisioner: new AttachedBoxProvisioner({ baseUrl: daemonUrl, token: "daemon" }),
    personalBoxDriver: { start: async () => daemonUrl, remove: async () => {} },
    onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); },
  });
  const address = new URL(base);
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const signIn = async (principalId: string) => {
    const { code } = await (await post("/api/channels/invite", { principalId }, { authorization: "Bearer t0k" })).json() as { code: string };
    const login = await post("/api/login", { code }, {});
    assert.equal(login.status, 200);
    return login.headers.getSetCookie().map(cookie => cookie.split(";")[0]).join("; ");
  };
  /** A socket upgrade: the status line with the refusal's word, the stream the daemon was asked for, and the socket. */
  const open = async (path: string, headers: Record<string, string>) => {
    const before = asked.length;
    const socket = connect(Number(address.port), address.hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("")}Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    sockets.push(socket);
    const answer = await new Promise<string>((resolve, reject) => { socket.once("data", data => resolve(String(data))); socket.once("error", reject); socket.once("close", () => resolve("closed")); });
    return { status: `${answer.split("\r\n")[0]} ${answer.split("\r\n\r\n")[1]?.trim() ?? ""}`.trim(), stream: asked[before], socket };
  };
  const sessions = (): DesktopSessionRecord[] => {
    const path = join(home, "desktop-sessions.jsonl");
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as DesktopSessionRecord) : [];
  };
  const until = async (what: string, test: () => boolean) => { for (let n = 0; n < 100 && !test(); n += 1) await new Promise(resolve => setTimeout(resolve, 20)); assert.ok(test(), what); };
  const get = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { headers, redirect: "manual" });
  // The first request for a desktop's page starts the desktop and answers "starting"; wait that out, as the page itself does.
  for (let n = 0; n < 100 && (await get(`/desktop/${index}/vnc.html`, { authorization: "Bearer t0k" })).status === 503; n += 1) await new Promise(resolve => setTimeout(resolve, 20));
  asked.length = 0;
  return { base, home, index, worker, asked, upstreams, logs, post, signIn, open, sessions, until, get };
}

test("private: the desktop's socket opens only with a ticket — this person's, this desktop's, once — and who watched is recorded", async t => {
  const { index, worker, asked, upstreams, logs, home, post, signIn, open, sessions, until, get } = await installation(t, { AGENTBOX_PUBLIC_URL: "https://box.example.test" }, "0.0.0.0");
  const page = `/desktop/${index}/vnc.html?autoconnect=1&resize=scale&path=desktop/${index}/websockify`;
  const socketOf = (location: string) => `/${new URLSearchParams(location.split("?")[1]).get("path")}`;
  /** The page as a browser asks for it: sent to itself with a ticket, which is then the socket's address. */
  const ticketFor = async (cookie: string, address = page) => {
    const redirect = await get(address, { cookie });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get("cache-control"), "no-store", "an address with a credential in it is not kept");
    return { location: redirect.headers.get("location")!, socket: socketOf(redirect.headers.get("location")!) };
  };
  const ann = await signIn("ann"), dee = await signIn("dee"), vic = await signIn("vic");

  assert.equal((await open(`/desktop/${index}/websockify`, { cookie: ann })).status, "HTTP/1.1 403 Forbidden ticket-missing", "a session alone does not open the stream");
  assert.equal((await open(`/desktop/${index}/websockify?ticket=made-up`, { cookie: ann })).status, "HTTP/1.1 403 Forbidden ticket-unknown");

  const annTicket = await ticketFor(ann);
  assert.match(annTicket.socket, new RegExp(`^/desktop/${index}/websockify\\?ticket=[A-Za-z0-9_-]{32}$`));
  // The page itself, with its ticket: served, with a way back for when the stream ends, and the ticket goes no further.
  const served = await get(annTicket.location, { cookie: ann, "accept-language": "en", referer: `https://box.example.test${annTicket.location}` });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("cache-control"), "no-store");
  const html = await served.text();
  assert.match(html, /^<html><body>desktop<script>.*This desktop's connection ended.*Reopen.*<\/script><\/body><\/html>$/s);
  assert.equal(Number(served.headers.get("content-length")), Buffer.byteLength(html));

  assert.equal((await open(annTicket.socket, { cookie: dee })).status, "HTTP/1.1 403 Forbidden ticket-other-person", "somebody else's session cannot use it");
  const watching = await open(annTicket.socket, { cookie: ann });
  assert.equal(watching.status, "HTTP/1.1 101 Switching Protocols");
  assert.equal(watching.stream, `/vnc/${index}/websockify`, "an admin's ticket is for the driving stream, and the box is not shown the ticket");
  assert.equal((await open(annTicket.socket, { cookie: ann })).status, "HTTP/1.1 403 Forbidden ticket-used", "the same ticket a second time");

  // A viewer's ticket is for the view-only stream; a driver who asks only to watch gets that too.
  assert.equal((await open((await ticketFor(vic)).socket, { cookie: vic })).stream, `/vnc-ro/${index}/websockify`);
  assert.equal((await open((await ticketFor(vic, `${page}&mode=control`)).socket, { cookie: vic })).stream, `/vnc-ro/${index}/websockify`, "asking for more does not get it");
  assert.equal((await open((await ticketFor(dee, `${page}&mode=view`)).socket, { cookie: dee })).stream, `/vnc-ro/${index}/websockify`);

  // A ticket is good for a minute.
  const stale = await ticketFor(dee);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  assert.equal((await open(stale.socket, { cookie: dee })).status, "HTTP/1.1 403 Forbidden ticket-expired");
  t.mock.timers.reset();

  // Dee drives, presses a key, and is then made a viewer: the stream she holds is closed at once.
  const driving = await open((await ticketFor(dee)).socket, { cookie: dee });
  assert.equal(driving.stream, `/vnc/${index}/websockify`);
  driving.socket.write(Buffer.concat([masked(HANDSHAKE), masked(UPDATE_REQUEST), masked(KEY_DOWN)]));
  await new Promise(resolve => setTimeout(resolve, 100));
  const lost = new Promise<void>(resolve => driving.socket.once("close", () => resolve()));
  const { Principals } = await import("../host/principals.ts");
  assert.equal((await post("/api/principals", { principals: new Principals().list().map(person => (person.id === "dee" ? { ...person, role: "viewer" } : person)) }, { authorization: "Bearer t0k" })).status, 200);
  await Promise.race([lost, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the demoted driver's stream is still open")), 2000))]);

  // Ann leaves; the box drops the viewer's stream.
  watching.socket.destroy();
  upstreams[1]!.destroy();
  await until("each stream that ended has its closing line", () => sessions().filter(line => line.event === "closed").length >= 3);

  const record = sessions();
  const of = (person: string, event: string) => record.filter(line => line.person === person && line.event === event);
  assert.deepEqual(of("ann", "opened").map(({ at: _at, stream: _stream, ...line }) => line), [{ event: "opened", person: "ann", box: record[0]!.box, display: index, agent: worker.id, mode: "control", by: "ticket" }]);
  assert.deepEqual(of("ann", "closed").map(line => [line.reason, line.input]), [["left", false]], "she watched, on the driving stream, and pressed nothing");
  assert.deepEqual(of("dee", "closed").filter(line => line.mode === "control").map(line => [line.reason, line.input]), [["revoked", true]], "Dee drove, and lost the stream when her role changed");
  assert.ok(of("vic", "closed").some(line => line.reason === "box-gone" && line.mode === "view" && line.input === undefined));
  assert.ok(record.every(line => typeof line.at === "string" && typeof line.stream === "string"));

  // Nothing that was passed on or printed holds a ticket.
  const tickets = [annTicket.socket, stale.socket].map(address => address.split("ticket=")[1]!);
  assert.ok(asked.length > 0 && asked.every(line => !line.includes("ticket")), `the box was shown: ${asked.join(" ; ")}`);
  assert.ok(asked.filter(line => line.startsWith("/vnc/") && line.includes("vnc.html")).every(line => line.endsWith("referer=")), "nor a Referer that carries one");
  for (const ticket of tickets) assert.ok(logs.every(line => !line.includes(ticket)) && !readFileSync(join(home, "desktop-sessions.jsonl"), "utf8").includes(ticket));

  // Who signed in is on the record too, beside the tries that did not.
  const signIns = readFileSync(join(home, "sign-ins.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { outcome: string; door: string; account?: string });
  assert.deepEqual(signIns.filter(line => line.outcome === "signed-in").map(line => [line.door, line.account]), [["invite-code", "ann"], ["invite-code", "dee"], ["invite-code", "vic"]]);
});

test("local: the session opens the desktop as it always did — no ticket, no redirect, nothing added to the page — and the stream is recorded", async t => {
  const { index, asked, signIn, open, sessions, until, get, home } = await installation(t, {}, "127.0.0.1");
  const page = `/desktop/${index}/vnc.html?autoconnect=1&resize=scale&path=desktop/${index}/websockify`;
  const ann = await signIn("ann");
  const served = await get(page, { cookie: ann });
  assert.equal(served.status, 200, "the page is served where it was asked for");
  assert.equal(await served.text(), "<html><body>desktop</body></html>", "exactly as the box sent it");
  assert.equal(asked.at(-1), `/vnc/${index}/vnc.html?autoconnect=1&resize=scale&path=desktop/${index}/websockify referer=`);
  const stream = await open(`/desktop/${index}/websockify`, { cookie: ann });
  assert.equal(stream.status, "HTTP/1.1 101 Switching Protocols");
  assert.equal((await open(`/desktop/${index}/websockify`, { authorization: "Bearer t0k" })).stream, `/vnc/${index}/websockify`, "the Owner's app");
  stream.socket.destroy();
  await until(`the stream's two lines: ${JSON.stringify(sessions())}`, () => sessions().filter(line => line.person === "ann").length === 2);
  assert.deepEqual(sessions().filter(line => line.person === "ann").map(line => [line.event, line.mode, line.by, line.reason]), [["opened", "control", "session", undefined], ["closed", "control", "session", "left"]]);
  assert.ok(sessions().some(line => line.person === "operator"), "the installation's own credential is said to be that");
  assert.deepEqual(readFileSync(join(home, "sign-ins.jsonl"), "utf8").trim().split("\n").map(line => (JSON.parse(line) as { outcome: string }).outcome), ["signed-in"], "a sign-in that worked is recorded at local too; nothing else is");
});

test("through the control plane's gateway: the tenant's page is sent to itself with a ticket, and the socket opens with it", async t => {
  // A tenant's box as the allocator configures it: every interface, the gateway believed; people are the gateway's.
  const box = await installation(t, { AGENTBOX_INSECURE: "1", AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" }, "0.0.0.0");
  const { SqliteControlStore } = await import("../control/store.ts");
  const { StaticAllocator } = await import("../control/allocator.ts");
  const { Gateway, PasswordListIdentity } = await import("../control/gateway.ts");
  const dir = mkdtempSync(join(tmpdir(), "desktop-streams-gateway-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const gateway = new Gateway({
    store, allocator: new StaticAllocator(store, { boxdUrl: "http://127.0.0.1:1", uiUrl: box.base, tokens: { box: "unused", ui: "t0k" } }),
    identity: PasswordListIdentity.parse("alice:secret:acme"), sessionSecret: Buffer.from("b".repeat(32)), image: "agentbox/box:test",
  });
  const front = createServer((req, res) => { void gateway.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  front.on("upgrade", (req, socket, head) => { void gateway.handleUpgrade(req, socket as Socket, head).catch(() => socket.destroy()); });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  const sockets: Socket[] = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); front.closeAllConnections(); front.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const address = new URL(`http://127.0.0.1:${(front.address() as { port: number }).port}`);

  const signIn = await fetch(`${address.origin}/gateway/login`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "secret" }), redirect: "manual" });
  const session = (signIn.headers.get("set-cookie") ?? "").split(";")[0]!;
  const page = `/desktop/${box.index}/vnc.html?autoconnect=1&path=desktop/${box.index}/websockify`;
  const redirect = await fetch(`${address.origin}${page}`, { headers: { cookie: session }, redirect: "manual" });
  assert.equal(redirect.status, 302, "the box's redirect reaches the browser through the gateway");
  assert.equal(redirect.headers.get("cache-control"), "no-store");
  const socketPath = `/${new URLSearchParams(redirect.headers.get("location")!.split("?")[1]).get("path")}`;
  const upgrade = (path: string) => new Promise<string>(resolve => {
    const socket = connect(Number(address.port), address.hostname, () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${address.host}\r\nCookie: ${session}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
    sockets.push(socket);
    socket.once("data", data => resolve(`${String(data).split("\r\n")[0]} ${String(data).split("\r\n\r\n")[1]?.trim() ?? ""}`.trim()));
    socket.once("close", () => resolve("closed"));
  });
  assert.equal(await upgrade(`/desktop/${box.index}/websockify`), "HTTP/1.1 403 Forbidden ticket-missing");
  assert.equal(await upgrade(socketPath), "HTTP/1.1 101 Switching Protocols", "the ticket in the socket's address survives the gateway");
  assert.equal(await upgrade(socketPath), "HTTP/1.1 403 Forbidden ticket-used");
  await box.until("the stream is recorded as the gateway's user's", () => box.sessions().some(line => line.event === "opened" && line.by === "ticket" && line.mode === "control" && line.person !== "operator"));
  assert.ok(box.asked.every(line => !line.includes("ticket")));
});
