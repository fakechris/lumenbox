/**
 * The consumer that answers questions put to our agents on a work item (INV-553).
 *
 * The fake Involute here keeps the parts of the real ledger that the consumer's behaviour
 * depends on: a claim that only one caller can hold, an answer that requires the claim,
 * and states that cannot be left once terminal. Everything asserted below is a rule from
 * docs/54 that would otherwise only exist in prose.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { InvoluteConsumer, conversationFor, promptFor, type InboxRequest } from "./involute-inbox.ts";

interface Row extends InboxRequest {
  answers: { body: string; state: string }[];
}

function ledger(rows: Partial<Row>[]) {
  const store: Row[] = rows.map((row, index) => ({
    id: row.id ?? `r${index + 1}`,
    work_id: row.work_id ?? "w1",
    work_identifier: row.work_identifier ?? "INV-999",
    root_comment_id: row.root_comment_id ?? "c1",
    body: row.body ?? "为什么当时这么判断?",
    state: row.state ?? "submitted",
    deadline_at: row.deadline_at ?? new Date(Date.now() + 3_600_000).toISOString(),
    requested_by_actor_id: row.requested_by_actor_id ?? "chris",
    claimed_by: row.claimed_by ?? null,
    answers: [],
  }));
  const call = (holder: string) => async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    if (tool === "work_get_context") {
      return { work: { title: "the consumer", state: { name: "In Review" }, acceptance: "A1 claimed and answered" }, runs: [{ status: "completed", summary: "PR #170" }] };
    }
    if (tool === "agent_inbox") {
      return { requests: store.filter(row => row.state === "submitted" || row.state === "working") };
    }
    const row = store.find(entry => entry.id === args.id);
    if (row === undefined) throw new Error("no such request");
    if (tool === "agent_request_claim") {
      if (row.claimed_by !== null && row.claimed_by !== holder) throw new Error("already claimed");
      row.claimed_by = holder;
      row.state = "working";
      return { id: row.id, state: "working" };
    }
    if (tool === "agent_request_answer") {
      if (row.claimed_by !== holder) throw new Error("you do not hold this request");
      row.answers.push({ body: String(args.body), state: String(args.state ?? "completed") });
      row.state = String(args.state ?? "completed");
      return { id: row.id, state: row.state };
    }
    throw new Error(`unexpected tool ${tool}`);
  };
  return { store, call };
}

const agentOf = (call: ReturnType<typeof ledger>["call"], holder = "ada") => ({
  agentId: "a1",
  agentName: "Ada",
  handle: "ada",
  call: call(holder),
});

test("a question is claimed, answered in its own thread, and the answer is the agent's", async () => {
  const { store, call } = ledger([{ id: "q1" }]);
  const turns: { conversation: string; prompt: string }[] = [];
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async input => {
      turns.push({ conversation: input.conversation, prompt: input.prompt });
      return "因为 RUN-245 当时是 blocked，见 PR#475。";
    },
    mayAnswer: () => ({ ok: true }),
    receiptsFor: subject => (subject === "inv:INV-999" ? "What was written down at the time:\n- 2026-09-10 Ada: chose polling — no inbound port on this machine" : ""),
    log: () => {},
  });

  const outcome = await consumer.poll();
  assert.deepEqual(outcome.answered, ["q1"]);
  assert.deepEqual(store[0]!.answers, [{ body: "因为 RUN-245 当时是 blocked，见 PR#475。", state: "completed" }]);
  assert.equal(store[0]!.state, "completed");
  // One conversation per thread, not per work item: two questions on one item never cross.
  assert.equal(turns[0]!.conversation, conversationFor({ work_identifier: "INV-999", work_id: "w1", root_comment_id: "c1" }));
  assert.notEqual(conversationFor({ work_identifier: "INV-999", work_id: "w1", root_comment_id: "c2" }), turns[0]!.conversation);
  // The prompt carries the rule that stops a fluent invention — and, now, the material
  // that makes an honest answer possible: the item itself and what was written down.
  assert.match(turns[0]!.prompt, /the record does not show it/);
  assert.match(turns[0]!.prompt, /You are @ada on Involute/);
  assert.match(turns[0]!.prompt, /acceptance: A1 claimed and answered/);
  assert.match(turns[0]!.prompt, /recent runs: completed PR #170/);
  assert.match(turns[0]!.prompt, /2026-09-10 Ada: chose polling — no inbound port/);
});

test("losing the claim race is normal, and the second consumer says nothing", async () => {
  const { store, call } = ledger([{ id: "q1", claimed_by: "codex" }]);
  let ran = false;
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => {
      ran = true;
      return "…";
    },
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });
  const outcome = await consumer.poll();
  assert.deepEqual(outcome.skipped, ["q1"]);
  assert.equal(ran, false, "no turn is run for work somebody else holds");
  assert.deepEqual(store[0]!.answers, []);
});

test("an asker we do not take work from is told so, and no turn runs", async () => {
  const { store, call } = ledger([{ id: "q1", requested_by_actor_id: "stranger" }]);
  let ran = false;
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => {
      ran = true;
      return "…";
    },
    mayAnswer: input => (input.requestedByActorId === "chris" ? { ok: true } : { ok: false, why: "they are not on this installation's roster" }),
    log: () => {},
  });
  const outcome = await consumer.poll();
  assert.deepEqual(outcome.failed, ["q1"]);
  assert.equal(ran, false);
  assert.match(store[0]!.answers[0]!.body, /not on this installation's roster/);
  assert.equal(store[0]!.answers[0]!.state, "failed");
});

test("a turn that says nothing, or throws, is reported rather than left to time out", async () => {
  const silent = ledger([{ id: "q1" }]);
  await new InvoluteConsumer({
    agents: () => [agentOf(silent.call)],
    runTurn: async () => "   ",
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  }).poll();
  assert.equal(silent.store[0]!.answers[0]!.state, "failed");
  assert.match(silent.store[0]!.answers[0]!.body, /produced nothing/);

  const broken = ledger([{ id: "q1" }]);
  await new InvoluteConsumer({
    agents: () => [agentOf(broken.call)],
    runTurn: async () => {
      throw new Error("the box is down");
    },
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  }).poll();
  assert.match(broken.store[0]!.answers[0]!.body, /the box is down/);
  assert.equal(broken.store[0]!.answers[0]!.state, "failed");
});

test("a question back keeps its place: input-required, not failed", async () => {
  const { store, call } = ledger([{ id: "q1" }]);
  await new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => "哪个账户?工作还是个人?",
    mayAnswer: () => ({ ok: true }),
    askedBack: () => true,
    log: () => {},
  }).poll();
  assert.equal(store[0]!.answers[0]!.state, "input-required");
  assert.equal(store[0]!.state, "input-required");
});

test("one request per agent per pass, and a request past its deadline is the server's", async () => {
  const { store, call } = ledger([
    { id: "q1" },
    { id: "q2" },
    { id: "q3", deadline_at: new Date(Date.now() - 1_000).toISOString() },
  ]);
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => "答复",
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });
  const first = await consumer.poll();
  assert.deepEqual(first.answered, ["q1"], "twenty mentions in a morning do not become twenty turns at once");
  const second = await consumer.poll();
  assert.deepEqual(second.answered, ["q2"]);
  assert.deepEqual(store.find(row => row.id === "q3")!.answers, [], "the overdue one belongs to the server's sweep");

  // And the prompt names the work item, so the agent knows where it is.
  assert.match(promptFor({ id: "x", work_id: "w1", work_identifier: "INV-999", body: "why", state: "submitted" }, "Ada", "ada"), /INV-999/);
});
