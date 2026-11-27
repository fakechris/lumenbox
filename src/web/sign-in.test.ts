import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { SESSION_COOKIE } from "./session.ts";
import { invitationLink, loginPageWithDoors, SIGN_IN_DOORS_MARKER, webSignInDoors } from "./sign-in.ts";

const orgs = createRequire(import.meta.url)("../../electron/organisations.cjs") as {
  parseOrganisationAddress(input: string): { origin: string; code?: string };
  readOrganisation(origin: string, token: string): Promise<{ identity: string; name: string; role: string }>;
  sessionTokenIn(cookies: { name: string; value: string }[]): string | undefined;
};
const { allowedRequest } = createRequire(import.meta.url)("../../electron/installations.cjs") as {
  allowedRequest(url: string, origin: string): boolean;
};

test("a door is offered only for a Feishu or DingTalk channel with its app set on an installation with a public address; an invite link needs that address too (INV-1701, INV-729)", () => {
  const records = [
    { id: "feishu", name: "Feishu", type: "feishu" },
    { id: "feishu-b", name: "", type: "feishu" },
    { id: "ding", name: "DingTalk", type: "dingtalk" },
    { id: "telegram", name: "Telegram", type: "telegram" },
  ];
  const set = (record: { id: string }) => record.id !== "feishu-b";
  assert.deepEqual(webSignInDoors(records, set, "https://org.example"), [{ id: "feishu", name: "Feishu", type: "feishu" }, { id: "ding", name: "DingTalk", type: "dingtalk" }]);
  assert.deepEqual(webSignInDoors(records, () => true, "https://org.example").map(door => door.name), ["Feishu", "feishu-b", "DingTalk"], "no name: the id; no web sign-in for Telegram");
  assert.deepEqual(webSignInDoors(records, () => true, undefined), [], "the vendor has nowhere to send the person back to");
  const page = `<p>${SIGN_IN_DOORS_MARKER}</p>`;
  assert.equal(loginPageWithDoors(page, [], "en"), "<p></p>");
  const doors = loginPageWithDoors(page, [{ id: "a&b", name: "<Acme>", type: "feishu" }], "en");
  assert.match(doors, /href="\/auth\/a%26b"/);
  assert.match(doors, /Sign in with &lt;Acme&gt;/);
  assert.match(loginPageWithDoors(page, [{ id: "feishu", name: "飞书", type: "feishu" }], "zh"), /用 飞书 登录/);
  assert.deepEqual(invitationLink("https://org.example/", "4F7KQZ"), { link: "https://org.example/login?code=4F7KQZ" });
  assert.deepEqual(invitationLink(undefined, "4F7KQZ"), { linkUnavailable: "public-url-unset" });
  assert.deepEqual(invitationLink(" ", "4F7KQZ"), { linkUnavailable: "public-url-unset" });
});

test("an organisation's /login offers its Feishu door; the door's sign-in gives a known person the session the app reads, a stranger the waiting page; the invite comes as a link (INV-1701)", async t => {
  const home = mkdtempSync(join(tmpdir(), "inv1701-sign-in-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  const publicUrl = "https://org.example";
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = publicUrl;
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "fixture", name: "Fixture", type: "feishu", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ env: { FIXTURE_APP_ID: "app", FIXTURE_APP_SECRET: "secret" } }));
  const secondAdmin = { id: "p-bao", name: "Bao", role: "admin", identities: ["fixture:ou_bao"] };
  writeFileSync(join(home, "principals.json"), JSON.stringify({
    principals: [{ id: "p-ana", name: "Ana", role: "admin", identities: ["fixture:ou_ana"] }, secondAdmin],
    installation: { mode: "organisation" },
  }));
  // The vendor, faked: the authorization code is the open_id it vouches for.
  const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("oauth/token")) return Response.json({ access_token: JSON.parse(String(init!.body)).code });
    const subject = new Headers(init?.headers).get("authorization")!.slice(7);
    return Response.json({ code: 0, data: { open_id: subject, name: subject } });
  }) as typeof fetch;
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch, onLog: () => {}, onReady: url => { base = url; } });

  const login = await (await fetch(`${base}/login?lang=en`)).text();
  const door = /<a class="door"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(login);
  assert.ok(door, "the sign-in page has a door button");
  assert.equal(door[1], "/auth/fixture");
  assert.equal(door[2], "Sign in with Fixture");
  assert.match(login, /id="code"/, "and the invite code beside it");

  const signIn = async (openId: string) => {
    const begin = await fetch(base + door[1], { redirect: "manual" });
    assert.equal(begin.status, 302);
    const vendor = new URL(begin.headers.get("location")!);
    assert.equal(allowedRequest(vendor.href, base), false, "the desktop organisation view blocks the Feishu redirect");
    const state = vendor.searchParams.get("state")!;
    // The window that started the sign-in is the one the vendor sends back, with the cookie the entry gave it.
    return fetch(`${base}/auth/fixture/callback?state=${state}&code=${openId}`, { redirect: "manual", headers: { cookie: begin.headers.getSetCookie()[0]!.split(";")[0]! } });
  };
  const known = await signIn("ou_ana");
  assert.equal(known.status, 302);
  const cookies = known.headers.getSetCookie().map(line => { const [pair] = line.split(";"); const at = pair!.indexOf("="); return { name: pair!.slice(0, at), value: pair!.slice(at + 1) }; });
  const token = orgs.sessionTokenIn(cookies);
  assert.ok(token, "the door's sign-in sets the session cookie the app's join window waits for");
  assert.deepEqual(await orgs.readOrganisation(base, token), { identity: "fixture:ou_ana", name: "Ana", role: "admin" }, "and /api/me says who, and as what");

  const html = { accept: "text/html", "accept-language": "en" };
  const checkRecovery = async (path: string, cookie: string, title: RegExp) => {
    const response = await fetch(base + path, { headers: { ...html, cookie } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("content-type")!, /^text\/html/);
    const page = await response.text();
    assert.match(page, title);
    assert.match(page, /href="\/login"/);
    assert.doesNotMatch(page, /\?token=/);
  };
  await checkRecovery("/", "", /Sign in to LumenBox/);
  await checkRecovery("/?view=settings", `${SESSION_COOKIE}=stale`, /Your session expired/);
  const desktopRecovery = await fetch(base + "/", {
    headers: { ...html, cookie: `${SESSION_COOKIE}=stale`, "user-agent": "Electron/38.0.0 LumenBoxOrgView/1" },
  });
  assert.equal(desktopRecovery.status, 401);
  const desktopPage = await desktopRecovery.text();
  assert.match(desktopPage, /Your session expired[\s\S]*Settings → Organisations[\s\S]*rejoin using its address or a fresh invite link/);
  assert.doesNotMatch(desktopPage, /href="\/login"|\?token=/);
  const expiredTarget = "/auth/fixture/callback?state=stale&code=stale";
  const expired = await fetch(base + expiredTarget, { headers: html });
  assert.equal(expired.status, 400);
  assert.match(await expired.text(), /Your sign-in QR code expired[\s\S]*href="\/login"/);
  const expiredApi = await fetch(base + expiredTarget);
  assert.equal(expiredApi.status, 400);
  assert.equal((await expiredApi.json()).code, "sign-in-expired");
  const removed = await fetch(base + "/api/principals/remove", {
    method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ principalId: "p-ana" }),
  });
  assert.equal(removed.status, 200);
  const cookie = known.headers.getSetCookie()[0]!.split(";")[0]!;
  await checkRecovery("/", cookie, /Your access was removed/);
  const deniedApi = await fetch(base + "/api/me", { headers: { ...html, cookie } });
  assert.equal(deniedApi.status, 401);
  assert.match(deniedApi.headers.get("content-type")!, /^application\/json/);

  const stranger = await signIn("ou_stranger");
  assert.equal(stranger.status, 403, "somebody nobody linked or activated has asked to join");
  assert.equal(stranger.headers.getSetCookie().length, 0, "and gets no session");

  const invite = async () => (await fetch(`${base}/api/channels/invite`, { method: "POST", headers: { authorization: "Bearer fixture", "content-type": "application/json" }, body: JSON.stringify({ role: "driver" }) })).json() as Promise<{ code: string; link?: string; linkUnavailable?: string }>;
  const withLink = await invite();
  assert.equal(withLink.link, `${publicUrl}/login?code=${withLink.code}`);
  assert.deepEqual(orgs.parseOrganisationAddress(withLink.link), { origin: publicUrl, code: withLink.code }, "the app takes the link as pasted");

  delete process.env.AGENTBOX_PUBLIC_URL;
  assert.doesNotMatch(await (await fetch(`${base}/login?lang=en`)).text(), /class="door"|sign-in-doors/, "no public address: the code form alone");
  const withoutLink = await invite();
  assert.equal(withoutLink.link, undefined);
  assert.equal(withoutLink.linkUnavailable, "public-url-unset");
});

test("a DingTalk door signs in the organisation's employee as the identity their chat messages carry; a stranger, an outsider and a stale state get no session (INV-729)", async t => {
  const home = mkdtempSync(join(tmpdir(), "inv729-dingtalk-sign-in-"));
  const previousHome = process.env.AGENTBOX_HOME, previousUrl = process.env.AGENTBOX_PUBLIC_URL;
  process.env.AGENTBOX_HOME = home; process.env.AGENTBOX_PUBLIC_URL = "https://org.example";
  let stop: (() => void) | undefined;
  t.after(() => {
    stop?.();
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    if (previousUrl === undefined) delete process.env.AGENTBOX_PUBLIC_URL; else process.env.AGENTBOX_PUBLIC_URL = previousUrl;
    rmSync(home, { recursive: true, force: true });
  });
  writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "ding", name: "DingTalk", type: "dingtalk", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
  writeFileSync(join(home, "config.json"), JSON.stringify({ env: { DING_CLIENT_ID: "ding-app", DING_CLIENT_SECRET: "secret" } }));
  // The chat side names a person `<door>:<senderStaffId>` — the organisation's userid — so that is
  // what Ana's Principal was linked as, and what the web sign-in must arrive at.
  writeFileSync(join(home, "principals.json"), JSON.stringify({
    principals: [{ id: "p-ana", name: "Ana", role: "admin", identities: ["ding:ana-staff"] }],
    installation: { mode: "organisation" },
  }));
  // DingTalk, faked: the authorization code is the unionId it vouches for; the organisation knows
  // Ana and Bob as employees and Eve as an external contact, and nobody else.
  const employees: Record<string, { userid: string; contact_type: number }> = {
    "union-ana": { userid: "ana-staff", contact_type: 0 }, "union-bob": { userid: "bob-staff", contact_type: 0 }, "union-eve": { userid: "eve-ext", contact_type: 1 },
  };
  const lookups: { token: string | null; unionid: string }[] = [];
  const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/userAccessToken") {
      assert.deepEqual({ clientId: body.clientId, grantType: body.grantType }, { clientId: "ding-app", grantType: "authorization_code" });
      return Response.json({ accessToken: body.code, refreshToken: "r", expireIn: 7200 });
    }
    if (url.href === "https://api.dingtalk.com/v1.0/contact/users/me") {
      const unionId = new Headers(init?.headers).get("x-acs-dingtalk-access-token")!;
      return Response.json({ unionId, openId: `open-${unionId}`, nick: unionId });
    }
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "app-token", expireIn: 7200 });
    if (url.origin + url.pathname === "https://oapi.dingtalk.com/topapi/user/getbyunionid") {
      lookups.push({ token: url.searchParams.get("access_token"), unionid: body.unionid });
      const found = employees[body.unionid];
      return Response.json(found ? { errcode: 0, errmsg: "ok", result: found } : { errcode: 60121, errmsg: "未找到对应员工" });
    }
    throw new Error(`unexpected vendor call ${url.href}`);
  }) as typeof fetch;
  let base = "";
  stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "fixture", useBox: false, loginFetch, onLog: () => {}, onReady: url => { base = url; } });

  const login = await (await fetch(`${base}/login?lang=en`)).text();
  assert.match(login, /<a class="door"[^>]*href="\/auth\/ding"[^>]*>Sign in with DingTalk<\/a>/, "/login offers the DingTalk door");

  // One browser: what the entry sets, the callback presents (the app's sign-in window keeps one cookie jar for both).
  let browser = "";
  const begin = async (next?: string) => {
    const response = await fetch(`${base}/auth/ding${next === undefined ? "" : `?next=${encodeURIComponent(next)}`}`, { redirect: "manual", headers: browser === "" ? {} : { cookie: browser } });
    assert.equal(response.status, 302);
    const bound = response.headers.getSetCookie()[0]!;
    assert.match(bound, /^agentbox_signin=[0-9a-f]{32}; Path=\/auth; Secure; Max-Age=600; HttpOnly; SameSite=Lax$/, "the entry ties the sign-in to this browser, over https only");
    if (browser !== "") assert.equal(bound.split(";")[0], browser, "a browser that already holds one keeps it, so two tabs do not undo each other");
    browser = bound.split(";")[0]!;
    const vendor = new URL(response.headers.get("location")!);
    assert.equal(vendor.origin + vendor.pathname, "https://login.dingtalk.com/oauth2/auth");
    assert.deepEqual(
      ["client_id", "response_type", "scope", "prompt", "redirect_uri"].map(key => vendor.searchParams.get(key)),
      ["ding-app", "code", "openid", "consent", "https://org.example/auth/ding/callback"],
    );
    return vendor.searchParams.get("state")!;
  };
  // DingTalk returns the code as both `code` and `authCode`.
  const callback = (state: string, unionId: string) =>
    fetch(`${base}/auth/ding/callback?state=${state}&code=${unionId}&authCode=${unionId}`, { redirect: "manual", headers: { "accept-language": "en", cookie: `pref=100%; ${browser}` } }); // beside a cookie of somebody else's that does not decode

  const known = await callback(await begin("/?view=settings"), "union-ana");
  assert.equal(known.status, 302);
  assert.equal(known.headers.get("location"), "/?view=settings", "back where they were going");
  assert.deepEqual(lookups.at(-1), { token: "app-token", unionid: "union-ana" }, "the unionId is mapped by the app's own organisation");
  const cookies = known.headers.getSetCookie().map(line => { const [pair] = line.split(";"); const at = pair!.indexOf("="); return { name: pair!.slice(0, at), value: pair!.slice(at + 1) }; });
  const token = orgs.sessionTokenIn(cookies);
  assert.ok(token, "a linked employee gets the session");
  assert.deepEqual(await orgs.readOrganisation(base, token), { identity: "ding:ana-staff", name: "Ana", role: "admin" }, "as the identity the DingTalk chat mints");

  const offSite = await callback(await begin("https://evil.example/steal"), "union-ana");
  assert.equal(offSite.headers.get("location"), "/", "a return address off this origin goes through safeNext to /");

  const stranger = await callback(await begin(), "union-bob");
  assert.equal(stranger.status, 403, "an employee nobody linked is refused");
  assert.equal(stranger.headers.getSetCookie().length, 0);
  const strangerPage = await stranger.text();
  assert.match(strangerPage, /Your request to join is with the Admins[\s\S]*signed in with DingTalk as union-bob[\s\S]*Once an Admin activates you/, "and told their request waits for an Admin (INV-2202)");

  for (const unionId of ["union-nobody", "union-eve"]) {
    const outsider = await callback(await begin(), unionId);
    assert.equal(outsider.status, 403, `${unionId}: not a member of the door's organisation`);
    assert.equal(outsider.headers.getSetCookie().length, 0);
    assert.match(await outsider.text(), /not a member of this channel&#39;s organisation/);
  }

  const forged = await fetch(`${base}/auth/ding/callback?state=forged&code=union-ana`, { redirect: "manual" });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).code, "sign-in-expired", "a state this server never issued is refused");
  // A finished link handed to somebody else: their browser did not start it, so it signs nobody in — and the state is spent (INV-2204).
  for (const other of [undefined, `agentbox_signin=${"0".repeat(32)}`]) {
    const handed = await fetch(`${base}/auth/ding/callback?state=${await begin()}&code=union-ana`, { redirect: "manual", ...(other !== undefined ? { headers: { cookie: other } } : {}) });
    assert.equal(handed.status, 400);
    assert.equal(handed.headers.getSetCookie().length, 0);
    assert.equal((await handed.json()).code, "sign-in-expired");
  }
  const replayState = await begin();
  assert.equal((await callback(replayState, "union-ana")).status, 302);
  assert.equal((await callback(replayState, "union-ana")).status, 400, "a state is used once");

  const late = await begin();
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60_000 });
  const expired = await callback(late, "union-ana");
  t.mock.timers.reset();
  assert.equal(expired.status, 400, "a state older than ten minutes is refused");
  assert.equal(expired.headers.getSetCookie().length, 0);
  assert.equal((await expired.json()).code, "sign-in-expired");
});
