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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

async function server(t: TestContext) {
  const { Principals } = await import("../../host/principals.ts");
  const { McpTokenStore } = await import("../mcp-tokens.ts");
  const { startWebServer } = await import("../server.ts");
  const home = mkdtempSync(join(tmpdir(), "client-api-contract-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_PUBLIC_URL: "https://box.example.test" });
  mkdirSync(join(home, "agents"), { recursive: true });
  const roster = [
    { id: "ann", name: "Ann", role: "admin" as const, identities: [] },
    { id: "ada", name: "Ada", role: "admin" as const, identities: [] },
    { id: "dee", name: "Dee", role: "driver" as const, identities: [] },
    { id: "vic", name: "Vic", role: "viewer" as const, identities: [] },
    { id: "gus", name: "Gus", role: "driver" as const, identities: [] },
  ];
  new Principals().save(roster);
  // One token whose time is over, minted before the server reads the store.
  const expired = new McpTokenStore(join(home, "mcp-tokens.json")).mintClient({ kind: "personal", principalId: "dee", label: "old", scopes: SCOPE_NAMES, expiresAt: new Date(Date.now() - 60_000), by: "test" }).token;
  let base = "";
  const logs: string[] = [];
  const stop = await startWebServer({ port: 0, host: "0.0.0.0", token: "t0k", useBox: false, onLog: line => logs.push(line), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
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
  const call = (operation: Operation, init: { token?: string; query?: string; headers?: Record<string, string>; from?: string } = {}) =>
    fetch(`${base}/api/v1${operation.path}${init.query ?? ""}`, { method: operation.method, headers: {
      "x-forwarded-for": init.from ?? fresh(), ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers,
    } });
  return { base, home, logs, expired, roster, mint, fresh, call, operator, Principals };
}

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
  const box = await server(t);
  const all = await box.mint({ principalId: "dee", label: "script", scopes: SCOPE_NAMES });
  const doc = openApiDocument() as Doc;
  const inDoc = Object.values(doc.paths).flatMap(methods => Object.values(methods).map(operation => operation.operationId)).sort();
  assert.deepEqual(inDoc, OPERATIONS.map(operation => operation.operationId).sort(), "the document is the schema's operations, all of them");
  for (const operation of OPERATIONS as readonly Operation[]) {
    const token = operation.auth === "none" ? undefined : all.token;
    const answer = await box.call(operation, token === undefined ? {} : { token });
    const body = await answer.json();
    assert.equal(answer.status, 200, `${operation.operationId}: ${JSON.stringify(body)}`);
    assert.deepEqual(problemsOf(body, SCHEMAS[operation.response] as Schema), [], `${operation.operationId} answers exactly its documented ${operation.response}`);
    assert.match(answer.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
    const etag = answer.headers.get("etag");
    assert.match(etag ?? "", /^"[A-Za-z0-9_-]{32}"$/, `${operation.operationId} carries a validator`);
    let again = await box.call(operation, { ...(token === undefined ? {} : { token }), headers: { "if-none-match": etag! } });
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
  const box = await server(t);
  const doc = openApiDocument() as Doc;
  const gone = await box.mint({ principalId: "gus", label: "leaver", scopes: SCOPE_NAMES });
  new box.Principals().save(box.roster.filter(person => person.id !== "gus"));
  const bogus = `lbxp_${"0".repeat(48)}`;

  const provoke: Record<ApiErrorCode, ((operation: Operation) => Promise<Response>) | undefined> = {
    "api-credential-needed": operation => box.call(operation),
    "api-credential-invalid": operation => box.call(operation, { token: bogus }),
    "api-credential-expired": operation => box.call(operation, { token: box.expired }),
    "access-removed": operation => box.call(operation, { token: gone.token }),
    "sign-in-limited": async operation => {
      const from = box.fresh();
      for (let tries = 0; tries < 20; tries += 1) {
        const answer = await box.call(operation, { token: bogus, from });
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
    "api-param-invalid": undefined,
    "api-operation-unknown": undefined,
    "api-method-not-allowed": undefined,
    "api-idempotency-key-invalid": undefined,
    "api-idempotency-conflict": undefined,
    "api-internal": undefined,
  };

  for (const operation of OPERATIONS as readonly Operation[]) {
    const documented = Object.entries(doc.paths[`/api/v1${operation.path}`]![operation.method.toLowerCase()]!.responses).flatMap(([, response]) => response["x-error-codes"] ?? []);
    if (operation.scope !== undefined) assert.ok(documented.includes("api-scope-needed"), `${operation.operationId} documents its scope refusal`);
    for (const code of documented) {
      if (PROVED_ELSEWHERE[code] !== undefined) continue;
      const how = provoke[code];
      assert.ok(how !== undefined, `${operation.operationId} documents ${code}: say here how a real server is made to answer it`);
      const answer = await how(operation);
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
  const fixtures: [string, keyof typeof SCHEMAS][] = [["meta.json", "Meta"], ["me.json", "Me"], ["error.json", "Error"]];
  for (const [file, name] of fixtures) {
    const body = JSON.parse(readFileSync(new URL(`../../../clients/codegen/fixtures/${file}`, import.meta.url), "utf8")) as unknown;
    assert.deepEqual(problemsOf(body, SCHEMAS[name] as Schema, false), [], `${file} is a ${name}, as a newer server would send it`);
    const strict = problemsOf(body, SCHEMAS[name] as Schema, true);
    assert.ok(strict.some(problem => problem.endsWith("not in the schema")), `${file} has a field this schema does not`);
    assert.ok(strict.some(problem => problem.endsWith("is not a known value")), `${file} has a value this schema does not list`);
  }
});
