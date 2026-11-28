/**
 * What the contract tests cannot set up on a real server (INV-2214): a secret an agent asked for — the
 * request lives in the server's memory, made by an agent's AskSecret — and the two forms of a step-up
 * signature. The rest of the inbox is proved on a real server in contract.test.ts.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IdempotencyStore } from "../idempotency.ts";
import type { ClientCredential } from "../mcp-tokens.ts";
import { answerSecret, type SecretRequest } from "../secret-requests.ts";
import { clientApi } from "./frame.ts";
import type { DecisionAccess } from "./inbox.ts";
import { stepUpRequiredFor, stepUpText, verifyStepUp } from "./step-up.ts";
import { decisionsFor, type DecisionWorld } from "../decisions.ts";
import { personActions } from "../person-actions.ts";
import { inboxChanges } from "./inbox.ts";

// Ann answers from her phone, a device with a step-up key (docs/110 §4); Dee with a personal token.
const deviceKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credential = (id: string): ClientCredential => ({ id, kind: id === "dev_ann" ? "device" : "personal", principalId: id === "dev_ann" ? "ann" : "dee", label: "t", scopes: ["work:decide"], createdAt: "2026-11-28T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" });

async function api(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "inbox-secret-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const pending = new Map<string, SecretRequest>([["GITHUB_TOKEN", { id: "GITHUB_TOKEN", agentId: "a1", agentName: "Writer", description: "to push the site", at: "2026-11-28T00:00:00.000Z" }]]);
  const vault: { id: string; value?: string; grants?: { holder: string }[] }[] = [], told: string[] = [], logs: string[] = [];
  const secretDeps = { pending, vault: { setSecret: (input: { id: string; value?: string; grants?: { holder: string }[] }) => { vault.push(input); } }, deliverSystem: (_agent: string, text: string) => { told.push(text); }, log: (line: string) => logs.push(line) };
  const decisions = {
    inbox: async () => ({ items: [], approvals: [], drafts: [], tasks: [], secrets: [...pending.values()] }),
    saveSecret: (id: string, value: string, by: string, forAgent: string) => answerSecret(secretDeps, id, value, by, forAgent),
    stepUpKeyOf: (id: string) => (id === "dev_ann" ? { id: "key-1", publicKey: deviceKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url") } : undefined),
  } as unknown as DecisionAccess;
  const persisted = join(home, "client-api-idempotency.jsonl");
  const frame = clientApi({
    world: { reachOf: () => ({ box: () => true, agent: () => true, task: () => true }), agents: () => [], tasks: () => [], attention: () => ({ mine: [], theirs: [] }), actor: () => undefined,
      changes: { latest: 0, after: () => ({ reset: false, lines: [] }), onAppend: () => () => {}, onClose: () => () => {} }, noteAgents: () => {} },
    tokens: { clientFor: presented => (presented === "lbxd_ann" ? { credential: credential("dev_ann") } : presented === "lbxp_dee" ? { credential: credential("tok_dee") } : { refused: "invalid" }), touch: () => "2026-11-28T00:00:00.000Z" },
    person: id => (id === "ann" ? { id, name: "Ann", role: "admin" } : id === "dee" ? { id, name: "Dee", role: "driver" } : undefined),
    installationMode: () => "organisation", version: "0.0.0", homeAgentOf: () => undefined,
    signIns: { blocked: () => undefined, failed: () => {}, succeeded: () => {} }, address: () => "127.0.0.1", devices: {} as never, chat: {} as never, decisions,
    idempotency: new IdempotencyStore({ ttlMs: 24 * 60 * 60_000, persistTo: persisted }), secretIdempotency: new IdempotencyStore({ ttlMs: 30_000 }), log: line => logs.push(line),
  });
  const server = createServer((req, res) => { void frame.handle(req, res, new URL(req.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  const answer = (token: string, body: unknown, key?: string) => fetch(`${base}/inbox/secret%3AGITHUB_TOKEN/answer`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key !== undefined ? { "idempotency-key": key } : {}) }, body: JSON.stringify(body),
  });
  return { answer, vault, told, logs, persisted, pending, list: (token: string) => fetch(`${base}/inbox`, { headers: { authorization: `Bearer ${token}` } }) };
}

test("a secret an agent asked for: listed for those who may read the agent, saved only by an Admin with a step-up proof over the value, straight to the vault, granted to that agent alone, and written nowhere else", async t => {
  const box = await api(t);
  const listed = await (await box.list("lbxp_dee")).json() as { items: { id: string; kind: string; actions: string[]; secret: { name: string } }[] };
  assert.deepEqual(listed.items.map(item => [item.id, item.kind, item.actions, item.secret.name]), [["secret:GITHUB_TOKEN", "secret", ["open-on-page"], "GITHUB_TOKEN"]], "a driver sees it and answers it on the page");
  const refused = await box.answer("lbxp_dee", { action: "save", value: "ghp_not-for-a-driver" });
  assert.deepEqual([refused.status, ((await refused.json()) as { code: string }).code], [403, "api-role-needed"]);
  assert.equal(box.vault.length, 0);

  const value = "ghp_0123456789abcdefSECRET";
  // Saving plants a value the agent will use: without the device's proof over this value, refused — even for an Admin.
  const unproved = await box.answer("lbxd_ann", { action: "save", value: "attacker-chosen" });
  assert.deepEqual([unproved.status, ((await unproved.json()) as { code: string }).code], [403, "step-up-required"]);
  const proof = (words: string) => ({
    keyId: "key-1",
    signature: sign("sha256", Buffer.from(stepUpText("dev_ann", "secret:GITHUB_TOKEN", "save", createHash("sha256").update(words).digest("base64url"))), { key: deviceKey.privateKey, dsaEncoding: "der" }).toString("base64url"),
  });
  const swapped = await box.answer("lbxd_ann", { action: "save", value: "attacker-chosen", stepUp: proof(value) });
  assert.deepEqual([swapped.status, ((await swapped.json()) as { code: string }).code], [403, "step-up-invalid"], "the proof covers the value, not just the act");
  assert.equal(box.vault.length, 0, "nothing planted");
  const request = { action: "save", value, stepUp: proof(value) }; // a retry sends the same request, signature and all
  const saved = await box.answer("lbxd_ann", request, "retry-key-0001");
  const text = await saved.text();
  assert.equal(saved.status, 200, text);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(box.vault, [{ id: "GITHUB_TOKEN", description: "to push the site", value, grants: [{ holder: "a1" }] }], "into the vault, for the agent that asked");
  assert.equal(box.pending.size, 0);
  assert.ok(!text.includes(value), "never in the answer");
  assert.ok(box.told.every(line => !line.includes(value)) && box.told.some(line => line.includes("GITHUB_TOKEN")), "the agent is told it is saved, by name");
  assert.ok(box.logs.every(line => !line.includes(value)), "never in a log");
  assert.ok(!existsSync(box.persisted) || readFileSync(box.persisted, "utf8").trim() === "", "and nothing in the replay file: its retry lives in memory");
  const again = await box.answer("lbxd_ann", request, "retry-key-0001");
  assert.deepEqual([again.status, again.headers.get("idempotent-replayed")], [200, "true"], "a retry gets the first answer, from memory");
  assert.equal(box.vault.length, 1, "saved once");
});

test("a step-up proof is the registered key's ECDSA P-256 signature over one decision, DER or raw r||s; the gate's own tiers say when it is needed", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const text = stepUpText("dev_1", "ap-1", "allow:once");
  assert.equal(text, "lumenbox-step-up/1\ndev_1\nap-1\nallow:once\n-");
  for (const dsaEncoding of ["der", "ieee-p1363"] as const) {
    const signature = sign("sha256", Buffer.from(text), { key: privateKey, dsaEncoding }).toString("base64url");
    assert.ok(verifyStepUp(spki, text, signature), dsaEncoding);
    assert.ok(!verifyStepUp(spki, stepUpText("dev_1", "ap-1", "allow:session"), signature), `${dsaEncoding}: another decision`);
    assert.ok(!verifyStepUp(spki, stepUpText("dev_2", "ap-1", "allow:once"), signature), `${dsaEncoding}: another device`);
  }
  const other = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  assert.ok(!verifyStepUp(spki, text, sign("sha256", Buffer.from(text), { key: other, dsaEncoding: "der" }).toString("base64url")), "another key");
  assert.ok(!verifyStepUp(spki, text, "not-a-signature"));
  assert.deepEqual(["observe", "self", "reach", "spend", "credential", "irreversible", "run-later", undefined].map(tier => stepUpRequiredFor(tier as never)), [false, false, true, true, true, true, true, true], "unknown is outside");
});

test("what the review found: a question settles only once its answer is admitted; stop never drops work it cannot stop; a secret goes only to the agent the person was shown; a paused chain only to those who reach it; a re-routed item is told to its new audience", async () => {
  // A question's answer the agent never admitted leaves the question waiting.
  const settled: string[] = [];
  const reject = personActions({ board: () => undefined, workControl: {} as never, questions: { noteReply: (_a: string, identity: string) => { settled.push(identity); return []; } }, log: () => {}, identitiesOf: id => [id],
    running: () => false, message: async () => { throw new Error("refused before admission"); } });
  await reject.say("dee", "a1", "main", "/goal do it", "q1");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled.length, 0, "not admitted: not settled");
  const admit = personActions({ board: () => undefined, workControl: {} as never, questions: { noteReply: (_a: string, identity: string) => { settled.push(identity); return []; } }, log: () => {}, identitiesOf: id => [id],
    running: () => false, message: async (_agent, _text, _person, _conversation, onAdmitted) => { onAdmitted?.(); } });
  await admit.say("dee", "a1", "main", "The blue one.", "q1");
  assert.deepEqual(settled, ["dee"], "admitted: settled");

  // Stop with nothing to cancel by, while something runs for the work: refused, and the row is not dropped.
  const updates: unknown[] = [];
  const task = { id: "t1", assigneeId: "a1", conversation: "main" };
  const stop = (running: boolean) => personActions({ board: () => ({ get: () => task, update: (...args: unknown[]) => { updates.push(args); return { task } as never; }, opposeClose: () => ({ refused: "" }) }) as never,
    workControl: { preview: () => ({ participants: [], resources: [] }) as never, cancel: async () => { throw new Error("no token"); } }, questions: { noteReply: () => [] }, log: () => {}, identitiesOf: id => [id],
    running: () => running, message: async () => {} }).work("dee", "t1", "stop");
  assert.equal((await stop(true)).ok, false, "running and nothing to cancel it by: refused");
  assert.deepEqual(updates, []);
  assert.equal((await stop(false)).ok, true, "nothing runs: dropped");
  assert.equal(updates.length, 1);

  // A secret asked for again under the same name by another agent: the person's save does not go to that one.
  const pending = new Map<string, SecretRequest>([["K", { id: "K", agentId: "a2", agentName: "Other", description: "", at: "" }]]);
  const vault: unknown[] = [];
  assert.equal(answerSecret({ pending, vault: { setSecret: input => { vault.push(input); } }, deliverSystem: () => {}, log: () => {} }, "K", "v", "ann", "a1"), "unknown");
  assert.deepEqual(vault, []);

  // A chain between two agents the viewer reaches neither of is not theirs.
  const world = { tasks: () => [], questions: () => [], approvals: () => [], drafts: () => [], exceptions: () => [], routinesHeld: async () => [], undeliverable: () => [], unanswered: () => [],
    paused: () => [{ fromId: "a1", fromName: "A", toId: "a2", toName: "B", hops: 9, at: "2026-11-28T00:00:00.000Z" }], nameOf: (id: string) => id, personIds: () => new Set<string>(), agentIds: () => new Set(["a1", "a2"]),
    chatKeyOf: () => undefined, active: () => false, checkPending: () => false, workOf: () => "/work", defaultBoxId: () => "default" } as DecisionWorld;
  const viewing = (reached: string) => ({ principalId: "dee", identities: [], all: false, sees: { agent: (id: string) => id === reached, box: () => true, task: () => true } });
  assert.deepEqual((await decisionsFor(world, viewing("a9"))).mine.map(item => item.kind), [], "neither agent");
  assert.deepEqual((await decisionsFor(world, viewing("a2"))).mine.map(item => item.kind), ["paused"], "one of them");

  // An item that moves to another agent is told again, routed to its new audience; one that goes is told as gone.
  const last = new Map([["nudged:t1", { op: "upsert" as const, assigneeId: "a1" }], ["question:q1", { op: "upsert" as const, assigneeId: "a1" }]]);
  assert.deepEqual(inboxChanges(last, [{ id: "nudged:t1", agentId: "a2" }]), [
    { type: "inbox", id: "nudged:t1", op: "upsert", assigneeId: "a2" },
    { type: "inbox", id: "question:q1", op: "delete", assigneeId: "a1" },
  ]);
});
