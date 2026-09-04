/**
 * Sign-in through a door: the OAuth face of a channel, provider-agnostic.
 *
 * The rule this file enforces: **the dance is one, the vendors are data.** A
 * person signs in with the IM app they already have — the same app credentials
 * the door's messages ride on — and lands in a session as the identity *that
 * door mints* (`<channelId>:<vendorSubject>`), which is the very string
 * knock/bind links to a Principal. Nothing new is trusted: a vendor subject
 * nobody linked gets the knock instructions, never a session.
 *
 * Provider isolation, spelled out because it was the point of the exercise:
 *
 * - A vendor's entire contribution is one object in `loginProviders` — where
 *   the browser authenticates, how a code becomes a subject, which env keys
 *   under the door's base hold the client, and a label for pages. Adding Slack
 *   is a third object; touching nothing else.
 * - The dance (state, redirect, callback, expiry, the open-redirect guard on
 *   `next`, the knock page, the session mint) lives here once and names no
 *   vendor. The web server learns nothing except that `/auth/*` exists.
 * - The subject each provider returns must be the field the door's inbound
 *   messages carry — Feishu's `open_id`, DingTalk's `staffId` — or the
 *   browser's "you" and the chat's "you" become two Principals. DingTalk's
 *   OAuth hands back a `unionId`, so its exchange walks one admin call further
 *   (`user/getbyunionid`) to arrive at the staffId the stream frames carry.
 *   That walk is DingTalk's business, kept inside its provider.
 */

import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ChannelType } from "./identity.ts";

/** Ten minutes: long enough for a person to find their phone, short enough that a leaked state is not a standing door. */
const STATE_TTL_MS = 10 * 60_000;

/** What one vendor's OAuth face looks like. Everything vendor-specific stops here. */
export interface LoginProvider {
  /** Which channel records this provider can sign people in for. */
  readonly type: ChannelType;
  /** For pages and refusals, capitalized as the docs do. */
  readonly label: string;
  /**
   * Env suffixes under the door's base (`<BASE>_…`) holding the OAuth client —
   * the same pair the door's messages already use, which is the design: one
   * app authenticates a person on both paths.
   */
  readonly clientIdEnv: string;
  readonly clientSecretEnv: string;
  /** Where the browser is sent to prove who it is. */
  authorizeUrl(args: { clientId: string; redirectUri: string; state: string }): string;
  /**
   * The code the vendor sent back, exchanged for the subject the door's
   * inbound messages carry — not the vendor's most convenient id.
   */
  exchange(args: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    fetchFn: typeof fetch;
  }): Promise<{ vendorSubject: string; name?: string }>;
}

/** Feishu's hosts flip wholesale for Lark; read at call time so tests and one env change both work. */
function feishuHosts(): { accounts: string; api: string } {
  return process.env.FEISHU_DOMAIN === "lark"
    ? { accounts: "accounts.larksuite.com", api: "open.larksuite.com" }
    : { accounts: "accounts.feishu.cn", api: "open.feishu.cn" };
}

/** Feishu/Lark: authorize, then authen v2 token, then user_info — `open_id` is the subject the events carry. */
export const feishuLogin: LoginProvider = {
  type: "feishu",
  label: "Feishu",
  clientIdEnv: "APP_ID",
  clientSecretEnv: "APP_SECRET",
  authorizeUrl({ clientId, redirectUri, state }) {
    const hosts = feishuHosts();
    return (
      `https://${hosts.accounts}/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(clientId)}` +
      `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`
    );
  },
  async exchange({ clientId, clientSecret, code, redirectUri, fetchFn }) {
    const hosts = feishuHosts();
    const tokenResponse = await fetchFn(`https://${hosts.api}/open-apis/authen/v2/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody = (await tokenResponse.json()) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (tokenBody.access_token === undefined) {
      throw new Error(tokenBody.error_description ?? tokenBody.error ?? `HTTP ${tokenResponse.status}`);
    }
    const infoResponse = await fetchFn(`https://${hosts.api}/open-apis/authen/v1/user_info`, {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoResponse.json()) as { data?: { open_id?: string; name?: string } };
    const openId = info.data?.open_id;
    if (openId === undefined || openId === "") throw new Error("user_info returned no open_id");
    return { vendorSubject: openId, name: info.data?.name };
  },
};

/** DingTalk's user-personal token comes with its own header on the modern API. */
const DINGTALK_TOKEN_HEADER = "x-acs-dingtalk-access-token";

/** DingTalk: scan → userAccessToken → users/me (`unionId`) → the admin walk to the `staffId` the stream frames carry. */
export const dingtalkLogin: LoginProvider = {
  type: "dingtalk",
  label: "DingTalk",
  clientIdEnv: "CLIENT_ID",
  clientSecretEnv: "CLIENT_SECRET",
  authorizeUrl({ clientId, redirectUri, state }) {
    return (
      "https://login.dingtalk.com/oauth2/auth" +
      `?redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}&scope=openid&state=${encodeURIComponent(state)}&prompt=login`
    );
  },
  async exchange({ clientId, clientSecret, code, redirectUri, fetchFn }) {
    // The person's own token, for the code the scan produced. redirect_uri rides along:
    // DingTalk checks it against the app's configured list even though the docs
    // omit it from this endpoint's body.
    const userTokenResponse = await fetchFn("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId,
        clientSecret,
        code,
        grantType: "authorization_code",
        redirectUri,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const userToken = (await userTokenResponse.json()) as {
      accessToken?: string;
      message?: string;
    };
    if (userToken.accessToken === undefined) {
      throw new Error(userToken.message ?? `HTTP ${userTokenResponse.status}`);
    }
    const meResponse = await fetchFn("https://api.dingtalk.com/v1.0/contact/users/me", {
      headers: { [DINGTALK_TOKEN_HEADER]: userToken.accessToken },
      signal: AbortSignal.timeout(15_000),
    });
    const me = (await meResponse.json()) as { unionId?: string; nick?: string };
    if (me.unionId === undefined || me.unionId === "") {
      throw new Error("users/me returned no unionId");
    }
    // The walk that makes the OAuth subject equal the message subject: the app's
    // own access token, then the legacy union→staff resolution. Both are the
    // door's admin credentials, and both stay inside this provider.
    const appTokenResponse = await fetchFn("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const appToken = (await appTokenResponse.json()) as { accessToken?: string };
    if (appToken.accessToken === undefined) {
      throw new Error(`app access token: HTTP ${appTokenResponse.status}`);
    }
    const staffResponse = await fetchFn(
      `https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appToken.accessToken)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unionid: me.unionId }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const staff = (await staffResponse.json()) as {
      errcode?: number;
      errmsg?: string;
      result?: { userid?: string };
    };
    const userid = staff.result?.userid;
    if (typeof userid !== "string" || userid === "") {
      throw new Error(`user/getbyunionid: ${staff.errmsg ?? `errcode ${staff.errcode ?? "unknown"}`}`);
    }
    return { vendorSubject: userid, name: me.nick };
  },
};

/** Telegram has no OAuth face here — the invite code is its way in — so it is absent on purpose. */
export const loginProviders: Readonly<Record<ChannelType, LoginProvider | undefined>> = {
  feishu: feishuLogin,
  dingtalk: dingtalkLogin,
  telegram: undefined,
};

/** What the dance needs from whoever is hosting it. All injectable; all of it one-liners at the server. */
export interface LoginDeps {
  /** The doors that exist, with the type that picks a provider. */
  doors(): Array<{ id: string; type: ChannelType }>;
  /** A door's OAuth client from wherever its message credentials live, or undefined when unset. */
  credentials(channelId: string, provider: LoginProvider): { clientId: string; clientSecret: string } | undefined;
  /** The installation's outward base URL — the redirect back has to name it. */
  publicBase(): string | undefined;
  /** Whether an identity is linked to a Principal here. */
  isKnown(identity: string): boolean;
  /** The linked person's display name, for the sign-in log line. */
  nameOf(identity: string): string | undefined;
  /** The session cookie for a signed-in identity. */
  sessionCookie(identity: string): string;
  /** The UI token cookie, when there is a token — sign-in admits to the UI too. */
  uiTokenCookie(): string | undefined;
  /**
   * The first-admin code a fresh installation is holding out (docs/36 §2).
   * Present only while the roster is empty and an invite is live; its
   * presence on the knock page is the one difference between "knock" and
   * "you may be the first admin".
   */
  pendingBootstrap(): { code: string } | undefined;
  /**
   * Spend that code on this identity: link them as the first admin. False
   * when the code is stale or the identity is already a person — the
   * ordinary knock check then decides, exactly as if no code was offered.
   */
  redeemBootstrap(code: string, identity: string, name: string | undefined): boolean;
  log(line: string): void;
  now(): number;
  /** Injectable so tests never reach a vendor; the server passes the global. */
  fetchFn: typeof fetch;
}

/**
 * The dance, as a handler for `/auth/<door>[/callback]`. Factory, not module
 * global, so each host — the server, each test — gets its own state map.
 */
export function vendorAuth(deps: LoginDeps) {
  const states = new Map<string, { channelId: string; next: string; at: number; bootstrap?: string }>();

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  return async function handleVendorAuth(url: URL, res: ServerResponse): Promise<void> {
    const parts = url.pathname.split("/").filter(Boolean); // ["auth", door, "callback"?]
    const channelId = parts[1] ?? "";
    const record = deps.doors().find(door => door.id === channelId);
    const provider = record === undefined ? undefined : loginProviders[record.type];
    if (record === undefined || provider === undefined || parts.length > 3) {
      const reason =
        record === undefined
          ? `No door named ${channelId}.`
          : provider === undefined
            ? `A ${record.type} door cannot sign people in; feishu and dingtalk can.`
            : `Not a sign-in path: ${url.pathname}`;
      sendJson(res, 404, { error: reason });
      return;
    }
    const client = deps.credentials(channelId, provider);
    if (client === undefined) {
      sendJson(res, 503, {
        error: `set ${provider.clientIdEnv} and ${provider.clientSecretEnv} for this door first.`,
      });
      return;
    }
    const publicBase = deps.publicBase()?.replace(/\/+$/, "");
    if (publicBase === undefined || publicBase === "") {
      sendJson(res, 503, { error: "set AGENTBOX_PUBLIC_URL — the redirect back has to name this installation." });
      return;
    }
    const redirectUri = `${publicBase}/auth/${channelId}/callback`;

    if (parts[2] === undefined) {
      // Entry: remember where they were going, hand them to the vendor.
      for (const [key, pending] of states) {
        if (deps.now() - pending.at > STATE_TTL_MS) states.delete(key);
      }
      const rawNext = url.searchParams.get("next") ?? "/";
      // Relative paths only: an absolute `next` would make this an open redirect.
      const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
      // A first-admin code, remembered server-side in the state entry — never in
      // the vendor's redirect, which is the vendor's URL, not ours. A wrong code
      // is ignored here (the dance proceeds; the knock page offers the field
      // again), so probing costs a vendor round-trip and learns nothing.
      const rawBootstrap = url.searchParams.get("bootstrap");
      const bootstrap =
        rawBootstrap !== null && deps.pendingBootstrap()?.code === rawBootstrap ? rawBootstrap : undefined;
      const state = randomBytes(16).toString("hex");
      states.set(state, { channelId, next, at: deps.now(), ...(bootstrap !== undefined ? { bootstrap } : {}) });
      res.writeHead(302, { location: provider.authorizeUrl({ clientId: client.clientId, redirectUri, state }) });
      res.end();
      return;
    }
    if (parts[2] !== "callback") {
      sendJson(res, 404, { error: `Not a sign-in path: ${url.pathname}` });
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const pending = states.get(state);
    states.delete(state);
    if (code === null || pending === undefined || pending.channelId !== channelId ||
        deps.now() - pending.at > STATE_TTL_MS) {
      sendJson(res, 400, { error: "This sign-in expired or was not started here. Open the link again." });
      return;
    }
    try {
      const { vendorSubject, name } = await provider.exchange({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        code,
        redirectUri,
        fetchFn: deps.fetchFn,
      });
      const identity = `${channelId}:${vendorSubject}`;
      if (pending.bootstrap !== undefined && deps.redeemBootstrap(pending.bootstrap, identity, name)) {
        // The first admin: the code was spent turning this vendor-authenticated
        // identity into the roster's first Principal. Same cookies, same landing.
        const admit = [deps.uiTokenCookie(), deps.sessionCookie(identity)].filter(
          (cookie): cookie is string => cookie !== undefined,
        );
        res.writeHead(302, { "set-cookie": admit, location: pending.next });
        res.end();
        deps.log(`bootstrap admin: ${identity} via ${channelId} (${name ?? "?"})`);
        return;
      }
      if (!deps.isKnown(identity)) {
        // Signed in with the vendor, unknown here: the answer is the knock path, said
        // as a page a person can act on — not a session for whoever the vendor knows.
        // While a first-admin invite is live, the same page holds the code field —
        // the one difference between "knock" and "you may be the first admin".
        const label = provider.label;
        const shown = identity.replace(/</g, "&lt;");
        const bootstrapField = (() => {
          if (deps.pendingBootstrap() === undefined) return "";
          const door = encodeURIComponent(channelId);
          return (
            `<hr style="border:0;border-top:1px solid #ddd;margin:22px 0">` +
            `<p>如果你是本安装的第一位管理员,输入引导码:</p>` +
            `<input id="bc" autocomplete="off" spellcheck="false" placeholder="引导码" ` +
            `style="width:60%;padding:8px 10px;font:inherit;letter-spacing:2px">` +
            `<button onclick="location.href='/auth/${door}?bootstrap='+encodeURIComponent(document.getElementById('bc').value)" ` +
            `style="margin-left:8px;padding:8px 14px;font:inherit">成为管理员</button>`
          );
        })();
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><meta charset="utf-8"><body style="font:15px/1.7 sans-serif;max-width:560px;margin:80px auto;padding:0 20px">` +
            `<h3>这个${label}账号还没有链接到本安装</h3>` +
            `<p>你的 id:<code>${shown}</code></p>` +
            `<p>给机器人发一条消息 —— 管理员会收到放行提示;或者向管理员要一个邀请码,在聊天里发送 <code>bind 邀请码</code>。链接完成后回到这里重新打开即可。</p>` +
            `${bootstrapField}</body>`,
        );
        deps.log(`web login refused: ${identity} signed in via ${channelId} but is not linked`);
        return;
      }
      const admit = [deps.uiTokenCookie(), deps.sessionCookie(identity)].filter(
        (cookie): cookie is string => cookie !== undefined,
      );
      res.writeHead(302, { "set-cookie": admit, location: pending.next });
      res.end();
      deps.log(`web login: ${identity} via ${channelId} (${deps.nameOf(identity) ?? "?"})`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.log(`web login via ${channelId} (${provider.label}) failed: ${detail}`);
      sendJson(res, 502, { error: `Sign-in failed: ${detail}` });
    }
  };
}
