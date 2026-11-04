/** An agent's unprompted pushes have a daily allowance; the rest wait for the chat's digest, and what needs a person never waits (INV-1576). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heldSection, PUSHES_PER_DAY, PushBudget } from "./push-budget.ts";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-push-budget-"));
  return { path: join(dir, "push-budget.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const at = (day: number, hour: number) => () => new Date(2026, 10, day, hour, 0, 0);

test("a day of twenty unprompted pushes and three approvals: eight go, one digest carries the twelve, every approval goes", () => {
  const { path, cleanup } = scratch();
  try {
    const budget = new PushBudget(path, at(4, 9));
    const delivered: string[] = [];
    // What deliverToChat does with the verdict: send, or hold for the digest.
    const push = (text: string, exempt = false) => { if (budget.admit({ agentId: "vic", chatKey: "feishu:room", text, exempt }) === "send") delivered.push(text); };
    for (let n = 1; n <= 20; n++) {
      push(`routine result ${n}`);
      if (n % 7 === 0) push(`goal t${n} verified: awaiting your acceptance`, true);
    }
    assert.equal(delivered.filter(text => text.startsWith("routine")).length, PUSHES_PER_DAY, "the allowance is eight");
    assert.equal(delivered.filter(text => text.startsWith("goal")).length, 2, "what needs a person is never held");
    push("goal t21 verified: awaiting your acceptance", true);
    assert.equal(delivered.filter(text => text.startsWith("goal")).length, 3);
    assert.deepEqual(budget.counts("vic"), { sent: 8, held: 12, exempt: 3, perDay: 8 });
    const held = budget.heldFor("feishu:room");
    const digest = heldSection(held, () => "Vic");
    assert.match(digest, /^Held updates \(12\), past the agents' daily allowance:\n- Vic: routine result 9\n/);
    assert.equal(digest.split("\n").length, 13, "one message: a heading and the twelve");
    budget.release("feishu:room", held.length);
    assert.deepEqual(budget.heldChats(), [], "sent once");
  } finally {
    cleanup();
  }
});

test("held pushes and an agent's own allowance survive a restart; a new day starts a new count", () => {
  const { path, cleanup } = scratch();
  try {
    const first = new PushBudget(path, at(4, 10));
    first.setPerDay("ada", 2);
    for (let n = 0; n < 4; n++) first.admit({ agentId: "ada", chatKey: "dingtalk:chat", text: `update ${n}` });
    const again = new PushBudget(path, at(4, 17));
    assert.deepEqual(again.counts("ada"), { sent: 2, held: 2, exempt: 0, perDay: 2 });
    assert.deepEqual(again.heldFor("dingtalk:chat").map(push => push.text), ["update 2", "update 3"]);
    // A digest that did not land releases nothing; the next one carries the same updates.
    assert.equal(again.heldFor("dingtalk:chat").length, 2);
    again.release("dingtalk:chat", 2);
    assert.deepEqual(new PushBudget(path, at(4, 19)).heldChats(), []);
    const tomorrow = new PushBudget(path, at(5, 8));
    assert.deepEqual(tomorrow.counts("ada"), { sent: 0, held: 0, exempt: 0, perDay: 2 }, "the allowance is per local day");
    tomorrow.setPerDay("ada", null);
    assert.equal(tomorrow.perDayOf("ada"), PUSHES_PER_DAY, "null goes back to the default");
  } finally {
    cleanup();
  }
});

test("a push with no agent behind it is not counted, and a nonsense allowance is refused", () => {
  const budget = new PushBudget(undefined, at(4, 9));
  for (let n = 0; n < 20; n++) assert.equal(budget.admit({ chatKey: "feishu:room", text: "a host notice" }), "send");
  assert.deepEqual(budget.heldChats(), []);
  assert.throws(() => budget.setPerDay("vic", -1), /whole number from 0 to 1000/);
  assert.throws(() => budget.setPerDay("vic", 2.5), /whole number/);
  budget.setPerDay("vic", 0);
  assert.equal(budget.admit({ agentId: "vic", chatKey: "feishu:room", text: "anything" }), "hold", "zero holds everything for the digest");
  assert.equal(budget.admit({ agentId: "vic", chatKey: "feishu:room", text: "approve this?", exempt: true }), "send");
});
