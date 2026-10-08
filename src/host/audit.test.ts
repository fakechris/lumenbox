/**
 * Tests for the audit protocol: the three parsed lines, the completion guard's
 * rule, and the manifest arithmetic that makes read-only a checked property.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuditPrompt, manifestDiff, parseManifest, settleAudit } from "./audit.ts";
import type { Task } from "./tasks.ts";

const withAcceptance = { contract: { acceptance: "the xlsx is in the vendor's inbox, not just attached" } };

test("an audit reply the parser cannot read is no verdict, and no verdict is not a pass (INV-817)", () => {
  // Fail-closed: the task does not move forward on prose, however approving.
  for (const reply of ["looks good to me!", "Status: done\nIntegrity: clean", "Status: complete"]) {
    const settled = settleAudit(withAcceptance, reply);
    assert.equal(settled.status, "review", reply);
    assert.equal(settled.verdict, undefined);
    assert.match(settled.note, /no verdict/);
    assert.match(settled.note, /not accepted/);
  }
});

test("a parsed rejection sends the work back to doing with the findings", () => {
  const settled = settleAudit(
    withAcceptance,
    "I checked.\nStatus: incomplete\nIntegrity: clean\nContract audit: aligned\n" +
      "Item acceptance: contradicted — the inbox shows no message\nNext action: send it\n"
  );
  assert.equal(settled.status, "doing");
  assert.match(settled.note, /acceptance contradicted \(the inbox shows no message\)/);
  assert.match(settled.note, /next: send it/);
});

test("a parsed pass leaves the task in review: done is the requester's word", () => {
  const settled = settleAudit(
    withAcceptance,
    "Status: complete\nIntegrity: clean\nContract audit: aligned\nItem acceptance: proven — message id 42 in the inbox\nNext action: none\n"
  );
  assert.equal(settled.status, "review");
  assert.equal(settled.verdict?.passed, true);
  // The headers alone are not a pass when an acceptance item was asked for and not answered.
  const unanswered = settleAudit(withAcceptance, "Status: complete\nIntegrity: clean\nContract audit: aligned\n");
  assert.equal(unanswered.status, "doing", "an acceptance item left unverified is not proven");
  // Without acceptance criteria the headers are the whole verdict, as before.
  assert.equal(settleAudit({}, "Status: complete\nIntegrity: clean\nContract audit: aligned\n").status, "review");
  assert.equal(settleAudit({}, "Status: complete\nIntegrity: suspect\nContract audit: aligned\n").status, "doing");
});

test("the audit prompt carries its load-bearing sentences", () => {
  const task: Task = {
    id: "t9",
    title: "ship the report",
    description: "Weekly numbers to the vendor, xlsx, by Friday.",
    status: "review",
    requester: "chris",
    assigneeId: "agent-rex",
    reviewerId: "agent-vera",
    conversation: "feishu-oc_room",
    createdAt: "",
    updatedAt: "",
    history: [],
  };
  const prompt = buildAuditPrompt({ task, assigneeName: "Rex", conversation: "feishu-oc_room" });
  assert.match(prompt, /Re-derive the acceptance constraints from the original request/);
  assert.match(prompt, /open file are not completion/);
  assert.match(prompt, /Do not modify any files/);
  assert.match(prompt, /move the task with the Tasks tool/);
  // The auditor makes acceptance safe; it does not perform it. An internal reviewer that
  // marks work done closes the task the requester was waiting to accept — observed on
  // production t51's successors and named by two reviews as organisational cosplay.
  assert.match(prompt, /LEAVE IT IN REVIEW/);
  assert.match(prompt, /done is the requester's word/);
  assert.doesNotMatch(prompt, /to done only if/);
  assert.match(prompt, /Weekly numbers to the vendor/, "the original request travels verbatim");
  assert.match(prompt, /Status: complete\|incomplete\|blocked/);
  assert.match(prompt, /no verdict is not a pass/);
  assert.doesNotMatch(prompt, /Item acceptance/, "no criteria, no item line");
});

test("acceptance criteria come before the history, and are asked for as an item (INV-817)", () => {
  const task: Task = {
    id: "t9",
    title: "ship the report",
    description: "Weekly numbers to the vendor.",
    status: "review",
    requester: "chris",
    assigneeId: "agent-rex",
    reviewerId: "agent-vera",
    contract: { acceptance: "the vendor confirms receipt in the thread" },
    createdAt: "",
    updatedAt: "",
    history: [],
  };
  const prompt = buildAuditPrompt({ task, assigneeName: "Rex" });
  const criteria = prompt.indexOf("the vendor confirms receipt in the thread");
  const history = prompt.indexOf("ReadHistory");
  assert.ok(criteria !== -1 && history !== -1 && criteria < history, "the standard is read before the work (docs/20 §3)");
  assert.match(prompt, /Item acceptance: proven\|contradicted\|incomplete\|unverified/);
});

test("the manifest reads sha256sum output and the diff names every kind of change", () => {
  const before = parseManifest(
    "a".repeat(64) + "  /home/box/work/kept.txt\n" +
      "b".repeat(64) + "  /home/box/work/edited.txt\n" +
      "c".repeat(64) + "  /home/box/work/deleted.txt\n" +
      "not a manifest line\n"
  );
  assert.equal(before.size, 3, "noise lines are ignored");
  const after = new Map(before);
  after.set("/home/box/work/edited.txt", "d".repeat(64));
  after.delete("/home/box/work/deleted.txt");
  after.set("/home/box/work/new.txt", "e".repeat(64));
  assert.deepEqual(manifestDiff(before, after), [
    "/home/box/work/deleted.txt",
    "/home/box/work/edited.txt",
    "/home/box/work/new.txt",
  ]);
  assert.deepEqual(manifestDiff(before, new Map(before)), [], "no change, no diff");
});
