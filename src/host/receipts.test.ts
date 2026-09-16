/**
 * Decision receipts (INV-551): what was decided, by whom, and whether a reason was
 * written down — the last of which is the point. An absent reason is a fact, not a gap
 * to fill in later from a model's impression.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Receipts, describeReceipts } from "./receipts.ts";

test("receipts are kept by subject, survive a restart, and say when no reason was recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-receipts-"));
  try {
    const path = join(dir, "receipts.jsonl");
    const receipts = new Receipts(path);
    receipts.write({ at: "2026-09-15T09:00:00.000Z", by: "a1", byName: "Iris", subject: "task:t12", decision: "proposed to close", because: "superseded by t77", evidence: ["pr:https://github.com/x/y/pull/9"] });
    receipts.write({ at: "2026-09-15T10:00:00.000Z", by: "aging", subject: "task:t12", decision: "archived after two nudges" });
    receipts.write({ at: "2026-09-15T11:00:00.000Z", by: "a1", subject: "inv:INV-553", decision: "polling rather than webhooks", because: "no inbound port on this machine" });

    // A second reader — what a restart is — sees all of it.
    const after = new Receipts(path);
    assert.deepEqual(after.forSubject("task:t12").map(r => r.decision), ["proposed to close", "archived after two nudges"]);
    assert.deepEqual(after.forSubject("inv:INV-553").map(r => r.by), ["a1"]);
    assert.deepEqual(after.forSubject("task:nothing"), []);
    assert.equal(after.recent().length, 3);

    const text = describeReceipts(after.forSubject("task:t12"));
    assert.match(text, /Iris: proposed to close — superseded by t77 \[pr:https/);
    assert.match(text, /archived after two nudges — \(no reason was written down at the time\)/);
    assert.equal(describeReceipts([]), "", "nothing recorded says nothing, rather than an empty heading");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a receipt is bounded, and a torn line does not hide the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-receipts-long-"));
  try {
    const path = join(dir, "receipts.jsonl");
    const receipts = new Receipts(path);
    receipts.write({ at: "2026-09-15T09:00:00.000Z", by: "a1", subject: "task:t1", decision: "x".repeat(900), because: "y".repeat(900), evidence: Array.from({ length: 20 }, (_, i) => `run:${i}`) });
    const [kept] = new Receipts(path).forSubject("task:t1");
    assert.equal(kept?.decision.length, 300);
    assert.equal(kept?.because?.length, 600);
    assert.equal(kept?.evidence?.length, 8);

    // A half-written line between two good ones costs only itself.
    appendFileSync(path, '{"at":"2026-09-15T09:30:00.000Z","subject":"task:t1"\n');
    receipts.write({ at: "2026-09-15T10:00:00.000Z", by: "a1", subject: "task:t1", decision: "still here" });
    assert.deepEqual(new Receipts(path).forSubject("task:t1").map(r => r.decision.slice(0, 10)), ["xxxxxxxxxx", "still here"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no path is a no-op, so a harness without a home still runs", () => {
  const receipts = new Receipts(null);
  receipts.write({ at: "2026-09-15T09:00:00.000Z", by: "a1", subject: "task:t1", decision: "nothing is written" });
  assert.deepEqual(receipts.recent(), []);
});
