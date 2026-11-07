import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startWebServer } from "./server.ts";
import { invitationLink, loginPageWithDoors, SIGN_IN_DOORS_MARKER, webSignInDoors } from "./sign-in.ts";

const orgs = createRequire(import.meta.url)("../../electron/organisations.cjs") as {
  parseOrganisationAddress(input: string): { origin: string; code?: string };
  readOrganisation(origin: string, token: string): Promise<{ identity: string; name: string; role: string }>;
  sessionTokenIn(cookies: { name: string; value: string }[]): string | undefined;
};

test("a door is offered only for a Feishu channel with its app set on an installation with a public address; an invite link needs that address too (INV-1701)", () => {
  const records = [
    { id: "feishu", name: "Feishu", type: "feishu" },
    { id: "feishu-b", name: "", type: "feishu" },
    { id: "ding", name: "DingTalk", type: "dingtalk" },
  ];
  const set = (record: { id: string }) => record.id !== "feishu-b";
  assert.deepEqual(webSignInDoors(records, set, "https://org.example"), [{ id: "feishu", name: "Feishu" }]);
  assert.deepEqual(webSignInDoors(records, () => true, "https://org.example").map(door => door.name), ["Feishu", "feishu-b"], "no name: the id");
  assert.deepEqual(webSignInDoors(records, () => true, undefined), [], "the vendor has nowhere to send the person back to");
  const page = `<p>${SIGN_IN_DOORS_MARKER}</p>`;
  assert.equal(loginPageWithDoors(page, [], "en"), "<p></p>");
  const doors = loginPageWithDoors(page, [{ id: "a&b", name: "<Acme>" }], "en");
  assert.match(doors, /href="\/auth\/a%26b"/);
  assert.match(doors, /Sign in with &lt;Acme&gt;/);
  assert.match(loginPageWithDoors(page, [{ id: "feishu", name: "飞书" }], "zh"), /用 飞书 登录/);
  assert.deepEqual(invitationLink("https://org.example/", "4F7KQZ"), { link: "https://org.example/login?code=4F7KQZ" });
  assert.deepEqual(invitationLink(undefined, "4F7KQZ"), { linkUnavailable: "public-url-unset" });
  assert.deepEqual(invitationLink(" ", "4F7KQZ"), { linkUnavailable: "public-url-unset" });
});

test("an organisation's /login offers its Feishu door; the door's sign-in gives a known person the session the app reads, a stranger the knock page; the invite comes as a link (INV-1701)", async t => {
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
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [{ id: "p-ana", name: "Ana", role: "admin", identities: ["fixture:ou_ana"] }], installation: { mode: "organisation" } }));
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
    const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
    return fetch(`${base}/auth/fixture/callback?state=${state}&code=${openId}`, { redirect: "manual" });
  };
  const known = await signIn("ou_ana");
  assert.equal(known.status, 302);
  const cookies = known.headers.getSetCookie().map(line => { const [pair] = line.split(";"); const at = pair!.indexOf("="); return { name: pair!.slice(0, at), value: pair!.slice(at + 1) }; });
  const token = orgs.sessionTokenIn(cookies);
  assert.ok(token, "the door's sign-in sets the session cookie the app's join window waits for");
  assert.deepEqual(await orgs.readOrganisation(base, token), { identity: "fixture:ou_ana", name: "Ana", role: "admin" }, "and /api/me says who, and as what");

  const stranger = await signIn("ou_stranger");
  assert.equal(stranger.status, 403, "somebody nobody linked is told how to knock");
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
