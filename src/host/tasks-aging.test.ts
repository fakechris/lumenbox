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

/** What the host does after the line reached a person: the nudge counts (INV-530). */
const deliver = (store: TaskStore, events: readonly { kind: string; task: { id: string }; reason?: "overdue" | "idle" }[], now: Date): void => {
  for (const event of events) if (event.kind === "nudge") store.recordNudge(event.task.id, event.reason!, now);
};

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
    assert.equal(store.get(overdue.id)?.aging, undefined, "a proposed nudge is not a delivered one");
    deliver(store, first, plus(6 * 86_400_000));
    assert.match(first[0]!.text, /overdue \(due 2026-09-05T23:59:59\.000Z\) — nudge 1 of 2\. close \/ downgrade \/ continue\?/);
    assert.equal(store.get(overdue.id)?.aging?.nudges, 1);
    assert.deepEqual(store.age(plus(6 * 86_400_000 + 3_600_000)), [], "not nudged again within the gap");

    // Day 8: idle joins; overdue gets its second nudge (48h gap passed).
    const second = store.age(plus(8 * 86_400_000 + 1));
    assert.deepEqual(second.map(e => [e.kind, e.task.id, (e as { nudge?: number }).nudge]).sort(), [["nudge", idle.id, 1], ["nudge", overdue.id, 2]].sort());
    deliver(store, second, plus(8 * 86_400_000 + 1));
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
    // A day must pass before an assignee may put a 48-hour clock on a request (INV-531).
    const P = plus(25 * 3_600_000);
    const after = (ms: number) => new Date(P.getTime() + ms);
    const t12 = store.create({ title: "t12 — old thread", requester: "chris", assigneeId: "bot", now: T0 })!;
    const t13 = store.create({ title: "t13", requester: "chris", assigneeId: "bot", now: T0 })!;
    assert.deepEqual(store.proposeClose(t12.id, "chris", "done with it", P), { refused: `${t12.id} is your own request; drop it directly instead of proposing.` });
    assert.deepEqual(store.proposeClose(t12.id, "mia", "looks stale to me", P), { refused: `${t12.id} is bot's work; only whoever is doing it can propose closing it.` });
    assert.deepEqual(store.proposeClose(t12.id, "bot", "superseded", T0), { refused: `${t12.id} was only asked for 1 minutes ago; say what you found and let chris answer before proposing to close it.` });
    assert.deepEqual(store.proposeClose(t12.id, "bot", "   ", P), { refused: "A close proposal needs a reason the requester can read." });
    const proposed = store.proposeClose(t12.id, "bot", "superseded by t77; nothing left to do", P);
    assert.ok("task" in proposed && proposed.task.closeProposal?.decideBy === new Date(P.getTime() + CLOSE_PROPOSAL_MS).toISOString());
    assert.match(store.get(t12.id)!.history.at(-1)!.note ?? "", /proposed to close: superseded by t77/);
    store.proposeClose(t13.id, "bot", "duplicate of t12", P);

    // Before the window: nothing closes.
    assert.deepEqual(store.settleCloseProposals(after(3_600_000)), []);
    // The requester objects to t13: it stays, the proposal is gone.
    assert.deepEqual(store.opposeClose(t13.id, "mia"), { refused: "Only chris can object to closing t2." });
    const kept = store.opposeClose(t13.id, "chris", "still needed", after(7_200_000));
    assert.ok("task" in kept && kept.task.closeProposal === undefined && kept.task.status === "open");
    assert.match(store.get(t13.id)!.history.at(-1)!.note ?? "", /objected to closing: still needed/);

    // After the window: t12 closes as proposed, and says whose proposal it was.
    const closed = store.settleCloseProposals(after(CLOSE_PROPOSAL_MS + 1));
    assert.deepEqual(closed.map(e => [e.kind, e.task.id]), [["closed", t12.id]]);
    assert.equal(store.get(t12.id)?.status, "dropped");
    assert.equal(store.get(t12.id)?.closeProposal, undefined);
    assert.match(closed[0]!.text, /closed as bot proposed: superseded by t77/);
    assert.deepEqual(store.settleCloseProposals(after(CLOSE_PROPOSAL_MS * 2)), [], "nothing closes twice");
    // A move by the requester while a proposal is open is their answer to it.
    const t14 = store.create({ title: "t14", requester: "chris", assigneeId: "bot", now: T0 })!;
    store.proposeClose(t14.id, "bot", "r", P);
    store.update(t14.id, { status: "doing" }, "chris", undefined, after(1));
    assert.equal(store.get(t14.id)?.closeProposal, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dropping is ending the work: only the requester or reviewer may, and a proposal about a task that changed does not settle (INV-531)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-terminal-"));
  try {
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    const P = plus(25 * 3_600_000);
    const task = store.create({ title: "ship the delta", requester: "chris", assigneeId: "bot", reviewerId: "mia", now: T0 })!;

    // An agent the task is not about cannot drop it; neither can the one doing it.
    const byStranger = store.update(task.id, { status: "dropped" }, "enzo", undefined, P);
    assert.equal(byStranger?.task.status, "open");
    assert.match(byStranger?.coerced ?? "", /Only chris or mia can drop this task/);
    assert.match(byStranger?.coerced ?? "", /propose it with a reason/);
    assert.equal(store.update(task.id, { status: "dropped" }, "bot", undefined, P)?.task.status, "open");
    // The requester, the reviewer, the board and the ageing sweep may.
    assert.equal(store.update(task.id, { status: "dropped" }, "mia", undefined, P)?.task.status, "dropped");

    // A proposal is about the task as it stood: a reviewer moving the due date answers it.
    const other = store.create({ title: "answer Q1-Q5", requester: "chris", assigneeId: "bot", reviewerId: "mia", now: T0 })!;
    store.proposeClose(other.id, "bot", "nobody replied in four weeks", P);
    store.update(other.id, { due: "2026-10-31" }, "mia", undefined, new Date(P.getTime() + 3_600_000));
    assert.ok(store.get(other.id)?.closeProposal !== undefined, "a reviewer's edit does not clear it outright");
    assert.deepEqual(store.settleCloseProposals(new Date(P.getTime() + CLOSE_PROPOSAL_MS + 1)), [], "but it does not close on the old clock either");
    assert.equal(store.get(other.id)?.status, "open");
    assert.equal(store.get(other.id)?.closeProposal, undefined);
    assert.match(store.get(other.id)!.history.at(-1)!.note ?? "", /close proposal dropped: .* changed after bot proposed it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a nudge nobody received is not counted, and cannot archive the work (INV-530)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-undelivered-"));
  try {
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    // The room it came from is a Feishu group whose address the host could not resolve.
    const task = store.create({ title: "answer Q1-Q5", requester: "chris", assigneeId: "bot", conversation: "feishu-oc_x-om_y", due: "2026-09-05", now: T0 })!;

    // Six sweeps over twelve days. Every one proposes a nudge; the host delivers none.
    for (let day = 6; day <= 16; day += 2) {
      const events = store.age(plus(day * 86_400_000));
      assert.deepEqual(events.map(e => [e.kind, (e as { nudge?: number }).nudge]), [["nudge", 1]], `day ${day} still proposes the first nudge`);
    }
    assert.equal(store.get(task.id)?.status, "open", "undeliverable is not unanswered");
    assert.equal(store.get(task.id)?.aging, undefined);

    // The room becomes reachable: now it counts, and the ordinary two-then-archive runs.
    deliver(store, store.age(plus(18 * 86_400_000)), plus(18 * 86_400_000));
    assert.equal(store.get(task.id)?.aging?.nudges, 1);
    deliver(store, store.age(plus(20 * 86_400_000)), plus(20 * 86_400_000));
    assert.equal(store.get(task.id)?.aging?.nudges, 2);
    assert.deepEqual(store.age(plus(22 * 86_400_000)).map(e => e.kind), ["archived"]);
    assert.equal(store.get(task.id)?.status, "dropped");

    // A double delivery of the same nudge is one nudge.
    const other = store.create({ title: "second", requester: "chris", due: "2026-09-05", now: T0 })!;
    const events = store.age(plus(6 * 86_400_000));
    deliver(store, events, plus(6 * 86_400_000));
    deliver(store, events, plus(6 * 86_400_000));
    assert.equal(store.get(other.id)?.aging?.nudges, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waiting is not abandonment: blocked, in review, waiting on somebody, or snoozed, a task is asked about but never archived (INV-532)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-tasks-waiting-"));
  try {
    const store = new TaskStore(join(dir, "tasks.jsonl"));
    const blocked = store.create({ title: "invoice approval", requester: "chris", assigneeId: "bot", due: "2026-09-05", now: T0 })!;
    store.update(blocked.id, { status: "blocked", note: "waiting for finance" }, "bot", undefined, T0);
    const inReview = store.create({ title: "the delta", requester: "chris", assigneeId: "bot", reviewerId: "mia", due: "2026-09-05", now: T0 })!;
    store.update(inReview.id, { status: "review" }, "bot", undefined, T0);
    const waiting = store.create({ title: "supplier quote", requester: "chris", assigneeId: "bot", due: "2026-09-05", now: T0 })!;
    store.update(waiting.id, { waitingOn: "the supplier, who answers at month end" }, "bot", undefined, T0);
    const later = store.create({ title: "next month's migration", requester: "chris", assigneeId: "bot", due: "2026-10-31", now: T0 })!;
    const ordinary = store.create({ title: "answer Q1-Q5", requester: "chris", assigneeId: "bot", due: "2026-09-05", now: T0 })!;

    // Six sweeps, every delivery landing. The ordinary one runs its course; the rest do not.
    for (let day = 6; day <= 16; day += 2) deliver(store, store.age(plus(day * 86_400_000)), plus(day * 86_400_000));
    assert.equal(store.get(ordinary.id)?.status, "dropped");
    for (const task of [blocked, inReview, waiting, later]) {
      assert.notEqual(store.get(task.id)?.status, "dropped", `${store.get(task.id)?.title} was archived`);
      assert.equal(store.get(task.id)?.aging?.nudges, 2, "asked about twice, then quiet");
    }
    assert.match(store.get(waiting.id)!.history.find(h => h.note?.startsWith("waiting on"))?.note ?? "", /waiting on the supplier/);

    // A snooze answers the nudge with a date, and the board goes quiet until it.
    const snoozed = store.create({ title: "the thing chris is away for", requester: "chris", assigneeId: "bot", due: "2026-09-05", now: T0 })!;
    store.update(snoozed.id, { snoozeUntil: "2026-09-30" }, "chris", undefined, plus(6 * 86_400_000));
    for (let day = 8; day <= 20; day += 2) assert.deepEqual(store.age(plus(day * 86_400_000)).filter(e => e.task.id === snoozed.id), [], `day ${day} is inside the snooze`);
    assert.equal(store.get(snoozed.id)?.status, "open");
    const awake = store.age(new Date(Date.parse("2026-10-02T09:00:00Z")));
    assert.deepEqual(awake.filter(e => e.task.id === snoozed.id).map(e => e.kind), ["nudge"], "and speaks again after it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
