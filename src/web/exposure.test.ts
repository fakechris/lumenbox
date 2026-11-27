/**
 * Where an installation is reachable, and what that requires of it (docs/106 §5, INV-2204).
 *
 * The first test pins `local` — every personal installation and the desktop app — as it was before
 * levels existed: it was written against the code before the change and passed there unchanged.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_INSECURE", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUST_GATEWAY_IDENTITY"] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;
const ORIGINAL = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const restore = () => { for (const key of KEYS) { if (ORIGINAL[key] === undefined) delete process.env[key]; else process.env[key] = ORIGINAL[key]; } };

/** A real server on a temporary home with exactly `env` of the settings a level is read from; an organisation's roster, so people can be invited. */
async function serve(t: TestContext, options: { host?: string; token?: string }, env: Env = {}) {
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "agentbox-exposure-"));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env, { AGENTBOX_HOME: home });
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
  const logs: string[] = [];
  let base = "";
  let stop: (() => void) | undefined;
  // The settings stay for the test: the server reads some of them on each request.
  t.after(() => { stop?.(); restore(); rmSync(home, { recursive: true, force: true }); });
  stop = await startWebServer({ port: 0, host: options.host ?? "127.0.0.1", ...(options.token !== undefined ? { token: options.token } : {}), useBox: false, onLog: line => logs.push(line), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers, redirect: "manual" });
  /** A person invited by the operator's machine credential and signed in with the code: their Set-Cookie line. */
  const signIn = async (name: string, role: string, operator: Record<string, string>) => {
    const invite = await fetch(base + "/api/channels/invite", { method: "POST", headers: { ...operator, "content-type": "application/json" }, body: JSON.stringify({ role }) });
    assert.equal(invite.status, 200, "the operator's machine credential makes an invitation");
    const { code } = await invite.json() as { code: string };
    const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
    assert.equal(login.status, 200);
    return login.headers.getSetCookie()[0]!;
  };
  return { base, home, logs, get, signIn };
}

test("local is what it was: no token on loopback, ?token= to a cookie, the bearer token, no Secure and no HSTS", async t => {
  const open = await serve(t, {});
  const anyone = await open.get("/api/me");
  assert.equal(anyone.status, 200, "loopback with no token configured serves whoever reaches it");
  assert.equal(anyone.headers.get("strict-transport-security"), null);

  const TOKEN = "l0cal-t0ken";
  const { get, signIn } = await serve(t, { token: TOKEN });
  const refused = await get("/api/me");
  assert.equal(refused.status, 401);
  assert.match((await refused.json() as { error: string }).error, /\?token=/, "and says how the operator gets in");

  const bootstrap = await get(`/?token=${TOKEN}`);
  assert.equal(bootstrap.status, 200, "the desktop app's first page load");
  assert.equal(bootstrap.headers.get("set-cookie"), `agentbox_ui=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`, "the token becomes a cookie the plain-HTTP loopback page can store");
  assert.equal(bootstrap.headers.get("strict-transport-security"), null);

  assert.equal((await get("/api/me", { cookie: `agentbox_ui=${TOKEN}` })).status, 200, "the cookie carries the page's later requests");
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}` })).status, 200, "the app shell and the CLI send it as a header");
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.9" })).status, 200, "from wherever");
  assert.equal((await get("/api/me", { authorization: "Bearer wrong" })).status, 401);

  const session = await signIn("Ana", "driver", { authorization: `Bearer ${TOKEN}` });
  assert.match(session, /^agentbox_who=[^;]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/, "a person's session is not Secure on plain loopback");
  const me = await get("/api/me", { cookie: session.split(";")[0]! });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { role: string }).role, "driver");
});

test("the level is the bind address unless the operator says otherwise, and a weak one names what is missing", async () => {
  const { resolveExposure } = await import("./exposure.ts");
  const at = (host: string, more: Record<string, unknown> = {}) => resolveExposure({ host, port: 7777, ...more });

  assert.deepEqual(at("127.0.0.1"), { level: "local", source: "derived", secureCookies: false, hsts: false, behindGateway: false, notes: [] });
  assert.equal(at("127.0.0.1", { publicUrl: "https://box.example.test" }).level, "local", "a loopback bind is never moved off local by what else is set");
  assert.equal(at("127.0.0.1", { publicUrl: "https://box.example.test" }).secureCookies, true, "and keeps the Secure cookie an https address always gave it");

  // Other machines can reach it: private, never local by silence, and not started weaker than that.
  assert.throws(() => at("0.0.0.0"), error => /exposure level is private/.test(String(error)) && /AGENTBOX_PUBLIC_URL=https:\/\//.test(String(error)) && /AGENTBOX_EXPOSURE=local/.test(String(error)));
  assert.throws(() => at("0.0.0.0", { insecure: true }), /AGENTBOX_INSECURE=1 no longer starts/, "what used to wave a plain-HTTP server through says so");
  assert.throws(() => at("0.0.0.0", { publicUrl: "http://box.example.test" }), /AGENTBOX_PUBLIC_URL is http:\/\/box\.example\.test/);
  assert.throws(() => at("127.0.0.1", { declared: "private" }), /AGENTBOX_EXPOSURE=private.*HTTPS/, "a proxy on the same machine, declared, is held to it too");
  assert.throws(() => at("0.0.0.0", { publicUrl: "https://box.example.test", noToken: true }), /AGENTBOX_NO_TOKEN=1/);
  assert.throws(() => at("0.0.0.0", { declared: "lan" }), /one of local, private, public/);

  const behindTls = at("0.0.0.0", { publicUrl: "https://box.example.test" });
  assert.deepEqual([behindTls.level, behindTls.source, behindTls.secureCookies, behindTls.hsts], ["private", "derived", true, true]);
  assert.equal(at("0.0.0.0", { declared: "public", publicUrl: "https://box.example.test" }).level, "public");

  // The operator's statement that only this machine reaches a wide bind: it starts, and says what was claimed, every time.
  const claimed = at("0.0.0.0", { declared: "local", insecure: true });
  assert.equal(claimed.level, "local");
  assert.match(claimed.notes.join("\n"), /only this machine reaches the port/);

  // A tenant's box behind the control plane's gateway: the hop is plain HTTP inside the cluster and nobody's door.
  const tenant = at("0.0.0.0", { behindGateway: true, insecure: true });
  assert.deepEqual([tenant.level, tenant.hsts, tenant.behindGateway], ["private", false, true]);
});

test("private: HTTPS or no start, Secure cookies and HSTS, and the installation token is a machine's, never a person's way in", async t => {
  const { startWebServer } = await import("./server.ts");
  const refusedHome = mkdtempSync(join(tmpdir(), "agentbox-exposure-"));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { AGENTBOX_HOME: refusedHome, AGENTBOX_INSECURE: "1" });
  try {
    await assert.rejects(() => startWebServer({ port: 0, host: "0.0.0.0", token: "t0k", useBox: false, onLog: () => {} }), /Refusing to serve 0\.0\.0\.0:0 without TLS.*AGENTBOX_PUBLIC_URL=https/, "a published server with no HTTPS in front does not start");
  } finally { restore(); rmSync(refusedHome, { recursive: true, force: true }); }

  const TOKEN = "0rganisation-t0ken";
  const { get, signIn, logs } = await serve(t, { host: "0.0.0.0", token: TOKEN }, { AGENTBOX_PUBLIC_URL: "https://box.example.test" });
  // Whatever arrives through the TLS terminator carries its headers; the CLI in the pod does not.
  const proxied = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };
  const code = async (response: Response) => (await response.json() as { code?: string }).code;

  const nobody = await get("/api/me", proxied);
  assert.equal(nobody.status, 401);
  assert.equal(nobody.headers.get("strict-transport-security"), "max-age=31536000", "every response says HSTS");
  assert.equal(await code(nobody), "sign-in-needed", "and the way in is to sign in, not a token");

  const inAddress = await get(`/?token=${TOKEN}`, proxied);
  assert.equal(inAddress.status, 401, "the right token in an address opens nothing");
  assert.equal(inAddress.headers.get("set-cookie"), null, "and is not turned into a cookie");
  assert.equal(await code(await get(`/api/me?token=${TOKEN}`, proxied)), "token-in-address");
  assert.equal((await get("/api/me", { ...proxied, cookie: `agentbox_ui=${TOKEN}` })).status, 401, "a cookie kept from before is not a credential");
  const remoteBearer = await get("/api/me", { ...proxied, authorization: `Bearer ${TOKEN}` });
  assert.equal(remoteBearer.status, 401, "the token from another machine is not a person signing in");
  assert.equal(await code(remoteBearer), "token-not-here");

  // The machine caller that remains on this server: the CLI beside it, a direct loopback connection.
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}` })).status, 200);
  assert.equal((await get("/api/me", { authorization: "Bearer wrong" })).status, 401);

  // A person, invited by that CLI, signs in as themselves and is who the roster says.
  const session = await signIn("Ana", "driver", { authorization: `Bearer ${TOKEN}` });
  assert.match(session, /^agentbox_who=[^;]+; Path=\/; Secure; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
  const cookie = session.split(";")[0]!;
  const me = await get("/api/me", { ...proxied, cookie });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { role: string }).role, "driver");
  assert.equal((await get(`/api/me?token=${TOKEN}`, { ...proxied, cookie })).status, 401, "a token in the address is refused even from somebody signed in");

  assert.ok(logs.some(line => /exposure private \(derived\)/.test(line)), "the level is said at start");
  assert.ok(logs.every(line => !line.includes(TOKEN)));
});

test("a tenant's box behind the control plane's gateway still answers the gateway, and only as the gateway presents itself", async t => {
  const { SqliteControlStore } = await import("../control/store.ts");
  const { StaticAllocator } = await import("../control/allocator.ts");
  const { Gateway, PasswordListIdentity } = await import("../control/gateway.ts");
  const { createServer } = await import("node:http");
  const TOKEN = "tenant-b0x-t0ken";
  // What the Kubernetes allocator gives a tenant's pod (src/control/kubernetes.ts): a wide bind, plain HTTP for the one hop, the gateway believed.
  const box = await serve(t, { host: "0.0.0.0", token: TOKEN }, { AGENTBOX_INSECURE: "1", AGENTBOX_TRUST_GATEWAY_IDENTITY: "1" });

  const dir = mkdtempSync(join(tmpdir(), "agentbox-exposure-gateway-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const gateway = new Gateway({
    store, allocator: new StaticAllocator(store, { boxdUrl: "http://127.0.0.1:1", uiUrl: box.base, tokens: { box: "unused", ui: TOKEN } }),
    identity: PasswordListIdentity.parse("alice:secret:acme"), sessionSecret: Buffer.from("b".repeat(32)), image: "agentbox/box:test", secureCookies: true, hsts: true,
  });
  const front = createServer((req, res) => { void gateway.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));
  t.after(() => { front.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(front.address() as { port: number }).port}`;

  const signIn = await fetch(`${url}/gateway/login`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "secret" }), redirect: "manual" });
  assert.equal(signIn.status, 302);
  assert.match(signIn.headers.get("set-cookie") ?? "", /; Secure$/, "the gateway is the door, and its session cookie is Secure");
  assert.equal(signIn.headers.get("strict-transport-security"), "max-age=31536000");
  const session = (signIn.headers.get("set-cookie") ?? "").split(";")[0]!;

  // A browser's request, as a TLS terminator in front of the gateway hands it over, reaches the box's API.
  const through = await fetch(`${url}/api/me`, { headers: { cookie: session, "x-forwarded-for": "203.0.113.9" } });
  assert.equal(through.status, 200, "the gateway's bearer header and identity headers open the tenant's box");

  // Reaching the pod without the gateway's header opens nothing, however the token is offered.
  assert.equal((await box.get(`/api/me?token=${TOKEN}`)).status, 401);
  assert.equal((await box.get("/api/me", { cookie: `agentbox_ui=${TOKEN}` })).status, 401);
  assert.equal((await box.get("/api/me")).status, 401);
});

test("the organisation manifest starts with the settings it ships, and the control plane's refuses the same weakness", async t => {
  const { readFileSync } = await import("node:fs");
  const manifest = readFileSync(new URL("../../deploy/kubernetes/organisation.yaml", import.meta.url), "utf8");
  const value = (name: string) => new RegExp(`- name: ${name}\\n\\s+value: "?([^"\\n]+)"?`).exec(manifest)?.[1];
  const host = /- --host\n\s+- (\S+)/.exec(manifest)?.[1];
  assert.equal(host, "0.0.0.0");
  assert.equal(value("AGENTBOX_EXPOSURE"), "private", "the level is written down, not left to the bind address");
  const publicUrl = value("AGENTBOX_PUBLIC_URL");
  assert.match(publicUrl ?? "", /^https:\/\//, "and the address people open is https");
  const server = await serve(t, { host: host! }, { AGENTBOX_EXPOSURE: value("AGENTBOX_EXPOSURE")!, AGENTBOX_PUBLIC_URL: publicUrl! });
  assert.equal((await server.get("/login")).status, 200, "it starts, and the sign-in page is there");
  const bootstrap = await server.get("/bootstrap?lang=en", { "x-forwarded-for": "203.0.113.9" });
  assert.equal(bootstrap.headers.get("strict-transport-security"), "max-age=31536000");
  // The first Admin's page asks for what the manifest's Secret holds, and for no page opened with a token (INV-2227).
  const page = await bootstrap.text();
  for (const name of ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET"]) {
    assert.ok(page.includes(`<code>${name}</code>`) && manifest.includes(name), `the page asks for ${name}, and the manifest's Secret has it`);
  }
  assert.ok(page.includes(`${publicUrl}/auth/dingtalk/callback`), "with the callback address at the manifest's public address");
  assert.doesNotMatch(page, /token/i);

  const { startControlPlane } = await import("../control/main.ts");
  const home = mkdtempSync(join(tmpdir(), "agentbox-exposure-control-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  await assert.rejects(
    () => startControlPlane({ port: 0, host: "0.0.0.0", allocator: "static", image: "agentbox/box:test", statePath: home, sweepSeconds: 0 }),
    /Refusing to serve 0\.0\.0\.0:0 without TLS/,
    "the gateway on every interface with no HTTPS in front does not start"
  );
});
