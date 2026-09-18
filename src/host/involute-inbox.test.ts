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
  /** The token of the execution holding the claim, as the real ledger keeps a hash of it. */
  token?: string;
  /** Who the request is addressed to; only they may claim it (the real ledger's targetActorId). */
  target?: string;
}

/** Every claim and renewal the fake ledger saw, so a test can assert the lease was kept alive. */
const claimCalls: { id: string; holder: string; token: string | undefined }[] = [];

function ledger(rows: Partial<Row>[]) {
  const store: Row[] = rows.map((row, index) => ({
    ...row,
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
      claimCalls.push({ id: row.id, holder, token: typeof args.claim_token === "string" ? args.claim_token : undefined });
      // Addressed to somebody else: the real ledger's CAS matches targetActorId, so this is
      // simply not claimable by anyone but the target (INV-582: hand-off is a new request).
      if (row.target !== undefined && row.target !== holder) throw new Error("this request is addressed to another actor");
      if (typeof args.claim_token === "string") {
        if (row.claimed_by === holder && row.token === args.claim_token) return { id: row.id, state: row.state, claim_token: row.token };
        throw new Error("claim superseded");
      }
      if (row.claimed_by !== null && row.claimed_by !== undefined && row.claimed_by !== holder) throw new Error("already claimed");
      row.claimed_by = holder;
      row.token = `t-${holder}-${claimCalls.length}`;
      row.state = "working";
      return { id: row.id, state: "working", claim_token: row.token };
    }
    if (tool === "agent_request_answer") {
      // The real ledger: the token proves the execution, not just the actor.
      if (typeof args.claim_token !== "string") throw new Error("claim_token is required");
      if (row.claimed_by !== holder || row.token !== args.claim_token) throw new Error("you do not hold this request");
      const state = String(args.state ?? "completed");
      row.answers.push({ body: String(args.body), state });
      row.state = state;
      if (state === "input-required") {
        // Handing back invalidates the execution's token; the next holder takes a new one.
        row.claimed_by = null;
        row.token = undefined;
      }
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

test("every answer carries the claim token, and a long turn keeps the lease alive (INV-582)", async () => {
  claimCalls.length = 0;
  const { store, call } = ledger([{ id: "q1" }]);
  const consumer = new InvoluteConsumer({
    agents: () => [agentOf(call)],
    // Longer than two renewal ticks, which is what a real turn is against a 60s lease.
    runTurn: () => new Promise(resolve => setTimeout(() => resolve("答复"), 70)),
    mayAnswer: () => ({ ok: true }),
    renewMs: 20,
    sessionId: "s-test",
    log: () => {},
  });
  await consumer.poll();
  assert.equal(store[0]!.answers[0]!.state, "completed", "the answer landed, so it carried the token the claim returned");
  const take = claimCalls.find(c => c.token === undefined)!;
  const renewals = claimCalls.filter(c => c.token !== undefined);
  assert.ok(renewals.length >= 2, `the lease was renewed while the turn ran (${renewals.length} renewals)`);
  assert.ok(renewals.every(r => r.token === store[0]!.token || r.token === `t-ada-${claimCalls.indexOf(take) + 1}`), "with the same token the claim returned");
});

test("a request the ledger handed over is answered by the successor in its own name, with the relation stated (INV-582 A1/A4, INV-556 A1)", async () => {
  // The ledger's hand-off (INV-589): Ada's request expired, and a *new* request q2 was opened
  // to Iris, linked to the old one. Iris sees q2 in its own inbox.
  const { store, call } = ledger([
    { id: "q1", state: "failed", target: "ada" },
    { id: "q2", target: "iris", handed_off_from_id: "q1", handed_off_from_handle: "ada" },
  ]);
  const prompts: string[] = [];
  const consumer = new InvoluteConsumer({
    agents: () => [{ agentId: "a2", agentName: "Iris", handle: "iris", call: call("iris") }],
    runTurn: async input => {
      prompts.push(input.prompt);
      return "记录里写的是 2026-09-10 选了轮询，理由是这台机器没有入站端口（见 PR#475）。";
    },
    mayAnswer: () => ({ ok: true }),
    receiptsFor: () => "What was written down at the time:\n- 2026-09-10 Ada: chose polling — no inbound port",
    log: () => {},
  });

  const outcome = await consumer.poll();
  assert.deepEqual(outcome.stoodIn, ["q2"]);
  assert.deepEqual(outcome.answered, []);
  assert.deepEqual(outcome.unanswered, []);

  // The ledger's author is the stand-in, on the request addressed to it. That is the whole point.
  const handed = store.find(row => row.id === "q2")!;
  assert.equal(handed.claimed_by, "iris");
  assert.equal(handed.answers[0]!.state, "completed");
  assert.match(handed.answers[0]!.body, /Iris \(@iris\), standing in for @ada/);
  assert.match(handed.answers[0]!.body, /Based on what is written down on this item/);
  assert.deepEqual(store.find(row => row.id === "q1")!.answers, [], "the closed original is not touched");

  // And it was told, in the same breath as the question, not to invent Ada's reasons.
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /@ada \(@ada\) was asked this and did not answer within the deadline, and you are its declared stand-in/);
  assert.match(prompts[0]!, /You were not there/);
  assert.match(prompts[0]!, /2026-09-10 Ada: chose polling/, "with the receipts it is supposed to answer from");
});

test("a hand-off the ledger did not name is still answered as a stand-in, without inventing who was asked first", async () => {
  const { store, call } = ledger([{ id: "q2", target: "iris", handed_off_from_id: "q1" }]);
  await new InvoluteConsumer({
    agents: () => [{ agentId: "a2", agentName: "Iris", handle: "iris", call: call("iris") }],
    runTurn: async () => "From the record: polling, because of the NAT.",
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  }).poll();
  const body = store[0]!.answers[0]!.body;
  assert.match(body, /standing in for the agent this was first put to/);
  assert.doesNotMatch(body, /@undefined|@the agent/);
});

test("an agent that cannot answer leaves the request open, in words, for the ledger to hand off (INV-582 A2/A3)", async () => {
  // Ada's runtime is gone. Under the ledger's model nobody else may claim Ada's request, and
  // a `failed` answer would close it so nobody is handed anything. So Ada — whose credential
  // this still is — says so and hands the claim back; the ledger's sweep does the rest.
  const { store, call } = ledger([{ id: "q1", target: "ada" }]);
  const irisCalls: string[] = [];
  const lines: string[] = [];
  const consumer = new InvoluteConsumer({
    agents: () => [
      { agentId: "a1", agentName: "Ada", handle: "ada", call: call("ada") },
      { agentId: "a2", agentName: "Iris", handle: "iris", call: async (tool: string, args: Record<string, unknown>) => { irisCalls.push(tool); return call("iris")(tool, args); } },
    ],
    successorFor: handle => (handle === "ada" ? { kind: "agent", handle: "iris" } : undefined),
    canRun: agentId => agentId !== "a1",
    runTurn: async () => "Iris would answer, but this is not addressed to Iris.",
    mayAnswer: () => ({ ok: true }),
    log: line => lines.push(line),
  });

  const outcome = await consumer.poll();
  assert.deepEqual(outcome.heldForHandoff, ["q1"]);
  assert.deepEqual(outcome.stoodIn, []);
  assert.deepEqual(outcome.failed, []);
  assert.equal(store[0]!.answers.length, 1, "exactly one post, and it is Ada's own account of itself");
  const posted = store[0]!.answers[0]!;
  assert.equal(posted.state, "input-required", "open, not closed: the ledger only hands off a request that is still open");
  assert.match(posted.body, /No answer is coming from Ada on this one/);
  assert.match(posted.body, /Ada is not able to run here at the moment/);
  assert.match(posted.body, /the ledger hands this to @iris, its declared stand-in/);
  assert.doesNotMatch(posted.body, /not running|offline|crashed/, "what we saw is reported; what the silence means is not guessed at");
  assert.equal(store[0]!.claimed_by, null, "the claim was handed back with the words");
  assert.ok(!irisCalls.includes("agent_request_claim"), "Iris never tries to claim a request addressed to Ada — the ledger would refuse, and the hand-off is its job");
  assert.equal(outcome.unanswered.length, 1, "and the attention page still shows it as waiting");
});

test("with a person as stand-in, the same words name the person; with nobody, the request is closed and says so (INV-556 A4)", async () => {
  const withPerson = ledger([{ id: "q1" }]);
  const held = await new InvoluteConsumer({
    agents: () => [agentOf(withPerson.call)],
    successorFor: () => ({ kind: "person", name: "Chris" }),
    runTurn: async () => {
      throw new Error("the box is down");
    },
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  }).poll();
  assert.deepEqual(held.heldForHandoff, ["q1"]);
  const note = withPerson.store[0]!.answers[0]!;
  assert.equal(note.state, "input-required");
  assert.match(note.body, /From this side: I could not finish looking into this: the box is down/);
  assert.match(note.body, /the ledger hands this to Chris, who is named as its stand-in/);

  const nobody = ledger([{ id: "q1" }]);
  const closed = await new InvoluteConsumer({
    agents: () => [agentOf(nobody.call)],
    runTurn: async () => {
      throw new Error("the box is down");
    },
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  }).poll();
  assert.deepEqual(closed.failed, ["q1"]);
  const detail = nobody.store[0]!.answers[0]!;
  assert.equal(detail.state, "failed", "nothing to hand off to, so the request is closed rather than left to expire in silence");
  assert.match(detail.body, /Ada gave no answer within the deadline/);
  assert.match(detail.body, /Nobody is named as its stand-in/);
  assert.equal(closed.unanswered[0]!.work, "INV-999");
});

test("the agent that was asked comes back later, and the answered request is not reopened (INV-556 A3)", async () => {
  const { store, call } = ledger([{ id: "q1", target: "iris", handed_off_from_id: "q0", handed_off_from_handle: "ada" }]);
  let adaIsBack = false;
  const consumer = new InvoluteConsumer({
    agents: () => [
      { agentId: "a1", agentName: "Ada", handle: "ada", call: call("ada") },
      { agentId: "a2", agentName: "Iris", handle: "iris", call: call("iris") },
    ],
    canRun: agentId => agentId !== "a1" || adaIsBack,
    runTurn: async () => (adaIsBack ? "Actually, here is the full story." : "Iris answers from the record."),
    mayAnswer: () => ({ ok: true }),
    log: () => {},
  });

  const first = await consumer.poll();
  assert.deepEqual(first.stoodIn, ["q1"]);
  assert.equal(store[0]!.answers.length, 1);

  // Ada is back and would now have plenty to say. The request is closed; whatever it has to
  // add belongs in the thread as a new comment, not as a second answer to one question.
  adaIsBack = true;
  const second = await consumer.poll();
  assert.deepEqual(second.answered, []);
  assert.deepEqual(second.stoodIn, []);
  assert.equal(store[0]!.answers.length, 1, "still one answer");
  assert.match(store[0]!.answers[0]!.body, /Iris/, "and it is the one that was given at the time");
});
