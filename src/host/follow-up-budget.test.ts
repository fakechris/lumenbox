/**
 * The follow-up budget (INV-535): one message per room per sweep, two a day, five items
 * in each; an ask can wait, an act never does; and what was said survives a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLLOW_UP_ITEMS_PER_MESSAGE, FOLLOW_UP_MESSAGES_PER_DAY, FOLLOW_UP_WINDOW_MS, FollowUpBudget } from "./follow-up-budget.ts";

const T0 = Date.parse("2026-09-14T09:00:00Z");
const ask = (i: number) => ({ kind: "ask" as const, text: `t${i} is overdue — close / downgrade / continue?`, ref: `t${i}` });
const act = (i: number) => ({ kind: "act" as const, text: `t${i} was archived`, ref: `t${i}` });

test("everything due for one room in one sweep is one message, five items at a time", () => {
  const budget = new FollowUpBudget();
  const message = budget.compose("feishu:oc_x", [ask(1), ask(2), ask(3), ask(4), ask(5), ask(6), ask(7)], T0)!;
  assert.equal(message.text.split("\n").filter(line => line.startsWith("t")).length, FOLLOW_UP_ITEMS_PER_MESSAGE);
  assert.match(message.text, /\(and 2 more on the board; I will not list them again today\)/);
  assert.deepEqual(message.sent, ["t1", "t2", "t3", "t4", "t5"]);
  assert.deepEqual(message.held.map(item => item.ref), ["t6", "t7"], "the rest are not counted as said");
});

test("two asks a day, and the third waits; an act goes out anyway and carries an ask with it", () => {
  const budget = new FollowUpBudget();
  for (const round of [1, 2]) {
    const message = budget.compose("feishu:oc_x", [ask(round)], T0)!;
    assert.equal(message.text, ask(round).text);
    budget.record("feishu:oc_x", T0);
  }
  assert.equal(budget.remaining("feishu:oc_x", T0), 0);
  const third = budget.compose("feishu:oc_x", [ask(3)], T0)!;
  assert.equal(third.text, "", "nothing more is asked of this room today");
  assert.deepEqual(third.held.map(item => item.ref), ["t3"]);

  // An act is the host saying what it already did: never held back, and an ask rides along.
  const spoken = budget.compose("feishu:oc_x", [act(9), ask(3)], T0)!;
  assert.equal(spoken.text, "t9 was archived\nt3 is overdue — close / downgrade / continue?");
  assert.deepEqual(spoken.sent, ["t9", "t3"]);

  // Tomorrow the room is asked again.
  assert.equal(budget.remaining("feishu:oc_x", T0 + FOLLOW_UP_WINDOW_MS + 1), FOLLOW_UP_MESSAGES_PER_DAY);
  assert.equal(budget.compose("feishu:oc_x", [ask(3)], T0 + FOLLOW_UP_WINDOW_MS + 1)!.text, ask(3).text);
});

test("one room's budget is not another's, and the day's spending survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-followups-"));
  try {
    const path = join(dir, "follow-ups.jsonl");
    const budget = new FollowUpBudget(path);
    budget.record("feishu:oc_x");
    budget.record("feishu:oc_x");
    assert.equal(budget.remaining("feishu:oc_x"), 0);
    assert.equal(budget.remaining("feishu:oc_y"), FOLLOW_UP_MESSAGES_PER_DAY, "a different room has its own day");

    const afterRestart = new FollowUpBudget(path);
    assert.equal(afterRestart.remaining("feishu:oc_x"), 0, "a budget that resets with the process is not a budget");
    assert.equal(afterRestart.compose("feishu:oc_x", [ask(1)])!.text, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
