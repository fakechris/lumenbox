/** The guest desk (INV-1708, docs/97): members-only by default, a cap per group chat per day that a restart keeps, and knowledge only an Admin writes. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_GUEST_TURNS_PER_DAY, GuestDesk } from "./guests.ts";

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
