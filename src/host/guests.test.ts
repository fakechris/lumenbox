/** The guest desk (INV-1708, docs/97): members-only by default, a cap per group chat per day that a restart keeps, and knowledge only an Admin writes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GUEST_TURNS_PER_DAY, DEFAULT_GUEST_WINDOW, GENERAL_COLLECTION, GUEST_WINDOW_LIMIT, GuestDesk } from "./guests.ts";

const turn = { turnId: "guest-1", agentId: "ada", agentName: "Ada", door: "feishu", chatKey: "feishu:oc_g", identity: "feishu:ou_x", senderLabel: "x", question: "q", answer: "a", offered: [], calls: [], rounds: 1, inputTokens: 1, outputTokens: 1, outcome: "answered" as const };

test("an agent answers members only until an Admin says otherwise, and the setting survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1708-desk-"));
  try {
    const paths = { settings: join(dir, "guests.jsonl"), turns: join(dir, "guest-turns.jsonl") };
    const desk = new GuestDesk(paths);
    assert.equal(desk.modeOf("ada"), "members");
    assert.equal(desk.cap(), DEFAULT_GUEST_TURNS_PER_DAY);
    desk.setMode("ada", "guests", "Chris");
    desk.setCap(2, "Chris");
    const entry = desk.addKnowledge({ title: "Opening hours", text: "We answer 9:00-18:00 Beijing time, Monday to Friday." }, "Chris");
    desk.addKnowledge({ title: "Refunds", text: "Refunds within 7 days of purchase." }, "Chris");
    assert.throws(() => desk.setMode("ada", "everyone" as never, "Chris"));
    assert.throws(() => desk.setCap(0, "Chris"));
    assert.throws(() => desk.addKnowledge({ title: " ", text: "x" }, "Chris"));

    const again = new GuestDesk(paths);
    assert.equal(again.modeOf("ada"), "guests");
    assert.equal(again.cap(), 2);
    assert.deepEqual(again.search("what are your opening hours").map(found => found.id), [entry.id]);
    assert.ok(again.removeKnowledge(entry.id, "Chris"));
    assert.equal(new GuestDesk(paths).knowledge().length, 1);
    again.setMode("ada", "members", "Chris");
    assert.equal(new GuestDesk(paths).modeOf("ada"), "members");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("past the day's cap a group chat is told once, then silence; the next day it starts again, and a restart keeps the count", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1708-cap-"));
  try {
    const clock = { now: new Date(2026, 10, 7, 10, 0, 0) };
    const paths = { settings: join(dir, "guests.jsonl"), turns: join(dir, "guest-turns.jsonl") };
    const desk = new GuestDesk(paths, () => clock.now);
    desk.setCap(2, "Chris");
    for (let i = 0; i < 2; i++) {
      assert.equal(desk.admit("feishu", "feishu:oc_g"), "yes");
      desk.recordTurn(turn);
    }
    assert.equal(desk.admit("feishu", "feishu:oc_other"), "yes", "the cap is per group chat");
    const restarted = new GuestDesk(paths, () => clock.now);
    assert.equal(restarted.turnsToday("feishu", "feishu:oc_g"), 2);
    assert.equal(restarted.admit("feishu", "feishu:oc_g"), "notify");
    restarted.recordTurn({ ...turn, outcome: "over-cap" });
    assert.equal(restarted.admit("feishu", "feishu:oc_g"), "silent");
    assert.equal(restarted.turnsToday("feishu", "feishu:oc_g"), 2, "a refused turn is not a turn");
    clock.now = new Date(2026, 10, 8, 10, 0, 0);
    assert.equal(restarted.admit("feishu", "feishu:oc_g"), "yes");
    assert.equal(restarted.recentTurns().every(line => line.source === "guest"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the short window is one guest's in one group chat: the last 5 exchanges or 30 minutes, an Admin can turn it off or extend it to the hard cap, and a restart forgets it (INV-1713)", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1713-window-"));
  try {
    const clock = { now: new Date(2026, 10, 7, 10, 0, 0) };
    const paths = { settings: join(dir, "guests.jsonl"), turns: join(dir, "guest-turns.jsonl"), reviews: join(dir, "guest-reviews.jsonl") };
    const desk = new GuestDesk(paths, () => clock.now);
    assert.deepEqual(desk.window(), DEFAULT_GUEST_WINDOW);
    for (let i = 1; i <= 7; i++) desk.remember("feishu", "feishu:oc_g", "feishu:ou_a", `a-question-${i}`, `a-answer-${i}`);
    desk.remember("feishu", "feishu:oc_g", "feishu:ou_b", "b-question", "b-answer");
    desk.remember("feishu", "feishu:oc_other", "feishu:ou_a", "a-elsewhere", "x");
    assert.deepEqual(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_a").map(e => e.question), ["a-question-3", "a-question-4", "a-question-5", "a-question-6", "a-question-7"], "the last five, and only this guest's in this group chat");
    assert.deepEqual(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_b").map(e => e.question), ["b-question"]);
    clock.now = new Date(2026, 10, 7, 10, 31, 0);
    assert.deepEqual(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_a"), [], "thirty minutes on, it has expired");

    assert.throws(() => desk.setWindow(GUEST_WINDOW_LIMIT.exchanges + 1, 30, "Chris"), /at most|0 to 20/);
    assert.throws(() => desk.setWindow(5, GUEST_WINDOW_LIMIT.minutes + 1, "Chris"));
    desk.setWindow(GUEST_WINDOW_LIMIT.exchanges, GUEST_WINDOW_LIMIT.minutes, "Chris");
    desk.remember("feishu", "feishu:oc_g", "feishu:ou_a", "kept", "kept");
    clock.now = new Date(2026, 10, 7, 20, 0, 0);
    assert.equal(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_a").length, 1, "extended to a day, it is still there ten hours on");
    desk.setWindow(0, 30, "Chris");
    assert.deepEqual(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_a"), [], "turned off, what it held is gone");
    desk.remember("feishu", "feishu:oc_g", "feishu:ou_a", "off", "off");
    assert.deepEqual(desk.windowFor("feishu", "feishu:oc_g", "feishu:ou_a"), []);

    desk.setWindow(5, 30, "Chris");
    desk.remember("feishu", "feishu:oc_g", "feishu:ou_a", "WINDOW_ONLY_QUESTION", "WINDOW_ONLY_ANSWER");
    const again = new GuestDesk(paths, () => clock.now);
    assert.deepEqual(again.window(), { exchanges: 5, minutes: 30 }, "the setting survives a restart");
    assert.deepEqual(again.windowFor("feishu", "feishu:oc_g", "feishu:ou_a"), [], "the window does not");
    for (const path of Object.values(paths)) assert.doesNotMatch(existsSync(path) ? readFileSync(path, "utf8") : "", /WINDOW_ONLY/, "nothing of the window is written to any ledger");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knowledge collections: the old single list becomes 组织通用, each agent reads only what it ticked, and a removed collection takes its entries with it (INV-1713)", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1713-sets-"));
  try {
    const paths = { settings: join(dir, "guests.jsonl") };
    // A ledger written before collections: one entry with no collection.
    writeFileSync(paths.settings, `${JSON.stringify({ kind: "knowledge", at: "2026-11-07T01:00:00.000Z", by: "Chris", entry: { id: "gold", title: "Opening hours", text: "We answer 9:00-18:00 Beijing time.", at: "2026-11-07T01:00:00.000Z", by: "Chris" } })}\n`);
    const desk = new GuestDesk(paths);
    assert.deepEqual(desk.collections().map(c => c.id), [GENERAL_COLLECTION]);
    assert.deepEqual(desk.ticksOf("ada"), [GENERAL_COLLECTION], "an agent nobody ticked uses 组织通用, so the old list still answers");
    assert.deepEqual(desk.viewFor("ada").knowledge().map(e => e.id), ["gold"]);

    const sales = desk.addCollection("Sales", "Chris");
    const price = desk.addKnowledge({ title: "Price list", text: "The standard plan is 99 yuan a month.", collection: sales.id }, "Chris");
    assert.throws(() => desk.addKnowledge({ title: "x", text: "y", collection: "nope" }, "Chris"));
    desk.setTicks("bob", [sales.id], "Chris");
    assert.throws(() => desk.setTicks("bob", ["nope"], "Chris"));
    const ada = desk.viewFor("ada"), bob = desk.viewFor("bob");
    assert.deepEqual(ada.search("standard plan price").map(e => e.id), [], "Ada did not tick Sales: its search never ranks a Sales entry");
    assert.equal(ada.entry(price.id), undefined, "nor reads it by id");
    assert.deepEqual(bob.search("standard plan price").map(e => e.id), [price.id]);
    assert.equal(bob.entry("gold"), undefined, "and Bob, ticking only Sales, cannot read 组织通用");

    const restarted = new GuestDesk(paths);
    assert.deepEqual(restarted.ticksOf("bob"), [sales.id]);
    assert.equal(restarted.renameCollection(GENERAL_COLLECTION, "通用问答", "Chris")?.name, "通用问答");
    assert.equal(restarted.removeCollection(GENERAL_COLLECTION, "Chris"), false, "the default collection stays");
    assert.ok(restarted.removeCollection(sales.id, "Chris"));
    const after = new GuestDesk(paths);
    assert.deepEqual(after.knowledge().map(e => e.id), ["gold"], "its entries went with it");
    assert.deepEqual(after.ticksOf("bob"), [], "and Bob now reads nothing");
    assert.equal(after.collections()[0]!.name, "通用问答");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviews: the audit list narrows by group chat, agent, time and the red flag; a held answer is approved once, and only then enters the guest's window (INV-1713)", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1713-audit-"));
  try {
    const clock = { now: new Date(2026, 10, 7, 10, 0, 0) };
    const paths = { settings: join(dir, "guests.jsonl"), turns: join(dir, "guest-turns.jsonl"), reviews: join(dir, "guest-reviews.jsonl") };
    const desk = new GuestDesk(paths, () => clock.now);
    desk.recordTurn({ ...turn, turnId: "t1" });
    desk.recordReview({ turnId: "t1", category: "PASS", confidence: 0.9, reason: "ok", status: "shadow" });
    clock.now = new Date(2026, 10, 7, 11, 0, 0);
    desk.recordTurn({ ...turn, turnId: "t2", agentId: "bob", agentName: "Bob", chatKey: "feishu:oc_sales", question: "refund?", answer: "I can refund you." });
    desk.setHold("feishu", "feishu:oc_sales", true, "Chris");
    desk.recordReview({ turnId: "t2", category: "PROMISE", confidence: 0.95, reason: "promises a refund", status: "held", answer: "I can refund you." });
    assert.deepEqual(desk.audit().map(r => r.turnId), ["t2", "t1"], "newest first");
    assert.deepEqual(desk.audit({ flagged: true }).map(r => r.turnId), ["t2"]);
    assert.deepEqual(desk.audit({ chatKey: "feishu:oc_g" }).map(r => r.turnId), ["t1"]);
    assert.deepEqual(desk.audit({ agentId: "bob" }).map(r => r.turnId), ["t2"]);
    assert.deepEqual(desk.audit({ since: new Date(2026, 10, 7, 10, 30, 0).toISOString() }).map(r => r.turnId), ["t2"]);
    assert.deepEqual(desk.groups(), [{ door: "feishu", chatKey: "feishu:oc_g", hold: false }, { door: "feishu", chatKey: "feishu:oc_sales", hold: true }]);

    const restarted = new GuestDesk(paths, () => clock.now);
    assert.equal(restarted.audit({ held: true })[0]?.review?.category, "PROMISE", "reviews and holds survive a restart");
    assert.ok(restarted.holdsIn("feishu", "feishu:oc_sales"));
    assert.equal(restarted.settle("t1", "approved", "Chris"), undefined, "only a held answer is settled");
    assert.equal(restarted.settle("t2", "approved", "Chris")?.answer, "I can refund you.");
    assert.equal(restarted.settle("t2", "approved", "Chris"), undefined, "and once");
    assert.equal(restarted.reviewOf("t2")?.status, "approved");
    assert.equal(restarted.reviewOf("t2")?.flagged, true, "an approved answer stays red in the record");
    assert.deepEqual(restarted.windowFor("feishu", "feishu:oc_sales", turn.identity).map(e => e.answer), ["I can refund you."]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
