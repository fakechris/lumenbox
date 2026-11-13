/** A row's four facts, folded per agent, and the marker order blocked > unread > working (INV-1625). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ConversationState } from "../host/conversation-state.ts";
import { AgentFacts, agentFactsRoute } from "./agent-facts.ts";

function harness() {
  const approvals: { agentId: string; description: string; requestedAt: string }[] = [];
  const questions: { agentId: string; conversation: string; question: string; askedAt: number }[] = [];
  const paused: { agentId: string; day: string }[] = [];
  const working = new Set<string>();
  const state = new ConversationState();
  const facts = new AgentFacts(state, { approvals: () => approvals, questions: () => questions, pausedForSpend: () => paused, working: id => working.has(id) });
  return { approvals, questions, paused, working, state, facts };
}

test("a turn's prose counts once per conversation until the turn ends; the person's own words and a teammate's add nothing", () => {
  const { facts, working } = harness();
  working.add("vic");
  facts.noteTurnEvent({ type: "turn_started", agentId: "vic" });
  facts.noteTurnEvent({ type: "text", agentId: "vic", conversation: "main" });
  facts.noteTurnEvent({ type: "text", agentId: "vic", conversation: "main" });
  facts.noteTurnEvent({ type: "text", agentId: "vic", conversation: "goal-3" });
  assert.equal(facts.forAgent("vic").unreadCount, 2);
  assert.deepEqual(facts.forAgent("vic").unreadIn, [{ conversation: "main", count: 1 }, { conversation: "goal-3", count: 1 }], "and the row says where, so a count is never one the page cannot lead to");
  assert.equal(facts.forAgent("vic").marker, "unread", "unread outranks working");
  facts.noteTurnEvent({ type: "turn_finished", agentId: "vic" });
  working.delete("vic");
  facts.noteTurnEvent({ type: "text", agentId: "vic", conversation: "main" });
  assert.equal(facts.forAgent("vic").unreadCount, 3);
  facts.noteInbound("vic", "main", { fromId: "user" });
  facts.noteInbound("vic", "main", { fromId: "bob-id" });
  facts.noteInbound("vic", "main", { fromId: "user", origin: "host:jobs" });
  assert.equal(facts.forAgent("vic").unreadCount, 3, "nothing the person or the host or a teammate sends is unread");
  facts.noteTurnEvent({ type: "message_sent" } as { type: string });
  assert.equal(facts.forAgent("vic").unreadCount, 3);
});

test("waiting on the person comes from the records that wait, outranks unread, and clears with them; looking clears unread only", () => {
  const { facts, approvals, questions, paused, state } = harness();
  facts.noteTurnEvent({ type: "text", agentId: "ada", conversation: "main" });
  approvals.push({ agentId: "ada", description: "bash — cp report.md  outbox/", requestedAt: "2026-11-05T12:00:00.000Z" });
  let row = facts.forAgent("ada");
  assert.equal(row.marker, "blocked");
  assert.deepEqual(row.awaiting, { kind: "approval", reason: "bash — cp report.md outbox/", since: "2026-11-05T12:00:00.000Z" });
  state.viewed("ada", "main");
  row = facts.forAgent("ada");
  assert.equal(row.unreadCount, 0);
  assert.equal(row.marker, "blocked", "looking does not answer the approval");
  questions.push({ agentId: "ada", conversation: "goal-1", question: "Which account?", askedAt: Date.parse("2026-11-05T13:00:00Z") });
  assert.equal(facts.forAgent("ada").awaiting?.kind, "question", "the newest reason wins");
  assert.equal(facts.awaitingFor("ada", "main")?.kind, "approval", "an approval is the agent's, a question its conversation's");
  approvals.length = 0; questions.length = 0;
  assert.equal(facts.forAgent("ada").marker, undefined);
  paused.push({ agentId: "ada", day: "2026-11-05" });
  assert.equal(facts.forAgent("ada").awaiting?.kind, "spend-limit");
  assert.equal(facts.forAgent("bob").unreadCount, 0);
  assert.equal(facts.forAgent("bob").marker, undefined);
});

test("the page's writes: viewed clears, unread restores, a stranger is refused, an unknown agent is 404", async () => {
  const { facts, state } = harness();
  facts.noteTurnEvent({ type: "text", agentId: "vic", conversation: "main" });
  const call = (route: string, body: Record<string, unknown>, refused = false) => agentFactsRoute(route, state, { readJson: async () => body, refused: () => refused, hasAgent: id => id === "vic" });
  assert.equal(await call("GET /api/agents", {}), undefined);
  assert.equal((await call("POST /api/agents/viewed", { id: "vic" }, true))?.status, 0);
  assert.equal((await call("POST /api/agents/viewed", { id: "nobody" }))?.status, 404);
  const viewed = await call("POST /api/agents/viewed", { id: "vic", conversation: "main" });
  assert.equal(viewed?.status, 200);
  assert.equal(facts.forAgent("vic").unreadCount, 0);
  const again = await call("POST /api/agents/unread", { id: "vic" });
  assert.equal((again!.body as { unreadCount: number }).unreadCount, 1);
  assert.equal(facts.forAgent("vic").marker, "unread");
});
