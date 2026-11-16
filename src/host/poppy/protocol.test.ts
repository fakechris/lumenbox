/**
 * Poppy end to end on a scripted network (INV-1893): every request the real PoppyManager makes
 * goes through `usePoppyTransport`, so nothing here reaches the network and each test can say
 * exactly what a Company — honest or not — answers.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { SseReader } from "./conversations.ts";
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

function sse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } });
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
    await assert.rejects(poppyGetFollowing("https://shop.example/go", {}), PoppyRefused, "followed, but not to an inside address");
    routes["https://shop.example/plain"] = () => new Response(null, { status: 301, headers: { location: "http://shop.example/x" } });
    await assert.rejects(poppyGetFollowing("https://shop.example/plain", {}), PoppyRefused, "nor down to http");
  });

  test("the real transport resolves a name through the guarded lookup: localhost is refused before any connection", async () => {
    usePoppyTransport();
    await assert.rejects(poppyRequest("https://localhost/x"), /resolves to/);
  });
});

describe("endpoints a Company names", () => {
  test("a conversation endpoint on another site, or inside, is never called", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { agent: { protocols: [{ type: "poppy", endpoint: "https://127.0.0.1:7890/api/agents" }] } });
    routes["https://mall.example/.well-known/poppy.json"] = company("mall.example", { agent: { protocols: [{ type: "poppy", endpoint: "https://victim.example/chat" }] } });
    const mgr = await manager();
    for (const domain of ["shop.example", "mall.example"]) {
      const result = await dispatchPoppyTool("PoppyConverse", { domain, message: "hi" }, { manager: mgr, who: "ada", conversation: "main" });
      assert.match(result.text, /Error/);
    }
    assert.deepEqual(calls.filter(call => call.method === "POST"), [], "nothing was posted anywhere");
  });

  test("an authorization server whose metadata names another issuer, or an off-site token endpoint, is not used", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example", { auth: { issuer: "https://auth.shop.example" } });
    routes["https://auth.shop.example/.well-known/oauth-authorization-server"] = () => json({ issuer: "https://auth.shop.example", authorization_endpoint: "https://auth.shop.example/a", token_endpoint: "https://collector.example/token" });
    const mgr = await manager();
    assert.equal(await mgr.startSignIn("shop.example", "ada"), null);
  });
});

describe("tokens", () => {
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

describe("a Company's operation", () => {
  test("goes to the person as a card, and their answer goes back to the Company, with the agent told what came of it", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    routes["https://shop.example/poppy/chat"] = () =>
      sse("event: message\r\ndata: {\"role\":\"assistant\",\"content\":\"Ready to refund.\"}\r\n\r\n", "event: operat", "ion\ndata: {\"id\":\"op1\",\"type\":\"refund\",\"description\":\"Refund order 42\",", "\ndata: \"requires_approval\":true}\n\n");
    const mgr = await manager();
    const cards: { id: string; description: string }[] = [];
    const result = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "refund 42" }, {
      manager: mgr, who: "ada", conversation: "c1", agentName: "Ada",
      requestConfirmation: input => { cards.push({ id: `ap${cards.length}`, description: input.description }); return { id: `ap${cards.length - 1}` }; },
    });
    assert.match(result.text, /Ready to refund\./);
    assert.match(result.text, /waiting for the person/);
    assert.equal(cards.length, 1, "an operation split across reads still arrived as an operation");
    assert.match(cards[0]!.description, /Refund order 42/);
    assert.equal(calls.filter(call => call.url.endsWith("/ops")).length, 0, "nothing is answered before the person answers");

    // The operation named no endpoint of its own, so its answer goes to the conversation endpoint's site.
    routes["https://shop.example/poppy/chat"] = call => json({ success: true, message: `refund ${JSON.parse(call.body ?? "{}").decision}` });
    const told: string[] = [];
    await mgr.settleApproval("ap0", "allowed", (agentId, conversation, text) => told.push(`${agentId}/${conversation}: ${text}`));
    const answer = calls.at(-1)!;
    assert.equal(JSON.parse(answer.body ?? "{}").decision, "approved");
    assert.ok(answer.headers["Poppy-Session"], "answered in Ada's session");
    assert.equal(told.length, 1);
    assert.match(told[0]!, /^ada\/c1: The person approved .*refund approved/);
    await mgr.settleApproval("ap0", "allowed", () => assert.fail("answered once"));
  });

  test("with nobody to ask, the agent is told it is not approved, and the Company is told nothing", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    routes["https://shop.example/poppy/chat"] = () => sse("event: operation\ndata: {\"id\":\"op1\",\"type\":\"checkout\",\"description\":\"Buy\",\"requires_approval\":true}\n\n");
    const result = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "buy" }, { manager: await manager(), who: "ada", conversation: "main" });
    assert.match(result.text, /not approved/);
    assert.equal(calls.filter(call => call.method === "POST").length, 1, "only the message itself");
  });

  test("a conversation that does not end is closed when the wait does", async () => {
    routes["https://shop.example/.well-known/poppy.json"] = company("shop.example");
    let signal: AbortSignal | undefined;
    routes["https://shop.example/poppy/chat"] = call => {
      signal = call.signal;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"role\":\"assistant\",\"content\":\"thinking\"}\n\n")); } }));
    };
    const result = await dispatchPoppyTool("PoppyConverse", { domain: "shop.example", message: "hi" }, { manager: await manager(), who: "ada", conversation: "main", timeoutMs: 50 });
    assert.match(result.text, /thinking/);
    assert.match(result.text, /closed/);
    assert.equal(signal?.aborted, true, "the stream was aborted, not left running");
  });
});

describe("the event stream", () => {
  test("events cross reads, lines end any of three ways, data lines join with a newline, and an unterminated last event still counts", () => {
    const seen: [string, string][] = [];
    const reader = new SseReader((event, data) => seen.push([event, data]));
    for (const piece of ["event: a\r", "\ndata: one\r\ndata:  two\r\n\r", "\n: comment\rdata:x\r\revent: b\ndata: y"]) reader.push(piece);
    reader.end();
    assert.deepEqual(seen, [["a", "one\n two"], ["", "x"], ["b", "y"]]);
  });
});
