/**
 * The doors' sign-in: the provider-agnostic dance, and the two providers it
 * carries. Feishu is tested first and most thoroughly — it is the door live
 * today — and DingTalk to the same shape, because the point of the design is
 * that the dance cannot tell them apart.
 */

import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { test } from "node:test";
import {
  dingtalkLogin,
  feishuLogin,
  type LoginDeps,
  loginProviders,
  vendorAuth,
} from "./login.ts";

/** A fetch stand-in: scripted responses in order, and a record of every call. */
function scriptedFetch(
  responses: Array<{ status?: number; body: unknown } | Error>,
): { fetchFn: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let index = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses[index++] ?? new Error("unexpected fetch");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** The smallest response recorder the dance writes to. */
interface Recorded {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}
function recorder(): { res: Recorded; asServerResponse: ServerResponse } {
  const res: Recorded = { status: 0, headers: {}, body: "" };
  const asServerResponse = {
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      res.status = status;
      if (headers !== undefined) Object.assign(res.headers, headers);
      return asServerResponse;
    },
    end(chunk?: string) {
      if (chunk !== undefined) res.body += chunk;
      return asServerResponse;
    },
  } as unknown as ServerResponse;
  return { res, asServerResponse };
}

/** Deps with everything a test wants to vary; sensible defaults for the rest. */
function danceDeps(overrides: Partial<LoginDeps> = {}): LoginDeps {
  const known = new Set(["feishu:ou_known"]);
  return {
    doors: () => [
      { id: "feishu", type: "feishu" },
      { id: "dingtalk", type: "dingtalk" },
      { id: "telegram", type: "telegram" },
    ],
    credentials: channelId =>
      channelId === "nocreds" ? undefined : { clientId: `${channelId}-id`, clientSecret: `${channelId}-secret` },
    publicBase: () => "https://box.example.com",
    isKnown: identity => known.has(identity),
    nameOf: () => "Known Person",
    sessionCookie: identity => `session=${identity}`,
    uiTokenCookie: () => "token=abc",
    log: () => {},
    now: () => 1_000_000,
    fetchFn: async () => new Response("{}", { status: 200 }),
    ...overrides,
  };
}

test("the registry carries feishu and dingtalk; telegram is absent on purpose", () => {
  assert.equal(loginProviders.feishu, feishuLogin);
  assert.equal(loginProviders.dingtalk, dingtalkLogin);
  assert.equal(loginProviders.telegram, undefined);
});

// ---------------------------------------------------------------- Feishu first

test("feishu: authorize URL names the app, the redirect, and the state", () => {
  const url = feishuLogin.authorizeUrl({
    clientId: "cli_a",
    redirectUri: "https://box.example.com/auth/feishu/callback",
    state: "st4te",
  });
  assert.equal(
    url,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_a" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fbox.example.com%2Fauth%2Ffeishu%2Fcallback&state=st4te",
  );
});

test("feishu: lark deployments flip hosts wholesale", () => {
  const before = feishuLogin.authorizeUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s" });
  assert.match(before, /^https:\/\/accounts\.feishu\.cn\//);
  process.env.FEISHU_DOMAIN = "lark";
  try {
    const after = feishuLogin.authorizeUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s" });
    assert.match(after, /^https:\/\/accounts\.larksuite\.com\//);
  } finally {
    delete process.env.FEISHU_DOMAIN;
  }
});

test("feishu: the exchange walks token → user_info and returns the open_id", async () => {
  const { fetchFn, calls } = scriptedFetch([
    { body: { access_token: "u-at" } },
    { body: { data: { open_id: "ou_9", name: "Nine" } } },
  ]);
  const subject = await feishuLogin.exchange({
    clientId: "cli",
    clientSecret: "sec",
    code: "the-code",
    redirectUri: "https://box.example.com/auth/feishu/callback",
    fetchFn,
  });
  assert.deepEqual(subject, { vendorSubject: "ou_9", name: "Nine" });
  assert.match(calls[0]!.url, /authen\/v2\/oauth\/token$/);
  const tokenBody = JSON.parse(String(calls[0]!.init?.body));
  assert.deepEqual(tokenBody, {
    grant_type: "authorization_code",
    client_id: "cli",
    client_secret: "sec",
    code: "the-code",
    redirect_uri: "https://box.example.com/auth/feishu/callback",
  });
  assert.match(calls[1]!.url, /authen\/v1\/user_info$/);
  assert.equal((calls[1]!.init!.headers as Record<string, string>).authorization, "Bearer u-at");
});

test("feishu: a refused token says the vendor's words, not just a status", async () => {
  const { fetchFn } = scriptedFetch([
    { status: 400, body: { error_description: "app has no login scope" } },
  ]);
  await assert.rejects(
    feishuLogin.exchange({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://b/cb", fetchFn }),
    /app has no login scope/,
  );
});

test("feishu: user_info without an open_id is an error, not a guess", async () => {
  const { fetchFn } = scriptedFetch([
    { body: { access_token: "t" } },
    { body: { data: {} } },
  ]);
  await assert.rejects(
    feishuLogin.exchange({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://b/cb", fetchFn }),
    /no open_id/,
  );
});

// ----------------------------------------------------------------- The dance

test("the dance: entry hands the browser to the vendor with a state it remembers", async () => {
  const handle = vendorAuth(danceDeps());
  const { res, asServerResponse } = recorder();
  await handle(new URL("https://box.example.com/auth/feishu?next=/desktop/b/box1/1/"), asServerResponse);
  assert.equal(res.status, 302);
  const location = res.headers.location as string;
  assert.match(location, /^https:\/\/accounts\.feishu\.cn\/open-apis\/authen\/v1\/authorize/);
  assert.match(location, /state=[0-9a-f]{32}/);
});

test("the dance: an absolute `next` is not honored — no open redirects", async () => {
  // The entry itself only ever redirects to the vendor, so the guard shows at the
  // callback: a state minted with a hostile next must land on "/" instead.
  const deps = danceDeps({
    credentials: () => ({ clientId: "c", clientSecret: "s" }),
    fetchFn: (async (url: string | URL) => {
      if (String(url).includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response(JSON.stringify({ data: { open_id: "ou_known" } }));
    }) as typeof fetch,
  });
  const handleGuarded = vendorAuth(deps);
  // Capture the state the entry minted for a hostile next by reading it back from
  // the redirect, then redeem it and check where it lands.
  const entry = recorder();
  await handleGuarded(new URL("https://box.example.com/auth/feishu?next=//evil.example.com"), entry.asServerResponse);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  assert.ok(state !== undefined, "entry minted a state");
  const back = recorder();
  await handleGuarded(
    new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`),
    back.asServerResponse,
  );
  assert.equal(back.res.status, 302);
  assert.equal(back.res.headers.location, "/", "a protocol-relative next was not followed");
});

test("the dance: a known Feishu identity gets the session and lands where it was going", async () => {
  const logs: string[] = [];
  const deps = danceDeps({
    log: line => logs.push(line),
    fetchFn: (async (url: string | URL) => {
      if (String(url).includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response(JSON.stringify({ data: { open_id: "ou_known", name: "Nine" } }));
    }) as typeof fetch,
  });
  const handle = vendorAuth(deps);
  const entry = recorder();
  await handle(new URL("https://box.example.com/auth/feishu?next=/some/page"), entry.asServerResponse);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  const back = recorder();
  await handle(new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`), back.asServerResponse);
  assert.equal(back.res.status, 302);
  assert.equal(back.res.headers.location, "/some/page");
  const cookies = back.res.headers["set-cookie"] as string[];
  assert.deepEqual(cookies, ["token=abc", "session=feishu:ou_known"]);
  assert.ok(logs.some(line => line.includes("web login: feishu:ou_known via feishu (Known Person)")));
});

test("the dance: an unlinked identity gets the knock page, never a session", async () => {
  const logs: string[] = [];
  const deps = danceDeps({
    log: line => logs.push(line),
    fetchFn: (async (url: string | URL) => {
      if (String(url).includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response(JSON.stringify({ data: { open_id: "ou_stranger" } }));
    }) as typeof fetch,
  });
  const handle = vendorAuth(deps);
  const entry = recorder();
  await handle(new URL("https://box.example.com/auth/feishu"), entry.asServerResponse);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  const back = recorder();
  await handle(new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`), back.asServerResponse);
  assert.equal(back.res.status, 403);
  assert.match(back.res.body, /还没有链接到本安装/);
  assert.match(back.res.body, /feishu:ou_stranger/);
  assert.ok(!JSON.stringify(back.res.headers).includes("set-cookie"), "no cookie was minted");
  assert.ok(logs.some(line => line.includes("web login refused")));
});

test("the dance: DingTalk signs in by the staffId its messages carry", async () => {
  const deps = danceDeps({
    isKnown: identity => identity === "dingtalk:staff_42",
    fetchFn: (async (url: string | URL) => {
      const target = String(url);
      if (target.includes("oauth2/userAccessToken")) return new Response(JSON.stringify({ accessToken: "ut" }));
      if (target.includes("contact/users/me")) return new Response(JSON.stringify({ unionId: "un_1", nick: "四二" }));
      if (target.includes("oauth2/accessToken")) return new Response(JSON.stringify({ accessToken: "at" }));
      if (target.includes("topapi/user/getbyunionid")) {
        return new Response(JSON.stringify({ errcode: 0, result: { userid: "staff_42" } }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch,
  });
  const handle = vendorAuth(deps);
  const entry = recorder();
  await handle(new URL("https://box.example.com/auth/dingtalk"), entry.asServerResponse);
  assert.equal(entry.res.status, 302);
  assert.match(entry.res.headers.location as string, /^https:\/\/login\.dingtalk\.com\/oauth2\/auth/);
  assert.match(entry.res.headers.location as string, /scope=openid/);
  assert.match(entry.res.headers.location as string, /prompt=login/);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  const back = recorder();
  await handle(new URL(`https://box.example.com/auth/dingtalk/callback?code=c&state=${state}`), back.asServerResponse);
  assert.equal(back.res.status, 302);
  assert.deepEqual(back.res.headers["set-cookie"], ["token=abc", "session=dingtalk:staff_42"]);
});

test("the dance: a state nobody minted, or one that aged out, is refused", async () => {
  const handle = vendorAuth(danceDeps());
  const stranger = recorder();
  await handle(new URL("https://box.example.com/auth/feishu/callback?code=c&state=deadbeef"), stranger.asServerResponse);
  assert.equal(stranger.res.status, 400);
  assert.match(stranger.res.body, /expired or was not started here/);

  // Mint a state, wind the clock past the TTL, redeem: same refusal.
  let clock = 1_000_000;
  const deps = danceDeps({ now: () => clock });
  const handleAged = vendorAuth(deps);
  const entry = recorder();
  await handleAged(new URL("https://box.example.com/auth/feishu"), entry.asServerResponse);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  clock += 10 * 60_000 + 1;
  const back = recorder();
  await handleAged(new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`), back.asServerResponse);
  assert.equal(back.res.status, 400);
});

test("the dance: a state is spent by its first redemption", async () => {
  const deps = danceDeps({
    fetchFn: (async (url: string | URL) => {
      if (String(url).includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response(JSON.stringify({ data: { open_id: "ou_known" } }));
    }) as typeof fetch,
  });
  const handle = vendorAuth(deps);
  const entry = recorder();
  await handle(new URL("https://box.example.com/auth/feishu"), entry.asServerResponse);
  const state = /state=([0-9a-f]+)/.exec(entry.res.headers.location as string)?.[1];
  const first = recorder();
  await handle(new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`), first.asServerResponse);
  assert.equal(first.res.status, 302);
  const replay = recorder();
  await handle(new URL(`https://box.example.com/auth/feishu/callback?code=c&state=${state}`), replay.asServerResponse);
  assert.equal(replay.res.status, 400, "a replayed state is not a second sign-in");
});

test("the dance: a door without credentials, or an installation without a public URL, says so", async () => {
  const noCreds = vendorAuth(danceDeps({ credentials: () => undefined }));
  const a = recorder();
  await noCreds(new URL("https://box.example.com/auth/feishu"), a.asServerResponse);
  assert.equal(a.res.status, 503);
  assert.match(a.res.body, /APP_ID/);

  const noBase = vendorAuth(danceDeps({ publicBase: () => undefined }));
  const b = recorder();
  await noBase(new URL("https://box.example.com/auth/dingtalk"), b.asServerResponse);
  assert.equal(b.res.status, 503);
  assert.match(b.res.body, /AGENTBOX_PUBLIC_URL/);
});

test("the dance: a telegram door is refused as a door, not as a failure", async () => {
  const handle = vendorAuth(danceDeps());
  const { res, asServerResponse } = recorder();
  await handle(new URL("https://box.example.com/auth/telegram"), asServerResponse);
  assert.equal(res.status, 404);
  assert.match(res.body, /telegram door cannot sign people in/);
});

// ------------------------------------------------------------------- DingTalk

test("dingtalk: the exchange walks four calls and arrives at the staffId", async () => {
  const { fetchFn, calls } = scriptedFetch([
    { body: { accessToken: "user-token" } },
    { body: { unionId: "un_7", nick: "Seven" } },
    { body: { accessToken: "app-token" } },
    { body: { errcode: 0, result: { userid: "staff_7" } } },
  ]);
  const subject = await dingtalkLogin.exchange({
    clientId: "cli",
    clientSecret: "sec",
    code: "scanned",
    redirectUri: "https://box.example.com/auth/dingtalk/callback",
    fetchFn,
  });
  assert.deepEqual(subject, { vendorSubject: "staff_7", name: "Seven" });

  // Call 1: the person's token for the code.
  assert.equal(calls[0]!.url, "https://api.dingtalk.com/v1.0/oauth2/userAccessToken");
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), {
    clientId: "cli",
    clientSecret: "sec",
    code: "scanned",
    grantType: "authorization_code",
    redirectUri: "https://box.example.com/auth/dingtalk/callback",
  });
  // Call 2: who they are, under the personal token's own header.
  assert.equal(calls[1]!.url, "https://api.dingtalk.com/v1.0/contact/users/me");
  assert.equal(
    (calls[1]!.init!.headers as Record<string, string>)["x-acs-dingtalk-access-token"],
    "user-token",
  );
  // Call 3: the app's admin token.
  assert.deepEqual(JSON.parse(String(calls[2]!.init?.body)), { appKey: "cli", appSecret: "sec" });
  // Call 4: union → staff, on the legacy api, with that token in the query.
  assert.match(calls[3]!.url, /^https:\/\/oapi\.dingtalk\.com\/topapi\/user\/getbyunionid\?access_token=app-token$/);
  assert.deepEqual(JSON.parse(String(calls[3]!.init?.body)), { unionid: "un_7" });
});

test("dingtalk: a scan whose user is outside the org says the vendor's words", async () => {
  const { fetchFn } = scriptedFetch([
    { body: { accessToken: "ut" } },
    { body: { unionId: "un_out", nick: "Guest" } },
    { body: { accessToken: "at" } },
    { body: { errcode: 60121, errmsg: "找不到该用户" } },
  ]);
  await assert.rejects(
    dingtalkLogin.exchange({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://b/cb", fetchFn }),
    /找不到该用户/,
  );
});

test("dingtalk: a missing unionId never reaches the admin walk", async () => {
  const { fetchFn, calls } = scriptedFetch([
    { body: { accessToken: "ut" } },
    { body: { nick: "No Union" } },
  ]);
  await assert.rejects(
    dingtalkLogin.exchange({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "https://b/cb", fetchFn }),
    /no unionId/,
  );
  assert.equal(calls.length, 2, "no credential was spent hunting for a subject that never arrived");
});
