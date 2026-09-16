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

test("twenty questions at once run one at a time, and the wait is visible (INV-554 A1)", async () => {
  // A normal morning, not an attack. Without a queue this starts twenty turns for one
  // person, each paying, and the twentieth is as late as the first.
  const { store, call } = ledger(Array.from({ length: 20 }, (_, i) => ({ id: `q${i + 1}`, work_identifier: `INV-${600 + i}` })));
  let running = 0;
  let mostAtOnce = 0;
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    capacity: 25,
    runTurn: async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise(resolve => setTimeout(resolve, 1));
      running -= 1;
      return "answered";
    },
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });

  const first = await consumer.poll();
  assert.deepEqual(first.answered, ["q1"], "one turn on the first pass");
  assert.equal(first.queues[0]!.waiting.length, 19, "and nineteen visibly waiting");
  assert.equal(first.queues[0]!.waiting[0]!.subject, "INV-601", "in the order they arrived, named by the item they are about");
  assert.equal(first.queues[0]!.waiting[0]!.position, 1);

  for (let pass = 0; pass < 19; pass += 1) await consumer.poll();
  assert.equal(mostAtOnce, 1, "never two turns at once for one agent");
  assert.equal(store.filter(row => row.answers.length === 1).length, 20, "and all twenty are answered in the end");
  assert.deepEqual(consumer.queueView(), [], "with nothing left waiting");
});

test("past capacity a question is turned down in words, not queued behind nineteen others (INV-554 A2)", async () => {
  const { store, call } = ledger(Array.from({ length: 5 }, (_, i) => ({ id: `q${i + 1}` })));
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    capacity: 2,
    runTurn: async () => "answered",
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });

  const outcome = await consumer.poll();
  assert.deepEqual(outcome.refused, ["q3", "q4", "q5"], "two wait, the rest are refused");
  for (const id of ["q3", "q4", "q5"]) {
    const row = store.find(entry => entry.id === id)!;
    assert.equal(row.state, "failed", "a refusal is an answer: the request is closed, not left to time out");
    assert.match(row.answers[0]!.body, /as many as I take at once/);
    assert.match(row.answers[0]!.body, /ask somebody who is free/, "and it says what to do instead");
  }
});

test("a withdrawn question is not revived by the next poll pass (INV-554 A3)", async () => {
  const { store, call } = ledger([{ id: "q1" }, { id: "q2" }]);
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => "answered",
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });

  await consumer.poll();
  assert.deepEqual(store[0]!.answers.length, 1, "the first is answered");
  assert.equal(consumer.queueView()[0]!.waiting[0]!.id, "q2", "the second is waiting");

  // Withdrawn. A cancellation does not arrive as an event — the request simply stops being
  // in the inbox, which is the only signal there is.
  store[1]!.state = "canceled";
  const second = await consumer.poll();
  assert.deepEqual(second.answered, []);
  assert.deepEqual(consumer.queueView(), [], "it is dropped rather than held for a deadline nobody is waiting on");

  // And now the same id is offered again: a redelivery, a restart, an ordinary retry.
  store[1]!.state = "submitted";
  const third = await consumer.poll();
  assert.deepEqual(third.answered, [], "a question that was taken back does not get answered late");
  assert.deepEqual(store[1]!.answers, []);
});

test("a question that cannot be paid for is refused before the turn runs, not after (INV-554 A4)", async () => {
  const { store, call } = ledger([{ id: "q1" }]);
  let ran = false;
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    runTurn: async () => {
      ran = true;
      return "answered";
    },
    mayAnswer: () => ({ ok: true }),
    // The policy gate reads what has been spent; this is asked before anything is.
    mayAfford: ({ payer }) => ({ ok: false, why: `${payer ?? "whoever asked"} is over the month's budget for me` }),
    log: () => {},
  });

  const outcome = await consumer.poll();
  assert.equal(ran, false, "no tokens are spent finding out we could not afford it");
  assert.deepEqual(outcome.failed, ["q1"]);
  assert.match(store[0]!.answers[0]!.body, /chris is over the month's budget for me/, "and the person is told which principal pays and why it stopped");
});
