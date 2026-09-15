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
