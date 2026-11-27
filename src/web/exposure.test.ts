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

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_TRUSTED_PROXIES", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_INSECURE", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUST_GATEWAY_IDENTITY"] as const;
type Env = Partial<Record<(typeof KEYS)[number], string>>;
const ORIGINAL = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const restore = () => { for (const key of KEYS) { if (ORIGINAL[key] === undefined) delete process.env[key]; else process.env[key] = ORIGINAL[key]; } };

/** A real server on a temporary home with exactly `env` of the settings a level is read from; an organisation's roster, so people can be invited. */
async function serve(t: TestContext, options: { host?: string; token?: string; prepare?: (home: string) => void; loginFetch?: typeof fetch }, env: Env = {}) {
  const { startWebServer } = await import("./server.ts");
  const home = mkdtempSync(join(tmpdir(), "agentbox-exposure-"));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, env, { AGENTBOX_HOME: home });
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
  options.prepare?.(home);
  const logs: string[] = [];
  let base = "";
  let stop: (() => void) | undefined;
  // The settings stay for the test: the server reads some of them on each request.
  t.after(() => { stop?.(); restore(); rmSync(home, { recursive: true, force: true }); });
  stop = await startWebServer({ port: 0, host: options.host ?? "127.0.0.1", ...(options.token !== undefined ? { token: options.token } : {}), useBox: false, ...(options.loginFetch !== undefined ? { loginFetch: options.loginFetch } : {}), onLog: line => logs.push(line), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
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

  // No sign-in limiter on the token at local (INV-2204 part 2 pins this before adding one elsewhere): a wrong token is a 401 however often.
  for (let n = 0; n < 12; n += 1) assert.equal((await get("/api/me", { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}` })).status, 200, "and the right one still opens");
  // The page's own requests carry the address it was loaded from; so do the app's, which loads http://127.0.0.1:<port>/.
  const own = new URL((await get("/login")).url).origin;
  const fromPage = await fetch(`${own}/api/channels/invite`, { method: "POST", headers: { cookie: `agentbox_ui=${TOKEN}`, origin: own, "content-type": "application/json" }, body: JSON.stringify({ role: "viewer" }) });
  assert.equal(fromPage.status, 200);
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

/** The first line of the answer to a socket upgrade — with the refusal's one word after it when asked — or "closed" when the server just hung up. */
async function upgrade(base: string, path: string, headers: Record<string, string>, withReason = false): Promise<string> {
  const { connect } = await import("node:net");
  const { port, hostname } = new URL(base);
  return new Promise(resolve => {
    const socket = connect(Number(port), hostname, () => {
      const lines = Object.entries({ host: `${hostname}:${port}`, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers });
      socket.write(`GET ${path} HTTP/1.1\r\n${lines.map(([name, value]) => `${name}: ${value}`).join("\r\n")}\r\n\r\n`);
    });
    let answer = "";
    socket.on("data", chunk => { answer += String(chunk); socket.destroy(); });
    socket.on("close", () => resolve(answer === "" ? "closed" : withReason ? `${answer.split("\r\n")[0]!} ${answer.split("\r\n\r\n")[1]?.trim() ?? ""}`.trim() : answer.split("\r\n")[0]!));
    socket.on("error", () => resolve("closed"));
  });
}

test("private: every way in waits after a few wrong tries and records them without the credential; a browser's change comes from the installation's own page", async t => {
  const { readFileSync } = await import("node:fs");
  const TOKEN = "0rganisation-t0ken", OURS = "https://box.example.test";
  const { base, home, get, signIn } = await serve(t, {
    host: "0.0.0.0", token: TOKEN,
    // A Feishu door, so the first Admin's code and the sign-in callback have somewhere to be tried.
    prepare: dir => {
      writeFileSync(join(dir, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", name: "Fixture", type: "feishu", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
      writeFileSync(join(dir, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "app", FIXTURE_APP_SECRET: "secret" } }));
    },
  }, { AGENTBOX_PUBLIC_URL: OURS });
  // As the TLS terminator hands a request over: whatever the client claimed, then the address the proxy saw.
  const via = (address: string) => ({ "x-forwarded-for": `198.51.100.250, ${address}`, "x-forwarded-proto": "https" });
  const post = (path: string, body: unknown, headers: Record<string, string>) => fetch(base + path, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  /** Tries until it is told to wait: the statuses of the tries that were looked at, then the refusal. */
  const until429 = async (attempt: () => Promise<Response>) => {
    const looked: number[] = [];
    for (let n = 0; n < 20; n += 1) {
      const response = await attempt();
      if (response.status === 429) return { looked, retryAfter: response.headers.get("retry-after"), code: (await response.json() as { code?: string }).code };
      looked.push(response.status);
    }
    throw new Error(`never limited: ${looked.join(",")}`);
  };
  const limited = (statuses: number[], status: number) => ({ looked: statuses.map(() => status), retryAfter: "2", code: "sign-in-limited" });
  const six = [0, 1, 2, 3, 4, 5];

  // Five free, the sixth starts a wait, and the seventh is refused before it is looked at — with how long.
  assert.deepEqual(await until429(() => post("/api/login", { code: "WRONG1", name: "x" }, via("203.0.113.1"))), limited(six, 400), "an invite code");
  assert.equal((await post("/api/login", { code: "WRONG1", name: "x" }, via("203.0.113.2"))).status, 400, "another address is not held by the first");
  assert.deepEqual(await until429(() => get("/api/me", { ...via("203.0.113.3"), authorization: "Bearer bad-token" })), limited(six, 401), "the installation token");
  assert.equal((await get("/api/me", { authorization: `Bearer ${TOKEN}` })).status, 200, "the CLI on the server is another address, and not waiting");
  assert.deepEqual(await until429(() => get(`/?token=${TOKEN}`, { ...via("203.0.113.9"), accept: "text/html" })), limited(six, 401), "the token in a page's address, which answers with the sign-in page, counts the same");
  assert.deepEqual(await until429(() => post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" }, { ...via("203.0.113.4"), authorization: "Bearer lmbx_bad-token" })), limited(six, 401), "a side-door token");
  assert.deepEqual(await until429(() => get("/auth/fixture/callback?state=forged&code=x", via("203.0.113.5"))), limited(six, 400), "a door's sign-in callback");
  // The first Admin's code is one secret: one address is stopped at its own limit, and many addresses at the code's.
  assert.deepEqual(await until429(() => post("/auth/fixture", { bootstrapCode: "n0t-the-c0de" }, via("203.0.113.6"))), limited(six, 400), "the first Admin's code");
  for (let n = 0; n < 5; n += 1) assert.equal((await post("/auth/fixture", { bootstrapCode: "n0t-the-c0de" }, via("203.0.113.7"))).status, 400);
  assert.equal((await post("/auth/fixture", { bootstrapCode: "n0t-the-c0de" }, via("203.0.113.8"))).status, 429, "an address that never tried waits too: the code itself is being guessed at");

  const record = readFileSync(join(home, "sign-ins.jsonl"), "utf8");
  const lines = record.trim().split("\n").map(line => JSON.parse(line) as { door: string; outcome: string; address: string; account?: string; reason?: string });
  for (const door of ["invite-code", "installation-token", "side-door", "door", "bootstrap"]) {
    assert.ok(lines.some(line => line.door === door && line.outcome === "failed"), `${door}: the wrong tries are recorded`);
    assert.ok(lines.some(line => line.door === door && line.outcome === "limited"), `${door}: and so is the wait`);
  }
  assert.ok(lines.some(line => line.address === "203.0.113.1") && lines.every(line => line.address !== "198.51.100.250"), "by the address the proxy saw, not the one the client claimed");
  assert.ok(lines.every(line => (line as { peer?: string }).peer === "127.0.0.1"), "with the connection's own other end beside it, which is how a forged one shows");
  for (const secret of ["WRONG1", "bad-token", "n0t-the-c0de", TOKEN]) assert.ok(!record.includes(secret), "never what was presented");

  // R5. Ana is signed in; her browser sends her cookie with any request to this address, whoever wrote the page.
  const cookie = (await signIn("Ana", "admin", { authorization: `Bearer ${TOKEN}` })).split(";")[0]!;
  const invite = (headers: Record<string, string>) => post("/api/channels/invite", { role: "viewer" }, { ...via("203.0.113.20"), ...headers });
  const crossSite = await invite({ cookie, origin: "https://evil.example" });
  assert.equal(crossSite.status, 403, "a page on another site cannot spend it");
  assert.equal((await crossSite.json() as { code: string }).code, "cross-origin");
  assert.equal(crossSite.headers.get("access-control-allow-origin"), null, "and no other site is told it may read anything");
  assert.equal((await invite({ cookie, origin: OURS })).status, 200, "her own page can");
  assert.equal((await invite({ cookie, origin: `http://${new URL(base).host}` })).status, 403, "the address behind the proxy is not the one people open");
  assert.equal((await invite({ cookie })).status, 200, "a program with her session names no origin and is not a browser");
  assert.equal((await post("/api/channels/invite", { role: "viewer" }, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status, 200, "a bearer credential is not ambient: exempt");
  assert.notEqual((await post("/hooks/abcdef123456", {}, { ...via("203.0.113.21"), origin: "https://ci.example" })).status, 403, "a webhook answers for itself");
  assert.equal((await post("/api/login", { code: "NOCODE", name: "x" }, { ...via("203.0.113.22"), origin: "https://evil.example" })).status, 403, "signing in is from our own page too");
  assert.equal(await upgrade(base, "/desktop/1/websockify", { cookie, origin: "https://evil.example" }), "HTTP/1.1 403 Forbidden", "nor can another site's page open the desktop's socket");
  assert.equal(await upgrade(base, "/desktop/1/websockify", { cookie, origin: OURS }, true), "HTTP/1.1 403 Forbidden ticket-missing", "her own page's socket gets past that check, to the next one: off local it needs a ticket (desktop-streams.test.ts)");

  const page = await get("/login", via("203.0.113.23"));
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "same-origin");
});

test("local: a page on another site cannot change anything either, and the page carries the same headers", async t => {
  const TOKEN = "l0cal-t0ken";
  const { base, get } = await serve(t, { token: TOKEN });
  const own = new URL(base).origin;
  const invite = (headers: Record<string, string>) => fetch(`${base}/api/channels/invite`, { method: "POST", headers: { cookie: `agentbox_ui=${TOKEN}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ role: "viewer" }) });
  assert.equal((await invite({ origin: "https://evil.example" })).status, 403, "the cookie the app's page holds is not another page's to spend");
  assert.equal((await invite({ origin: "http://127.0.0.1:3000" })).status, 403, "another program's page on this machine is another site");
  assert.equal((await invite({ origin: own })).status, 200);
  assert.equal(await upgrade(base, "/desktop/1/websockify", { cookie: `agentbox_ui=${TOKEN}`, origin: "https://evil.example" }), "HTTP/1.1 403 Forbidden");
  assert.notEqual(await upgrade(base, "/desktop/1/websockify", { cookie: `agentbox_ui=${TOKEN}`, origin: own }), "HTTP/1.1 403 Forbidden");
  assert.match((await get("/login")).headers.get("content-security-policy") ?? "", /object-src 'none'/);
});
