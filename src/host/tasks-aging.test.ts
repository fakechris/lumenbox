/**
 * The board's ageing and close proposals (INV-527, INV-529): a due date is kept, an
 * overdue or idle task nudges twice and is archived on the third pass, any movement
 * resets the count, a close proposal closes by itself when nobody objects and stays open
 * when the requester says no — all on the history, all surviving a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOSE_PROPOSAL_MS, TASK_IDLE_MS, TASK_NUDGE_GAP_MS, TaskStore, dueOf } from "./tasks.ts";

const T0 = new Date("2026-09-01T09:00:00Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

test("a due date is stored as an instant, from a date or an instant", () => {
  assert.equal(dueOf("2026-09-19"), "2026-09-19T23:59:59.000Z");
  assert.equal(dueOf("2026-09-19T10:00:00Z"), "2026-09-19T10:00:00.000Z");
  assert.equal(dueOf("next week"), undefined);
  assert.equal(dueOf(""), undefined);
});

test("overdue and idle tasks nudge twice then archive; movement resets; the history says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-aging-"));
  try {
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    const overdue = store.create({ title: "TEAM.md v2 — answer Q1-Q5", requester: "chris", assigneeId: "bot", due: "2026-09-05", now: T0 })!;
    const idle = store.create({ title: "review t74", requester: "chris", now: T0 })!;
    const fresh = store.create({ title: "fresh", requester: "chris", due: "2026-12-01", now: plus(5 * 86_400_000) })!;
    const proposal = store.create({ title: "only a proposal", requester: "chris", proposedBy: "bot", due: "2026-09-02", now: T0 })!;
    assert.equal(overdue.due, "2026-09-05T23:59:59.000Z");

    assert.deepEqual(store.age(plus(86_400_000)), [], "nothing is due on day one");
    // Day 6: the overdue one is nudged; the idle one is not yet idle; the proposal is never aged.
    const first = store.age(plus(6 * 86_400_000));
    assert.deepEqual(first.map(e => [e.kind, e.task.id]), [["nudge", overdue.id]]);
    assert.match(first[0]!.text, /overdue \(due 2026-09-05T23:59:59\.000Z\) — nudge 1 of 2\. close \/ downgrade \/ continue\?/);
    assert.equal(store.get(overdue.id)?.aging?.nudges, 1);
    assert.deepEqual(store.age(plus(6 * 86_400_000 + 3_600_000)), [], "not nudged again within the gap");

    // Day 8: idle joins; overdue gets its second nudge (48h gap passed).
    const second = store.age(plus(8 * 86_400_000 + 1));
    assert.deepEqual(second.map(e => [e.kind, e.task.id, (e as { nudge?: number }).nudge]).sort(), [["nudge", idle.id, 1], ["nudge", overdue.id, 2]].sort());
    assert.match(second.find(e => e.task.id === idle.id)!.text, /idle: nothing has moved for 8 days/);

    // The person moves the idle one: its count resets.
    store.update(idle.id, { status: "doing", assigneeId: "bot" }, "chris", undefined, plus(8 * 86_400_000 + 2));
    assert.equal(store.get(idle.id)?.aging, undefined);

    // Day 10: the overdue one, twice nudged and untouched, is archived; the idle one is fresh again.
    const third = store.age(plus(10 * 86_400_000 + 2));
    assert.deepEqual(third.map(e => [e.kind, e.task.id]), [["archived", overdue.id]]);
    assert.equal(store.get(overdue.id)?.status, "dropped");
    assert.match(store.get(overdue.id)!.history.at(-1)!.note ?? "", /archived by ageing: overdue, no answer to 2 nudges/);
    assert.equal(store.get(fresh.id)?.aging, undefined);
    assert.equal(store.get(proposal.id)?.aging, undefined, "a proposal awaiting commit is not nudged");

    // Survives a restart.
    const again = new TaskStore(join(dir, "tasks.jsonl"));
    assert.equal(again.get(overdue.id)?.status, "dropped");
    assert.equal(again.get(fresh.id)?.due, "2026-12-01T23:59:59.000Z");
    void TASK_IDLE_MS;
    void TASK_NUDGE_GAP_MS;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a close proposal closes by itself after the window, stays open when the requester objects, and the requester cannot propose", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-close-"));
  try {
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    const t12 = store.create({ title: "t12 — old thread", requester: "chris", assigneeId: "bot", now: T0 })!;
    const t13 = store.create({ title: "t13", requester: "chris", assigneeId: "bot", now: T0 })!;
    assert.deepEqual(store.proposeClose(t12.id, "chris", "done with it", T0), { refused: `${t12.id} is your own request; drop it directly instead of proposing.` });
    assert.deepEqual(store.proposeClose(t12.id, "bot", "   ", T0), { refused: "A close proposal needs a reason the requester can read." });
    const proposed = store.proposeClose(t12.id, "bot", "superseded by t77; nothing left to do", T0);
    assert.ok("task" in proposed && proposed.task.closeProposal?.decideBy === new Date(T0.getTime() + CLOSE_PROPOSAL_MS).toISOString());
    assert.match(store.get(t12.id)!.history.at(-1)!.note ?? "", /proposed to close: superseded by t77/);
    store.proposeClose(t13.id, "bot", "duplicate of t12", T0);

    // Before the window: nothing closes.
    assert.deepEqual(store.settleCloseProposals(plus(3_600_000)), []);
    // The requester objects to t13: it stays, the proposal is gone.
    assert.deepEqual(store.opposeClose(t13.id, "mia"), { refused: "Only chris can object to closing t2." });
    const kept = store.opposeClose(t13.id, "chris", "still needed", plus(7_200_000));
    assert.ok("task" in kept && kept.task.closeProposal === undefined && kept.task.status === "open");
    assert.match(store.get(t13.id)!.history.at(-1)!.note ?? "", /objected to closing: still needed/);

    // After the window: t12 closes as proposed, and says whose proposal it was.
    const closed = store.settleCloseProposals(plus(CLOSE_PROPOSAL_MS + 1));
    assert.deepEqual(closed.map(e => [e.kind, e.task.id]), [["closed", t12.id]]);
    assert.equal(store.get(t12.id)?.status, "dropped");
    assert.equal(store.get(t12.id)?.closeProposal, undefined);
    assert.match(closed[0]!.text, /closed as bot proposed: superseded by t77/);
    assert.deepEqual(store.settleCloseProposals(plus(CLOSE_PROPOSAL_MS * 2)), [], "nothing closes twice");
    // A move by the requester while a proposal is open is their answer to it.
    const t14 = store.create({ title: "t14", requester: "chris", assigneeId: "bot", now: T0 })!;
    store.proposeClose(t14.id, "bot", "r", T0);
    store.update(t14.id, { status: "doing" }, "chris", undefined, plus(1));
    assert.equal(store.get(t14.id)?.closeProposal, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
