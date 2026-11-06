/** One list on the Tasks panel (INV-1654): an attention item appears once, on its task's row, and those rows come first. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { boardOrder, BOARD_ORDER_JS, looseItems } from "./board-order.ts";

const tasks = [
  { id: "t1", status: "doing", updatedAt: "2026-11-06T08:00:00Z" },
  { id: "t2", status: "review", updatedAt: "2026-11-06T09:00:00Z" },
  { id: "t3", status: "open", updatedAt: "2026-11-06T07:00:00Z" },
  { id: "t4", status: "review", updatedAt: "2026-11-06T06:00:00Z" },
  { id: "t5", status: "done", updatedAt: "2026-11-06T10:00:00Z" },
];
const mine = [
  { ref: "t4", kind: "review", detail: "Bob says it is done", deadline: "2026-11-08T00:00:00Z", decision: false },
  { ref: "t2", kind: "review", detail: "Enzo says it is done", deadline: "2026-11-07T00:00:00Z", decision: false },
  { ref: "t3", kind: "nudged", detail: "Nothing has moved for a week", decision: false },
  { ref: "t5", kind: "close-proposal", detail: "Ada proposes closing it", decision: true },
  { ref: "apr-9", kind: "approval", detail: "Ada wants to run a command", decision: true },
  { ref: "ada/main", kind: "question", detail: "Ada asks: which repo?", decision: true },
];
const theirs = [
  { ref: "t1", kind: "blocked", detail: "waiting on Mia" },
  { ref: "t2", kind: "blocked", detail: "waiting on Mia too" },
];

test("every task once; the owed ones first — a decision, then reviews by nearest deadline, then a nudge — then the board's order; an owed row carries no 'theirs'", () => {
  const rows = boardOrder(tasks, mine, theirs);
  assert.deepEqual(rows.map(row => row.task.id), ["t5", "t2", "t4", "t3", "t1"]);
  assert.equal(rows[1]!.mine?.detail, "Enzo says it is done");
  assert.equal(rows[1]!.theirs, undefined, "the person's mark wins the row");
  assert.equal(rows[4]!.theirs?.detail, "waiting on Mia");
  assert.equal(rows.filter(row => row.mine).length, 4, "the four task items appear once each, on their rows");
});

test("items that are not tasks are the only ones left for the panel above the board", () => {
  assert.deepEqual(looseItems(mine).map(item => item.ref), ["apr-9", "ada/main"]);
  assert.deepEqual(looseItems(theirs), []);
});

test("the page's copy is the same functions and runs without the module", () => {
  const page = new Function(`${BOARD_ORDER_JS}; return { boardOrder: boardOrder, looseItems: looseItems };`)() as { boardOrder: typeof boardOrder; looseItems: typeof looseItems };
  assert.deepEqual(page.boardOrder(tasks, mine, theirs).map(row => row.task.id), ["t5", "t2", "t4", "t3", "t1"]);
  assert.equal(page.looseItems(mine).length, 2);
});
