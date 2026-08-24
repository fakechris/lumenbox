/**
 * Tests for the audit protocol: the three parsed lines, the completion guard's
 * rule, and the manifest arithmetic that makes read-only a checked property.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auditAccepts,
  buildAuditPrompt,
  manifestDiff,
  parseAuditReport,
  parseManifest,
} from "./audit.ts";
import type { Task } from "./tasks.ts";

test("the three header lines parse through preamble, and malformed reports do not", () => {
  const report = parseAuditReport(
    "I checked the deploy.\nStatus: complete\nIntegrity: clean\nContract audit: aligned\n\n" +
      "Reproduced the build; the artifact matches."
  );
  assert.deepEqual(
    { status: report?.status, integrity: report?.integrity, contract: report?.contract },
    { status: "complete", integrity: "clean", contract: "aligned" }
  );

  assert.equal(parseAuditReport("Status: done\nIntegrity: clean\nContract audit: aligned"), undefined, "done is not a status");
  assert.equal(parseAuditReport("Status: complete\nIntegrity: clean"), undefined, "all three or nothing");
  assert.equal(parseAuditReport("looks good to me!"), undefined);
});

test("the completion guard accepts only complete, clean, and a contract not in revision", () => {
  const base = { status: "complete", integrity: "clean", contract: "aligned", body: "" } as const;
  assert.ok(auditAccepts({ ...base }));
  assert.ok(auditAccepts({ ...base, contract: "unknown" }), "unknown contract is not a veto");
  assert.ok(!auditAccepts({ ...base, status: "incomplete" }));
  assert.ok(!auditAccepts({ ...base, integrity: "suspect" }));
  assert.ok(!auditAccepts({ ...base, contract: "needs_revision" }));
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
  assert.match(prompt, /Weekly numbers to the vendor/, "the original request travels verbatim");
  assert.match(prompt, /Status: complete\|incomplete\|blocked/);
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
