/**
 * What needs me (INV-543): the questions with my name on them, the closes I have not
 * objected to, the reviews I owe and the tasks of mine that have been nudged — and,
 * separately, what I am waiting on. Somebody else's items are not mine.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { attentionFor } from "./attention.ts";
import type { Task } from "./tasks.ts";
import type { WatchedQuestion } from "./question-expiry.ts";

const T0 = Date.parse("2026-09-15T09:00:00Z");
const task = (over: Partial<Task>): Task => ({
  id: "t1",
  title: "a task",
  status: "open",
  requester: "p-chris",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  history: [],
  ...over,
});
const question = (over: Partial<WatchedQuestion>): WatchedQuestion => ({
  id: "q1",
  agentId: "a1",
  agentName: "Ada",
  conversation: "feishu-oc_x",
  question: "Which account?",
  askedAt: T0,
  expiresAt: T0 + 3_600_000,
  ...over,
});
const nameOf = (id: string) => ({ "p-chris": "Chris", "p-mia": "Mia", bot: "Ada" })[id] ?? id;

test("two lists, soonest first, and somebody else's items are not mine", () => {
  const answer = attentionFor({
    principalId: "p-chris",
    identities: ["feishu:ou_chris"],
    nameOf,
    questions: [
      question({ asker: "feishu:ou_chris", fallback: "the work account" }),
      question({ id: "q2", asker: "feishu:ou_mia", question: "Mia's question" }),
    ],
    tasks: [
      task({ id: "t-close", title: "old thread", closeProposal: { by: "bot", at: "2026-09-14T09:00:00Z", reason: "superseded", decideBy: "2026-09-16T09:00:00Z" } }),
      task({ id: "t-review", title: "the delta", status: "review", reviewerId: "p-chris", assigneeId: "bot" }),
      task({ id: "t-nudged", title: "answer Q1-Q5", due: "2026-09-10T23:59:59.000Z", aging: { nudges: 2, lastNudgedAt: "2026-09-14T09:00:00Z", reason: "overdue" }, assigneeId: "bot" }),
      task({ id: "t-waiting", title: "supplier quote", waitingOn: "the supplier", assigneeId: "bot" }),
      task({ id: "t-hers", title: "Mia's task", requester: "p-mia" }),
      task({ id: "t-done", title: "finished", status: "done" }),
    ],
    now: new Date(T0),
  });

  assert.deepEqual(answer.mine.map(item => [item.kind, item.ref]), [
    ["nudged", "t-nudged"],
    ["question", "feishu-oc_x"],
    ["close-proposal", "t-close"],
    ["review", "t-review"],
  ], "soonest deadline first; the review has no date so it is last");
  assert.match(answer.mine.find(item => item.kind === "question")!.detail, /with no answer it goes with: the work account/);
  assert.match(answer.mine.find(item => item.kind === "close-proposal")!.detail, /Say nothing and it closes/);
  assert.deepEqual(answer.theirs.map(item => [item.ref, item.detail]), [["t-waiting", "waiting on the supplier"]]);

  // Mia's question and Mia's task are hers.
  assert.equal(answer.mine.some(item => item.title === "Mia's question"), false);
  assert.equal(answer.theirs.some(item => item.title === "Mia's task"), false);
});

test("the operator's own credential sees everything with a clock on it", () => {
  const answer = attentionFor({
    principalId: "",
    identities: [],
    all: true,
    nameOf,
    questions: [question({ asker: "feishu:ou_mia" })],
    tasks: [task({ id: "t-hers", requester: "p-mia", aging: { nudges: 1, lastNudgedAt: "2026-09-14T09:00:00Z", reason: "idle" } })],
    now: new Date(T0),
  });
  assert.deepEqual(answer.mine.map(item => item.kind), ["question", "nudged"]);
});

test("a paused teammate chain is everyone's to see, with either agent as the way back in (INV-1277)", () => {
  const answer = attentionFor({
    principalId: "p-mia",
    identities: [],
    tasks: [],
    questions: [],
    nameOf,
    paused: [{ fromId: "a1", fromName: "Ada", toName: "Bob", hops: 4, at: "2026-10-19T08:30:00.000Z" }],
    now: new Date(T0),
  });
  const row = answer.mine.find(item => item.kind === "paused");
  assert.ok(row !== undefined, "shown without being the operator");
  assert.equal(row.ref, "a1");
  assert.match(row.title, /Ada ↔ Bob: paused after 4 turns with no person/);
  assert.match(row.detail, /message either of them/);
});

test("a task whose mandate went stale waits on the person whose word it was (INV-1457)", () => {
  const stale = task({ id: "t7", assigneeId: "bot", mandate: { by: "p-chris", strength: "explicit", grantedAt: "2026-09-01T00:00:00.000Z", stale: { at: "2026-09-15T08:00:00.000Z", reasons: ["rules-changed"] } } });
  const mine = attentionFor({ principalId: "p-chris", identities: [], tasks: [stale], questions: [], nameOf, now: new Date(T0) }).mine;
  assert.equal(mine.length, 1);
  assert.deepEqual({ kind: mine[0]!.kind, ref: mine[0]!.ref, with: mine[0]!.with }, { kind: "reauthorize", ref: "t7", with: "Ada" });
  assert.match(mine[0]!.detail, /rules changed/);
  assert.equal(attentionFor({ principalId: "p-mia", identities: [], tasks: [stale], questions: [], nameOf, now: new Date(T0) }).mine.length, 0, "not Mia's to re-authorise");
  const withdrawn = task({ ...stale, mandate: { ...stale.mandate!, withdrawn: { at: "t", by: "p-chris", reason: "stop" } } });
  assert.equal(attentionFor({ principalId: "p-chris", identities: [], tasks: [withdrawn], questions: [], nameOf, now: new Date(T0) }).mine.length, 0, "a withdrawn mandate asks nobody");
});

test("a message the host could not get into a chat after its retries is everyone's to see (INV-1460)", () => {
  const answer = attentionFor({ principalId: "p-mia", identities: [], tasks: [], questions: [], nameOf, now: new Date(T0), undeliverable: [{ id: "r1", chatKey: "feishu:oc_9", purpose: "attention under t3", attempts: 3, lastError: "ECONNRESET" }] });
  assert.equal(answer.mine.length, 1);
  assert.deepEqual({ kind: answer.mine[0]!.kind, ref: answer.mine[0]!.ref }, { kind: "undeliverable", ref: "feishu:oc_9" });
  assert.match(answer.mine[0]!.detail, /3 attempts; last: ECONNRESET/);
});

test("every live task has a stage by the table, a blocked task with options is a question for its requester, and the world is read for delivery and activity (INV-1464)", () => {
  const asks = task({ id: "t3", status: "blocked", assigneeId: "bot", conversation: "feishu-oc_1", history: [{ at: "t", by: "bot", status: "blocked", note: "us or eu?", options: ["us", "eu"] }] });
  const working = task({ id: "t4", status: "doing", assigneeId: "bot", conversation: "feishu-oc_2" });
  const stuck = task({ id: "t5", status: "doing", assigneeId: "bot", conversation: "feishu-oc_3" });
  const answer = attentionFor({
    principalId: "p-chris", identities: [], tasks: [asks, working, stuck], questions: [], nameOf, now: new Date(T0),
    undeliverable: [{ id: "r1", chatKey: "feishu:oc_3", purpose: "notice", attempts: 3 }],
    chatKeyOf: conversation => ({ "feishu-oc_3": "feishu:oc_3" })[conversation],
    active: t => t.id === "t4",
  });
  assert.deepEqual(answer.stages, { t3: "person/answer", t4: "working", t5: "person/delivery" });
  const question = answer.mine.find(item => item.ref === "t3");
  assert.deepEqual({ kind: question?.kind, stage: question?.stage, with: question?.with }, { kind: "question", stage: "person/answer", with: "Ada" });
  assert.match(question?.detail ?? "", /us or eu\? — us \/ eu/);
  assert.equal(answer.theirs.find(item => item.ref === "t4")?.stage, "working");
});

test("a pending approval is mine, first on the strip, with the agent, what it asked and when (INV-1627)", async () => {
  const { urgencyOf } = await import("./attention.ts");
  const out = attentionFor({
    principalId: "p-chris", identities: [], tasks: [], nameOf,
    questions: [question({})],
    approvals: [{ id: "ap-1", agentId: "a2", agentName: "Vic", description: "bash — cd /home/box/work;\n  find . -name '.scratch*' | xargs rm", action: "run a command in the box", requestedAt: "2026-11-04T02:36:16.275Z" }],
    now: new Date(T0),
  });
  const approval = out.mine.find(item => item.kind === "approval");
  assert.ok(approval);
  assert.equal(approval.ref, "ap-1");
  assert.equal(approval.title, "Vic wants to run a command in the box");
  assert.match(approval.detail, /^bash — cd \/home\/box\/work; find \. -name '\.scratch\*' \| xargs rm · asked 2026-11-04 02:36Z$/);
  assert.equal(approval.with, "Vic");
  assert.ok(urgencyOf("approval") < urgencyOf("question") && urgencyOf("question") < urgencyOf("spend-limit") && urgencyOf("spend-limit") < urgencyOf("review"));
});

test("a task an agent reviews is the team's, not mine, even for the operator; every kind is a decision or a notice (INV-1647)", async () => {
  const { DECISION_KINDS, isDecision } = await import("./attention.ts");
  const out = attentionFor({
    principalId: "", identities: [], all: true, nameOf,
    agentIds: new Set(["bot", "vic"]),
    questions: [],
    tasks: [
      task({ id: "t-team", title: "[临时·bob-audit] 判别臂B", status: "review", requester: "bot", assigneeId: "vic", reviewerId: "bot" }),
      task({ id: "t-mine", title: "the delta", status: "review", reviewerId: "p-chris", assigneeId: "bot" }),
    ],
    now: new Date(T0),
  });
  assert.deepEqual(out.mine.filter(item => item.kind === "review").map(item => item.ref), ["t-mine"]);
  assert.equal(out.stages["t-team"], "review");
  assert.equal(out.stages["t-mine"], "person/review");
  assert.ok(isDecision("approval") && isDecision("question") && isDecision("review") && isDecision("close-proposal") && isDecision("reauthorize"));
  assert.ok(!isDecision("provider-resting") && !isDecision("box-update") && !isDecision("boundary-probe") && !isDecision("undeliverable") && !isDecision("nudged") && !isDecision("team-memory") && !isDecision("flagged"));
  assert.ok(DECISION_KINDS.size >= 5);
});
