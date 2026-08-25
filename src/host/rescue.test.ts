/**
 * Tests for finding work the process abandoned.
 *
 * The failure this repairs is not a crash — it is worse than a crash, because it looks
 * like progress. The turn is recovered from the ledger and finishes; the promise that
 * would have delivered its answer died with the process; and the person watches a card
 * that says "Working" for ever while the money is spent and the answer goes nowhere.
 *
 * So both directions matter. Missing a stuck task leaves the frozen card. Calling a
 * healthy task stuck reopens work somebody is actively doing, which is how two agents end
 * up doing the same thing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rescueMessage, stuckTasks } from "./rescue.ts";
import type { Task } from "./tasks.ts";

const task = (over: Partial<Task>): Task => ({
  id: "t1",
  title: "look something up",
  status: "doing",
  requester: "feishu:ou_chris",
  conversation: "feishu-oc_room",
  createdAt: "2026-08-25T02:00:00.000Z",
  updatedAt: "2026-08-25T02:00:00.000Z",
  history: [],
  ...over,
});

test("a task nobody is working on is stuck; one somebody is working on is not", () => {
  const doing = task({});

  // After a restart nothing is live, which is the case this exists for.
  assert.equal(stuckTasks([doing], new Set()).length, 1);

  // But the same check on a running system must not reopen live work — that is how two
  // agents end up doing the same thing.
  assert.equal(stuckTasks([doing], new Set(["feishu-oc_room"])).length, 0);
});

test("only `doing` claims that work is happening now", () => {
  // `review` is somebody else's turn to act, and `blocked` already says it is going
  // nowhere and why. Neither is a lie the way a frozen "Working" card is.
  for (const status of ["open", "blocked", "review", "done", "dropped"] as const) {
    assert.equal(stuckTasks([task({ status })], new Set()).length, 0, status);
  }
});

test("where to say something travels with the task", () => {
  const [stuck] = stuckTasks([task({})], new Set());
  assert.equal(stuck?.conversation, "feishu-oc_room");
  assert.equal(stuck?.requester, "feishu:ou_chris");

  // A task raised from the web has no chat to push to, and that is not an error — the
  // page shows it. It still has to be rescued.
  const [fromWeb] = stuckTasks([task({ conversation: undefined as never })], new Set());
  assert.ok(fromWeb !== undefined);
  assert.equal(fromWeb.conversation, undefined);
});

test("the message does not claim the work failed, because usually it did not", () => {
  const [stuck] = stuckTasks([task({})], new Set());
  const message = rescueMessage(stuck!);

  // The turn is resumed from the ledger and usually finishes; what was lost is the
  // delivery. "It failed" would cost the person work that exists.
  assert.doesNotMatch(message, /failed/i);
  assert.match(message, /may well have finished/);
  assert.match(message, /cannot tell/);
  // Named, so the person can point at it rather than describe it again.
  assert.match(message, /t1/);
  assert.match(message, /look something up/);
});
