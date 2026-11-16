/**
 * Poppy end to end on a scripted network (INV-1893, INV-1895): every request the real PoppyManager makes
 * goes through `usePoppyTransport`, so nothing here reaches the network and each test can say
 * exactly what a Company — honest or not — answers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { clearDiscoveryCache } from "./discovery.ts";
import { PoppyRefused, poppyGetFollowing, poppyRequest, usePoppyTransport, type PoppyRequest } from "./http.ts";
import { PoppyManager } from "./manager.ts";
import { clearAuthServerCache } from "./oauth.ts";
import { dispatchPoppyTool } from "../poppy-tools.ts";

interface Call { url: string; method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }
type Handler = (call: Call) => Response | Promise<Response>;

let calls: Call[] = [];
let routes: Record<string, Handler> = {};
let home = "";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A Company's poppy.json, served at its own domain. */
function company(domain: string, extra: Record<string, unknown> = {}): Handler {
  return () => json({ protocol_version: "1.0", organization: { name: domain, domain }, agent: { protocols: [{ type: "poppy", endpoint: `https://${domain}/poppy/chat` }] }, ...extra });
}

/** An authorization server for `issuer`, whose token endpoint answers with `tokens`. */
function authServer(issuer: string, tokens: Handler): void {
  routes[`${issuer}/.well-known/oauth-authorization-server`] = () => json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
  routes[`${issuer}/token`] = tokens;
}

/**
 * A spec conversation endpoint (8.2–8.7) at `base`: a POST starts one or adds a message, and the
 * Company's reply is `reply(text, body)` — events it records, optionally still `working` for the
 * next read. Every message the agent sent is kept in `sent`.
 */
function conversationAt(base: string, reply: (body: Record<string, unknown>) => { events: Record<string, unknown>[]; working?: boolean }[]): { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  let queue: { events: Record<string, unknown>[]; working?: boolean }[] = [];
  let n = 0;
  const read = () => {
    const next = queue.shift() ?? { events: [] };
    return json({ conversation_id: "cnv_1", events: next.events, cursor: next.events.at(-1)?.id ?? `evt_${n}`, has_more: false, working: next.working === true || queue.length > 0, handoff: "none", responder: "agent", closed: false });
  };
  const post = (call: Call, status: number) => {
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    sent.push(body);
    queue = reply(body);
    const response = read();
    return new Response(response.body, { status, headers: response.headers });
  };
  routes[base] = call => post(call, 201);
  routes[`${base}/cnv_1/messages`] = call => post(call, 202);
  routes[`${base}/cnv_1/events`] = () => read();
  return { sent };
}

/** A Company message event, optionally carrying an operation or a decline. */
function said(id: string, text: string, operations?: Record<string, unknown>): Record<string, unknown> {
  return { id, type: "message", created_at: "2026-11-16T10:00:00Z", message: { role: "company", author: { type: "agent" }, text, ...(operations ? { extensions: { operations } } : {}) } };
}

/** An operation as the Operations extension v3 shapes it. */
function operation(id = "exc_1", revision = "rev_1"): Record<string, unknown> {
  return { operation_id: id, revision, summary: "Exchange the jacket for $70 more.", terms: { order_id: "ord_7", price_difference: { amount: "70.00", currency: "USD" } }, expires_at: "2099-01-01T00:00:00Z" };
}

function payloadOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

async function manager(): Promise<PoppyManager> {
  const made = new PoppyManager({ home, origin: "https://agent.example" });
  await made.init();
  return made;
}

/** Signs `who` in at `domain` through the real code-flow path: start, callback, token exchange. */
async function signIn(mgr: PoppyManager, domain: string, who: string): Promise<void> {
  const started = await mgr.startSignIn(domain, who);
  assert.ok(started, `${domain} offers sign-in`);
  await mgr.handleCallback("code-1", started.state);
}

beforeEach(() => {
  calls = [];
  routes = {};
  home = mkdtempSync(join(tmpdir(), "poppy-protocol-"));
  clearDiscoveryCache();
  clearAuthServerCache();
  usePoppyTransport(async (url: URL, init: PoppyRequest) => {
    const call: Call = { url: url.toString(), method: init.method ?? "GET", headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}), ...(init.signal ? { signal: init.signal } : {}) };
    calls.push(call);
    const route = routes[`${url.origin}${url.pathname}`];
    return route ? route(call) : new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  usePoppyTransport();
  rmSync(home, { recursive: true, force: true });
});

describe("the door every Poppy request goes through", () => {
  test("only https, no credentials in the URL, no inside address, and on the site that named it", async () => {
    await assert.rejects(poppyRequest("http://shop.example/x"), PoppyRefused);
    await assert.rejects(poppyRequest("https://user:pw@shop.example/x"), PoppyRefused);
    await assert.rejects(poppyRequest("https://127.0.0.1/x"), PoppyRefused);
    await assert.rejects(poppyRequest("https://[::1]/x"), PoppyRefused);
    await assert.rejects(poppyRequest("https://169.254.169.254/latest/meta-data"), PoppyRefused);
    await assert.rejects(poppyRequest("https://other.example/x", {}, "shop.example"), PoppyRefused);
    await assert.rejects(poppyRequest("https://shop.example.evil.example/x", {}, "shop.example"), PoppyRefused, "a suffix that is not a label boundary");
    await poppyRequest("https://api.shop.example/x", {}, "shop.example");
    assert.deepEqual(calls.map(call => call.url), ["https://api.shop.example/x"], "only the last one was ever sent");
  });

  test("a redirect is refused, except in discovery, where each hop is checked again", async () => {
    routes["https://shop.example/go"] = () => new Response(null, { status: 302, headers: { location: "https://127.0.0.1/admin" } });
    await assert.rejects(poppyRequest("https://shop.example/go"), PoppyRefused);
    await assert.rejects(poppyGetFollowing("https://shop.example/go", {}, "shop.example"), PoppyRefused, "followed, but not to an inside address");
    routes["https://shop.example/plain"] = () => new Response(null, { status: 301, headers: { location: "http://shop.example/x" } });
    await assert.rejects(poppyGetFollowing("https://shop.example/plain", {}, "shop.example"), PoppyRefused, "nor down to http");
  });

  test("the real transport resolves a name through the guarded lookup: localhost is refused before any connection", async () => {
    usePoppyTransport();
    await assert.rejects(poppyRequest("https://localhost/x"), /resolves to/);
  });
});

describe("endpoints a Company names", () => {
  test("an endpoint a Company lists at an inside address is never called", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { agent: { protocols: [{ type: "poppy", endpoint: "https://127.0.0.1:7890/api/agents" }] } });
    const result = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "hi" }, { manager: await manager(), who: "ada", conversation: "main" });
    assert.match(result.text, /^Refused/);
    assert.deepEqual(calls.filter(call => call.method === "POST"), [], "nothing was posted anywhere");
  });

  test("PoppyRequest goes only to destinations: the domain's own pages and what its documents list, never elsewhere", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { apis: [{ type: "openapi", url: "https://api.shop.example/openapi.json" }] });
    routes["https://shop.example/orders"] = () => json({ orders: [] });
    routes["https://api.shop.example/v1/orders"] = () => json({ orders: [1] });
    const mgr = await manager();
    const ctx = { manager: mgr, who: "ada", conversation: "main" };
    assert.match((await dispatchPoppyTool("PoppyRequest", { url: "https://shop.example/orders" }, ctx)).text, /^HTTP 200/);
    assert.match((await dispatchPoppyTool("PoppyRequest", { url: "https://api.shop.example/v1/orders", domain: "shop.example" }, ctx)).text, /^HTTP 200/, "the host its API is described on");
    for (const url of ["https://other.example/x", "https://www.shop.example/orders", "http://shop.example/orders"]) {
      assert.match((await dispatchPoppyTool("PoppyRequest", { url, domain: "shop.example" }, ctx)).text, /^Refused/, url);
    }
    const signed = calls.filter(call => call.headers["Poppy-Session"] !== undefined).map(call => call.url);
    assert.deepEqual(signed, ["https://shop.example/orders", "https://api.shop.example/v1/orders"]);
  });

  test("the agent cannot set credentials or the headers this host signs", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    routes["https://shop.example/orders"] = () => json({});
    await dispatchPoppyTool("PoppyRequest", { url: "https://shop.example/orders", headers: { Authorization: "Bearer stolen", Cookie: "s=1", "Poppy-Session": "forged", "UCP-Agent": "profile=\"x\"", Accept: "application/json" } }, { manager: await manager(), who: "ada", conversation: "main" });
    const sent = calls.at(-1)!.headers;
    assert.equal(sent.Authorization, undefined);
    assert.equal(sent.Cookie, undefined);
    assert.notEqual(sent["Poppy-Session"], "forged");
    assert.equal(sent["UCP-Agent"], undefined, "not a UCP service");
    assert.equal(sent.Accept, "application/json");
  });

  test("an authorization server whose metadata names another issuer, or an off-site token endpoint, is not used", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    routes["https://auth.shop.example/.well-known/oauth-authorization-server"] = () => json({ issuer: "https://auth.shop.example", authorization_endpoint: "https://auth.shop.example/a", token_endpoint: "https://collector.example/token" });
    const mgr = await manager();
    assert.equal(await mgr.startSignIn("shop.example", "ada"), null);
  });
});

describe("tokens", () => {
  test("a site whose poppy.json redirects to another Company's is not taken for it, so its pages never carry that Company's token", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    routes["https://attacker.example/.well-known/poppy.json"] = () => new Response(null, { status: 302, headers: { location: "https://shop.example/.well-known/poppy.json" } });
    authServer("https://auth.shop.example", () => json({ access_token: "at_shop", expires_in: 3600 }));
    const mgr = await manager();
    await signIn(mgr, "shop.example", "ada");
    assert.deepEqual(await mgr.headersFor("GET", "https://attacker.example/page", "ada"), {});
    assert.equal(await mgr.discover("attacker.example"), null);
  });

  test("a refresh that comes back after a new sign-in does not overwrite or delete it", async () => {
    let release: () => void = () => {};
    let signIns = 0;
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    authServer("https://auth.shop.example", async call => {
      if (call.body?.includes("grant_type=refresh_token")) {
        await new Promise<void>(resolve => { release = resolve; });
        return json({ error: "invalid_grant" }, 400);
      }
      signIns++;
      return json({ access_token: `at_signin_${signIns}`, expires_in: signIns === 1 ? 1 : 3600, refresh_token: `rt_${signIns}` });
    });
    const mgr = await manager();
    await signIn(mgr, "shop.example", "ada");
    const stale = mgr.headersFor("GET", "https://shop.example/a", "ada");
    while (calls.filter(call => call.body?.includes("refresh_token")).length === 0) await new Promise(resolve => setImmediate(resolve));
    await signIn(mgr, "shop.example", "ada");
    release();
    assert.equal((await stale).Authorization, "Bearer at_signin_2", "the answer about the old grant is not applied to the new one");
    assert.equal((await mgr.headersFor("GET", "https://shop.example/b", "ada")).Authorization, "Bearer at_signin_2");
  });

  test("a site that claims another Company's issuer gets none of its tokens, and another agent's sign-in is not this one's", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    routes["https://evil.example/.well-known/poppy.json"] = company("evil.example", { auth: { issuer: "https://auth.shop.example" } });
    authServer("https://auth.shop.example", () => json({ access_token: "at_shop", expires_in: 3600, refresh_token: "rt_shop" }));
    const mgr = await manager();
    await signIn(mgr, "shop.example", "ada");
    assert.equal((await mgr.headersFor("GET", "https://shop.example/orders", "ada")).Authorization, "Bearer at_shop");
    assert.equal((await mgr.headersFor("GET", "https://evil.example/orders", "ada")).Authorization, undefined);
    assert.equal((await mgr.headersFor("GET", "https://shop.example/orders", "bob")).Authorization, undefined);
    assert.equal(statSync(join(home, "poppy-tokens.json")).mode & 0o777, 0o600);
  });

  test("one refresh at a time; a 503 keeps the token, only invalid_grant ends it", async () => {
    let refreshes = 0;
    let answer: () => Response = () => json({ access_token: "at_1", expires_in: 1 });
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    authServer("https://auth.shop.example", call => {
      if (call.body?.includes("grant_type=refresh_token")) {
        refreshes++;
        return answer();
      }
      return json({ access_token: "at_0", expires_in: 1, refresh_token: "rt_0" });
    });
    const mgr = await manager();
    await signIn(mgr, "shop.example", "ada");

    answer = () => json({ access_token: "at_1", expires_in: 1 });
    const both = await Promise.all([mgr.headersFor("GET", "https://shop.example/a", "ada"), mgr.headersFor("GET", "https://shop.example/b", "ada")]);
    assert.equal(refreshes, 1, "two requests that found it stale shared one refresh");
    assert.deepEqual(both.map(h => h.Authorization), ["Bearer at_1", "Bearer at_1"]);

    answer = () => json({ error: "temporarily_unavailable" }, 503);
    await mgr.headersFor("GET", "https://shop.example/c", "ada");
    answer = () => json({ access_token: "at_2", expires_in: 3600 });
    assert.equal((await mgr.headersFor("GET", "https://shop.example/d", "ada")).Authorization, "Bearer at_2", "the refresh token survived the 503 and the refresh without a new one");

    // Signed in afresh with a token about to lapse, then the server ends the grant.
    await signIn(mgr, "shop.example", "ada");
    answer = () => json({ error: "invalid_grant" }, 400);
    assert.equal((await mgr.headersFor("GET", "https://shop.example/e", "ada")).Authorization, undefined);
    assert.equal(mgr.hasTokenFor("shop.example", "ada"), false, "the refused grant is gone");
  });
});

describe("sessions", () => {
  test("headers only over https; the session JWT expires; User IDs last across restarts and differ per agent", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    const mgr = await manager();
    assert.deepEqual(await mgr.headersFor("GET", "http://shop.example/page", "ada"), {});
    const headers = await mgr.headersFor("GET", "https://shop.example/page", "ada");
    const payload = payloadOf(headers["Poppy-Session"]!);
    assert.equal(typeof payload.exp, "number");
    assert.ok((payload.exp as number) - (payload.iat as number) <= 60);

    const again = payloadOf((await (await manager()).headersFor("GET", "https://shop.example/page", "ada"))["Poppy-Session"]!);
    assert.equal(again.sub, payload.sub, "the same User after a restart");
    const bob = payloadOf((await mgr.headersFor("GET", "https://shop.example/page", "bob"))["Poppy-Session"]!);
    assert.notEqual(bob.sub, payload.sub, "a different agent is a different User");
    assert.equal(statSync(join(home, "poppy-user-ids.json")).mode & 0o777, 0o600);
  });
});

describe("conversations (spec 8)", () => {
  test("a message starts a conversation, the reply is read until the Company stops working, and the next message continues it", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    const { sent } = conversationAt("https://shop.example/poppy/chat", body => {
      const text = (body.message as { text?: string }).text;
      return text === "hi" ? [{ events: [said("e1", "Hello")], working: true }, { events: [said("e2", "How can I help?")] }] : [{ events: [said("e3", `You said: ${text}`)] }];
    });
    const mgr = await manager();
    const ctx = { manager: mgr, who: "ada", conversation: "main" };
    const first = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "hi" }, ctx);
    assert.match(first.text, /Conversation cnv_1/);
    assert.match(first.text, /Hello[\s\S]*How can I help\?/, "the second read, while it was still working, is part of the reply");
    const second = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "medium", conversation_id: "cnv_1" }, ctx);
    assert.match(second.text, /You said: medium/);
    assert.doesNotMatch(second.text, /Hello/, "events already handled are not shown again");
    assert.deepEqual(sent.map(body => (body.message as { author?: unknown }).author), [{ type: "agent" }, { type: "agent" }]);
    assert.ok(sent.every(body => typeof body.id === "string" && /^[A-Za-z0-9_-]+$/.test(body.id as string)), "every POST carries a request id");
    assert.equal((sent[1]!.message as { as_of_cursor?: unknown }).as_of_cursor, "e2", "the reply it had read");
    const posts = calls.filter(call => call.method === "POST").map(call => new URL(call.url));
    assert.deepEqual(posts.map(url => url.pathname), ["/poppy/chat", "/poppy/chat/cnv_1/messages"]);
    assert.ok(posts.every(url => url.searchParams.has("wait")), "the reply is asked for in the same response");
  });
});

describe("a Company that changes its poppy.json", () => {
  test("is met with what it says now", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    conversationAt("https://shop.example/poppy/chat", () => [{ events: [said("e1", "old")] }]);
    conversationAt("https://shop.example/v2/chat", () => [{ events: [said("e1", "new")] }]);
    const ctx = { manager: await manager(), who: "ada", conversation: "main" };
    assert.match((await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "hi" }, ctx)).text, /old/);
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { agent: { protocols: [{ type: "poppy", endpoint: "https://shop.example/v2/chat" }] } });
    clearDiscoveryCache();
    assert.match((await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "hi" }, ctx)).text, /new/);
  });
});

describe("a Company's operation (Operations extension v3)", () => {
  test("an API's approval_required goes to the person; their approval resends the same request with Poppy-Approval", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { extensions: { operations: [{ version: "3" }] } });
    routes["https://shop.example/api/exchanges"] = call => (call.headers["Poppy-Approval"] ? json({ exchange: "done" }) : json({ error: "approval_required", operation: operation() }, 403));
    const mgr = await manager();
    const cards: string[] = [];
    const result = await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop.example/api/exchanges", body: { item: "itm_4" } }, {
      manager: mgr, who: "ada", conversation: "c1", requestConfirmation: input => { cards.push(input.description); return { id: "ap1" }; },
    });
    assert.match(result.text, /asks for approval first/);
    assert.match(cards[0]!, /^shop\.example asks for approval \(operation exc_1, revision rev_1\)/);
    assert.match(cards[0]!, /"amount": "70\.00"/, "the card shows the terms, not only the summary");
    assert.equal(calls.filter(call => call.url.endsWith("/api/exchanges")).length, 1, "nothing is resent before the person answers");
    assert.match(calls[1]!.headers["Poppy-Extensions"] ?? "", /"operations";v="3"/);

    const told: string[] = [];
    await mgr.settleApproval("ap1", "allowed", (_agent, conversation, text) => told.push(`${conversation}: ${text}`));
    const resent = calls.at(-1)!;
    assert.equal(resent.method, "POST");
    assert.equal(resent.body, JSON.stringify({ item: "itm_4" }), "the same request");
    assert.match(resent.headers["Poppy-Approval"]!, /^operation_id="exc_1", revision="rev_1", approver="user", approved_at=\d+, input_type="tap", reference="apr_[0-9a-f]+"$/);
    assert.match(told[0]!, /^c1: The person approved .* HTTP 200/);
    await mgr.settleApproval("ap1", "allowed", () => assert.fail("answered once"));
  });

  test("declined by the person, nothing is sent; declined by the Company, the agent is told not to send it again", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    let resends = 0;
    routes["https://shop.example/api/close"] = call => {
      if (!call.headers["Poppy-Approval"]) return json({ error: "approval_required", operation: operation("cls_1") }, 403);
      resends++;
      return json({ error: "approval_declined", operation_id: "cls_1", revision: "rev_1", reason: "Only the account holder can close it." }, 403);
    };
    const mgr = await manager();
    let card = 0;
    const ctx = { manager: mgr, who: "ada", conversation: "main", requestConfirmation: () => ({ id: `ap${++card}` }) };
    await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop.example/api/close" }, ctx);
    const told: string[] = [];
    await mgr.settleApproval("ap1", "refused", (_a, _c, text) => told.push(text));
    assert.equal(resends, 0);
    assert.match(told[0]!, /declined .* Nothing was sent/);
    await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop.example/api/close" }, ctx);
    await mgr.settleApproval("ap2", "allowed", (_a, _c, text) => told.push(text));
    assert.equal(resends, 1);
    assert.match(told[1]!, /declined it: Only the account holder can close it\. Nothing was performed; do not send the approval again/);
  });

  test("a UCP MCP tool's operation is approved by calling the same tool again with the approval in _meta", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { agent: { protocols: [{ type: "ucp", endpoint: "https://shop.example/.well-known/ucp" }] }, extensions: { ucp: [{ version: "1" }] } });
    routes["https://shop.example/.well-known/ucp"] = () => json({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ version: "2026-08-25", transport: "mcp", endpoint: "https://shop-store.myshopify.example/api/ucp/mcp" }] } } });
    routes["https://shop-store.myshopify.example/api/ucp/mcp"] = call => {
      const body = JSON.parse(call.body ?? "{}") as { id: unknown; params: { _meta?: Record<string, unknown> } };
      return body.params._meta?.["personalagentprotocol.org/approval"]
        ? json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { id: "chk_1", status: "completed", continue_url: "https://shop.example/checkout/chk_1" } } })
        : json({ jsonrpc: "2.0", id: body.id, result: { isError: true, content: [{ type: "text", text: "Needs approval" }], structuredContent: { operation: operation("chk_1") } } });
    };
    const mgr = await manager();
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "complete_checkout", arguments: { id: "chk_1" } } };
    const result = await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop-store.myshopify.example/api/ucp/mcp", domain: "shop.example", body: call }, {
      manager: mgr, who: "ada", conversation: "main", requestConfirmation: () => ({ id: "ap1" }),
    });
    assert.match(result.text, /asks for approval first/);
    const told: string[] = [];
    await mgr.settleApproval("ap1", "allowed", (_a, _c, text) => told.push(text));
    const resent = JSON.parse(calls.at(-1)!.body!) as { id: unknown; params: { name: string; arguments: Record<string, unknown>; _meta: Record<string, { operation_id: string }> } };
    assert.equal(resent.params.name, "complete_checkout", "the same tool");
    assert.equal(resent.params.arguments.id, "chk_1", "with the same arguments");
    assert.equal(resent.params._meta["personalagentprotocol.org/approval"]!.operation_id, "chk_1");
    assert.notEqual(resent.id, 1, "a new JSON-RPC request");
    assert.equal(calls.at(-1)!.headers["Poppy-Approval"], undefined, "MCP carries it in _meta, not a header");
    assert.match(told[0]!, /continue_url/);
  });

  test("in a conversation, the operation in a message goes to the person, and the approval goes back as a message", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    const { sent } = conversationAt("https://shop.example/poppy/chat", body => {
      const approval = (body.message as { extensions?: { operations?: { approval?: unknown } } }).extensions?.operations?.approval;
      return approval ? [{ events: [said("e2", "Done: the exchange is on its way.")] }] : [{ events: [said("e1", "I can exchange it for $70 more. I'll do it once you approve.", { operation: operation() })] }];
    });
    const mgr = await manager();
    const cards: string[] = [];
    const result = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "exchange it" }, { manager: mgr, who: "ada", conversation: "c1", requestConfirmation: input => { cards.push(input.description); return { id: "ap1" }; } });
    assert.match(result.text, /once you approve[\s\S]*waiting for the person/);
    assert.equal(cards.length, 1);
    assert.equal(sent.length, 1, "the Company's own words approve nothing");
    const told: string[] = [];
    await mgr.settleApproval("ap1", "allowed", (_a, _c, text) => told.push(text));
    const approval = (sent[1]!.message as { extensions: { operations: { approval: Record<string, unknown> } } }).extensions.operations.approval;
    assert.deepEqual([approval.operation_id, approval.revision, approval.approver], ["exc_1", "rev_1", "user"]);
    assert.match(told[0]!, /Done: the exchange is on its way/);
  });

  test("two Companies asking in the same words get two cards; an expired operation's approval is not sent", async () => {
    for (const domain of ["shop.example", "mall.example"]) {
      routes[`https://${domain}/.well-known/poppy.json`] = company(domain);
      routes[`https://${domain}/api/x`] = () => json({ error: "approval_required", operation: { ...operation(), expires_at: "2000-01-01T00:00:00Z" } }, 403);
    }
    const mgr = await manager();
    const cards: string[] = [];
    const ctx = { manager: mgr, who: "ada", conversation: "main", requestConfirmation: (input: { description: string }) => { cards.push(input.description); return { id: `ap${cards.length}` }; } };
    for (const domain of ["shop.example", "mall.example"]) await dispatchPoppyTool("PoppyRequest", { method: "POST", url: `https://${domain}/api/x` }, ctx);
    assert.notEqual(cards[0], cards[1]);
    const before = calls.length;
    const told: string[] = [];
    await mgr.settleApproval("ap1", "allowed", (_a, _c, text) => told.push(text));
    assert.equal(calls.length, before);
    assert.match(told[0]!, /expired/);
  });

  test("with nobody to ask, the agent is told it is not approved, and the Company is told nothing", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    routes["https://shop.example/api/buy"] = () => json({ error: "approval_required", operation: operation() }, 403);
    const result = await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop.example/api/buy" }, { manager: await manager(), who: "ada", conversation: "main" });
    assert.match(result.text, /not approved and nothing was performed/);
    assert.equal(calls.filter(call => call.url.endsWith("/api/buy")).length, 1);
  });

  test("an answer is not sent under a different sign-in than the one the operation was asked under", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    authServer("https://auth.shop.example", () => json({ access_token: `at_${calls.length}`, expires_in: 3600 }));
    routes["https://shop.example/api/refund"] = () => json({ error: "approval_required", operation: operation() }, 403);
    const mgr = await manager();
    await signIn(mgr, "shop.example", "ada");
    await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://shop.example/api/refund" }, { manager: mgr, who: "ada", conversation: "main", requestConfirmation: () => ({ id: "ap1" }) });
    await signIn(mgr, "shop.example", "ada");
    const before = calls.filter(call => call.url.endsWith("/api/refund")).length;
    const told: string[] = [];
    await mgr.settleApproval("ap1", "allowed", (_agent, _conversation, text) => told.push(text));
    assert.equal(calls.filter(call => call.url.endsWith("/api/refund")).length, before, "nothing sent");
    assert.match(told[0]!, /sign-in .* changed .* not sent/);
  });
});

describe("UCP through Poppy", () => {
  test("the services in the Company's UCP profile are destinations, even on another host, and every request names the platform profile", async () => {
    routes["https://allbirds.example/.well-known/poppy.json"] = () => json({ protocol_version: "0.4", organization: { name: "Allbirds", domain: "allbirds.example" }, agent: { protocols: [{ type: "ucp", endpoint: "https://allbirds.example/.well-known/ucp" }] }, extensions: { ucp: [{ version: "1" }] } });
    routes["https://allbirds.example/.well-known/ucp"] = () => json({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ version: "2026-08-25", transport: "mcp", endpoint: "https://weareallbirds.myshopify.example/api/ucp/mcp" }] } } });
    routes["https://weareallbirds.myshopify.example/api/ucp/mcp"] = call => json({ jsonrpc: "2.0", id: 1, result: { structuredContent: { echo: JSON.parse(call.body ?? "{}") } } });
    const mgr = await manager();
    const ctx = { manager: mgr, who: "ada", conversation: "main" };
    const discovered = await dispatchPoppyTool("PoppyDiscover", { domain: "allbirds.example" }, ctx);
    assert.match(discovered.text, /dev\.ucp\.shopping over mcp: https:\/\/weareallbirds\.myshopify\.example\/api\/ucp\/mcp/);
    assert.match(discovered.text, /continue_url/);
    const result = await dispatchPoppyTool("PoppyRequest", { method: "POST", url: "https://weareallbirds.myshopify.example/api/ucp/mcp", domain: "allbirds.example", body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_catalog", arguments: { query: "runners" } } } }, ctx);
    assert.match(result.text, /^HTTP 200/);
    const sent = calls.at(-1)!;
    const profile = "https://agent.example/poppy/ucp/2026-08-25.json";
    assert.equal(sent.headers["UCP-Agent"], `profile="${profile}"`);
    const body = JSON.parse(sent.body!) as { params: { arguments: { query: string; meta: { "ucp-agent": { profile: string } } } } };
    assert.equal(body.params.arguments.meta["ucp-agent"].profile, profile, "the same URL in both places");
    assert.equal(body.params.arguments.query, "runners");
    assert.ok(sent.headers["Poppy-Session"]);
    assert.match(sent.headers["Poppy-Extensions"] ?? "", /"ucp";v="1"/);
  });

  test("a UCP profile reached by redirect is not used", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { extensions: { ucp: [{ version: "1" }] } });
    routes["https://shop.example/.well-known/ucp"] = () => new Response(null, { status: 302, headers: { location: "https://evil.example/.well-known/ucp" } });
    routes["https://evil.example/.well-known/ucp"] = () => json({ ucp: { version: "2026-08-25", services: { "dev.ucp.shopping": [{ transport: "mcp", endpoint: "https://evil.example/mcp" }] } } });
    const mgr = await manager();
    await dispatchPoppyTool("PoppyDiscover", { domain: "shop.example" }, { manager: mgr, who: "ada", conversation: "main" });
    assert.equal(mgr.ucpProfileOf("shop.example"), null);
    assert.ok(!calls.some(call => call.url.startsWith("https://evil.example")));
    assert.match((await dispatchPoppyTool("PoppyRequest", { url: "https://evil.example/mcp", domain: "shop.example" }, { manager: mgr, who: "ada", conversation: "main" })).text, /^Refused/);
  });
});
