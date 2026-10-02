/** Seeded fault schedules over the existing ledgers, not a second runtime scheduler. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingWork, type SweepDeps } from "./pending-work.ts";
import { Inbox } from "../agents/inbox.ts";

function schedule(seed: number): string[] {
  const windows = ["refuse-delivery", "throw-before-delivery", "crash-after-delivery", "settled"];
  let state = seed >>> 0;
  for (let i = windows.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [windows[i], windows[j]] = [windows[j]!, windows[i]!];
  }
  return windows;
}

test("fixed seed gives a reproducible fault order", () => {
  assert.deepEqual(schedule(884), ["refuse-delivery", "throw-before-delivery", "crash-after-delivery", "settled"]);
});

for (const seed of [884, 42, 1, 65535]) {
  test(`seed ${seed}: parent delivery must precede settlement across each crash window`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-faults-"));
    try {
      for (const point of schedule(seed)) {
        const path = join(root, `${point}-work.jsonl`);
        const inboxPath = join(root, `${point}-inbox.jsonl`);
        const ledger = new PendingWork(path);
        const id = ledger.prepare({ agentId: "ada", parent: "main", child: "fork/one", brief: "source check" });
        ledger.admitted(id, 1);
        const inbox = () => new Inbox<{ text: string }>(inboxPath);
        const deps: SweepDeps = {
          dropForkAdmissions: () => 0, endForkTurns: () => 0,
          lastWordsOf: () => undefined, agentExists: () => true,
          jobStatus: async () => undefined,
          noteQueued: (_a, _c, tag) => inbox().pending().some(x => x.message.text.startsWith(tag)),
          deliver: (agentId, text) => {
            if (point === "refuse-delivery") return false;
            if (point === "throw-before-delivery") throw new Error("injected before delivery");
            inbox().admit(agentId, { text });
            if (point === "crash-after-delivery") throw new Error("injected after delivery");
            return true;
          },
        };
        if (point === "throw-before-delivery" || point === "crash-after-delivery") {
          await assert.rejects(ledger.sweep(deps), /injected/);
        } else await ledger.sweep(deps);
        assert.equal(new PendingWork(path).open().length, point === "settled" ? 0 : 1, `${point}: no early settlement`);
        // Fresh instances stand in for restart. The inbox's durable tag is the receipt.
        await new PendingWork(path).sweep({ ...deps, deliver: (agentId, text) => {
          inbox().admit(agentId, { text });
          return true;
        } });
        assert.equal(inbox().pending().length, 1, `${point}: exactly one parent notice`);
        assert.deepEqual(new PendingWork(path).open(), []);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("cancellation is terminal: a delayed delegation result cannot revive or overwrite it", () => {
  const root = mkdtempSync(join(tmpdir(), "ledger-cancel-"));
  try {
    const path = join(root, "work.jsonl");
    const ledger = new PendingWork(path);
    ledger.prepare({ kind: "delegate", agentId: "ada", parent: "main", child: "job-1", brief: "source check" });
    assert.equal(ledger.commitDelegate("job-1", "aborted"), true);
    const restart = new PendingWork(path);
    assert.equal(restart.commitDelegate("job-1", "done"), false);
    assert.equal(restart.commitDelegate("job-1", "failed"), false);
    assert.deepEqual(restart.open(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
