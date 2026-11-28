/**
 * Signing in on the web through a chat door (INV-1701, INV-729): `/auth/<door>` hands the person to
 * the vendor's authorize page, `/auth/<door>/callback` exchanges the code and signs the person in
 * **as the identity that door mints** — `<door>:<subject>`, the same string the door's chat
 * messages carry and knock/bind linked to their Principal. Nothing new is trusted: an identity
 * nobody linked gets a session only if an Admin activated that person (INV-2202); otherwise they
 * have asked to join, and wait.
 *
 * One dispatcher, one sign-in per door type. What every type shares lives here once: the state
 * (one use, ten minutes, bound to the door's app and incarnation, and to the browser that started —
 * `BINDING_COOKIE`), the safe return address, the
 * first-Admin code, and the rule that only a linked identity gets a session. What differs is a
 * `DoorSignIn`: where the vendor's authorize page is, and how a code becomes the subject the chat
 * side uses.
 *
 * - Feishu: the open_id (`ou_…`), per app — what the Feishu adapter mints.
 * - DingTalk: the organisation's `userid` (the chat's `senderStaffId`). The web sign-in proves a
 *   `unionId`; the app's own organisation maps it to a userid (`topapi/user/getbyunionid`), and a
 *   unionId it does not know — or knows as an external contact — is not a member and is refused.
 *
 * WeCom joins when it has a door.
 *
 * A phone's sign-in (INV-2214) comes through the same door: `/auth/<door>?device=<id>`, which the app
 * opened from `POST /api/v1/auth/oauth/start` (device-sign-in.ts). The same state, binding and admission
 * rule apply; what differs is the end. Nobody gets a session: the browser is sent back to the app's own
 * address with a one-time code — for a person let in, and for one whose request now waits for an Admin
 * (the exchange answers `asked_to_join`) — or with `error=access_denied` and why.
 */

import { randomBytes } from "node:crypto";
import type { DoorOutcome } from "./device-sign-in.ts";
import type { ServerResponse } from "node:http";
import { apiError } from "./api-error.ts";
import { safeNext } from "./auth.ts";
import { requestLocaleOf, localeOf } from "./page-locale.ts";
import { askedToJoinPage, notLinkedPage, notMemberPage, signInRecoveryPage } from "./server-pages.ts";
import { signInCallbackUrl, signsInOnWeb, wantsHtml, type WebSignInType } from "./sign-in.ts";

const STATE_TTL_MS = 10 * 60_000;

/**
 * What ties a sign-in to the browser that started it (docs/106 §5 R5, INV-2204).
 *
 * The state alone lived on the server, so a callback address was good in anybody's browser:
 * somebody could start a sign-in, authorize as themselves at the vendor, and hand the finished
 * callback link to another person, whose browser would then be signed in as the sender. The entry
 * now gives the browser a random value in a cookie, the state remembers it, and the callback is
 * honoured only from a browser that presents the same one. HttpOnly, SameSite=Lax (the vendor's
 * redirect back is a top-level navigation, which Lax carries), ten minutes like the state, and
 * only under `/auth`. A browser that already holds one keeps it, so two sign-in tabs do not
 * invalidate each other.
 */
export const BINDING_COOKIE = "agentbox_signin";
// Read on its own, undecoded: the value is hex, and decoding every cookie in the header would let
// one malformed cookie of somebody else's (`pref=100%`) fail the sign-in. The last one wins, as in parseCookies.
const bindingOf = (cookieHeader: string | undefined): string | undefined => {
  let value: string | undefined;
  for (const part of (cookieHeader ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === BINDING_COOKIE) value = part.slice(at + 1).trim();
  }
  return value !== undefined && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
};

/** Who the vendor vouches for, in the door's own subject — or that they are outside its organisation. */
export type Vouched = { subject: string; name?: string } | { notMember: true };

interface AppCredentials { appId: string; appSecret: string; redirectUri: string; fetch: typeof fetch }

/** One door type's half of the sign-in. */
export interface DoorSignIn {
  /** The credential names, from the door's env base (`FEISHU_APP_ID`, `DINGTALK_CLIENT_ID`). */
  keys(base: string): { id: string; secret: string };
  authorizeUrl(app: { appId: string; redirectUri: string }, state: string): string;
  /** The authorization code, as the person, a subject in the door's namespace. Throws on a vendor failure. */
  vouch(code: string, app: AppCredentials): Promise<Vouched>;
}

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

function feishu(lark: boolean): DoorSignIn {
  const accountsHost = lark ? "accounts.larksuite.com" : "accounts.feishu.cn";
  const apiHost = lark ? "open.larksuite.com" : "open.feishu.cn";
  return {
    keys: base => ({ id: `${base}_APP_ID`, secret: `${base}_APP_SECRET` }),
    authorizeUrl: ({ appId, redirectUri }, state) =>
      `https://${accountsHost}/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(appId)}` +
      `&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    async vouch(code, app) {
      const tokenResponse = await app.fetch(`https://${apiHost}/open-apis/authen/v2/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", client_id: app.appId, client_secret: app.appSecret, code, redirect_uri: app.redirectUri }),
      });
      const token = await json<{ access_token?: string; error_description?: string; error?: string }>(tokenResponse);
      if (!tokenResponse.ok || token.access_token === undefined) throw new Error(token.error_description ?? token.error ?? `HTTP ${tokenResponse.status}`);
      const infoResponse = await app.fetch(`https://${apiHost}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${token.access_token}` } });
      const info = await json<{ code?: number; data?: { open_id?: string; name?: string } }>(infoResponse);
      const openId = info.data?.open_id;
      if (!infoResponse.ok || info.code !== 0 || typeof openId !== "string" || openId === "") throw new Error("user_info returned no authenticated identity");
      return { subject: openId, ...(info.data?.name ? { name: info.data.name } : {}) };
    },
  };
}

/** DingTalk's errcode for "no employee with that unionid" in the app's organisation. */
const DINGTALK_NO_SUCH_EMPLOYEE = 60121;

const dingtalk: DoorSignIn = {
  keys: base => ({ id: `${base}_CLIENT_ID`, secret: `${base}_CLIENT_SECRET` }),
  authorizeUrl: ({ appId, redirectUri }, state) =>
    `https://login.dingtalk.com/oauth2/auth?redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code` +
    `&client_id=${encodeURIComponent(appId)}&scope=openid&state=${state}&prompt=consent`,
  async vouch(code, app) {
    // The person's token, then who they are: a unionId, which is not what the chat side names them by.
    const userToken = await app.fetch("https://api.dingtalk.com/v1.0/oauth2/userAccessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: app.appId, clientSecret: app.appSecret, code, grantType: "authorization_code" }),
    });
    const token = await json<{ accessToken?: string; message?: string; code?: string }>(userToken);
    if (!userToken.ok || typeof token.accessToken !== "string" || token.accessToken === "") throw new Error(token.message ?? token.code ?? `HTTP ${userToken.status}`);
    const meResponse = await app.fetch("https://api.dingtalk.com/v1.0/contact/users/me", { headers: { "x-acs-dingtalk-access-token": token.accessToken } });
    const me = await json<{ unionId?: string; nick?: string; message?: string }>(meResponse);
    if (!meResponse.ok || typeof me.unionId !== "string" || me.unionId === "") throw new Error(me.message ?? "users/me returned no authenticated identity");
    // The app's token, and its organisation's answer: which employee that unionId is.
    const appToken = await app.fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ appKey: app.appId, appSecret: app.appSecret }),
    });
    const appBody = await json<{ accessToken?: string; message?: string }>(appToken);
    if (!appToken.ok || typeof appBody.accessToken !== "string" || appBody.accessToken === "") throw new Error(appBody.message ?? `app token HTTP ${appToken.status}`);
    const lookup = await app.fetch(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appBody.accessToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unionid: me.unionId }),
    });
    const found = await json<{ errcode?: number | string; errmsg?: string; result?: { userid?: string; contact_type?: number | string } }>(lookup);
    if (Number(found.errcode) === DINGTALK_NO_SUCH_EMPLOYEE) return { notMember: true };
    if (!lookup.ok || Number(found.errcode) !== 0) throw new Error(found.errmsg ?? `getbyunionid HTTP ${lookup.status}`);
    const userid = found.result?.userid;
    // contact_type 1 is an external contact of the organisation: known to it, not in it.
    if (Number(found.result?.contact_type ?? 0) !== 0 || typeof userid !== "string" || userid === "") return { notMember: true };
    return { subject: userid, ...(me.nick ? { name: me.nick } : {}) };
  },
};

/** The door types a person can sign in through on the web, and how. */
export function doorSignInFor(type: string, options: { feishuDomain: string }): DoorSignIn | undefined {
  if (!signsInOnWeb(type)) return undefined;
  const doors: Record<WebSignInType, () => DoorSignIn> = { feishu: () => feishu(options.feishuDomain === "lark"), dingtalk: () => dingtalk };
  return doors[type]();
}

export interface DoorSignInDeps {
  records(): readonly { id: string; name: string; type: string; incarnation: number }[];
  /** The door's env base: the id, uppercased. */
  envBase(id: string): string;
  /** A credential, from the environment or the saved config. */
  env(key: string): string | undefined;
  publicUrl(): string | undefined;
  feishuDomain(): string;
  fetch: typeof fetch;
  bootstrap: { accepts(code: string): boolean; redeem(code: string, identity: string, name: string, incarnation: number): boolean };
  setupPending(): boolean;
  principals: { reload(): void; isKnown(identity: string): boolean; resolve(identity: string): { id: string; name: string } };
  /** For an identity nobody holds: an Admin's activation makes them a roster person now, or they have asked to join (activation-routes.ts). */
  admit(channelId: string, subject: string, name: string): "admitted" | "asked" | "refused";
  /** The session cookie for a person on the roster. */
  sessionCookie(identity: string, principalId: string): string;
  send(res: ServerResponse, status: number, body: unknown, type?: string): void;
  log(line: string): void;
  /** Whether cookies say `Secure` (the installation is reached over https). */
  secureCookies?(): boolean;
  /**
   * The sign-in limiter and record, for the callback (sign-in-limits.ts). `blocked` is the seconds
   * this request's address must wait, asked before anything is exchanged; `failed` records a
   * callback that did not sign anyone in, and counts it unless `counts` is false.
   */
  attempts?: { blocked(res: ServerResponse): number | undefined; failed(res: ServerResponse, reason: string, account?: string, counts?: boolean): void; succeeded?(res: ServerResponse, account: string): void };
  /** A device's sign-in (device-sign-in.ts): the entry takes its start once; the callback asks where the browser goes back to. */
  device?: { take(id: string): { providerId: string } | undefined; finish(id: string, outcome: DoorOutcome): string | undefined };
}

interface PendingSignIn { channelId: string; next: string; at: number; appId: string; incarnation: number; binding: string; bootstrapCode?: string; device?: string }

/** The handler for `/auth/<door>` and `/auth/<door>/callback`; `bootstrapCode` is the first Admin's (POST). */
export function doorSignInHandler(deps: DoorSignInDeps): (url: URL, res: ServerResponse, bootstrapCode?: string) => Promise<void> {
  const states = new Map<string, PendingSignIn>();
  const expired = (pending: PendingSignIn) => Date.now() - pending.at > STATE_TTL_MS;

  return async function handle(url, res, bootstrapCode) {
    const { send } = deps;
    const parts = url.pathname.split("/").filter(Boolean); // ["auth", door, "callback"?]
    const channelId = parts[1] ?? "";
    const record = deps.records().find(entry => entry.id === channelId);
    const door = record === undefined ? undefined : doorSignInFor(record.type, { feishuDomain: deps.feishuDomain() });
    if (record === undefined || door === undefined || parts.length > 3) {
      send(res, 404, apiError("sign-in-channel-unknown", { channel: channelId }));
      return;
    }
    const base = deps.envBase(channelId);
    const keys = door.keys(base);
    const appId = deps.env(keys.id);
    const appSecret = deps.env(keys.secret);
    const redirectUri = signInCallbackUrl(deps.publicUrl(), channelId);
    if (typeof appId !== "string" || appId === "" || typeof appSecret !== "string" || appSecret === "") {
      send(res, 503, apiError("channel-app-unset", keys));
      return;
    }
    if (redirectUri === undefined) {
      send(res, 503, apiError("public-url-unset"));
      return;
    }

    if (parts[2] === undefined) {
      if (bootstrapCode !== undefined && !deps.bootstrap.accepts(bootstrapCode)) {
        send(res, 400, apiError("bootstrap-code-invalid"));
        return;
      }
      // Entry: remember where they were going, hand them to the vendor.
      for (const [key, pending] of states) if (expired(pending)) states.delete(key);
      // A device's sign-in, started from the app: taken once, for the door it was started for, never with the first Admin's code.
      const device = url.searchParams.get("device") ?? undefined;
      if (device !== undefined && (bootstrapCode !== undefined || deps.device?.take(device)?.providerId !== channelId)) {
        send(res, 400, signInRecoveryPage("sign-in-expired", localeOf(res.req, url), { setup: deps.setupPending() }), "text/html");
        return;
      }
      // A path on this origin only: anything else would make this an open redirect (INV-724).
      const next = safeNext(url.searchParams.get("next")) ?? "/";
      const state = randomBytes(16).toString("hex");
      const binding = bindingOf(res.req.headers.cookie) ?? randomBytes(16).toString("hex");
      states.set(state, { channelId, next, at: Date.now(), appId, incarnation: record.incarnation, binding, ...(bootstrapCode !== undefined ? { bootstrapCode } : {}), ...(device !== undefined ? { device } : {}) });
      const target = door.authorizeUrl({ appId, redirectUri }, state);
      const bound = `${BINDING_COOKIE}=${binding}; Path=/auth; ${deps.secureCookies?.() === true ? "Secure; " : ""}Max-Age=${STATE_TTL_MS / 1000}; HttpOnly; SameSite=Lax`;
      // The first Admin's page asks by fetch and then navigates: the cookie rides the fetch's reply.
      if (bootstrapCode !== undefined) { res.setHeader("set-cookie", bound); send(res, 200, { url: target }); return; }
      res.writeHead(302, { location: target, "set-cookie": bound });
      res.end();
      return;
    }
    if (parts[2] !== "callback") {
      send(res, 404, apiError("sign-in-path-unknown", { path: url.pathname }));
      return;
    }
    // DingTalk sends the code as both `code` and `authCode`; Feishu as `code`.
    const code = url.searchParams.get("code") ?? url.searchParams.get("authCode");
    const state = url.searchParams.get("state") ?? "";
    const wait = deps.attempts?.blocked(res);
    if (wait !== undefined) {
      res.setHeader("retry-after", String(wait));
      send(res, 429, apiError("sign-in-limited", { seconds: wait }));
      return;
    }
    const pending = states.get(state);
    states.delete(state);
    const sameBrowser = pending !== undefined && bindingOf(res.req.headers.cookie) === pending.binding;
    if (code === null || pending === undefined || !sameBrowser || pending.channelId !== channelId || pending.appId !== appId || pending.incarnation !== record.incarnation || expired(pending)) {
      deps.attempts?.failed(res, pending !== undefined && !sameBrowser ? "another-browser" : "state-unknown");
      if (wantsHtml(res.req.headers.accept)) send(res, 400, signInRecoveryPage("sign-in-expired", localeOf(res.req, url), { setup: deps.setupPending() }), "text/html");
      else send(res, 400, apiError("sign-in-expired"));
      return;
    }
    const channelName = record.name || record.id;
    /** Back to the app that started this sign-in, with a code or with why not; false when this is the page's own sign-in. */
    const backToApp = (outcome: DoorOutcome): boolean => {
      if (pending.device === undefined) return false;
      const location = deps.device?.finish(pending.device, outcome);
      if (location === undefined) send(res, 400, signInRecoveryPage("sign-in-expired", localeOf(res.req, url), { setup: deps.setupPending() }), "text/html");
      else { res.writeHead(302, { location, "cache-control": "no-store" }); res.end(); }
      return true;
    };
    try {
      const vouched = await door.vouch(code, { appId, appSecret, redirectUri, fetch: deps.fetch });
      if ("notMember" in vouched) {
        deps.attempts?.failed(res, "not-a-member", undefined, false);
        if (backToApp({ kind: "refused", why: "not-a-member" })) return;
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(notMemberPage(channelName, requestLocaleOf(res.req)));
        deps.log(`web login refused: signed in via ${channelId} as somebody outside the door's organisation`);
        return;
      }
      const identity = `${channelId}:${vouched.subject}`;
      const currentDoor = deps.records().find(entry => entry.id === channelId);
      if (!currentDoor || currentDoor.incarnation !== pending.incarnation || deps.env(keys.id) !== pending.appId) {
        send(res, 409, apiError("sign-in-channel-changed"));
        return;
      }
      if (pending.bootstrapCode !== undefined) {
        if (!deps.bootstrap.redeem(pending.bootstrapCode, identity, vouched.name ?? vouched.subject, currentDoor.incarnation)) {
          send(res, 409, apiError("bootstrap-gone"));
          return;
        }
        deps.principals.reload();
        deps.log("First administrator enrolled through authenticated sign-in.");
      }
      // The one rule that decides admission here: an identity linked to a Principal gets a
      // session; any other waits for an Admin — never a session for whoever the vendor knows.
      // An identity nobody holds yet is admitted by an Admin's activation and nothing else (INV-2202,
      // docs/107): activated, they become a person on the roster here; otherwise they have asked to join.
      // Since INV-2220 the activation made the person when it was pressed: `admit` only finds them, and makes nobody.
      const admitted = deps.admit(channelId, vouched.subject, vouched.name ?? vouched.subject);
      if (admitted !== "admitted" && pending.device !== undefined) {
        deps.log(`device sign-in: ${identity} via ${channelId} is not ${admitted === "asked" ? "activated" : "linked"}`);
        deps.attempts?.failed(res, admitted === "asked" ? "not-activated" : "not-linked", identity, false);
        backToApp(admitted === "asked" ? { kind: "asked", name: vouched.name ?? vouched.subject } : { kind: "refused", why: "not-linked" });
        return;
      }
      if (admitted !== "admitted") {
        const locale = requestLocaleOf(res.req);
        res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
        res.end(admitted === "asked" ? askedToJoinPage(vouched.name ?? vouched.subject, channelName, locale) : notLinkedPage(identity, channelName, locale));
        deps.log(`web login refused: ${identity} signed in via ${channelId} but is not ${admitted === "asked" ? "activated" : "linked"}`);
        deps.attempts?.failed(res, admitted === "asked" ? "not-activated" : "not-linked", identity, false);
        return;
      }
      // The session, and only the session: a credential issued to *this person*, not the
      // installation's token.
      const person = deps.principals.resolve(identity);
      if (backToApp({ kind: "person", principalId: person.id, identity })) {
        deps.log(`device sign-in: ${identity} via ${record.type} door ${channelId} (${person.name}); the code goes back to the app`);
        deps.attempts?.succeeded?.(res, person.id);
        return;
      }
      res.writeHead(302, { "set-cookie": [deps.sessionCookie(identity, person.id)], location: pending.next });
      res.end();
      deps.log(`web login: ${identity} via ${record.type} door ${channelId} (${person.name})`);
      deps.attempts?.succeeded?.(res, person.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      deps.log(`${record.type} sign-in via ${channelId} failed: ${detail}`);
      deps.attempts?.failed(res, "vendor-refused");
      if (backToApp({ kind: "refused", why: "vendor-refused" })) return;
      send(res, 502, apiError("sign-in-failed", { detail }));
    }
  };
}
