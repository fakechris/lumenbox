/** A person's follow-up in a task's thread (INV-1462): who owns it, and that it is handed back once. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deliveredFollowUp, followUpPrompt, handBack, ownerOf } from "./follow-up.ts";
import type { Task } from "./tasks.ts";

const task = (over: Partial<Task>): Task => ({ id: "t1", title: "x", status: "doing", requester: "p", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", history: [], ...over });
const now = new Date("2026-11-01T06:00:00Z");

test("the newest task of the thread owns its follow-ups; a stopped one or a mere proposal does not", () => {
  const older = task({ id: "t1", conversation: "c", createdAt: "2026-11-01T00:00:00.000Z" });
  const newer = task({ id: "t2", conversation: "c", createdAt: "2026-11-01T01:00:00.000Z" });
  assert.equal(ownerOf([older, newer], "c")?.id, "t2");
  assert.equal(ownerOf([older, task({ ...newer, mandate: { by: "p", strength: "explicit", grantedAt: "t", withdrawn: { at: "t", by: "p", reason: "stop" } } })], "c")?.id, "t1", "a stopped task owns nothing");
  assert.equal(ownerOf([task({ ...newer, proposedBy: "a1" })], "c"), undefined);
  assert.equal(ownerOf([older], "elsewhere"), undefined);
});

test("a follow-up is handed back once, with its reason kept short; none to hand back says so", () => {
  const delivered = deliveredFollowUp("m1", now);
  const first = handBack(delivered, "a1", " beyond this task: it asks for a new report ".repeat(10), now);
  assert.equal(first.result, "handed");
  assert.ok((first.followUp?.handedBack?.reason.length ?? 0) <= 300);
  assert.equal(handBack(first.followUp, "a1", "again", now).result, "already");
  assert.equal(handBack(undefined, "a1", "x", now).result, "none");
  assert.match(followUpPrompt({ id: "t2", title: "Sum the reports" }, "也加上三月的"), /task t2 \(Sum the reports\)[\s\S]*HandBack with task_id "t2"[\s\S]*也加上三月的$/);
});
