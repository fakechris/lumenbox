/**
 * The client API's contract, run against a real server (docs/106 §7, INV-2213): the OpenAPI
 * document is read, and for every operation in it the server answers the documented resource —
 * nothing more, nothing missing — with `ETag` and 304; every error code the document lists for an
 * operation is provoked on that operation and answers with its status and the `{ code, error,
 * requestId }` body; and an operation that needs a scope refuses a token without it.
 *
 * The server runs at the private level (an `https://` public address, a wider bind), where sign-in
 * limits are on: the deployment the API is for. Each provocation that trips a limit comes from an
 * address of its own (`X-Forwarded-For`, believed with no trusted-proxy list), so one does not
 * block the next.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openApiDocument } from "./openapi.ts";
import { problemsOf } from "./routes.ts";
import { ERRORS, OPERATIONS, SCHEMAS, SCOPE_NAMES, type ApiErrorCode, type Operation, type Schema } from "./schema.ts";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_INSECURE", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUSTED_PROXIES"] as const;

type Doc = { paths: Record<string, Record<string, { operationId: string; responses: Record<string, { "x-error-codes"?: ApiErrorCode[] }> }>> };

/** The codes a real server cannot be made to answer from outside, and where each is proved instead. */
const PROVED_ELSEWHERE: Partial<Record<ApiErrorCode, string>> = {
  "api-internal": "frame.test.ts: a handler that throws answers 500 with the request id, and the log has the stack",
};

/** `door`: an organisation's DingTalk door a phone signs in through (INV-2214); off, the installation has none, as the read slice's tests were written for. */
async function server(t: TestContext, options: { door?: boolean } = {}) {
  const { Principals } = await import("../../host/principals.ts");
  const { McpTokenStore } = await import("../mcp-tokens.ts");
  const { startWebServer } = await import("../server.ts");
  const home = mkdtempSync(join(tmpdir(), "client-api-contract-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_PUBLIC_URL: "https://box.example.test" });
  mkdirSync(join(home, "agents"), { recursive: true });
  // An organisation's DingTalk door: what a phone signs in through (INV-2214), faked below as the vendor.
  if (options.door === true) {
    writeFileSync(join(home, "channels.json"), JSON.stringify({ channels: [{ id: "ding", name: "DingTalk", type: "dingtalk", incarnation: 1, boxId: "default", createdAt: new Date().toISOString() }] }));
    writeFileSync(join(home, "config.json"), JSON.stringify({ env: { DING_CLIENT_ID: "ding-app", DING_CLIENT_SECRET: "secret" } }));
  }
  const roster: { id: string; name: string; role: "admin" | "driver" | "viewer"; identities: string[] }[] = [
    { id: "ann", name: "Ann", role: "admin" as const, identities: ["ding:ann-staff"] },
    { id: "ada", name: "Ada", role: "admin" as const, identities: [] },
    { id: "dee", name: "Dee", role: "driver" as const, identities: ["ding:dee-staff", "feishu:ou_dee", "feishu:ou_dee2"] },
    { id: "ivy", name: "Ivy", role: "driver" as const, identities: ["ding:ivy-staff"] },
    { id: "vic", name: "Vic", role: "viewer" as const, identities: [] },
    { id: "gus", name: "Gus", role: "driver" as const, identities: [] },
    { id: "pat", name: "Pat", role: "driver" as const, identities: [] },
  ];
  new Principals().save(roster);
  // The world the read operations read: two agents in the installation's box (everyone's), one hidden from
  // listings, and one in Pat's own box that nobody else may enter — Admins included (docs/111 §1).
  const { AgentRegistry } = await import("../../agents/registry.ts");
  const { TaskStore } = await import("../../host/tasks.ts");
  const registry = new AgentRegistry(join(home, "agents"));
  registry.attachBox({ id: "pat-box", name: "Pat's sandbox", kind: "attached", members: ["pat"], displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() });
  const writer = registry.create({ name: "Writer", title: "editor", description: "Writes the newsletter.", tags: ["media"] });
  const hidden = registry.create({ name: "Quiet", hidden: true });
  const patBot = registry.create({ name: "PatBot", boxId: "pat-box" });
  const board = new TaskStore(join(home, "tasks.jsonl"));
  // Asked for three days ago: a close may be proposed only once the requester has had time to look.
  const t1 = board.create({ title: "Plan the issue", description: "Draft the plan for the December issue.", requester: "dee", assigneeId: writer.id, now: new Date(Date.now() - 3 * 24 * 3_600_000) })!;
  const t2 = board.create({ title: "Write the lead story", requester: "dee", assigneeId: writer.id, origin: { kind: "internal", parentId: t1.id } })!;
  board.update(t2.id, { status: "blocked", note: "Halfway through the draft.", waitingOn: "the photographs" }, writer.id); // a start puts "doing" back to "open"
  const t3 = board.create({ title: "Pat's private errand", requester: "pat", assigneeId: patBot.id })!;
  const t4 = board.create({ title: "Find a photographer", requester: "dee" })!;
  const t5 = board.create({ title: "Vic's own note", requester: "vic" })!;
  assert.ok("task" in board.proposeClose(t1.id, writer.id, "the plan is in the shared folder"), "the close proposal Dee is asked to answer");
  const ids = { writer: writer.id, hidden: hidden.id, patBot: patBot.id, t1: t1.id, t2: t2.id, t3: t3.id, t4: t4.id, t5: t5.id };
  // What waits on people (INV-2214), as the gate, the Outbox and the question watch keep it, written before the server reads them:
  // an approval for an action that leaves the box, one that stays in it, one in Pat's box nobody else may see, an Outbox draft and
  // its consent record, and a question the Writer put to Dee.
  const asked = new Date().toISOString();
  const approval = (id: string, agentId: string, description: string, more: Record<string, unknown> = {}) =>
    JSON.stringify({ at: asked, kind: "approval-requested", id, fingerprint: `fp-${id}`, agentId, description, ...more });
  writeFileSync(join(home, "policy.jsonl"), `${[
    approval("ap-reach", writer.id, "post the issue to the newsletter list", { tier: "reach", action: "send a message outside the box" }),
    approval("ap-self", writer.id, "rename draft.md to issue.md", { tier: "self" }),
    approval("ap-pat", patBot.id, "Pat's private deploy", { tier: "reach" }),
    approval("ap-draft", writer.id, "Send the December issue to the list", { harnessResumes: true }),
  ].join("\n")}\n`);
  const { OutboxDrafts, OUTBOX_FILE } = await import("../../host/outbox-drafts.ts");
  new OutboxDrafts(join(home, OUTBOX_FILE)).record({ id: "dr-1", agentId: writer.id, agentName: "Writer", conversation: "main", kind: "message", target: "the newsletter list", body: "The December issue is out.", why: "The issue is ready", approvalId: "ap-draft" });
  const { QuestionWatch } = await import("../../host/question-expiry.ts");
  const question = new QuestionWatch(join(home, "questions.jsonl")).ask({ agentId: writer.id, agentName: "Writer", conversation: "main", question: "Which cover, the red or the blue?", asker: "dee", ttlMs: 3_600_000 }).question;
  const questionId = question.id;
  // One token whose time is over, minted before the server reads the store.
  const expired = new McpTokenStore(join(home, "mcp-tokens.json")).mintClient({ kind: "personal", principalId: "dee", label: "old", scopes: SCOPE_NAMES, expiresAt: new Date(Date.now() - 60_000), by: "test" }).token;
  // And a device signed in 31 days ago and never used since: its refresh token's time is over.
  const { DeviceStore } = await import("../device-credentials.ts");
  const staleRefresh = new DeviceStore(join(home, "devices.json"), () => {}, () => {}, () => new Date(Date.now() - 31 * 24 * 3_600_000))
    .signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "old phone", platform: "ios", scopes: SCOPE_NAMES, by: "test" }).tokens.refreshToken;
  // And one whose refresh token was spent 90 seconds ago, past the 30 seconds a device's own retry gets: presented again, it ends the device.
  let then = Date.now() - 120_000;
  const rotating = new DeviceStore(join(home, "devices.json"), () => {}, () => {}, () => new Date(then));
  const spent = rotating.signIn({ principalId: "dee", identity: "dee", via: "person", method: "pairing", name: "copied phone", platform: "android", scopes: SCOPE_NAMES, by: "test" }).tokens;
  then += 30_000;
  const current = rotating.refresh(spent.refreshToken, () => true);
  assert.ok("tokens" in current);
  const reused = { deviceId: spent.deviceId, spent: spent.refreshToken, current: current.tokens.refreshToken, access: current.tokens.accessToken };
  // DingTalk, faked: the code is the unionId it vouches for; Dee, Ivy and Bob work there, and only Dee and Ivy are on the roster.
  const employees: Record<string, string> = { "union-dee": "dee-staff", "union-ivy": "ivy-staff", "union-bob": "bob-staff" };
  const loginFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, string>;
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/userAccessToken") return Response.json({ accessToken: body.code });
    if (url.href === "https://api.dingtalk.com/v1.0/contact/users/me") { const unionId = new Headers(init?.headers).get("x-acs-dingtalk-access-token")!; return Response.json({ unionId, nick: unionId }); }
    if (url.href === "https://api.dingtalk.com/v1.0/oauth2/accessToken") return Response.json({ accessToken: "app-token" });
    if (url.origin + url.pathname === "https://oapi.dingtalk.com/topapi/user/getbyunionid") {
      const userid = employees[body.unionid!];
      return Response.json(userid !== undefined ? { errcode: 0, result: { userid, contact_type: 0 } } : { errcode: 60121, errmsg: "none" });
    }
    throw new Error(`unexpected vendor call ${url.href}`);
  }) as typeof fetch;
  let base = "";
  const logs: string[] = [];
  const start = () => startWebServer({ port: 0, host: "0.0.0.0", token: "t0k", useBox: false, loginFetch, onLog: line => logs.push(line), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
  let stop = await start();
  /** The server stops and another starts on the same home: what a client finds after a restart. */
  const restart = async () => { stop(); stop = await start(); };
  t.after(() => {
    stop();
    for (const key of KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  });
  const operator = { authorization: "Bearer t0k", "content-type": "application/json" };
  /** A token minted through the page's route, as the operator for `principalId`. */
  const mint = async (body: Record<string, unknown>) => {
    const answer = await fetch(`${base}/api/client-tokens`, { method: "POST", headers: operator, body: JSON.stringify({ expiresInDays: 30, ...body }) });
    const json = await answer.json() as { token: string; credential: { id: string } };
    assert.equal(answer.status, 200, JSON.stringify(json));
    return json;
  };
  let address = 0;
  /** An address nobody else in this file uses: a limit tripped from it trips nothing else. */
  const fresh = () => { address += 1; return `203.0.113.${address}`; };
  /** A request for an operation; `{id}` is an agent the caller reaches, or work they may read, unless `id` says which. */
  const call = (operation: Operation, init: { token?: string; query?: string; headers?: Record<string, string>; from?: string; id?: string; body?: unknown } = {}) =>
    fetch(`${base}/api/v1${operation.path.replace(/\{(id|seq)\}/, encodeURIComponent(init.id ?? (operation.path.startsWith("/agents") ? writer.id : t1.id)))}${init.query ?? ""}`, { method: operation.method, headers: {
      "x-forwarded-for": init.from ?? fresh(), ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers,
    }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
  const op = (id: string) => OPERATIONS.find(operation => operation.operationId === id) as Operation;
  /** A page session for `identity` (a sign-in) that signed in `ago` ms ago, signed as the server signs one (session.ts). */
  const { makeSession, sessionKey, SESSION_COOKIE } = await import("../session.ts");
  const session = (identity: string, ago = 0) => `${SESSION_COOKIE}=${encodeURIComponent(makeSession(identity, sessionKey("t0k"), 0, Math.floor((Date.now() - ago) / 1000)))}`;
  /** Through the door as a phone: PKCE start, the door's entry and callback in one browser, and where the browser is sent back to. */
  const doorCode = async (unionId: string, start: Record<string, unknown> = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const started = await call(op("startOAuth"), { body: { provider: "ding", codeChallenge: createHash("sha256").update(verifier).digest("base64url"), codeChallengeMethod: "S256", redirectUri: "lumenbox://oauth/callback", state: "app-state", ...start } });
    const { authorizationUrl } = await started.json() as { authorizationUrl: string };
    assert.equal(started.status, 200, authorizationUrl);
    const entry = await fetch(`${base}${new URL(authorizationUrl).pathname}${new URL(authorizationUrl).search}`, { redirect: "manual" });
    assert.equal(entry.status, 302, "the door hands the phone's browser to the vendor");
    const state = new URL(entry.headers.get("location")!).searchParams.get("state")!;
    const back = await fetch(`${base}/auth/ding/callback?state=${state}&code=${unionId}`, { redirect: "manual", headers: { cookie: entry.headers.getSetCookie()[0]!.split(";")[0]! } });
    assert.equal(back.status, 302);
    assert.deepEqual(back.headers.getSetCookie(), [], "a phone's sign-in sets no page session");
    const location = new URL(back.headers.get("location")!);
    return { location, code: location.searchParams.get("code") ?? undefined, verifier, authorizationUrl };
  };
  type SignIn = { status: string; tokens: { deviceId: string; accessToken: string; refreshToken: string; scopes: string[] }; me: { id: string; credential: { kind: string; id: string } } };
  /** A phone signed in for Dee (or `unionId`) through the door: the exchange's answer. */
  const phone = async (unionId = "union-dee"): Promise<SignIn> => {
    const { code, verifier } = await doorCode(unionId);
    const answer = await call(op("exchangeOAuthCode"), { body: { code, codeVerifier: verifier, redirectUri: REDIRECT, deviceName: "Dee's phone", platform: "ios" } });
    const body = await answer.json() as SignIn;
    assert.equal(answer.status, 200, JSON.stringify(body));
    return body;
  };
  /** A pairing code shown on `identity`'s signed-in page, as the QR code holds it. */
  const pairingCode = async (identity = "ding:dee-staff") => {
    const shown = await fetch(`${base}/api/devices/pairing`, { method: "POST", headers: { cookie: session(identity), "content-type": "application/json" }, body: "{}" });
    const body = await shown.json() as { link: string; qrSvg: string; expiresAt: string };
    assert.equal(shown.status, 200, JSON.stringify(body));
    return { ...body, code: new URLSearchParams(new URL(body.link).hash.slice(1)).get("code")! };
  };
  /** A device paired for `identity` with a step-up key (docs/110 §4): its tokens, and how it signs a decision. */
  const keyedPhone = async (identity = "ding:dee-staff") => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const answer = await call(op("pairDevice"), { body: {
      code: (await pairingCode(identity)).code, deviceName: "Dee's keyed phone", platform: "ios", stepUpKeyId: "key-1", stepUpPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    } });
    const { tokens } = await answer.json() as { tokens: { deviceId: string; accessToken: string } };
    assert.equal(answer.status, 200);
    const proof = (itemId: string, decision: string, detail = "-") => ({
      keyId: "key-1", signature: sign("sha256", Buffer.from(`lumenbox-step-up/1\n${tokens.deviceId}\n${itemId}\n${decision}\n${detail}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url"),
    });
    return { token: tokens.accessToken, deviceId: tokens.deviceId, proof };
  };
  /** The `seq` of the change record saying `itemId` came to wait on somebody, as the caller is told of it. */
  const inboxSeq = async (token: string, itemId: string): Promise<number> => {
    const changes = await (await call(op("getChanges"), { token, query: "?since=0&limit=1000" })).json() as { items: { seq: number; type: string; id: string; op: string }[] };
    const line = changes.items.find(item => item.type === "inbox" && item.id === itemId && item.op === "upsert");
    assert.ok(line !== undefined, `an inbox change for ${itemId}: ${JSON.stringify(changes.items.filter(item => item.type === "inbox"))}`);
    return line.seq;
  };
  return { base, home, logs, expired, staleRefresh, reused, questionId, keyedPhone, inboxSeq, roster, mint, fresh, call, op, operator, Principals, ids, restart, url: () => base, session, doorCode, phone, pairingCode };
}

/** A body each operation that takes one accepts as well-formed (what it then finds in it is another matter). */
const VERIFIER = "v".repeat(43);
/** The app's own address every sign-in in these tests starts with, and so must finish with (RFC 6749 §4.1.3). */
const REDIRECT = "lumenbox://oauth/callback";
const WELL_FORMED: Record<string, Record<string, unknown>> = {
  startOAuth: { provider: "ding", codeChallenge: createHash("sha256").update(VERIFIER).digest("base64url"), codeChallengeMethod: "S256", redirectUri: "lumenbox://oauth/callback", state: "s" },
  exchangeOAuthCode: { code: "no-such-code", codeVerifier: VERIFIER, redirectUri: "lumenbox://oauth/callback", deviceName: "Phone", platform: "ios" },
  pairDevice: { code: "no-such-code", deviceName: "Phone", platform: "ios" },
  refreshDeviceToken: { refreshToken: `lbxr_${"0".repeat(64)}` },
  decideApproval: { decision: "deny", reason: "no" },
  answerInboxItem: { action: "reject", reason: "no" },
  decideWork: { decision: "keep-open", note: "no" },
};

type Box = Awaited<ReturnType<typeof server>>;
/** Each operation that changes something, made to answer 200 on a real server (`token`: Dee's personal token with every scope). */
const SUCCEED: Record<string, (box: Box, token: string) => Promise<Response>> = {
  startOAuth: box => box.call(box.op("startOAuth"), { body: WELL_FORMED.startOAuth }),
  exchangeOAuthCode: async box => {
    const { code, verifier } = await box.doorCode("union-dee");
    return box.call(box.op("exchangeOAuthCode"), { body: { code, codeVerifier: verifier, redirectUri: REDIRECT, deviceName: "Dee's phone", platform: "android" } });
  },
  pairDevice: async box => box.call(box.op("pairDevice"), { body: { code: (await box.pairingCode()).code, deviceName: "Dee's tablet", platform: "ios" } }),
  refreshDeviceToken: async box => box.call(box.op("refreshDeviceToken"), { body: { refreshToken: (await box.phone()).tokens.refreshToken } }),
  signOutDevice: async box => box.call(box.op("signOutDevice"), { token: (await box.phone()).tokens.accessToken }),
  deleteDevice: async (box, token) => box.call(box.op("deleteDevice"), { token, id: (await box.phone()).tokens.deviceId }),
  decideApproval: (box, token) => box.call(box.op("decideApproval"), { token, id: "ap-self", body: { decision: "deny", reason: "not now" } }),
  answerInboxItem: (box, token) => box.call(box.op("answerInboxItem"), { token, id: `question:${box.questionId}`, body: { action: "answer", text: "The blue one." } }),
  decideWork: (box, token) => box.call(box.op("decideWork"), { token, body: { decision: "keep-open", note: "Not yet: the photographs are missing." } }),
};

/** An error answer is the documented shape, with the code asked for and the request id of its header. */
async function assertRefusal(answer: Response, code: ApiErrorCode, what: string): Promise<Record<string, unknown>> {
  const body = await answer.json() as Record<string, unknown>;
  assert.equal(answer.status, ERRORS[code].status, `${what}: ${JSON.stringify(body)}`);
  assert.equal(body.code, code, what);
  assert.deepEqual(problemsOf(body, SCHEMAS.Error as Schema), [], what);
  assert.equal(body.requestId, answer.headers.get("x-request-id"), `${what}: the body names the request its header names`);
  return body;
}

test("every operation in the document answers its resource — every field documented, none missing — with ETag, 304 and a request id", async t => {
  const box = await server(t, { door: true });
  const all = await box.mint({ principalId: "dee", label: "script", scopes: SCOPE_NAMES });
  const doc = openApiDocument() as Doc;
  const inDoc = Object.values(doc.paths).flatMap(methods => Object.values(methods).map(operation => operation.operationId)).sort();
  assert.deepEqual(inDoc, OPERATIONS.map(operation => operation.operationId).sort(), "the document is the schema's operations, all of them");
  for (const operation of OPERATIONS as readonly Operation[]) {
    const token = operation.auth === "none" ? undefined : all.token;
    if (operation.stream === true) {
      // A stream is not JSON and has no ETag: what it says is the next test's.
      const opened = await box.call(operation, { token: token! });
      assert.equal(opened.status, 200);
      assert.match(opened.headers.get("content-type") ?? "", /^text\/event-stream/);
      assert.match(opened.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
      await opened.body?.cancel();
      continue;
    }
    if (operation.method !== "GET") {
      // What changes something is made to work for real, once: a phone signed in, a code exchanged, a device ended.
      const answer = await SUCCEED[operation.operationId]!(box, all.token);
      const body = await answer.json();
      assert.equal(answer.status, 200, `${operation.operationId}: ${JSON.stringify(body)}`);
      assert.deepEqual(problemsOf(body, SCHEMAS[operation.response] as Schema), [], `${operation.operationId} answers exactly its documented ${operation.response}`);
      assert.match(answer.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
      assert.equal(answer.headers.get("etag"), null, `${operation.operationId} changes something: no validator`);
      if (operation.secret === true) assert.equal(answer.headers.get("cache-control"), "no-store", `${operation.operationId} holds a token: stored nowhere on the way`);
      continue;
    }
    const required = operation.operationId === "getChanges" ? "?since=0" : "";
    // A notification names the change record of something waiting on the caller.
    const seq = operation.operationId === "getNotification" ? { id: String(await box.inboxSeq(all.token, "outbox:dr-1")) } : {};
    const answer = await box.call(operation, { ...(token === undefined ? {} : { token }), query: required, ...seq });
    const body = await answer.json();
    assert.equal(answer.status, 200, `${operation.operationId}: ${JSON.stringify(body)}`);
    assert.deepEqual(problemsOf(body, SCHEMAS[operation.response] as Schema), [], `${operation.operationId} answers exactly its documented ${operation.response}`);
    assert.match(answer.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    const etag = answer.headers.get("etag");
    assert.match(etag ?? "", /^"[A-Za-z0-9_-]{32}"$/, `${operation.operationId} carries a validator`);
    let again = await box.call(operation, { ...(token === undefined ? {} : { token }), query: required, ...seq, headers: { "if-none-match": etag! } });
    // `me` names the minute of its last use: across a minute's turn the body did change, and once more settles it.
    if (again.status === 200 && operation.operationId === "getMe") { const turned = again.headers.get("etag")!; await again.body?.cancel(); again = await box.call(operation, { token: token!, headers: { "if-none-match": turned } }); }
    assert.equal(again.status, 304, `${operation.operationId}: unchanged is 304`);
    assert.equal(await again.text(), "", "with no body");
    assert.match(again.headers.get("etag") ?? "", /^"[A-Za-z0-9_-]{32}"$/);
  }
});

test("what meta and me say: the revision, the stable operations, the person, the credential and never the token", async t => {
  const box = await server(t);
  const meta = await (await box.call(OPERATIONS[0])).json() as { api: string; capabilities: string[]; preview: string[]; installation: { mode: string } };
  assert.match(meta.api, /^1\.\d+$/);
  assert.deepEqual(meta.capabilities, OPERATIONS.filter(operation => operation.tier === "stable").map(operation => operation.operationId));
  assert.deepEqual(meta.preview, []);
  assert.equal(meta.installation.mode, "organisation");
  const getMe = OPERATIONS.find(operation => operation.operationId === "getMe")!;

  const personal = await box.mint({ principalId: "vic", label: "my script", scopes: ["work:read"] });
  const me = await (await box.call(getMe, { token: personal.token })).json() as Record<string, unknown> & { credential: Record<string, unknown> };
  assert.equal(me.id, "vic");
  assert.equal(me.role, "viewer", "a viewer mints a token, and it reads as a viewer: a token never raises anything");
  assert.equal(me.credential.kind, "personal");
  assert.deepEqual(me.credential.scopes, ["work:read"]);
  assert.equal(me.credential.label, "my script");
  assert.equal(me.credential.view, undefined, "only a service token has a view");
  assert.ok(!JSON.stringify(me).includes(personal.token), "never the token");

  const service = await box.mint({ kind: "service", principalId: "ann", label: "Acme board", scopes: ["work:read", "agents:read"], view: { agentIds: ["a1"] } });
  const read = await (await box.call(getMe, { token: service.token })).json() as { id: string; credential: { kind: string; view: unknown } };
  assert.equal(read.id, "ann", "a service token reads for the Admin who minted it");
  assert.equal(read.credential.kind, "service");
  assert.deepEqual(read.credential.view, { allAgents: false, agentIds: ["a1"], allWork: false, workIds: [], conversationText: false }, "nothing is visible that the view does not name");

  // Last use is noted, to the minute, and is in the next answer.
  const later = await (await box.call(getMe, { token: personal.token })).json() as { credential: { lastUsedAt?: string } };
  assert.match(later.credential.lastUsedAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/, "to the minute, written to the second");

  // An Admin demoted: the integration they minted stops, with the code a client drops its cache on.
  const people = new box.Principals();
  people.save(box.roster.map(person => (person.id === "ann" ? { ...person, role: "driver" as const } : person)));
  await assertRefusal(await box.call(getMe, { token: service.token }), "access-removed", "a service token of an Admin who is no longer one");
  // In the reader's language.
  const zh = await assertRefusal(await box.call(getMe, { headers: { "accept-language": "zh-CN" } }), "api-credential-needed", "no credential, in Chinese");
  assert.match(String(zh.error), /令牌/);
});

test("every error the document lists for an operation is provoked on it, and an operation with a scope refuses a token without it", async t => {
  const box = await server(t, { door: true });
  const doc = openApiDocument() as Doc;
  const gone = await box.mint({ principalId: "gus", label: "leaver", scopes: SCOPE_NAMES });
  const staying = box.roster.filter(person => person.id !== "gus");
  new box.Principals().save(staying);
  const bogus = `lbxp_${"0".repeat(48)}`;
  const dee = (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token;
  const viewer = (await box.mint({ principalId: "vic", label: "v", scopes: SCOPE_NAMES })).token;
  let keyedDevice: Awaited<ReturnType<typeof box.keyedPhone>> | undefined;
  const keyed = async () => (keyedDevice ??= await box.keyedPhone());
  /** Ivy is let in, then removed before her phone finishes signing in: it is told her access is gone. */
  const ivyLeavesBefore = async (finish: () => Promise<Response>) => {
    new box.Principals().save(staying.filter(person => person.id !== "ivy"));
    try { return await finish(); } finally { new box.Principals().save(staying); }
  };
  const bodyOf = (operation: Operation) => (operation.requestBody !== undefined ? { body: WELL_FORMED[operation.operationId] } : {});
  const CONFLICT_FIELD: Record<string, string> = { startOAuth: "state", exchangeOAuthCode: "code", pairDevice: "code", refreshDeviceToken: "refreshToken", decideApproval: "reason", answerInboxItem: "reason", decideWork: "note" };
  /** Where an operation is made to answer a code its own way: a credential in the body, not in `Authorization`. */
  const special: Record<string, Partial<Record<ApiErrorCode, () => Promise<Response>>>> = {
    refreshDeviceToken: {
      "api-credential-invalid": () => box.call(box.op("refreshDeviceToken"), { body: WELL_FORMED.refreshDeviceToken }),
      "api-credential-expired": () => box.call(box.op("refreshDeviceToken"), { body: { refreshToken: box.staleRefresh } }),
      "access-removed": async () => {
        const signedIn = await box.phone();
        await (await box.call(box.op("deleteDevice"), { token: dee, id: signedIn.tokens.deviceId })).body?.cancel();
        return box.call(box.op("refreshDeviceToken"), { body: { refreshToken: signedIn.tokens.refreshToken } });
      },
    },
    exchangeOAuthCode: {
      "access-removed": async () => {
        const { code, verifier } = await box.doorCode("union-ivy");
        return ivyLeavesBefore(() => box.call(box.op("exchangeOAuthCode"), { body: { code, codeVerifier: verifier, redirectUri: REDIRECT, deviceName: "Ivy's phone", platform: "ios" } }));
      },
    },
    decideApproval: {
      "api-role-needed": async () => box.call(box.op("decideApproval"), { token: viewer, id: "ap-self", body: { decision: "allow", scope: "once" } }),
      "approval-always-refused": () => box.call(box.op("decideApproval"), { token: dee, id: "ap-self", body: { decision: "allow", scope: "always" } }),
      "step-up-required": () => box.call(box.op("decideApproval"), { token: dee, id: "ap-reach", body: { decision: "allow", scope: "once" } }),
      "step-up-invalid": async () => box.call(box.op("decideApproval"), { token: (await keyed()).token, id: "ap-reach", body: { decision: "allow", scope: "once", stepUp: { keyId: "key-1", signature: randomBytes(64).toString("base64url") } } }),
      "inbox-answer-invalid": () => box.call(box.op("decideApproval"), { token: dee, id: "ap-self", body: { decision: "allow", scope: "forever" } }),
    },
    answerInboxItem: {
      "api-not-found": () => box.call(box.op("answerInboxItem"), { token: dee, id: "outbox:no-such-draft", body: { action: "reject", reason: "no" } }),
      "api-role-needed": () => box.call(box.op("answerInboxItem"), { token: viewer, id: "outbox:dr-1", body: { action: "reject", reason: "no" } }),
      "step-up-required": () => box.call(box.op("answerInboxItem"), { token: dee, id: "outbox:dr-1", body: { action: "approve" } }),
      "step-up-invalid": async () => box.call(box.op("answerInboxItem"), { token: (await keyed()).token, id: "outbox:dr-1", body: { action: "approve", stepUp: { keyId: "key-1", signature: randomBytes(70).toString("base64url") } } }),
      "inbox-answer-invalid": () => box.call(box.op("answerInboxItem"), { token: dee, id: "outbox:dr-1", body: { action: "answer", text: "hello" } }),
    },
    decideWork: {
      "api-role-needed": () => box.call(box.op("decideWork"), { token: viewer, id: box.ids.t2, body: { decision: "done" } }),
      "decision-refused": () => box.call(box.op("decideWork"), { token: dee, id: box.ids.t2, body: { decision: "keep-open" } }),
      "inbox-answer-invalid": () => box.call(box.op("decideWork"), { token: dee, id: box.ids.t2, body: { decision: "put-off" } }),
    },
    getNotification: {
      "api-not-found": () => box.call(box.op("getNotification"), { token: dee, id: "999999999" }),
      "api-param-invalid": () => box.call(box.op("getNotification"), { token: dee, id: "zero" }),
      "api-param-unknown": () => box.call(box.op("getNotification"), { token: dee, id: "1", query: "?nope=1" }),
    },
    pairDevice: {
      "access-removed": async () => {
        const { code } = await box.pairingCode("ding:ivy-staff");
        return ivyLeavesBefore(() => box.call(box.op("pairDevice"), { body: { code, deviceName: "Ivy's phone", platform: "ios" } }));
      },
    },
  };

  const provoke: Record<ApiErrorCode, ((operation: Operation) => Promise<Response>) | undefined> = {
    "api-credential-needed": operation => box.call(operation),
    "api-credential-invalid": operation => box.call(operation, { token: bogus }),
    "api-credential-expired": operation => box.call(operation, { token: box.expired }),
    "access-removed": operation => box.call(operation, { token: gone.token }),
    "sign-in-limited": async operation => {
      const from = box.fresh();
      for (let tries = 0; tries < 20; tries += 1) {
        // A credential in the body is tried in the body; any other, as a bearer.
        const answer = await box.call(operation, operation.signIn === true ? { from, body: WELL_FORMED[operation.operationId] } : { token: bogus, from });
        if (answer.status === 429) return answer;
        await answer.body?.cancel();
      }
      throw new Error("never limited");
    },
    "api-scope-needed": async operation => {
      const without = await box.mint({ principalId: "dee", label: "narrow", scopes: SCOPE_NAMES.filter(scope => scope !== operation.scope) });
      return box.call(operation, { token: without.token });
    },
    "api-param-unknown": async operation => box.call(operation, { query: "?nope=1", ...(operation.auth === "none" ? {} : { token: (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token }) }),
    "api-rate-limited": async operation => {
      const from = box.fresh();
      const token = operation.auth === "none" ? undefined : (await box.mint({ principalId: "dee", label: "busy", scopes: SCOPE_NAMES })).token;
      for (let sent = 0; sent < 700; sent += 50) {
        const answers = await Promise.all(Array.from({ length: 50 }, () => box.call(operation, { from, ...(token === undefined ? {} : { token }) })));
        const limited = answers.find(answer => answer.status === 429);
        for (const answer of answers) if (answer !== limited) await answer.body?.cancel();
        if (limited !== undefined) return limited;
      }
      throw new Error("never limited");
    },
    "api-param-invalid": async operation => {
      const token = (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token;
      // A body's string field given as a number.
      if (operation.requestBody !== undefined) return box.call(operation, { token, body: { ...WELL_FORMED[operation.operationId], [CONFLICT_FIELD[operation.operationId]!]: 12345 } });
      // A POST that takes no body still reads one: a JSON array is not one.
      if (operation.method === "POST") return box.call(operation, { token, body: [] });
      return (operation.query ?? []).some(param => param.name === "limit") ? box.call(operation, { token, query: "?limit=0" }) : box.call(operation, { token, id: "x".repeat(201) });
    },
    "api-not-found": async operation => box.call(operation, { token: (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token, id: "no-such-thing", ...bodyOf(operation) }),
    "api-cursor-invalid": async operation => box.call(operation, { token: (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token, query: "?cursor=bm90LW91cnM" }),
    "api-operation-unknown": undefined,
    "api-method-not-allowed": undefined,
    "api-idempotency-key-invalid": operation => box.call(operation, { token: dee, ...bodyOf(operation), headers: { "idempotency-key": "short" } }),
    "api-idempotency-conflict": async operation => {
      const key = `key-${randomBytes(6).toString("hex")}`, body = WELL_FORMED[operation.operationId]!, field = CONFLICT_FIELD[operation.operationId]!;
      await (await box.call(operation, { token: dee, body, headers: { "idempotency-key": key } })).body?.cancel();
      return box.call(operation, { token: dee, body: { ...body, [field]: `${String(body[field])}x` }, headers: { "idempotency-key": key } });
    },
    "api-internal": undefined,
    "auth-provider-unknown": () => box.call(box.op("startOAuth"), { body: { ...WELL_FORMED.startOAuth, provider: "nope" } }),
    "auth-redirect-invalid": () => box.call(box.op("startOAuth"), { body: { ...WELL_FORMED.startOAuth, redirectUri: "https://evil.example/callback" } }),
    "auth-code-invalid": () => box.call(box.op("exchangeOAuthCode"), { body: WELL_FORMED.exchangeOAuthCode }),
    "pairing-code-invalid": () => box.call(box.op("pairDevice"), { body: WELL_FORMED.pairDevice }),
    "refresh-superseded": async () => {
      const { refreshToken } = (await box.phone()).tokens;
      await (await box.call(box.op("refreshDeviceToken"), { body: { refreshToken } })).body?.cancel();
      return box.call(box.op("refreshDeviceToken"), { body: { refreshToken } });
    },
    "device-credential-needed": () => box.call(box.op("signOutDevice"), { token: dee }),
    // Each answered on the operation it belongs to (`special`, above).
    "api-role-needed": undefined, "approval-always-refused": undefined, "step-up-required": undefined, "step-up-invalid": undefined, "inbox-answer-invalid": undefined, "decision-refused": undefined,
  };

  for (const operation of OPERATIONS as readonly Operation[]) {
    const documented = Object.entries(doc.paths[`/api/v1${operation.path}`]![operation.method.toLowerCase()]!.responses).flatMap(([, response]) => response["x-error-codes"] ?? []);
    if (operation.scope !== undefined) assert.ok(documented.includes("api-scope-needed"), `${operation.operationId} documents its scope refusal`);
    for (const code of documented) {
      if (PROVED_ELSEWHERE[code] !== undefined) continue;
      const own = special[operation.operationId]?.[code], how = provoke[code];
      assert.ok(own !== undefined || how !== undefined, `${operation.operationId} documents ${code}: say here how a real server is made to answer it`);
      const answer = own !== undefined ? await own() : await how!(operation);
      await assertRefusal(answer, code, `${operation.operationId} → ${code}`);
      if (ERRORS[code].status === 429) assert.match(answer.headers.get("retry-after") ?? "", /^\d+$/, `${code} says how long to wait`);
    }
  }

  // Outside every operation: an unknown path and a method a path does not take, refused before any credential is read.
  await assertRefusal(await fetch(`${box.base}/api/v1/nothing-here`, { headers: { authorization: `Bearer ${bogus}` } }), "api-operation-unknown", "an unknown path");
  await assertRefusal(await fetch(`${box.base}/api/v1`), "api-operation-unknown", "the bare prefix");
  const wrongMethod = await fetch(`${box.base}/api/v1/me`, { method: "DELETE" });
  await assertRefusal(wrongMethod, "api-method-not-allowed", "DELETE on a GET path");
  assert.equal(wrongMethod.headers.get("allow"), "GET");

  // The page's own credentials are not this API's: the installation token and a cookie are refused here.
  await assertRefusal(await fetch(`${box.base}/api/v1/me`, { headers: { authorization: "Bearer t0k" } }), "api-credential-invalid", "the installation token");
  // A token that did not work is a try, on the record with no token in it.
  const signIns = readFileSync(join(box.home, "sign-ins.jsonl"), "utf8");
  assert.match(signIns, /"door":"client-api","outcome":"failed".*"reason":"unknown-token"/);
  assert.ok(!signIns.includes(bogus));
});

test("tokens: a viewer mints their own, only an Admin mints a service token and only with read scopes, a holder revokes theirs, all of it on the record without a secret", async t => {
  const box = await server(t);
  const post = (path: string, body: unknown) => fetch(`${box.base}${path}`, { method: "POST", headers: box.operator, body: JSON.stringify(body) });
  // The operator mints for a person it names; refusals say why, with a stable code.
  assert.equal((await post("/api/client-tokens", { principalId: "dee", scopes: ["work:write"] })).status, 400, "a scope that does not exist");
  assert.equal((await post("/api/client-tokens", { principalId: "dee", scopes: [] })).status, 400, "no scope at all");
  assert.equal((await post("/api/client-tokens", { principalId: "dee", scopes: ["work:read"], expiresInDays: 366 })).status, 400, "longer than a year");
  assert.equal((await post("/api/client-tokens", { principalId: "dee", scopes: ["work:read"], view: { allAgents: true } })).status, 400, "a view on a personal token");
  const asDriver = await post("/api/client-tokens", { kind: "service", principalId: "dee", scopes: ["work:read"] });
  assert.equal(asDriver.status, 403, "a service token reads for an Admin");
  assert.equal((await post("/api/client-tokens", { kind: "service", principalId: "ann", scopes: ["chat:write"] })).status, 400, "a service token reads; it does not write");

  const minted = await box.mint({ principalId: "vic", label: "mine", scopes: ["agents:read"] });
  assert.match(minted.token, /^lbxp_[0-9a-f]{48}$/, "a prefix a leak scan finds");
  const service = await box.mint({ kind: "service", principalId: "ann", label: "Acme", scopes: ["work:read"] });
  assert.match(service.token, /^lbxs_[0-9a-f]{48}$/);
  const listed = await (await fetch(`${box.base}/api/client-tokens`, { headers: box.operator })).json() as { tokens: { id: string; kind: string; principalId: string }[] };
  assert.deepEqual(listed.tokens.map(token => [token.kind, token.principalId]), [["personal", "dee"], ["personal", "vic"], ["service", "ann"]], "the expired one is still listed until revoked; the refused mints left nothing");
  const stored = readFileSync(join(box.home, "mcp-tokens.json"), "utf8");
  assert.ok(!stored.includes(minted.token) && !stored.includes(service.token), "the store keeps hashes, never a token");

  // The side door does not take a client token, and the side door's list does not show one.
  const mcp = await (await fetch(`${box.base}/api/mcp`, { headers: box.operator })).json() as { tokens: unknown[] };
  assert.deepEqual(mcp.tokens, []);

  assert.equal((await post("/api/client-tokens/revoke", { id: minted.credential.id })).status, 200);
  await assertRefusal(await box.call(OPERATIONS.find(operation => operation.operationId === "getMe")!, { token: minted.token }), "api-credential-invalid", "a revoked token");
  assert.equal((await post("/api/client-tokens/revoke", { id: minted.credential.id })).status, 404, "revoked once");

  const ledger = readFileSync(join(box.home, "tokens.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(ledger.filter(line => line.kind === "personal" && line.for === "vic").map(line => [line.event, line.id, line.by]), [["minted", minted.credential.id, "operator"], ["revoked", minted.credential.id, "operator"]]);
  const serviceLine = ledger.find(line => line.kind === "service")!;
  assert.deepEqual([serviceLine.event, serviceLine.for, serviceLine.label, serviceLine.scopes], ["minted", "ann", "Acme", ["work:read"]]);
  assert.deepEqual(serviceLine.view, { allAgents: false, agentIds: [], allWork: false, workIds: [], conversationText: false }, "the view as minted: nothing named, nothing seen");
  const written = readFileSync(join(box.home, "tokens.jsonl"), "utf8");
  assert.ok(!written.includes(minted.token) && !written.includes(service.token), "never a token on the record");
  assert.ok(existsSync(join(box.home, "tokens.jsonl")));
});

test("the generation check's fixtures stand for a newer server: each fits its schema once unknowns are allowed, and each has an unknown field and an unknown value", () => {
  // clients/codegen decodes these with the Swift and Kotlin code generated from the document (CI's client-codegen job).
  const fixtures: [string, keyof typeof SCHEMAS][] = [
    ["meta.json", "Meta"], ["me.json", "Me"], ["error.json", "Error"], ["work-page.json", "WorkPage"], ["changes.json", "Changes"],
    // A device's sign-in (INV-2214): a provider type, a sign-in status, a token type, a platform and a sign-in method added later.
    ["auth-providers.json", "AuthProviderList"], ["device-sign-in.json", "DeviceSignIn"], ["device-sign-in-other.json", "DeviceSignIn"], ["device-page.json", "DevicePage"],
    // Decisions (INV-2214): an inbox kind, an action, a tier, a draft kind and an outcome added later.
    ["inbox-page.json", "InboxPage"], ["decision-ack.json", "DecisionAck"],
  ];
  for (const [file, name] of fixtures) {
    const body = JSON.parse(readFileSync(new URL(`../../../clients/codegen/fixtures/${file}`, import.meta.url), "utf8")) as unknown;
    assert.deepEqual(problemsOf(body, SCHEMAS[name] as Schema, false), [], `${file} is a ${name}, as a newer server would send it`);
    const strict = problemsOf(body, SCHEMAS[name] as Schema, true);
    assert.ok(strict.some(problem => problem.endsWith("not in the schema")), `${file} has a field this schema does not`);
    assert.ok(strict.some(problem => problem.endsWith("is not a known value")), `${file} has a value this schema does not list`);
  }
});

test("agents, work and the board show what the page shows this person: their boxes' agents and work, 404 for the rest, the page's waiting mark and order, and a service token only its view", async t => {
  const box = await server(t);
  const { ids } = box;
  const op = (id: string) => OPERATIONS.find(operation => operation.operationId === id) as Operation;
  const read = async <T>(operationId: string, token: string, init: { query?: string; id?: string; headers?: Record<string, string> } = {}): Promise<T> => {
    const answer = await box.call(op(operationId), { token, ...init });
    const body = await answer.json() as T;
    assert.equal(answer.status, 200, `${operationId}: ${JSON.stringify(body)}`);
    assert.deepEqual(problemsOf(body, SCHEMAS[op(operationId).response] as Schema), [], `${operationId} answers its documented shape`);
    return body;
  };
  type Page<T> = { items: T[]; nextCursor?: string };
  type Work = { id: string; state: string; topLevelId: string; parentId?: string; agentId?: string; waitsOnMe: boolean; waitKind?: string; description?: string; summary?: string };
  const dee = (await box.mint({ principalId: "dee", label: "dee", scopes: SCOPE_NAMES })).token;

  // Agents: the boxes Dee is in; the hidden one is not listed and still readable; Pat's is not there at all.
  const agents = await read<Page<{ id: string; name: string; teams: string[]; status: string }>>("listAgents", dee);
  assert.deepEqual(agents.items.map(agent => agent.name), ["Writer"]);
  assert.deepEqual(agents.items[0]!.teams, ["media"]);
  assert.equal(agents.items[0]!.status, "idle");
  assert.equal((await read<{ name: string }>("getAgent", dee, { id: ids.hidden })).name, "Quiet");
  await assertRefusal(await box.call(op("getAgent"), { token: dee, id: ids.patBot }), "api-not-found", "an agent in a box Dee is not in");
  await assertRefusal(await box.call(op("getAgent"), { token: dee, id: "nobody" }), "api-not-found", "and one that does not exist: the same answer");

  // Work: what Dee's boxes hold and what Dee asked for; Pat's errand and Vic's note are not there.
  const work = await read<Page<Work>>("listWork", dee);
  assert.deepEqual(work.items.map(item => item.id).sort(), [ids.t1, ids.t2, ids.t4].sort());
  for (const hiddenWork of [ids.t3, ids.t5]) await assertRefusal(await box.call(op("getWork"), { token: dee, id: hiddenWork }), "api-not-found", `work ${hiddenWork} Dee may not read`);
  const child = work.items.find(item => item.id === ids.t2)!;
  assert.deepEqual([child.state, child.topLevelId, child.parentId, child.agentId, child.summary], ["blocked", ids.t1, ids.t1, ids.writer, "Halfway through the draft."]);
  const planned = work.items.find(item => item.id === ids.t1)!;
  assert.deepEqual([planned.waitsOnMe, planned.waitKind], [true, "close-proposal"], "the writer proposes closing what Dee asked for: it waits on Dee");
  assert.equal(planned.description, "Draft the plan for the December issue.");
  // Filters, each against what it names.
  const only = async (query: string) => (await read<Page<Work>>("listWork", dee, { query })).items.map(item => item.id).sort();
  assert.deepEqual(await only("?state=blocked"), [ids.t2]);
  assert.deepEqual(await only(`?agentId=${ids.writer}`), [ids.t1, ids.t2].sort());
  assert.deepEqual(await only(`?topLevelId=${ids.t1}`), [ids.t1, ids.t2].sort());
  assert.deepEqual(await only("?waitsOnMe=true"), [ids.t1]);
  assert.deepEqual(await only(`?agentId=${ids.patBot}`), [], "an agent Dee cannot reach holds nothing Dee sees");
  // Pages: one at a time, every item once, and a cursor is for the filters it was given with.
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page: Page<Work> = await read<Page<Work>>("listWork", dee, { query: `?limit=1${cursor !== undefined ? `&cursor=${cursor}` : ""}` });
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  assert.deepEqual(seen.sort(), [ids.t1, ids.t2, ids.t4].sort());
  const first = await read<Page<Work>>("listWork", dee, { query: "?limit=1" });
  await assertRefusal(await box.call(op("listWork"), { token: dee, query: `?state=open&cursor=${first.nextCursor}` }), "api-cursor-invalid", "a cursor given for other filters");
  // History, oldest first, with who and what.
  const history = await read<Page<{ byKind: string; byName?: string; state?: string; note?: string }>>("listWorkHistory", dee, { id: ids.t2 });
  assert.ok(history.items.some(change => change.byKind === "agent" && change.byName === "Writer" && change.state === "blocked" && change.note === "Halfway through the draft."), JSON.stringify(history.items));
  // The board: a column per state, what waits on Dee first in its column; titles in the reader's language.
  const board = await read<{ columns: { id: string; title: string; total: number; cards: Work[] }[] }>("getBoard", dee, { headers: { "accept-language": "zh-CN" } });
  assert.deepEqual(board.columns.map(column => column.id), ["open", "doing", "blocked", "review", "done", "dropped"]);
  const open = board.columns[0]!;
  assert.equal(open.title, "待开始");
  assert.deepEqual([open.total, open.cards[0]!.id], [2, ids.t1], "the card waiting on Dee is first");

  // A service token: Ann's reach (Pat's box is closed to Admins too), and only what its view names.
  const service = async (view: Record<string, unknown>) => (await box.mint({ kind: "service", principalId: "ann", label: "Acme", scopes: ["agents:read", "work:read"], view })).token;
  const none = await service({});
  assert.deepEqual((await read<Page<unknown>>("listAgents", none)).items, [], "a view that names nothing shows nothing");
  assert.deepEqual((await read<Page<unknown>>("listWork", none)).items, []);
  const everything = await service({ allAgents: true, allWork: true });
  assert.deepEqual((await read<Page<{ name: string }>>("listAgents", everything)).items.map(agent => agent.name), ["Writer"], "every agent Ann may reach: not Pat's");
  const held = await read<Page<Work>>("listWork", everything);
  assert.deepEqual(held.items.map(item => item.id).sort(), [ids.t1, ids.t2].sort(), "all work the view's agents hold: none nobody holds, none in Pat's box");
  assert.ok(held.items.every(item => item.description === undefined), "no conversation text unless the view says so");
  assert.ok((await read<Page<{ note?: string }>>("listWorkHistory", everything, { id: ids.t2 })).items.every(change => change.note === undefined));
  const named = await service({ workIds: [ids.t1] });
  const namedWork = await read<Page<Work>>("listWork", named);
  assert.deepEqual(namedWork.items.map(item => item.id).sort(), [ids.t1, ids.t2].sort(), "named work comes with the work made for it");
  assert.ok(namedWork.items.every(item => item.agentId === undefined), "and without naming an agent its view does not");
  await assertRefusal(await box.call(op("getWork"), { token: named, id: ids.t4 }), "api-not-found", "work outside the view");
  const withText = await service({ allAgents: true, allWork: true, conversationText: true });
  assert.equal((await read<Work>("getWork", withText, { id: ids.t1 })).description, "Draft the plan for the December issue.");
});

/** Reads a server-sent event stream until `ready`, and gives each event's name, id and data. */
async function eventsUntilReady(answer: Response): Promise<{ event: string; id?: string; data: Record<string, unknown> }[]> {
  assert.equal(answer.status, 200);
  const reader = answer.body!.getReader();
  let text = "";
  while (!/event: ready\n/.test(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await reader.cancel();
  return text.split("\n\n").filter(block => /^(id|event|data):/m.test(block)).map(block => {
    const field = (name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(block)?.[1];
    return { event: field("event") ?? "message", ...(field("id") !== undefined ? { id: field("id")! } : {}), data: JSON.parse(field("data") ?? "{}") as Record<string, unknown> };
  });
}

test("a phone away for more than the page's 512 live events, and across a restart, catches up exactly: what changed, once each, only what it may read, and no reset", async t => {
  const box = await server(t);
  const { ids } = box;
  const op = (id: string) => OPERATIONS.find(operation => operation.operationId === id) as Operation;
  const dee = (await box.mint({ principalId: "dee", label: "phone", scopes: SCOPE_NAMES })).token;
  type Changes = { items: { seq: number; type: string; id: string; op: string }[]; durableSeq: number; hasMore: boolean; reset: boolean };
  const changes = async (since: number, limit?: number): Promise<Changes> => {
    const answer = await box.call(op("getChanges"), { token: dee, query: `?since=${since}${limit !== undefined ? `&limit=${limit}` : ""}` });
    const body = await answer.json() as Changes;
    assert.equal(answer.status, 200, JSON.stringify(body));
    assert.deepEqual(problemsOf(body, SCHEMAS.Changes as Schema), [], "the documented shape: no title, no text, nothing but that it changed");
    return body;
  };
  /** Everything after `since`, page by page, as a phone would: each thing once (its newest change), and where to go on from. */
  const catchUp = async (since: number) => {
    const seen = new Map<string, number>();
    let at = since, pages = 0;
    for (;;) {
      const page = await changes(at, 2);
      assert.equal(page.reset, false, "no reset: the ledger still holds the gap");
      for (const item of page.items) seen.set(`${item.type}:${item.id}`, item.seq);
      assert.ok(page.durableSeq >= at);
      at = page.durableSeq; pages += 1;
      if (!page.hasMore) return { seen, at, pages };
    }
  };

  // The phone is up to date, then goes to sleep.
  const asleep = (await changes(0)).durableSeq;
  assert.ok(asleep > 0, "the agents and the seeded work are on the ledger");
  // The page's own cursor now: its 512-frame live ring is what is about to wrap.
  const pageCursor = (await fetch(`${box.url()}/api/me`, { headers: box.operator })).headers.get("x-lumen-event-cursor")!;

  // 600 changes while it sleeps: notes on Dee's two pieces of work, and on Pat's errand, which Dee may not read.
  const touched = [ids.t1, ids.t2, ids.t3];
  for (let n = 0; n < 600; n += 1) {
    const answer = await fetch(`${box.url()}/api/tasks/update`, { method: "POST", headers: box.operator, body: JSON.stringify({ id: touched[n % 3], note: `step ${n}` }) });
    assert.equal(answer.status, 200, await answer.text());
  }
  // The page's live replay has lost the gap: proof the phone could not have caught up from it.
  const page = await eventsUntilReadyOrReset(await fetch(`${box.url()}/api/events`, { headers: { ...box.operator, "last-event-id": pageCursor } }));
  assert.ok(page.includes('"type":"reset"'), "the page's 512-frame ring was wrapped");

  // The server restarts; the phone wakes after it.
  await box.restart();
  const fresh = await box.mint({ principalId: "dee", label: "after", scopes: ["work:read"] }); // the store came back too
  assert.ok(fresh.token.startsWith("lbxp_"));
  const after = await catchUp(asleep);
  assert.deepEqual([...after.seen.keys()].sort(), [`work:${ids.t1}`, `work:${ids.t2}`].sort(), "the two pieces of work Dee may read, once each; nothing of Pat's errand");
  assert.ok(after.pages > 1, "and it came in pages");
  // Work made after the restart follows on from where the phone now is, with a sequence that kept rising.
  const made = await fetch(`${box.url()}/api/tasks`, { method: "POST", headers: box.operator, body: JSON.stringify({ title: "After the restart", assigneeId: ids.writer }) }); // held by an agent in Dee's box, so Dee may read it
  const madeId = ((await made.json()) as { task?: { id: string }; id?: string }).task?.id;
  const next = await changes(after.at);
  assert.ok(next.items.some(item => item.type === "work" && item.id === madeId && item.seq > after.at), JSON.stringify(next.items));
  assert.deepEqual((await changes(next.durableSeq)).items, [], "and then nothing more");

  // The stream resumes from the same ledger: from where the phone slept, the same set, then ready at the newest position.
  const replay = await eventsUntilReady(await box.call(op("streamEvents"), { token: dee, headers: { "last-event-id": String(asleep) } }));
  const replayed = replay.filter(entry => entry.event === "change").map(entry => `${entry.data.type}:${entry.data.id}`);
  assert.deepEqual(new Set(replayed), new Set([`work:${ids.t1}`, `work:${ids.t2}`, `work:${madeId}`]));
  assert.equal(replayed.length, new Set(replayed).size, "each thing once");
  assert.ok(replay.every(entry => entry.event !== "change" || entry.id === String(entry.data.seq)), "an event's id is its record's seq");
  const ready = replay.at(-1)!;
  assert.deepEqual([ready.event, Number(ready.id)], ["ready", next.durableSeq]);

  // A position the ledger does not hold — from another installation, or past what is kept — is a reset, said the same way on both.
  const beyond = await changes(next.durableSeq + 1000);
  assert.deepEqual([beyond.reset, beyond.items.length, beyond.durableSeq], [true, 0, next.durableSeq]);
  const resetStream = await eventsUntilReady(await box.call(op("streamEvents"), { token: dee, headers: { "last-event-id": String(next.durableSeq + 1000) } }));
  assert.deepEqual(resetStream[0], { event: "reset", data: { durableSeq: next.durableSeq } });

  // Live: a change made while the stream is open arrives as it happens; one Dee may not read does not.
  const live = await box.call(op("streamEvents"), { token: dee });
  const reader = live.body!.getReader();
  let text = "";
  const until = async (pattern: RegExp) => { while (!pattern.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); } };
  await until(/event: ready\n/);
  for (const id of [ids.t3, ids.t1]) await (await fetch(`${box.url()}/api/tasks/update`, { method: "POST", headers: box.operator, body: JSON.stringify({ id, note: "live" }) })).body?.cancel();
  await until(new RegExp(`"id":"${ids.t1}"`));
  await reader.cancel();
  assert.ok(!text.includes(`"id":"${ids.t3}"`), "Pat's errand changed and Dee was not told");
  // On disk: a sequence and the routing, never a title or a note.
  const ledger = readFileSync(join(box.home, "changes.jsonl"), "utf8");
  assert.ok(!ledger.includes("step ") && !ledger.includes("Plan the issue"), "no words of the work in the ledger");
});

/** The page's stream, read until its first data line: a reset, or a replay. */
async function eventsUntilReadyOrReset(answer: Response): Promise<string> {
  const reader = answer.body!.getReader();
  let text = "";
  while (!/data: /.test(text)) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  await reader.cancel();
  return text;
}

test("a phone signs in through the organisation's door with PKCE or a page's pairing code, rotates its refresh token, and is ended — by reuse, by its person, by an Admin — with its stream closed at once and every step on the record without a token (INV-2214)", async t => {
  const box = await server(t, { door: true });
  const { op } = box;
  const post = (id: string, body: unknown, init: { token?: string; headers?: Record<string, string> } = {}) => box.call(op(id), { body, ...init });
  const json = async <T>(answer: Promise<Response> | Response, status = 200): Promise<T> => {
    const response = await answer, body = await response.json() as T;
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  type Tokens = { deviceId: string; accessToken: string; refreshToken: string; scopes: string[] };
  const dee = (await box.mint({ principalId: "dee", label: "script", scopes: SCOPE_NAMES })).token;

  // The channels, named in the reader's language.
  assert.deepEqual((await json<{ items: unknown[] }>(box.call(op("listAuthProviders"), { headers: { "accept-language": "en" } }))).items, [{ id: "ding", type: "dingtalk", displayName: "DingTalk" }]);
  assert.deepEqual((await json<{ items: { displayName: string }[] }>(box.call(op("listAuthProviders"), { headers: { "accept-language": "zh-CN" } }))).items[0]!.displayName, "钉钉");

  // PKCE: the address the app opens is this server's door, and the browser comes back to the app with a code and the app's state.
  const first = await box.doorCode("union-dee");
  assert.equal(new URL(first.authorizationUrl).origin, "https://box.example.test");
  assert.deepEqual([first.location.protocol, first.location.searchParams.get("state")], ["lumenbox:", "app-state"]);
  const exchange = (code: string | undefined, codeVerifier: string, redirectUri: string | "omit" = REDIRECT) =>
    post("exchangeOAuthCode", { code, codeVerifier, ...(redirectUri !== "omit" ? { redirectUri } : {}), deviceName: "Dee's phone", platform: "ios" });
  // The redirectUri the sign-in started with must come back, exactly (RFC 6749 §4.1.3): absent is refused before the code is looked at.
  await assertRefusal(await exchange(first.code, first.verifier, "omit"), "api-param-invalid", "no redirectUri");
  const other = await box.doorCode("union-dee");
  await assertRefusal(await exchange(other.code, other.verifier, "lumenbox://oauth/elsewhere"), "auth-code-invalid", "another redirectUri spends the code and gets nothing");
  await assertRefusal(await exchange(first.code, randomBytes(32).toString("base64url")), "auth-code-invalid", "a verifier that is not the challenge's");
  await assertRefusal(await exchange(first.code, first.verifier), "auth-code-invalid", "and the code is spent by the wrong try: it works once");
  const opened = await fetch(`${box.base}${new URL(first.authorizationUrl).pathname}${new URL(first.authorizationUrl).search}`, { redirect: "manual" });
  assert.equal(opened.status, 400, "the start's address works once too");
  await opened.body?.cancel();

  const signedIn = await box.phone();
  assert.equal(signedIn.status, "authenticated");
  assert.match(signedIn.tokens.accessToken, /^lbxd_[0-9a-f]{64}$/);
  assert.match(signedIn.tokens.refreshToken, /^lbxr_[0-9a-f]{64}$/);
  assert.deepEqual(signedIn.tokens.scopes, SCOPE_NAMES.filter(scope => scope !== "desktop:control"), "everything but driving a desktop (docs/110 §4)");
  assert.deepEqual([signedIn.me.id, signedIn.me.credential.kind, signedIn.me.credential.id], ["dee", "device", signedIn.tokens.deviceId]);
  assert.equal((await json<{ credential: { kind: string } }>(box.call(op("getMe"), { token: signedIn.tokens.accessToken }))).credential.kind, "device");

  // Somebody the organisation has not let in: their request goes to the Admins, and no credential comes back.
  const bob = await box.doorCode("union-bob");
  const asked = await json<{ status: string; tokens?: unknown; message: string }>(exchange(bob.code, bob.verifier));
  assert.deepEqual([asked.status, asked.tokens], ["asked_to_join", undefined]);
  assert.match(asked.message, /管理员/, "in the reader's language");
  // Somebody outside the organisation: the app is told why, with no code at all.
  const outsider = await box.doorCode("union-zed");
  assert.deepEqual([outsider.code, outsider.location.searchParams.get("error"), outsider.location.searchParams.get("error_description")], [undefined, "access_denied", "not-a-member"]);

  // A refresh rotates: a new pair; the spent token again within 30 seconds ends nothing; a retry with its Idempotency-Key gets the same pair.
  const refresh = (refreshToken: string, key?: string) => post("refreshDeviceToken", { refreshToken }, key !== undefined ? { headers: { "idempotency-key": key } } : {});
  const rotated = await json<Tokens>(refresh(signedIn.tokens.refreshToken, "refresh-0001"));
  assert.notEqual(rotated.refreshToken, signedIn.tokens.refreshToken);
  assert.deepEqual(await json<Tokens>(refresh(signedIn.tokens.refreshToken, "refresh-0001")), rotated, "a lost answer, asked again with its key: the same pair");
  await assertRefusal(await refresh(signedIn.tokens.refreshToken), "refresh-superseded", "the other process lost the race");
  assert.equal((await box.call(op("getMe"), { token: rotated.accessToken })).status, 200, "and nothing ended");

  // A spent refresh token presented past those 30 seconds: two holders of one token. The device ends, for both of them.
  await assertRefusal(await refresh(box.reused.spent), "access-removed", "the copy");
  await assertRefusal(await refresh(box.reused.current), "access-removed", "and the device's own current token");
  await assertRefusal(await box.call(op("getMe"), { token: box.reused.access }), "access-removed", "and its access token, at once");

  // Pairing: a QR code on Dee's signed-in page; the code signs in once.
  const shown = await box.pairingCode();
  assert.match(shown.qrSvg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.match(shown.link, /^lumenbox:\/\/pair#server=https%3A%2F%2Fbox\.example\.test&code=[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(shown.expiresAt) - Date.now() <= 120_000, "two minutes");
  const paired = await json<{ tokens: Tokens }>(post("pairDevice", { code: shown.code, deviceName: "Dee's tablet", platform: "ios" }));
  await assertRefusal(await post("pairDevice", { code: shown.code, deviceName: "again", platform: "ios" }), "pairing-code-invalid", "once");

  // Dee's devices; the one asking is marked.
  const listed = await json<{ items: { id: string; signInMethod: string; current: boolean }[] }>(box.call(op("listDevices"), { token: paired.tokens.accessToken }));
  assert.deepEqual(listed.items.map(device => [device.id, device.signInMethod, device.current]).slice(0, 2), [[paired.tokens.deviceId, "pairing", true], [signedIn.tokens.deviceId, "oauth", false]]);

  // A device deleted: its open stream ends at once (not at the next ping), and it is told to wipe what it kept.
  const stream = await box.call(op("streamEvents"), { token: rotated.accessToken });
  const reader = stream.body!.getReader();
  let text = "";
  while (!/event: ready\n/.test(text)) text += new TextDecoder().decode((await reader.read()).value);
  const deleted = Date.now();
  await json(box.call(op("deleteDevice"), { token: dee, id: signedIn.tokens.deviceId }));
  for (;;) { const { done } = await reader.read(); if (done) break; }
  assert.ok(Date.now() - deleted < 5_000, "the stream closed when the device ended");
  await assertRefusal(await box.call(op("getMe"), { token: rotated.accessToken }), "access-removed", "a deleted device");
  await assertRefusal(await refresh(rotated.refreshToken), "access-removed", "and its refresh token");
  await assertRefusal(await box.call(op("deleteDevice"), { token: dee, id: signedIn.tokens.deviceId }), "api-not-found", "deleted once");

  // A device signs itself out.
  const third = await box.phone();
  await json(box.call(op("signOutDevice"), { token: third.tokens.accessToken }));
  await assertRefusal(await box.call(op("getMe"), { token: third.tokens.accessToken }), "access-removed", "signed out");
  // An Admin takes the DingTalk sign-in from Dee: the device paired from it ends, and its open stream closes at once.
  const pairedStream = (await box.call(op("streamEvents"), { token: paired.tokens.accessToken })).body!.getReader();
  for (let seen = ""; !/event: ready\n/.test(seen);) seen += new TextDecoder().decode((await pairedStream.read()).value);
  const revoked = Date.now();
  assert.equal((await fetch(`${box.base}/api/principals/revoke-sign-in`, { method: "POST", headers: box.operator, body: JSON.stringify({ principalId: "dee", identity: "ding:dee-staff" }) })).status, 200);
  for (;;) { const { done } = await pairedStream.read(); if (done) break; }
  assert.ok(Date.now() - revoked < 5_000, "the stream closed when the sign-in was taken");
  await assertRefusal(await box.call(op("getMe"), { token: paired.tokens.accessToken }), "access-removed", "a device of a sign-in taken away");
  // A roster saved without one of Dee's sign-ins ends the devices made from it, as taking it does.
  const fifth = await json<{ tokens: Tokens }>(post("pairDevice", { code: (await box.pairingCode("feishu:ou_dee2")).code, deviceName: "Dee's tablet", platform: "android" }));
  const roster = new box.Principals().list().map(person => (person.id === "dee" ? { ...person, identities: person.identities.filter(identity => identity !== "feishu:ou_dee2") } : person));
  assert.equal((await fetch(`${box.base}/api/principals`, { method: "POST", headers: box.operator, body: JSON.stringify({ principals: roster }) })).status, 200);
  await assertRefusal(await box.call(op("getMe"), { token: fifth.tokens.accessToken }), "access-removed", "a device of a sign-in a roster save dropped");
  // Then an Admin removes Dee, and her last device — paired from her other sign-in — ends with her, as does a code shown a moment before.
  const fourth = await json<{ tokens: Tokens }>(post("pairDevice", { code: (await box.pairingCode("feishu:ou_dee")).code, deviceName: "Dee's laptop", platform: "macos" }));
  const shownBefore = await box.pairingCode("feishu:ou_dee");
  assert.equal((await fetch(`${box.base}/api/principals/remove`, { method: "POST", headers: box.operator, body: JSON.stringify({ principalId: "dee" }) })).status, 200);
  await assertRefusal(await box.call(op("getMe"), { token: fourth.tokens.accessToken }), "access-removed", "a removed person's device");
  await assertRefusal(await post("pairDevice", { code: shownBefore.code, deviceName: "late", platform: "ios" }), "pairing-code-invalid", "a code shown before the removal makes no device after it");

  // On the record: who signed in which device, each rotation, each end and why — and no token anywhere.
  const ledger = readFileSync(join(box.home, "tokens.jsonl"), "utf8"), lines = ledger.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const of = (id: string) => lines.filter(line => line.kind === "device" && line.id === id).map(line => [line.event, line.reason ?? line.method, line.by]);
  assert.deepEqual(of(signedIn.tokens.deviceId), [["minted", "oauth", "ding:dee-staff"], ["rotated", undefined, "dee"], ["revoked", "removed", "dee"]]);
  assert.deepEqual(of(box.reused.deviceId), [["revoked", "refresh-reuse", "refresh-reuse"]], "the family ended for a reuse");
  assert.deepEqual(of(third.tokens.deviceId).at(-1), ["revoked", "signed-out", "dee"]);
  assert.deepEqual(of(paired.tokens.deviceId), [["minted", "pairing", "dee"], ["revoked", "access-ended", "operator"]]);
  assert.deepEqual(of(fourth.tokens.deviceId), [["minted", "pairing", "dee"], ["revoked", "access-ended", "operator"]]);
  assert.deepEqual(of(fifth.tokens.deviceId), [["minted", "pairing", "dee"], ["revoked", "access-ended", "operator"]]);
  assert.ok(lines.some(line => line.event === "pairing-shown" && line.for === "dee" && line.by === "ding:dee-staff" && typeof line.signedInAt === "string"));
  const stored = readFileSync(join(box.home, "devices.json"), "utf8");
  for (const token of [signedIn.tokens.accessToken, signedIn.tokens.refreshToken, rotated.refreshToken, paired.tokens.accessToken, shown.code]) {
    assert.ok(!ledger.includes(token) && !stored.includes(token), "never a token or a code on disk");
  }
  assert.ok(!readFileSync(join(box.home, "client-api-idempotency.jsonl"), { encoding: "utf8", flag: "a+" }).includes("lbxr_"), "a replayed pair is kept in memory, never in the file");
  assert.match(readFileSync(join(box.home, "sign-ins.jsonl"), "utf8"), /"door":"client-api","outcome":"failed"[^\n]*"reason":"auth-code"/, "a code that did not work is a sign-in try");
});

test("minting a token or showing a pairing code needs a sign-in in the last ten minutes; an older session or one from before the field still reads the page (INV-2318)", async t => {
  const box = await server(t, { door: true });
  const { sessionKey, SESSION_COOKIE } = await import("../session.ts");
  const post = (path: string, cookie: string, body: unknown) => fetch(`${box.base}${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
  const mints: [string, unknown][] = [["/api/client-tokens", { scopes: ["work:read"] }], ["/api/mcp/tokens", { label: "ide" }], ["/api/devices/pairing", {}]];
  // A cookie from before the sign-in time was signed into it: `identity|epoch`, as the server signed one before.
  const payload = "ding:dee-staff|0";
  const legacy = `${SESSION_COOKIE}=${encodeURIComponent(`${payload}.${createHmac("sha256", sessionKey("t0k")).update(payload).digest("hex").slice(0, 32)}`)}`;
  for (const [cookie, what] of [[legacy, "a cookie with no sign-in time"], [box.session("ding:dee-staff", 11 * 60_000), "a sign-in eleven minutes ago"]] as const) {
    assert.equal((await fetch(`${box.base}/api/me`, { headers: { cookie } })).status, 200, `${what} reads the page`);
    for (const [path, body] of mints) {
      const refused = await post(path, cookie, body);
      const answer = await refused.json() as { code: string; error: string };
      assert.deepEqual([refused.status, answer.code], [403, "sign-in-again"], `${what} mints nothing at ${path}`);
      assert.match(answer.error, /10/, "and says how recent");
    }
  }
  // An Admin whose sign-in is stale cannot launder it through an invite: an invite is a credential too, so making one
  // needs the same recent sign-in — for themselves, and for a new Admin — and so does a box's connection code.
  const staleAnn = box.session("ding:ann-staff", 11 * 60_000);
  assert.equal((await post("/api/client-tokens", staleAnn, { scopes: ["work:read"] })).status, 403);
  for (const body of [{ principalId: "ann" }, { role: "admin" }]) {
    const invite = await post("/api/channels/invite", staleAnn, body);
    const answer = await invite.json() as { code: string };
    assert.deepEqual([invite.status, answer.code], [403, "sign-in-again"], `an invite ${JSON.stringify(body)} from a stale sign-in`);
  }
  const connect = await post("/api/boxes/connect-codes", staleAnn, {});
  assert.deepEqual([connect.status, ((await connect.json()) as { code: string }).code], [403, "sign-in-again"], "a box's connection code from a stale sign-in");
  // Fresh, the invite works, and redeeming it is a sign-in of its own; what it was made with is on the record.
  const freshInvite = await post("/api/channels/invite", box.session("ding:ann-staff"), { principalId: "ann" });
  assert.equal(freshInvite.status, 200);
  const inviteLine = readFileSync(join(box.home, "tokens.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>).find(line => line.kind === "invite")!;
  assert.deepEqual([inviteLine.for, inviteLine.by, typeof inviteLine.signedInAt], ["ann", "ding:ann-staff", "string"], "the invite on the record, with the sign-in it relied on");
  const inviteCode = ((await freshInvite.json()) as { code: string }).code;
  assert.ok(!JSON.stringify(inviteLine).includes(inviteCode), "never the code");
  // Nor may a stale sign-in read a live invite's code off the people list: it would redeem into a fresh session.
  const listed = async (cookie: string) => JSON.stringify(await (await fetch(`${box.base}/api/people`, { headers: { cookie } })).json());
  assert.ok(!(await listed(staleAnn)).includes(inviteCode), "a stale sign-in sees the invite, not its code");
  assert.ok((await listed(box.session("ding:ann-staff"))).includes(inviteCode), "a recent one sees the code");

  // Signed in again through the door: the new cookie carries the time, and the mint names it on the record.
  const entry = await fetch(`${box.base}/auth/ding`, { redirect: "manual" });
  const state = new URL(entry.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${box.base}/auth/ding/callback?state=${state}&code=union-dee`, { redirect: "manual", headers: { cookie: entry.headers.getSetCookie()[0]!.split(";")[0]! } });
  const cookie = back.headers.getSetCookie()[0]!.split(";")[0]!;
  for (const [path, body] of mints) assert.equal((await post(path, cookie, body)).status, 200, `a fresh sign-in mints at ${path}`);
  const minted = readFileSync(join(box.home, "tokens.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; kind: string; by: string; signedInAt?: string }).filter(line => line.by === "ding:dee-staff");
  assert.deepEqual(minted.map(line => [line.event, line.kind]), [["minted", "personal"], ["minted", "side-door"], ["pairing-shown", "device"]]);
  assert.ok(minted.every(line => line.signedInAt !== undefined && Date.now() - Date.parse(line.signedInAt) < 60_000), "each names the sign-in it relied on");
  // The installation's own credential is not asked: the operator is the token holder, not a cookie somebody copied.
  assert.equal((await fetch(`${box.base}/api/client-tokens`, { method: "POST", headers: box.operator, body: JSON.stringify({ principalId: "dee", scopes: ["work:read"] }) })).status, 200);
});


test("decisions from a phone: the page's own inbox, an outside action allowed only with the device's step-up proof and never `always`, a draft edited and sent, a question answered, a close kept open, each recorded with the person and the device, and a wake-only push's words while the item still waits (INV-2214)", async t => {
  const box = await server(t, { door: true });
  const { op } = box;
  const read = async <T>(answer: Promise<Response>, status = 200): Promise<T> => { const response = await answer, body = await response.json() as T; assert.equal(response.status, status, JSON.stringify(body)); return body; };
  type Item = { id: string; kind: string; actions: string[]; stepUpRequired: boolean; approval?: { scopes: string[]; tier?: string }; question?: { conversation: string } };
  const inbox = async (token: string) => (await read<{ items: Item[] }>(box.call(op("listInbox"), { token }))).items;
  const phone = await box.keyedPhone();
  const script = (await box.mint({ principalId: "dee", label: "script", scopes: SCOPE_NAMES })).token;
  const viewer = (await box.mint({ principalId: "vic", label: "v", scopes: SCOPE_NAMES })).token;

  // What waits on Dee, as the page lists it: Pat's approval is in a box she may not enter, and the draft's consent is the draft.
  const items = await inbox(phone.token);
  assert.deepEqual(items.map(item => item.id).sort(), ["approval:ap-reach", "approval:ap-self", "close-proposal:t1", "outbox:dr-1", `question:${box.questionId}`].sort());
  const reach = items.find(item => item.id === "approval:ap-reach")!, self = items.find(item => item.id === "approval:ap-self")!;
  assert.deepEqual([reach.stepUpRequired, reach.approval?.tier, self.stepUpRequired, self.approval?.tier], [true, "reach", false, "self"], "the gate's own tiers decide the step-up");
  assert.deepEqual(items.find(item => item.kind === "outbox")!.stepUpRequired, true, "a draft goes outside the box");
  // Paging: a cursor names the item it stopped at; answered meanwhile, the cursor is refused rather than the list restarting.
  const first = await read<{ items: Item[]; nextCursor?: string }>(box.call(op("listInbox"), { token: phone.token, query: "?limit=1" }));
  assert.equal(first.items[0]!.id, "outbox:dr-1", "what stops work comes first");
  // A viewer sees what waits in the boxes they are in, and answers none of it.
  assert.ok((await inbox(viewer)).every(item => item.actions.length === 0 || item.actions.join() === "open-on-page"));

  // An outside action: a script cannot allow it, `always` is never granted, a wrong proof is refused, the right one allows it.
  const allow = (token: string, body: Record<string, unknown>) => box.call(op("decideApproval"), { token, id: "ap-reach", body: { decision: "allow", ...body } });
  await assertRefusal(await allow(script, { scope: "once" }), "step-up-required", "a token with no step-up key");
  await assertRefusal(await allow(phone.token, { scope: "always", stepUp: phone.proof("ap-reach", "allow:always") }), "approval-always-refused", "always, even with a proof");
  await assertRefusal(await allow(phone.token, { scope: "session", stepUp: phone.proof("ap-reach", "allow:once") }), "step-up-invalid", "a proof for another decision");
  await assertRefusal(await allow(phone.token, { scope: "once", stepUp: { keyId: "key-2", signature: phone.proof("ap-reach", "allow:once").signature } }), "step-up-invalid", "another key's name");
  assert.deepEqual((await read<{ outcome: string }>(allow(phone.token, { scope: "session", stepUp: phone.proof("ap-reach", "allow:session") }))).outcome, "allowed");
  await assertRefusal(await allow(phone.token, { scope: "session", stepUp: phone.proof("ap-reach", "allow:session") }), "api-not-found", "answered once: the same proof again is nothing");
  // An action that stays in the box needs no proof; refusing never does.
  assert.equal((await read<{ outcome: string }>(box.call(op("decideApproval"), { token: script, id: "ap-self", body: { decision: "deny", reason: "wrong file" } }))).outcome, "denied");
  await assertRefusal(await box.call(op("decideApproval"), { token: phone.token, id: "ap-pat", body: { decision: "deny" } }), "api-not-found", "Pat's approval is not Dee's to know of");

  // The draft, edited: the proof covers the words that will go.
  const words = "The December issue is out — with the blue cover.";
  const digest = createHash("sha256").update(words).digest("base64url");
  await assertRefusal(await box.call(op("answerInboxItem"), { token: phone.token, id: "outbox:dr-1", body: { action: "edit", body: words, stepUp: phone.proof("outbox:dr-1", "edit", createHash("sha256").update("other words").digest("base64url")) } }), "step-up-invalid", "a proof for other words");
  // A wake-only push for the draft, while it waits: its words come from here, for Dee.
  const seq = await box.inboxSeq(phone.token, "outbox:dr-1");
  const pushed = await read<{ itemId: string; kind: string; title: string }>(box.call(op("getNotification"), { token: phone.token, id: String(seq) }));
  assert.deepEqual([pushed.itemId, pushed.kind], ["outbox:dr-1", "outbox"]);
  // Pat's approval, in Pat's own box: Dee is not told of its change, and its seq gives Dee no words.
  const patSeq = await box.inboxSeq((await box.mint({ principalId: "pat", label: "pat", scopes: SCOPE_NAMES })).token, "approval:ap-pat");
  const deeChanges = await read<{ items: { type: string; id: string }[] }>(box.call(op("getChanges"), { token: phone.token, query: "?since=0&limit=1000" }));
  assert.ok(!deeChanges.items.some(item => item.id === "approval:ap-pat"), "not in Dee's changes");
  await assertRefusal(await box.call(op("getNotification"), { token: phone.token, id: String(patSeq) }), "api-not-found", "a seq for what does not wait on Dee: no words");
  assert.equal((await read<{ outcome: string }>(box.call(op("answerInboxItem"), { token: phone.token, id: "outbox:dr-1", body: { action: "edit", body: words, stepUp: phone.proof("outbox:dr-1", "edit", digest) } }))).outcome, "edited");
  await assertRefusal(await box.call(op("getNotification"), { token: phone.token, id: String(seq) }), "api-not-found", "answered: the push says nothing more");
  await assertRefusal(await box.call(op("listInbox"), { token: phone.token, query: `?limit=1&cursor=${first.nextCursor}` }), "api-cursor-invalid", "the cursor's item was answered");

  // The question, answered in words: it no longer waits on Dee.
  assert.equal((await read<{ outcome: string }>(box.call(op("answerInboxItem"), { token: phone.token, id: `question:${box.questionId}`, body: { action: "answer", text: "The blue one." } }))).outcome, "answered");
  // The close proposal, refused.
  assert.equal((await read<{ outcome: string }>(box.call(op("decideWork"), { token: phone.token, id: box.ids.t1, body: { decision: "keep-open", note: "The photographs are missing." } }))).outcome, "kept-open");
  assert.deepEqual((await inbox(phone.token)).map(item => item.id), [], "nothing waits on Dee now");

  // On the record: who answered, with which device; the edited words on the draft.
  const policy = readFileSync(join(box.home, "policy.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const granted = policy.find(line => line.kind === "approval-granted-session" && line.id === "ap-reach")!;
  assert.equal(granted.by, `user:dee device:${phone.deviceId}`, "for this session, by Dee, from this device");
  assert.match(String(policy.find(line => line.kind === "approval-denied" && line.id === "ap-self")?.by), /^user:dee token:tok_/);
  assert.match(String(policy.find(line => line.kind === "approval-granted" && line.id === "ap-draft")?.by), new RegExp(`^user:dee device:${phone.deviceId}$`));
  assert.match(readFileSync(join(box.home, "outbox-drafts.jsonl"), "utf8"), /"decision":"approved"[^\n]*"body":"The December issue is out — with the blue cover."/);
});
