/**
 * The frame under the client API (INV-2213), with operations of its own: what v1's read slice has
 * none of yet — a `POST` and its `Idempotency-Key`, parameters of every type, a handler that throws —
 * runs through the same frame the real operations do, so the conventions are proved before the
 * first operation that needs them arrives.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { IdempotencyStore } from "../idempotency.ts";
import type { ClientCredential } from "../mcp-tokens.ts";
import { clientApi, refuse, Window, type Handler } from "./frame.ts";
import { matchRoute, readParams } from "./routes.ts";
import { OPERATIONS, type Operation } from "./schema.ts";

const credential: ClientCredential = { id: "tok_1", kind: "personal", principalId: "dee", label: "t", scopes: ["work:read"], createdAt: "2026-11-28T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };

const OPS: Operation[] = [
  { operationId: "listThings", method: "GET", path: "/things", auth: "credential", scope: "work:read", tier: "stable", response: "Meta", summary: "", description: "",
    query: [
      { name: "limit", description: "", schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "mine", description: "", schema: { type: "boolean" } },
      { name: "state", description: "", schema: { type: "string", "x-extensible-enum": ["open", "done"] } },
    ] },
  { operationId: "getThing", method: "GET", path: "/things/{id}", auth: "credential", tier: "stable", response: "Meta", summary: "", description: "", pathParams: [{ name: "id", description: "", schema: { type: "string" } }] },
  { operationId: "makeThing", method: "POST", path: "/things", auth: "credential", tier: "stable", response: "Meta", summary: "", description: "" },
  { operationId: "breakThing", method: "GET", path: "/broken", auth: "none", tier: "stable", response: "Meta", summary: "", description: "" },
];

async function frame(t: TestContext, handlers: Record<string, Handler>) {
  const logs: string[] = [];
  const api = clientApi({
    tokens: { clientFor: presented => (presented === "lbxp_good" ? { credential } : { refused: "invalid" }), touch: () => "2026-11-28T00:00:00.000Z" },
    person: id => (id === "dee" ? { id, name: "Dee", role: "driver" } : undefined),
    installationMode: () => "organisation", version: "0.0.0", homeAgentOf: () => undefined,
    signIns: { blocked: () => undefined, failed: () => {} }, address: () => "127.0.0.1",
    idempotency: new IdempotencyStore({ ttlMs: 24 * 60 * 60_000 }), log: line => logs.push(line),
  }, { operations: OPS, handlers });
  const server = createServer((req, res) => { void api.handle(req, res, new URL(req.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const auth = { authorization: "Bearer lbxp_good" };
  return { base, auth, logs };
}

test("the route table is pure and denies by default: an unlisted path, an unlisted method and a malformed segment are refused before anything runs", () => {
  assert.deepEqual(matchRoute("GET", "/api/v1/things/t%2F1", OPS), { kind: "operation", operation: OPS[1], pathParams: { id: "t/1" } });
  assert.deepEqual(matchRoute("GET", "/api/v1/things/a/b", OPS), { kind: "unknown" });
  assert.deepEqual(matchRoute("PUT", "/api/v1/things", OPS), { kind: "method", allowed: ["GET", "POST"] });
  assert.deepEqual(matchRoute("GET", "/api/v1/things/%E0%A4%A", OPS), { kind: "malformed", name: "id" });
  assert.deepEqual(matchRoute("GET", "/api/v1things", OPS), { kind: "unknown" });
  assert.deepEqual(matchRoute("GET", "/api/v2/meta"), { kind: "unknown" }, "another major version is another table");
  for (const operation of OPERATIONS) assert.equal(matchRoute(operation.method, `/api/v1${operation.path.replace(/\{\w+\}/g, "x")}`).kind, "operation", operation.operationId);
});

test("parameters are read against their schema: unknown, repeated, out of range, not a boolean, not a known value", () => {
  const read = (query: string) => readParams(OPS[0]!, {}, new URLSearchParams(query));
  assert.deepEqual(read("limit=5&mine=true&state=done"), { values: { limit: 5, mine: true, state: "done" } });
  assert.deepEqual(read("nope=1"), { code: "api-param-unknown", vars: { name: "nope" } });
  assert.equal((read("limit=5&limit=6") as { code: string }).code, "api-param-invalid");
  assert.deepEqual(read("limit=0"), { code: "api-param-invalid", vars: { name: "limit", why: "at least 1" } });
  assert.deepEqual(read("limit=101"), { code: "api-param-invalid", vars: { name: "limit", why: "at most 100" } });
  assert.deepEqual(read("limit=1.5"), { code: "api-param-invalid", vars: { name: "limit", why: "a whole number" } });
  assert.deepEqual(read("mine=yes"), { code: "api-param-invalid", vars: { name: "mine", why: "true or false" } });
  assert.deepEqual(read("state=lost"), { code: "api-param-invalid", vars: { name: "state", why: "one of open, done" } });
});

test("a POST with an Idempotency-Key answers its first answer on a repeat, refuses the key on another body, and refuses a key not worth storing", async t => {
  let made = 0;
  const box = await frame(t, { makeThing: () => { made += 1; return { made }; } });
  const post = (body: unknown, key?: string) => fetch(`${box.base}/things`, { method: "POST", headers: { ...box.auth, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body) });
  const first = await post({ name: "a" }, "key-0000001");
  assert.deepEqual(await first.json(), { made: 1 });
  const repeat = await post({ name: "a" }, "key-0000001");
  assert.deepEqual(await repeat.json(), { made: 1 }, "the first answer, not a second thing made");
  assert.equal(repeat.headers.get("idempotent-replayed"), "true");
  assert.equal(made, 1);
  const other = await post({ name: "b" }, "key-0000001");
  assert.equal(other.status, 409);
  assert.equal(((await other.json()) as { code: string }).code, "api-idempotency-conflict");
  const short = await post({ name: "a" }, "short");
  assert.equal(((await short.json()) as { code: string }).code, "api-idempotency-key-invalid");
  assert.deepEqual(await (await post({ name: "a" })).json(), { made: 2 }, "no key, no memory");
});

test("a refused POST is refused again on its repeat; a handler that throws answers 500 with the request id and the log has why", async t => {
  const box = await frame(t, { makeThing: () => refuse("api-scope-needed", { scope: "work:decide" }), breakThing: () => { throw new Error("boom"); }, listThings: () => ({}), getThing: () => ({}) });
  const post = () => fetch(`${box.base}/things`, { method: "POST", headers: { ...box.auth, "idempotency-key": "key-0000002" }, body: "{}" });
  const first = await (await post()).json() as { code: string; requestId: string };
  const again = await (await post()).json() as { code: string; requestId: string };
  assert.equal(again.code, "api-scope-needed");
  assert.equal(again.requestId, first.requestId, "the same answer, the first request's id");
  const broken = await fetch(`${box.base}/broken`);
  const body = await broken.json() as { code: string; requestId: string; error: string };
  assert.equal(broken.status, 500);
  assert.equal(body.code, "api-internal");
  assert.equal(body.requestId, broken.headers.get("x-request-id"));
  assert.ok(body.error.includes(body.requestId), "the words name the request, so a person can quote it");
  assert.ok(!JSON.stringify(body).includes("boom"), "what went wrong inside stays inside");
  assert.ok(box.logs.some(line => line.includes(body.requestId) && line.includes("boom")), "and is in the log under that id");
});

test("a limit's windows: over the limit waits out its own window, and new keys push out the least recently used, never one still calling", () => {
  const window = new Window(60_000, 3);
  assert.equal(window.take("busy", 2, 0), undefined);
  assert.equal(window.take("busy", 2, 1_000), undefined);
  assert.equal(window.take("busy", 2, 2_000), 58, "the third in a minute waits out the rest of the minute");
  for (const key of ["a", "b"]) window.take(key, 2, 3_000);
  assert.equal(window.take("busy", 2, 4_000), 56, "still calling: it moves to the back");
  for (const key of ["c", "d"]) window.take(key, 2, 5_000);
  assert.equal(window.take("busy", 2, 6_000), 54, "the two that went were a and b; busy is still limited");
  for (const key of ["e", "f", "g"]) window.take(key, 2, 7_000);
  assert.equal(window.take("busy", 2, 8_000), undefined, "pushed out only once three keys were used after it");
  assert.equal(window.take("busy", 2, 69_000), undefined, "and a new minute is a new window");
});
