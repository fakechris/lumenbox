/**
 * An organisation's node, end to end on the real server (INV-1697, docs/96 §4): an Admin signs in
 * to the organisation through its Feishu door (the vendor faked), the app's node module enrols the
 * machine with that session — no code typed — and keeps the credential in the keychain; a member's
 * sign-in cannot enrol, nor can the installation's own credential. The node runner registers its
 * Docker box and its native environment (both daemons faked); both are listed under the node, the
 * Docker box is usable by a member at once, the native environment only once an Admin opens it,
 * and opening it is refused while its shell is not confined. Revoking the node cuts off both boxes
 * and stops the runner. And the organisation refuses a box by a connection code.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { NodeRunner, type NodeBox } from "../box/node-runner.ts";
import { BOXD_PROTOCOL } from "../protocol/index.ts";

const load = createRequire(import.meta.url);
const orgs = load("../../electron/organisations.cjs") as { sessionTokenIn(cookies: { name: string; value: string }[]): string | undefined };
const nodes = load("../../electron/organisation-node.cjs") as {
  organisationNode(o: object): { register(o: { address: string; name?: string }): Promise<{ organisation: { name: string; origin: string }; node: { name: string } }>; status(): { organisation: string; name: string; revoked: boolean } | undefined };
};
const { memoryKeychain } = load("../../electron/keychain.cjs") as { memoryKeychain(): { items: Map<string, string>; set(a: string, s: string): Promise<void>; get(a: string): Promise<string | undefined>; remove(a: string): Promise<void> } };

/** A box daemon that answers its health, headless or not, confined or not. */
async function fakeBoxd(health: () => Record<string, unknown>): Promise<{ url: string; close(): void }> {
  const server: Server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, version: "test", protocol: BOXD_PROTOCOL, display: "", uptime_seconds: 1, ...health() })); return; }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

test("an Admin's sign-in on the node enrols it; a member's cannot; its Docker box and native environment register, open to members by the rules, and revoking the node cuts both off (INV-1697)", async t => {
  const home = mkdtempSync(join(tmpdir(), "inv1697-org-"));
  const userData = mkdtempSync(join(tmpdir(), "inv1697-node-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = "https://org.example";
  const closers: (() => void)[] = [];
  t.after(() => {
    for (const close of closers.reverse()) close();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  });
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", name: "Fixture", type: "feishu", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "app", FIXTURE_APP_SECRET: "secret" } }));
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [{ id: "p-ana", name: "Ana", role: "admin", identities: ["fixture:ou_ana"] }, { id: "p-bo", name: "Bo", role: "driver", identities: ["fixture:ou_bo"] }], installation: { mode: "organisation" } }));
  // The vendor, faked: the authorization code is the open_id it vouches for.
  const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("oauth/token")) return Response.json({ access_token: JSON.parse(String(init!.body)).code });
    const subject = new Headers(init?.headers).get("authorization")!.slice(7);
    return Response.json({ code: 0, data: { open_id: subject, name: subject } });
  }) as typeof fetch;
  const logs: string[] = [];
  let base = "";
  const stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch, onLog: line => logs.push(line), onReady: url => { base = url; } });
  closers.push(stop);

  // Signing in through the organisation's Feishu door, as the app's sign-in window does.
  const signIn = async (openId: string): Promise<string> => {
    const begin = await fetch(`${base}/auth/fixture`, { redirect: "manual" });
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    const back = await fetch(`${base}/auth/fixture/callback?state=${state}&code=${openId}`, { redirect: "manual" });
    const cookies = back.headers.getSetCookie().map(line => { const [pair] = line.split(";"); const at = pair!.indexOf("="); return { name: pair!.slice(0, at), value: pair!.slice(at + 1) }; });
    return orgs.sessionTokenIn(cookies)!;
  };
  const as = (token: string) => (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: `agentbox_who=${token}`, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ana = await signIn("ou_ana");
  const bo = await signIn("ou_bo");

  // A member cannot enrol a node, in the app or by the route; nor can the installation's own credential.
  const started: { origin: string; name: string; credential: string }[] = [];
  const nodeFor = (session: string, file: string, keychain = memoryKeychain()) => ({ keychain, node: nodes.organisationNode({ file, keychain, signIn: async () => session, startNode: (input: { origin: string; name: string; credential: string }) => started.push(input) }) });
  const member = nodeFor(bo, join(userData, "bo-node.json"));
  await assert.rejects(member.node.register({ address: base, name: "mac-studio" }), (error: { code?: string }) => error.code === "not-admin");
  assert.equal(member.keychain.items.size, 0, "nothing kept");
  assert.equal(existsSync(join(userData, "bo-node.json")), false, "nothing recorded");
  const byRoute = await as(bo)("/api/nodes/enrol", { name: "mac-studio" });
  assert.equal(byRoute.status, 403);
  assert.equal(((await byRoute.json()) as { code: string }).code, "role-needed");
  const byToken = await fetch(`${base}/api/nodes/enrol`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ name: "mac-studio" }) });
  assert.equal(((await byToken.json()) as { code: string }).code, "node-enrol-person-needed", "the installation's credential names nobody");

  // The Admin's sign-in enrols it: no code anywhere, the credential in the keychain only.
  const admin = nodeFor(ana, join(userData, "node.json"));
  const registered = await admin.node.register({ address: base, name: "mac-studio" });
  assert.equal(registered.organisation.origin, base);
  assert.equal(registered.node.name, "mac-studio", "the page shows which node this machine became");
  assert.equal(started.length, 1, "the node process starts");
  const credential = started[0]!.credential;
  assert.match(credential, /^lbxn_/);
  assert.deepEqual([...admin.keychain.items.values()], [credential]);
  assert.ok(!readFileSync(join(userData, "node.json"), "utf8").includes(credential), "the record holds no credential");
  assert.deepEqual(admin.node.status(), { organisation: new URL(base).host, origin: base, name: "mac-studio", revoked: false });
  assert.ok(!readFileSync(join(home, "connect.json"), "utf8").includes(credential), "the organisation keeps it hashed");

  // The node's two boxes, registered by the runner with that credential.
  let confined = false;
  const native = await fakeBoxd(() => ({ headless: true, confinement: confined ? { active: true } : { active: false, reason: "sandbox-exec is missing" } }));
  const docker = await fakeBoxd(() => ({}));
  closers.push(native.close, docker.close);
  const stoppedBoxes: string[] = [];
  const box = (name: string, kind: "docker" | "host", url: string): NodeBox => ({ name, kind, start: async () => ({ baseUrl: url, token: `${name}-daemon-token`, ...(kind === "host" ? { workDir: "/srv/work", repositories: [{ path: "/srv/work", mode: "rw" as const }] } : {}) }), stop: async () => { stoppedBoxes.push(name); } });
  const runner = new NodeRunner({ control: base, credential, boxes: [box("mac-studio-native", "host", native.url), box("mac-studio-docker", "docker", docker.url)], version: "0.0.0-test", heartbeatMs: 60_000, log: line => logs.push(line) });
  closers.push(() => { void runner.stop(); });
  await runner.start();

  const listed = (await (await as(ana)("/api/nodes")).json()) as { nodes: { id: string; name: string; lastSeenAt?: string; boxes: { name: string; kind: string; state: string; members: unknown }[] }[] };
  assert.equal(listed.nodes.length, 1);
  assert.ok(listed.nodes[0]!.lastSeenAt, "the node was heard");
  assert.deepEqual(listed.nodes[0]!.boxes.map(b => [b.name, b.kind, b.state]), [["mac-studio-native", "native", "connected"], ["mac-studio-docker", "docker", "connected"]]);
  assert.deepEqual(listed.nodes[0]!.boxes[0]!.members, [], "the native environment joins with nobody in it");
  const boxesOf = async (token: string) => ((await (await as(token)("/api/boxes")).json()) as { boxes: { name: string; kind: string; connected: boolean; node?: { name: string } }[] }).boxes;
  assert.deepEqual((await boxesOf(bo)).filter(b => b.node !== undefined).map(b => b.name), ["mac-studio-docker"], "a member can use the Docker box at once, not the native environment");
  const operator = ((await (await fetch(`${base}/api/boxes`, { headers: { authorization: "Bearer fixture" } })).json()) as { boxes: { name: string; kind: string }[] }).boxes;
  assert.equal(operator.find(b => b.name === "mac-studio-native")?.kind, "host", "the native environment is a host box: its writes ask (INV-1700)");
  const bundles = JSON.parse(readFileSync(join(home, "bundles.json"), "utf8")) as { bundles: { id: string; repositories?: unknown }[] };
  assert.deepEqual(bundles.bundles.find(b => b.id === "host-mac-studio-native")?.repositories, [{ path: "/srv/work", mode: "rw" }], "what it may reach is recorded in the organisation");

  // Opening the native environment: refused while its shell is not confined, allowed once it is.
  const open = () => as(ana)("/api/boxes/update", { name: "mac-studio-native", members: "everyone" });
  const unconfined = await open();
  assert.equal(unconfined.status, 409);
  assert.equal(((await unconfined.json()) as { code: string }).code, "node-native-unconfined");
  confined = true;
  assert.equal((await open()).status, 200);
  assert.ok((await boxesOf(bo)).some(b => b.name === "mac-studio-native"), "now a member is in it");

  // The heartbeat is the same registration again: one box each, not two.
  await runner.beat();
  assert.equal((await boxesOf(bo)).filter(b => b.node !== undefined).length, 2);

  // The organisation takes no box by a code, and says which ways it takes before a token is sent.
  assert.deepEqual(await (await fetch(`${base}/api/boxes/register`)).json(), { installation: "organisation", takes: ["node", "runner"] });
  assert.equal(((await (await fetch(`${base}/api/boxes/connect-codes`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: "{}" })).json()) as { code: string }).code, "box-code-organisation");
  const byCode = await fetch(`${base}/api/boxes/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "lbx-00000000-anything", name: "laptop", baseUrl: docker.url, token: "x".repeat(20) }) });
  assert.equal(byCode.status, 403);
  assert.equal(((await byCode.json()) as { code: string }).code, "box-code-organisation");

  // Revoking the node cuts both boxes off; the runner hears it on its next beat and stops them.
  const revoked = (await (await as(ana)("/api/nodes/revoke", { node: listed.nodes[0]!.id })).json()) as { boxes: string[] };
  assert.equal(revoked.boxes.length, 2);
  assert.deepEqual((await boxesOf(bo)).filter(b => b.node !== undefined).map(b => b.connected), [false, false], "unreachable from the organisation");
  await runner.beat();
  assert.equal(await runner.done, "revoked");
  assert.deepEqual(stoppedBoxes.sort(), ["mac-studio-docker", "mac-studio-native"]);
  const after = (await (await as(ana)("/api/nodes")).json()) as { nodes: { revoked?: object; boxes: { state: string; stateReason?: string }[] }[] };
  assert.ok(after.nodes[0]!.revoked);
  assert.deepEqual(after.nodes[0]!.boxes.map(b => [b.state, b.stateReason]), [["revoked", "NodeRevoked"], ["revoked", "NodeRevoked"]]);
  const again = await fetch(`${base}/api/boxes/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ node: credential, name: "mac-studio-docker", kind: "docker", baseUrl: docker.url, token: "y".repeat(20) }) });
  assert.equal(again.status, 403, "a revoked node's credential is refused");

  const joined = logs.join("\n");
  assert.ok(!joined.includes(credential) && !joined.includes("daemon-token") && !joined.includes(ana), "no credential, daemon token or session in the log");
});
