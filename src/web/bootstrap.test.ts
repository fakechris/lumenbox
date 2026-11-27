import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
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
    assert.match(page, /pane=doors[\s\S]+Add channel[\s\S]+OAuth callback URL[\s\S]+scan the QR code[\s\S]+<button name="door" value="fixture">Sign in with Feishu<\/button>/, "local: the token still opens the settings, and the channel is named by its type");
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
    const begin = async (bootstrapCode: string) => fetch(base + "/auth/fixture", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bootstrapCode, identity: "attacker:chosen", role: "admin" }), redirect: "manual" });
    assert.equal((await begin("wrong")).status, 400);
    const refusedStart = await begin(code);
    const refusedData = await refusedStart.json() as { url: string };
    const refusedState = new URL(refusedData.url).searchParams.get("state")!;
    vendorCode = 999;
    assert.equal((await fetch(base + `/auth/fixture/callback?state=${refusedState}&code=not-authenticated`, { redirect: "manual" })).status, 502);
    assert.equal(new Principals().list().length, 0, "vendor error cannot create an admin or consume the bootstrap");
    vendorCode = 0;
    const states: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = await begin(code); assert.equal(response.status, 200);
      const data = await response.json() as { url: string };
      assert.equal(data.url.includes(code), false);
      states.push(new URL(data.url).searchParams.get("state")!);
    }
    const results = await Promise.all(states.map((state, i) => fetch(base + `/auth/fixture/callback?state=${state}&code=person${i}`, { redirect: "manual" })));
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
  assert.match(zh, /<button[^>]*value="dingtalk"[^>]*>用钉钉登录<\/button>/, "the DingTalk channel the environment set up, named by its type");
  assert.doesNotMatch(zh, /token|pane=doors|飞书/i, "no page opened with a token, and no channel that cannot sign in");
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
    assert.match(page, words);
    for (const name of ["DINGTALK_CLIENT_ID", "DINGTALK_CLIENT_SECRET", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "https://org.example.test/auth/dingtalk/callback", "https://org.example.test/auth/feishu/callback"]) {
      assert.ok(page.includes(name), `${lang}: the page names ${name}`);
    }
    assert.doesNotMatch(page, /token|pane=doors|<button|REPLACE_WITH_PUBLIC_HOST/i, `${lang}: no token page, no dead button, and no placeholder warning when public URL is real`);
  }
  const placeholder = await fresh({ AGENTBOX_PUBLIC_URL: "https://REPLACE_WITH_PUBLIC_HOST" });
  const placeholderPage = await (await fetch(`${placeholder.base}/bootstrap?lang=en`, { headers: browser })).text();
  assert.match(placeholderPage, /REPLACE_WITH_PUBLIC_HOST[\s\S]*real public HTTPS address/, "warns when manifest placeholder host has not been replaced");
  assert.doesNotMatch(placeholderPage, /token/i);
});
