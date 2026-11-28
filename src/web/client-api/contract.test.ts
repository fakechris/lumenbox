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
  /** A request for an operation; `{id}` is an agent the caller reaches, or work they may read, unless `id` says which. */
  const call = (operation: Operation, init: { token?: string; query?: string; headers?: Record<string, string>; from?: string; id?: string } = {}) =>
    fetch(`${base}/api/v1${operation.path.replace("{id}", encodeURIComponent(init.id ?? (operation.path.startsWith("/agents") ? writer.id : t1.id)))}${init.query ?? ""}`, { method: operation.method, headers: {
      "x-forwarded-for": init.from ?? fresh(), ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}), ...init.headers,
    } });
  return { base, home, logs, expired, roster, mint, fresh, call, operator, Principals, ids };
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
    "api-param-invalid": async operation => {
      const token = (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token;
      return (operation.query ?? []).some(param => param.name === "limit") ? box.call(operation, { token, query: "?limit=0" }) : box.call(operation, { token, id: "x".repeat(201) });
    },
    "api-not-found": async operation => box.call(operation, { token: (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token, id: "no-such-thing" }),
    "api-cursor-invalid": async operation => box.call(operation, { token: (await box.mint({ principalId: "dee", label: "p", scopes: SCOPE_NAMES })).token, query: "?cursor=bm90LW91cnM" }),
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
  const fixtures: [string, keyof typeof SCHEMAS][] = [["meta.json", "Meta"], ["me.json", "Me"], ["error.json", "Error"], ["work-page.json", "WorkPage"]];
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
