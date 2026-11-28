import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { bootstrapPage, type BootstrapPageInput } from "./server-pages.ts";
import { Principals } from "../host/principals.ts";

test("bootstrap HTTP flow uses only vendor identity, never leaks the code and admits one concurrent callback", async () => {
  const home = mkdtempSync(join(tmpdir(), "bootstrap-http-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = "http://127.0.0.1:7890";
  let stop: (() => void) | undefined;
  const logs: string[] = [];
  let vendorCode = 0;
  try {
    writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", name: "Fixture", type: "feishu", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "app", FIXTURE_APP_SECRET: "secret" } }));
    const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("oauth/token")) return Response.json({ access_token: JSON.parse(String(init!.body)).code });
      const subject = new Headers(init?.headers).get("authorization")!.slice(7);
      return Response.json({ code: vendorCode, data: { open_id: subject, name: subject } });
    }) as typeof fetch;
    let base = "";
    const start = async () => startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch, onLog: line => logs.push(line), onReady: url => { base = url; } });
    stop = await start();
    const setup = async (headers: Record<string, string>) => (await (await fetch(base + "/api/mcp", { headers })).json()).setup;
    assert.deepEqual(await setup({ authorization: "Bearer fixture" }), { admins: 0, bootstrap: true });
    const unauthRoot = await fetch(base + "/?lang=en", { headers: { accept: "text/html" } });
    assert.equal(unauthRoot.status, 401);
    assert.match(await unauthRoot.text(), /href="\/bootstrap">Set up the first administrator/, "landing on / before bootstrap offers the first-Admin setup link");
    assert.match(await (await fetch(base + "/login?lang=en")).text(), /href="\/bootstrap">Set up the first administrator/);
    for (const body of ["{", "null", "[]"]) {
      const malformed = await fetch(base + "/auth/fixture", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(1500) });
      assert.equal(malformed.status, 400);
    }
    const code = readFileSync(join(home, "bootstrap-code"), "utf8").trim();
    assert.equal((await fetch(base + "/bootstrap")).status, 200);
    const page = await (await fetch(base + "/bootstrap?lang=en")).text();
    assert.match(page, /data-step="signin"[\s\S]*<button name="door" value="fixture">Sign in with Feishu<\/button>/, "a channel already set up: the page is the one-use code and that channel");
    assert.doesNotMatch(page, /id="op-unlock"|Add channel|CHANNEL_ID|Action needed|On server|data-step="unlock"/);
    assert.ok(page.includes(join(home, "bootstrap-code")));
    assert.ok(!page.includes(code), "never put the setup code in the page");
    assert.ok(logs.some(line => line.includes(join(home, "bootstrap-code"))));
    const doors = async () => (await (await fetch(base + "/api/channels", { headers: { authorization: "Bearer fixture" } })).json());
    const uninitialized = await doors();
    assert.equal(uninitialized.bootstrapPending, true);
    assert.equal(uninitialized.feishuCallbackTemplate, "http://127.0.0.1:7890/auth/CHANNEL_ID/callback");
    assert.equal(uninitialized.records.find((record: { id: string }) => record.id === "feishu").credentialsSet, false);
    const expired = await fetch(base + "/auth/fixture/callback?state=lost&code=unused&lang=en", { headers: { accept: "text/html" } });
    assert.equal(expired.status, 400);
    assert.match(await expired.text(), /Your sign-in QR code expired[\s\S]+href="\/bootstrap"/);
    const begin = async (bootstrapCode: string, headers: Record<string, string> = {}) => fetch(base + "/auth/fixture", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ bootstrapCode, identity: "attacker:chosen", role: "admin" }), redirect: "manual" });
    assert.equal((await begin("wrong")).status, 400);
    const refusedStart = await begin(code);
    // The first Admin's page asks by fetch, then navigates: the reply's cookie is what the callback must present (INV-2204).
    const browser = { cookie: refusedStart.headers.getSetCookie()[0]!.split(";")[0]! };
    assert.match(browser.cookie, /^agentbox_signin=[0-9a-f]{32}$/);
    const refusedData = await refusedStart.json() as { url: string };
    const refusedState = new URL(refusedData.url).searchParams.get("state")!;
    vendorCode = 999;
    assert.equal((await fetch(base + `/auth/fixture/callback?state=${refusedState}&code=not-authenticated`, { redirect: "manual", headers: browser })).status, 502);
    assert.equal(new Principals().list().length, 0, "vendor error cannot create an admin or consume the bootstrap");
    vendorCode = 0;
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await begin(code, browser); assert.equal(response.status, 200);
      const data = await response.json() as { url: string };
      assert.equal(data.url.includes(code), false);
      states.push(new URL(data.url).searchParams.get("state")!);
    }
    const results = await Promise.all(states.map((state, i) => fetch(base + `/auth/fixture/callback?state=${state}&code=person${i}`, { redirect: "manual", headers: browser })));
    assert.deepEqual(results.map(response => response.status).sort(), [302, 409]);
    const winner = results.find(response => response.status === 302)!;
    const cookie = winner.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    assert.ok(cookie, "bootstrap creates the authenticated admin session");
    assert.deepEqual(await setup({ cookie }), { admins: 1, bootstrap: false });
    assert.equal((await doors()).bootstrapPending, false);
    const issued = await fetch(base + "/api/mcp/tokens", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ label: "first editor" }),
    });
    assert.equal(issued.status, 200);
    assert.ok((await issued.json() as { token: string }).token.startsWith("lmbx_"));
    const tokens = (await (await fetch(base + "/api/mcp", { headers: { cookie } })).json()).tokens;
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].principalId, new Principals().list()[0]!.id, "the token belongs to the redeemed vendor identity");
    const roster = new Principals().list();
    assert.equal(roster.length, 1); assert.match(roster[0]!.id, /^fixture:person[01]$/); assert.equal(roster[0]!.role, "admin");
    assert.equal((await begin(code)).status, 400);
    assert.doesNotMatch(await (await fetch(base + "/?lang=en", { headers: { accept: "text/html" } })).text(), /href="\/bootstrap"/, "once an Admin exists, / no longer offers /bootstrap");
    assert.doesNotMatch(await (await fetch(base + "/login?lang=en")).text(), /href="\/bootstrap"/);
    const stale = await fetch(base + "/bootstrap?lang=en", { headers: { accept: "text/html" } });
    assert.equal(stale.status, 404);
    assert.equal(stale.headers.get("cache-control"), "no-store");
    assert.match(stale.headers.get("content-type")!, /^text\/html/);
    const staleHtml = await stale.text();
    assert.match(staleHtml, /First administrator setup is unavailable[\s\S]+already has an administrator[\s\S]+href="\/login">Go to sign-in/);
    assert.doesNotMatch(staleHtml, /personal desktop installation/, "an organisation server says it already has an admin, not that it is a personal desktop");
    const api = await fetch(base + "/bootstrap", { headers: { accept: "application/json" } });
    assert.equal(api.status, 404);
    assert.equal((await api.json()).code, "bootstrap-unavailable");
    assert.equal(logs.some(line => line.includes(code)), false);
    stop(); stop = await start();
    assert.equal((await fetch(base + "/bootstrap")).status, 404);
    assert.equal((await begin(code)).status, 400);
    writeFileSync(join(home, "principals.json"), "broken");
    assert.equal((await fetch(base + "/bootstrap")).status, 503);
    assert.equal((await begin(code)).status, 503);
    const mcp = await fetch(base + "/api/mcp", { headers: { authorization: "Bearer fixture" } });
    assert.equal(mcp.status, 200, "unreadable bootstrap must not hide MCP settings");
    const settings = await mcp.json();
    assert.equal(settings.setup.bootstrap, false, "a corrupt roster never offers enrollment");
    assert.equal(settings.tokens.length, 1, "existing tokens remain visible");
    assert.ok(Array.isArray(settings.servers), "MCP server data remains available");
  } finally {
    stop?.();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  }
});

test("at the private level the first Admin needs no token anywhere: the environment sets up the DingTalk channel, /bootstrap names it, and the code plus the DingTalk sign-in make the Admin; with nothing set the page says what to set (INV-2227)", async t => {
  const KEYS = ["AGENTBOX_HOME", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_UI_TOKEN", "DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET"] as const;
  const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const homes: string[] = [];
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    for (const key of KEYS) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });
  // A fresh organisation home, and only what the manifest's Secret would put in the environment.
  const fresh = async (env: Partial<Record<(typeof KEYS)[number], string>>, loginFetch?: typeof fetch) => {
    stop?.();
    const home = mkdtempSync(join(tmpdir(), "bootstrap-private-")); homes.push(home);
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_EXPOSURE: "private", AGENTBOX_PUBLIC_URL: "https://org.example.test" }, env);
    writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
    let base = "";
    stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, ...(loginFetch ? { loginFetch } : {}), onLog: () => {}, onReady: url => { base = url; } });
    return { home, base };
  };
  // What a browser across the network looks like once the Ingress hands it over: never the CLI beside the server.
  const browser = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

  const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/userAccessToken") return Response.json({ accessToken: body.code, expireIn: 7200 });
    if (url.href === "https://api.dingtalk.com/v1.0/contact/users/me") return Response.json({ unionId: new Headers(init?.headers).get("x-acs-dingtalk-access-token"), nick: "Ana" });
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "app-token", expireIn: 7200 });
    if (url.origin + url.pathname === "https://oapi.dingtalk.com/topapi/user/getbyunionid") return Response.json({ errcode: 0, errmsg: "ok", result: { userid: "ana-staff", contact_type: 0 } });
    throw new Error(`unexpected vendor call ${url.href}`);
  }) as typeof fetch;
  const { home, base } = await fresh({ DINGTALK_CLIENT_ID: "ding-app", DINGTALK_CLIENT_SECRET: "ding-secret" }, loginFetch);
  const zh = await (await fetch(`${base}/bootstrap?lang=zh`, { headers: browser })).text();
  assert.match(zh, /data-step="signin"[\s\S]*<button[^>]*value="dingtalk"[^>]*>用钉钉登录<\/button>/, "the DingTalk channel the environment set up, named by its type");
  assert.doesNotMatch(zh, /token|pane=doors|飞书|id="op-unlock"|data-step="unlock"/i, "no page opened with a token, and no channel that cannot sign in");
  assert.ok(zh.includes(join(home, "bootstrap-code")), "where the code is");
  const en = await (await fetch(`${base}/bootstrap?lang=en`, { headers: browser })).text();
  assert.match(en, />Sign in with DingTalk<\/button>/);

  // The page's own request, as the browser sends it, and DingTalk's return.
  const code = readFileSync(join(home, "bootstrap-code"), "utf8").trim();
  const begin = await fetch(`${base}/auth/dingtalk`, { method: "POST", headers: { ...browser, "content-type": "application/json", origin: "https://org.example.test" }, body: JSON.stringify({ bootstrapCode: code }) });
  assert.equal(begin.status, 200);
  const carried = begin.headers.getSetCookie().map(line => line.split(";")[0]).join("; "); // whatever binds the sign-in to this browser
  const vendor = new URL((await begin.json() as { url: string }).url);
  assert.equal(vendor.searchParams.get("redirect_uri"), "https://org.example.test/auth/dingtalk/callback");
  const back = await fetch(`${base}/auth/dingtalk/callback?state=${vendor.searchParams.get("state")}&code=union-ana&authCode=union-ana`, { headers: { ...browser, ...(carried ? { cookie: carried } : {}) }, redirect: "manual" });
  assert.equal(back.status, 302);
  const session = back.headers.getSetCookie().find(line => line.startsWith("agentbox_who="));
  assert.match(session ?? "", /; Secure;/, "the Admin's session, Secure at this level");
  const me = await fetch(`${base}/api/me`, { headers: { ...browser, cookie: session!.split(";")[0]! } });
  assert.equal(me.status, 200);
  assert.equal((await me.json() as { role: string }).role, "admin");
  assert.deepEqual(new Principals().list().map(person => [person.id, person.role]), [["dingtalk:ana-staff", "admin"]]);

  // Nothing in the environment: no channel can sign in, and the page says what to set and what to register.
  const empty = await fresh({});
  for (const [lang, words] of [["zh", /部署的 Secret/], ["en", /the deployment&#39;s Secret/]] as const) {
    const page = await (await fetch(`${empty.base}/bootstrap?lang=${lang}`, { headers: browser })).text();
    assert.match(page, /data-step="env"/);
    assert.match(page, words);
    for (const name of ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "https://org.example.test/auth/dingtalk/callback", "https://org.example.test/auth/feishu/callback"]) {
      assert.ok(page.includes(name), `${lang}: the page names ${name}`);
    }
    assert.doesNotMatch(page, /token|pane=doors|<button|id="code"|id="op-unlock"|REPLACE_WITH_PUBLIC_HOST/i, `${lang}: no token page, no dead button, and no placeholder warning when public URL is real`);
  }
  const placeholder = await fresh({ AGENTBOX_PUBLIC_URL: "https://REPLACE_WITH_PUBLIC_HOST" });
  const placeholderPage = await (await fetch(`${placeholder.base}/bootstrap?lang=en`, { headers: browser })).text();
  assert.match(placeholderPage, /REPLACE_WITH_PUBLIC_HOST[\s\S]*real public HTTPS address/, "warns when manifest placeholder host has not been replaced");
  assert.doesNotMatch(placeholderPage, /token/i);
});

test("local port-forward bootstrap breaks the 401 loop: operator unlock opens Settings -> Channels, saves publicUrl + credentials, and private exposure refuses operator unlock (INV-2260)", async t => {
  const { resetConfigEnvForTests } = await import("../config.ts");
  const KEYS = ["AGENTBOX_HOME", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_UI_TOKEN"] as const;
  const original = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  const homes: string[] = [];
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    resetConfigEnvForTests();
    for (const key of KEYS) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  });

  const home = mkdtempSync(join(tmpdir(), "bootstrap-local-pf-")); homes.push(home);
  for (const key of KEYS) delete process.env[key];
  resetConfigEnvForTests();
  Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_EXPOSURE: "local" });
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
  let listenUrl = "";
  stop = await startWebServer({ port: 0, host: "0.0.0.0", useBox: false, onLog: () => {}, onReady: url => { listenUrl = url; } });
  const port = new URL(listenUrl).port;
  const base = `http://127.0.0.1:${port}`;
  const uiCred = readFileSync(join(home, "ui-token"), "utf8").trim();

  // 1. Unauthenticated /bootstrap shows the inline operator unlock form; clicking the channel settings link directly also offers operator unlock (never a dead loop).
  const bootUnauth = await (await fetch(`${base}/bootstrap?lang=en`, { headers: { accept: "text/html" } })).text();
  assert.match(bootUnauth, /data-step="unlock"[\s\S]*id="op-unlock"[\s\S]*data-next="\/bootstrap\?lang=en"/);
  assert.match(bootUnauth, /does not make you an administrator/);
  assert.doesNotMatch(bootUnauth, /data-step="url"|data-step="signin"|id="code"|bootstrap-code|Add channel|CHANNEL_ID|Action needed|On server/);
  const settingsUnauth = await fetch(`${base}/?ui=next&once=1&view=settings&pane=doors&lang=en`, { headers: { accept: "text/html" } });
  assert.equal(settingsUnauth.status, 401);
  const recoveryHtml = await settingsUnauth.text();
  assert.match(recoveryHtml, /id="op-unlock"[\s\S]*data-next="\/\?ui=next&amp;once=1&amp;view=settings&amp;pane=doors&amp;lang=en"/);
  assert.doesNotMatch(recoveryHtml, /\?token=/);

  // 2. Wrong credential fails with 401; correct credential sets HttpOnly cookie and returns safe redirect.
  const wrongUnlock = await fetch(`${base}/api/operator-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "wrong", next: "/?ui=next&once=1&view=settings&pane=doors" }),
  });
  assert.equal(wrongUnlock.status, 401);
  assert.equal((await wrongUnlock.json()).code, "operator-cred-invalid");

  const okUnlock = await fetch(`${base}/api/operator-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: uiCred, next: "/?ui=next&once=1&view=settings&pane=doors" }),
  });
  assert.equal(okUnlock.status, 200);
  const unlockBody = await okUnlock.json() as { ok: boolean; redirect: string };
  assert.equal(unlockBody.redirect, "/?ui=next&once=1&view=settings&pane=doors");
  const opCookie = okUnlock.headers.getSetCookie()[0]!.split(";")[0]!;
  assert.match(opCookie, /^agentbox_ui=/);

  // 3. Evil next URL is neutralized to "/".
  const evilUnlock = await fetch(`${base}/api/operator-session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: uiCred, next: "https://evil.example/steal" }),
  });
  assert.equal(((await evilUnlock.json()) as { redirect: string }).redirect, "/");

  // 4. With opCookie, Settings -> Channels still loads, and /bootstrap moves to the callback address. The operator credential is gone.
  assert.equal((await fetch(`${base}/?ui=next&once=1&view=settings&pane=doors`, { headers: { cookie: opCookie, accept: "text/html" } })).status, 200);
  const bootUrl = await (await fetch(`${base}/bootstrap?lang=en`, { headers: { cookie: opCookie } })).text();
  assert.match(bootUrl, /data-step="url"/);
  assert.match(bootUrl, /Use current origin/);
  assert.match(bootUrl, /DingTalk and Feishu servers cannot call it/);
  assert.doesNotMatch(bootUrl, /id="op-unlock"|id="code"|ui-token|data-step="unlock"/);

  // 5. Save publicUrl via POST /api/channels/public-url, validate bad URL rejection, and verify live propagation to /api/channels and /bootstrap.
  const badUrl = await fetch(`${base}/api/channels/public-url`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: "not-a-url" }),
  });
  assert.equal(badUrl.status, 400);
  assert.equal((await badUrl.json()).code, "public-url-invalid");

  const saveUrl = await fetch(`${base}/api/channels/public-url`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: `${base}/` }),
  });
  assert.equal(saveUrl.status, 200);
  assert.equal(((await saveUrl.json()) as { publicUrl: string }).publicUrl, base);

  const bootVendor = await (await fetch(`${base}/bootstrap?lang=en`, { headers: { cookie: opCookie } })).text();
  assert.match(bootVendor, /data-step="vendor"/);
  assert.match(bootVendor, /href="\/bootstrap\?vendor=dingtalk&amp;lang=en"/);
  assert.doesNotMatch(bootVendor, /id="code"|id="cred-step"|id="op-unlock"/);
  const bootCred = await (await fetch(`${base}/bootstrap?lang=en&vendor=dingtalk`, { headers: { cookie: opCookie } })).text();
  assert.match(bootCred, /data-step="credentials"/);
  assert.ok(bootCred.includes(`${base}/auth/dingtalk/callback`), "the exact callback for the chosen vendor");
  assert.match(bootCred, />Set credentials</);
  assert.doesNotMatch(bootCred, /CHANNEL_ID|id="code"|Add channel|id="op-unlock"/);

  // Partial credential save (only appSecret without appId) is rejected with 400 channel-app-unset.
  const partialDing = await fetch(`${base}/api/channels/records`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "dingtalk", type: "dingtalk", appSecret: "only-secret" }),
  });
  assert.equal(partialDing.status, 400);
  assert.equal((await partialDing.json()).code, "channel-app-unset");

  const saveDing = await fetch(`${base}/api/channels/records`, {
    method: "POST", headers: { cookie: opCookie, "content-type": "application/json" },
    body: JSON.stringify({ id: "dingtalk", type: "dingtalk", name: "DingTalk", appId: "ding-id", appSecret: "ding-secret" }),
  });
  assert.equal(saveDing.status, 200);

  const channelsAfter = await (await fetch(`${base}/api/channels`, { headers: { cookie: opCookie } })).json();
  assert.equal(channelsAfter.publicUrl, base);
  assert.equal(channelsAfter.publicUrlLocked, false);
  assert.equal(channelsAfter.feishuCallbackTemplate, `${base}/auth/CHANNEL_ID/callback`);
  assert.equal(channelsAfter.records.find((r: { id: string }) => r.id === "dingtalk").credentialsSet, true);

  const bootReview = await (await fetch(`${base}/bootstrap?lang=en&review=1`, { headers: { cookie: opCookie } })).text();
  assert.match(bootReview, /data-step="review"/);
  assert.match(bootReview, /id="confirm"/);
  assert.doesNotMatch(bootReview, /id="code"|id="op-unlock"|ui-token|bootstrap-code/);

  const bootReady = await (await fetch(`${base}/bootstrap?lang=en`, { headers: { cookie: opCookie } })).text();
  assert.match(bootReady, /data-step="signin"[\s\S]*>Sign in with DingTalk<\/button>/);
  assert.doesNotMatch(bootReady, /id="op-unlock"|data-step="review"|Add channel|Action needed|On server/);

  // 6. On private exposure, POST /api/operator-session is strictly refused (403 token-not-here) and /api/channels/public-url refuses plain http://.
  stop(); stop = undefined;
  const privHome = mkdtempSync(join(tmpdir(), "bootstrap-priv-lock-")); homes.push(privHome);
  for (const key of KEYS) delete process.env[key];
  resetConfigEnvForTests();
  Object.assign(process.env, { AGENTBOX_HOME: privHome, AGENTBOX_EXPOSURE: "private", AGENTBOX_PUBLIC_URL: "https://org.example.test" });
  writeFileSync(join(privHome, "principals.json"), JSON.stringify({ principals: [], installation: { mode: "organisation" } }));
  let privUrl = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", useBox: false, onLog: () => {}, onReady: url => { privUrl = url; } });
  const privCred = readFileSync(join(privHome, "ui-token"), "utf8").trim();
  const refusedUnlock = await fetch(`${privUrl}/api/operator-session`, {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" },
    body: JSON.stringify({ credential: privCred }),
  });
  assert.equal(refusedUnlock.status, 403);
  assert.equal((await refusedUnlock.json()).code, "token-not-here");

  const lockedUrl = await fetch(`${privUrl}/api/channels/public-url`, {
    method: "POST", headers: { authorization: `Bearer ${privCred}`, "content-type": "application/json" },
    body: JSON.stringify({ publicUrl: "https://other.example.test" }),
  });
  assert.equal(lockedUrl.status, 409);
  assert.equal((await lockedUrl.json()).code, "public-url-from-env");

  const privPage = await (await fetch(`${privUrl}/bootstrap?lang=en`, { headers: { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", accept: "text/html" } })).text();
  assert.match(privPage, /data-step="env"/);
  assert.doesNotMatch(privPage, /id="op-unlock"|id="code"|<button/i);
});

test("the bootstrap wizard renders one step, and never both secrets, even if a caller asks for the operator form off local (INV-2294)", () => {
  const door = { id: "dingtalk", name: "DingTalk", type: "dingtalk" as const };
  const toSet = [
    { id: "dingtalk", type: "dingtalk" as const, keys: { id: "DINGTALK_CLIENT_ID", secret: "DINGTALK_CLIENT_SECRET" }, callback: "https://org.example.test/auth/dingtalk/callback" },
    { id: "feishu", type: "feishu" as const, keys: { id: "FEISHU_APP_ID", secret: "FEISHU_APP_SECRET" }, callback: "https://org.example.test/auth/feishu/callback" },
  ];
  const page = (over: Partial<BootstrapPageInput>): string => bootstrapPage({
    doors: [], toSet, local: true, canEdit: false, locale: "en", codePath: "/state/bootstrap-code",
    operatorUnlock: { credPath: "/state/ui-token", next: "/bootstrap?lang=en" }, ...over,
  });
  const steps = ["unlock", "url", "vendor", "credentials", "review", "signin", "env"];
  const only = (html: string, step: string) => {
    assert.match(html, new RegExp(`data-step="${step}"`));
    for (const other of steps) if (other !== step) assert.equal(html.includes(`data-step="${other}"`), false, other);
  };
  const unlock = page({});
  only(unlock, "unlock");
  assert.match(unlock, /ui-token/);
  assert.doesNotMatch(unlock, /bootstrap-code|id="code"/);

  const url = page({ canEdit: true, operatorUnlock: undefined });
  only(url, "url");
  assert.match(url, /id="url-loopback"/);
  assert.doesNotMatch(url, /id="op-unlock"|id="code"|ui-token/);

  const vendor = page({ canEdit: true, operatorUnlock: undefined, publicUrl: "https://org.example.test" });
  only(vendor, "vendor");
  assert.match(vendor, /vendor=feishu/);
  assert.doesNotMatch(vendor, /id="cred-step"|id="code"/);

  const credentials = page({ canEdit: true, operatorUnlock: undefined, publicUrl: "https://org.example.test", vendor: "feishu" });
  only(credentials, "credentials");
  assert.match(credentials, /https:\/\/org\.example\.test\/auth\/feishu\/callback/);
  assert.match(credentials, />Set credentials</);
  assert.doesNotMatch(credentials, /CHANNEL_ID|Add channel|id="code"/);

  const review = page({
    canEdit: true, operatorUnlock: undefined, publicUrl: "https://org.example.test", review: true, doors: [door],
  });
  only(review, "review");
  assert.match(review, /id="confirm"/);
  assert.match(review, /DingTalk/);
  assert.doesNotMatch(review, /id="code"|ui-token|bootstrap-code|id="op-unlock"/);

  const signin = page({ operatorUnlock: undefined, publicUrl: "https://org.example.test", doors: [door] });
  only(signin, "signin");
  assert.match(signin, /id="code"/);
  assert.match(signin, /bootstrap-code/);
  assert.doesNotMatch(signin, /id="op-unlock"|ui-token|Action needed|On server/);

  const offLocal = page({ local: false, publicUrl: "https://org.example.test" });
  only(offLocal, "env");
  assert.doesNotMatch(offLocal, /id="op-unlock"|id="code"|<button/);
});
