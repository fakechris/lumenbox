/**
 * Commitments a routine writes down are checked against what it set up (INV-528): the
 * block is found under its heading in either language, dates are read in three
 * spellings, a card with a due date holds a commitment, an @at routine is the other
 * reminder, gaps are said and cued, and the next run is told where last time's stand.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommitmentLedger, bindingsOf, describeGaps, matches, parseCommitments, priorCommitmentsPrompt, reconcileCommitments } from "./commitments.ts";
import { dedupeKey } from "./memory.ts";

const RETRO = `周报・9/7 ~ 9/13

挂着: t77 (TEAM.md v2 等 Q1-Q5, 4 周了)、t12 (可关)。

下周改 (具体): retro 末尾所有 "下周改" 立即建 task 卡追踪。

## 下周改
- close t12 — t183 done before 9/19
- send the person one Q1-Q5 default proposal (yes/no only) by 2026-09-17
- close 2 items in the review queue

长版 /home/box/work/research/weekly-retro.md。`;

test("the commitments block is found under its heading, with dates in three spellings", () => {
  const items = parseCommitments(RETRO, 2026);
  assert.deepEqual(items, [
    { text: "close t12 — t183 done before 9/19", due: "2026-09-19" },
    { text: "send the person one Q1-Q5 default proposal (yes/no only) by 2026-09-17", due: "2026-09-17" },
    { text: "close 2 items in the review queue" },
  ]);
  assert.deepEqual(parseCommitments("## Next week\n1. ship the changelog by 9月20日\n\nOther prose.", 2026), [{ text: "ship the changelog by 9月20日", due: "2026-09-20" }]);
  assert.deepEqual(parseCommitments("**下周改**\n- one thing", 2026), [{ text: "one thing" }]);
  assert.deepEqual(parseCommitments("No block here.\n- a bullet", 2026), []);
});

test("a commitment is held by a card with a due date, or an @at routine; what is missing is named", () => {
  const items = parseCommitments(RETRO, 2026);
  const checks = reconcileCommitments(
    items,
    [
      { id: "t183", title: "close t12", status: "open", due: "2026-09-19T23:59:59.000Z" },
      { id: "t190", title: "Q1-Q5 default proposal card to the person", status: "open" },
    ],
    [{ slug: "review-queue-sweep", name: "close two review queue items", at: Date.parse("2026-09-18T09:00:00Z") }]
  );
  assert.deepEqual(checks.map(c => [c.task?.id, c.reminder, c.missing]), [
    ["t183", { kind: "task-due", ref: "t183" }, []],
    ["t190", undefined, ["due", "reminder"]],
    [undefined, { kind: "routine", ref: "review-queue-sweep" }, ["card"]],
  ]);
  const gaps = describeGaps(checks);
  assert.match(gaps.toChat ?? "", /^Commitments in this report that nothing is holding:\n- send the person one Q1-Q5 default proposal .* \(by 2026-09-17\): the card has no due date, nothing will remind anyone by then\n- close 2 items in the review queue: no task card$/);
  assert.match(gaps.cue ?? "", /^\[commitments\] The report you just delivered lists 3 commitment\(s\); 2 of them are not held by anything:/);
  assert.match(gaps.cue ?? "", /create a task card for each with Tasks/);
  assert.deepEqual(describeGaps(reconcileCommitments([items[0]!], [{ id: "t183", title: "close t12", status: "open", due: "2026-09-19T00:00:00Z" }], [])), {}, "all held: silence");
  assert.equal(matches("close t12 — t183 done before 9/19", "anything at all", "t183"), true, "the id named in the item is a match");
  assert.equal(matches("close 2 items in the review queue", "close the review queue items"), true);
  assert.equal(matches("send a reminder", "write the changelog"), false);
});

test("the ledger keeps each run's commitments, and the next run opens with where they stand", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-commitments-"));
  try {
    const ledger = new CommitmentLedger(join(dir, "commitments.jsonl"));
    assert.equal(priorCommitmentsPrompt(ledger.lastFor("weekly-retro"), []), undefined);
    const items = parseCommitments(RETRO, 2026);
    ledger.record({ at: "2026-09-14T02:00:00.000Z", slug: "weekly-retro", agentId: "a1", commitments: items, checks: reconcileCommitments(items, [], []) });
    ledger.record({ at: "2026-09-14T02:05:00.000Z", slug: "other-routine", agentId: "a1", commitments: [{ text: "x" }], checks: [] });
    const prompt = priorCommitmentsPrompt(ledger.lastFor("weekly-retro"), [{ id: "t183", title: "close t12", status: "done", due: "2026-09-19T23:59:59.000Z" }]);
    assert.match(prompt ?? "", /^Last time \(2026-09-14\) this routine committed to:\n- close t12 — t183 done before 9\/19 \(by 2026-09-19\) — t183 is done, due 2026-09-19\n- send the person .* — no card was ever created\n- close 2 items in the review queue — no card was ever created\nSay where each stands before anything else/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a finished or dropped card does not carry this week's commitment, and a deadline does not slip a day (INV-534)", () => {
  const items = parseCommitments(RETRO, 2026);
  const madeAt = Date.parse("2026-09-21T02:00:00Z");
  // The same retro, a week later. Last week's card for it is done, and another is dropped.
  const checks = reconcileCommitments(
    items,
    [
      { id: "t183", title: "close t12", status: "done", due: "2026-09-19T23:59:59.000Z", updatedAt: "2026-09-18T10:00:00Z" },
      { id: "t190", title: "Q1-Q5 default proposal card to the person", status: "dropped", due: "2026-09-17T23:59:59.000Z", updatedAt: "2026-09-16T10:00:00Z" },
    ],
    [],
    madeAt
  );
  assert.deepEqual(checks.map(c => [c.task?.id, c.missing]), [
    [undefined, ["card", "reminder"]],
    [undefined, ["card", "reminder"]],
    [undefined, ["card", "reminder"]],
  ], "last week's finished and dropped cards hold nothing this week");

  // A card finished after the commitment was made does carry it.
  const later = reconcileCommitments([items[0]!], [{ id: "t183", title: "close t12", status: "done", due: "2026-09-19T23:59:59.000Z", updatedAt: "2026-09-21T09:00:00Z" }], [], madeAt);
  assert.deepEqual(later.map(c => c.task?.id), ["t183"]);

  // "by 2026-09-19" is not satisfied by a card due the 20th.
  const late = reconcileCommitments([items[0]!], [{ id: "t183", title: "close t12", status: "open", due: "2026-09-20T09:00:00Z" }], [], madeAt);
  assert.deepEqual(late[0]!.missing, ["reminder"]);
  const onTime = reconcileCommitments([items[0]!], [{ id: "t183", title: "close t12", status: "open", due: "2026-09-19T18:00:00Z" }], [], madeAt);
  assert.deepEqual(onTime[0]!.missing, []);
});

test("a commitment keeps the card it was bound to, and one nobody restated is still carried (INV-534)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-commitments-carry-"));
  try {
    const ledger = new CommitmentLedger(join(dir, "commitments.jsonl"));
    const week1 = [{ text: "send the weekly reminder", due: "2026-09-11" }, { text: "close t12", due: "2026-09-19" }];
    const board = [
      { id: "t200", title: "weekly reminder to the team", status: "open", due: "2026-09-11T23:59:59.000Z", updatedAt: "2026-09-07T09:00:00Z" },
      { id: "t183", title: "close t12", status: "open", due: "2026-09-19T23:59:59.000Z", updatedAt: "2026-09-07T09:00:00Z" },
    ];
    const first = reconcileCommitments(week1, board, [], Date.parse("2026-09-07T02:00:00Z"));
    assert.deepEqual(first.map(c => c.boundTaskId), ["t200", "t183"]);
    ledger.record(ledger.withCarried({ at: "2026-09-07T02:00:00.000Z", slug: "weekly-retro", agentId: "a1", commitments: week1, checks: first }, () => false));

    // Week two restates only the reminder. A word match would have moved "close t12" onto
    // whatever else is on the board; the binding keeps it, and the unrestated item travels.
    const week2 = [{ text: "send the weekly reminder", due: "2026-09-18" }];
    const bound = bindingsOf(ledger.lastFor("weekly-retro"));
    assert.equal(bound.get(dedupeKey("send the weekly reminder")), "t200");
    const second = reconcileCommitments(week2, board, [], Date.parse("2026-09-14T02:00:00Z"), bound);
    assert.equal(second[0]!.task?.id, "t200");
    const record = ledger.withCarried({ at: "2026-09-14T02:00:00.000Z", slug: "weekly-retro", agentId: "a1", commitments: week2, checks: second }, taskId => taskId === "t183");
    assert.deepEqual(record.carried, undefined, "an item whose card is done is not carried");
    const stillOpen = ledger.withCarried({ at: "2026-09-14T02:00:00.000Z", slug: "weekly-retro", agentId: "a1", commitments: week2, checks: second }, () => false);
    assert.deepEqual(stillOpen.carried?.map(c => [c.commitment.text, c.taskId]), [["close t12", "t183"]]);
    ledger.record(stillOpen);

    const prompt = priorCommitmentsPrompt(ledger.lastFor("weekly-retro"), board);
    assert.match(prompt ?? "", /Still open from before:\n- \(from 2026-09-07\) close t12 \(by 2026-09-19\) — t183 is open/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
