/**
 * What the real-server tests (conversations.test.ts, contract.test.ts) cannot make happen from outside (INV-2214): a sandbox
 * that is not running when a file is uploaded, a chain the bus paused (it lives in the bus's memory), and the change records
 * and live events made from the page's events, event by event.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { IdempotencyStore } from "../idempotency.ts";
import type { ClientCredential } from "../mcp-tokens.ts";
import type { DisplayEntry } from "../transcript.ts";
import { ChangeLedger } from "./change-ledger.ts";
import { chatAccess } from "./chat-access.ts";
import { type ChatAccess, type LiveEvent, conversationIdOf } from "./conversations.ts";
import { clientApi } from "./frame.ts";
import type { DecisionAccess } from "./inbox.ts";

const credential: ClientCredential = { id: "tok_dee", kind: "personal", principalId: "dee", label: "t", scopes: ["chat:read", "chat:write", "work:decide"], createdAt: "2026-11-28T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" };

async function api(t: TestContext, chat: Partial<ChatAccess>, decisions: Partial<DecisionAccess> = {}) {
  const frame = clientApi({
    world: {
      // Dee reaches a2 and not a1.
      reachOf: () => ({ box: () => true, agent: id => id !== "a1", task: () => true }),
      agents: () => [{ id: "a2", name: "Writer", description: "", boxId: "b", boxName: "Box", teams: [], hidden: false, working: false }], tasks: () => [], attention: () => ({ mine: [], theirs: [] }), actor: () => undefined,
      changes: { latest: 0, after: () => ({ reset: false, lines: [] }), onAppend: () => () => {}, onClose: () => () => {} }, noteAgents: () => {},
    },
    tokens: { clientFor: presented => (presented === "lbxp_dee" ? { credential } : { refused: "invalid" }), touch: () => "2026-11-28T00:00:00.000Z" },
    person: id => (id === "dee" ? { id, name: "Dee", role: "driver" } : undefined),
    installationMode: () => "organisation", version: "0.0.0", homeAgentOf: () => undefined,
    signIns: { blocked: () => undefined, failed: () => {}, succeeded: () => {} }, address: () => "127.0.0.1", devices: {} as never,
    chat: { conversations: () => [{ id: "main" }], kindOf: () => "main", ...chat } as ChatAccess, decisions: decisions as DecisionAccess,
    idempotency: new IdempotencyStore({ ttlMs: 60_000 }), secretIdempotency: new IdempotencyStore({ ttlMs: 30_000 }), log: () => {},
  });
  const server = createServer((req, res) => { void frame.handle(req, res, new URL(req.url ?? "/", "http://localhost")); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;
  return (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: "Bearer lbxp_dee", ...init.headers } });
}

test("an upload to a conversation whose sandbox is not running is refused with box-not-running, and nothing is named", async t => {
  const call = await api(t, { store: async () => "no-box", uploads: { put: () => { throw new Error("nothing to name"); }, get: () => undefined } });
  const answer = await call(`/uploads?conversationId=${encodeURIComponent(conversationIdOf("a2", "main"))}&name=notes.txt`, { method: "POST", headers: { "content-type": "text/plain" }, body: "hello" });
  assert.deepEqual([answer.status, ((await answer.json()) as { code: string }).code], [503, "box-not-running"]);
});

test("a paused chain is answered by a message, to whichever of its two agents the person reaches", async t => {
  const said: unknown[] = [];
  const call = await api(t, {}, {
    inbox: async () => ({
      items: [{ kind: "paused", ref: "a1", title: "A ↔ Writer: paused after 9 turns with no person", detail: "message either of them to decide", with: "A" }],
      approvals: [], drafts: [], tasks: [], secrets: [], paused: [{ fromId: "a1", toId: "a2" }],
    }),
    say: async (person, agentId, conversation, text) => { said.push([person.id, agentId, conversation, text]); },
  });
  const listed = await (await call("/inbox")).json() as { items: { id: string; actions: string[]; agentId?: string; conversationId?: string }[] };
  assert.deepEqual(listed.items.map(item => [item.id, item.actions, item.agentId, item.conversationId]), [["paused:a1", ["answer"], "a2", conversationIdOf("a2", "main")]]);
  const answered = await call("/inbox/paused%3Aa1/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "answer", text: "Stop arguing; Writer decides." }) });
  assert.equal(answered.status, 200, await answered.text());
  assert.deepEqual(said, [["dee", "a2", "main", "Stop arguing; Writer decides."]]);
});

test("the page's events become a conversation's live stream and its change records: named once, then a record per new message, never the words", t => {
  const entries: DisplayEntry[] = [{ kind: "text", role: "user", text: "Old words." }];
  const ledger = new ChangeLedger(undefined);
  const chat = chatAccess({
    send: async () => ({ failed: "unused" }), stop: () => {}, active: () => false, display: () => entries, chatKeyFor: () => undefined,
    boxOf: () => { throw new Error("unused"); }, receiveFiles: async () => undefined,
  }, { listConversations: () => [{ id: "main" }], conversationFirstLine: () => undefined, contextStore: () => ({ current: () => ({ epoch: 0 }) }) as never }, ledger, () => {});
  t.after(chat.close);
  const heard: LiveEvent[] = [];
  const unwatch = chat.access.watch("a2", "main", event => heard.push(event));
  // A message taken: the conversation is named at once, as it was before the message's own entries.
  chat.live({ type: "prompt", agentId: "a2", messageId: "m-1", conversation: "main" });
  chat.live({ type: "turn_started", agentId: "a2", conversation: "main" });
  chat.live({ type: "text", agentId: "a2", conversation: "main", delta: "Do" });
  chat.live({ type: "tool_start", agentId: "a2", conversation: "main", tool: "bash", input: { command: "ls -la /secret" }, toolUseId: "tu-1" });
  entries.push({ kind: "text", role: "user", text: "New words." }, { kind: "text", role: "assistant", text: "Done." });
  chat.live({ type: "turn_failed", agentId: "a2" });
  chat.access.note();
  const id = conversationIdOf("a2", "main");
  const lines = ledger.after(0);
  assert.ok(!lines.reset);
  assert.deepEqual(lines.lines.map(line => [line.type, line.op, line.assigneeId, line.conversationId ?? "-"]), [
    ["conversation", "upsert", "a2", "-"], ["message", "upsert", "a2", id], ["message", "upsert", "a2", id], ["conversation", "upsert", "a2", "-"],
  ], "named, then the two new messages, then the conversation again");
  assert.ok(!JSON.stringify(lines.lines).includes("words"), "never the words");
  assert.deepEqual(heard.map(event => event.kind === "step" ? [event.kind, event.state, event.tool] : event.kind === "turn" ? [event.kind, event.state] : [event.kind]), [
    ["sent"], ["turn", "started"], ["text"], ["step", "started", "bash"], ["turn", "failed"],
  ], "a failed turn, which names only its agent, ends the turn its conversation had open");
  chat.access.note();
  assert.equal(ledger.latest, 4, "nothing new: nothing written");
  unwatch();
});
