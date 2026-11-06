/** What a person sees of a fork (INV-1667): written as it happens, read back after a restart, grouped by parent and by task. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ForkEvents } from "./fork-events.ts";
import { PendingWork } from "./pending-work.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 9, minute));

test("a fork's chain is written as it happens and read back whole by the next host; status follows the chain", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-fork-events-"));
  try {
    const path = join(dir, "fork-events.jsonl");
    const ledger = new PendingWork(join(dir, "pending-work.jsonl"));
    const forks = new ForkEvents(path);
    ledger.forks = forks;
    const one = ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-1", brief: "find  the\npricing" });
    const two = ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-2", brief: "notify the team" });
    const other = ledger.prepare({ agentId: "a1", parent: "feishu-oc_1", child: "fork/feishu-oc_1-y-1", brief: "read the doc" });
    forks.spawned({ id: one, agentId: "a1", parent: "main", child: "fork/main-x-1", brief: "find  the\npricing", taskId: "t1" }, at(0));
    forks.spawned({ id: two, agentId: "a1", parent: "main", child: "fork/main-x-2", brief: "notify the team", taskId: "t1" }, at(1));
    forks.spawned({ id: other, agentId: "a1", parent: "feishu-oc_1", child: "fork/feishu-oc_1-y-1", brief: "read the doc" }, at(2));
    forks.started("a1", "fork/main-x-1", at(3));
    forks.started("a1", "fork/main-x-1", at(4)); // a second turn in the same child is not a second start
    forks.started("a1", "fork/main-x-2", at(3));
    forks.fenced("a1", "fork/main-x-2", "SendToAgent", at(5));
    assert.equal(forks.ofTask("t1")[1]!.status, "fenced", "stopped by the fence before it reports");
    forks.reported(one, "done", undefined, at(6));
    forks.reported(two, "blocked", "needs to message the team", at(6));
    ledger.commit([{ id: one, how: "done" }, { id: two, how: "done" }], at(7)); // the ledger's commit is the merge
    ledger.dropped(other, "restart", at(8));
    ledger.commit([{ id: "pw-not-a-fork", how: "done" }]); // a delegate or an effect: not a fork, not shown

    const reread = new ForkEvents(path);
    const t1 = reread.ofTask("t1");
    assert.deepEqual(t1.map(fork => [fork.child, fork.brief, fork.status, fork.reason]), [
      ["fork/main-x-1", "find the pricing", "done", undefined],
      ["fork/main-x-2", "notify the team", "fenced", "SendToAgent"],
    ], "in the order they were sent; a fenced child that reported blocked stays fenced");
    assert.deepEqual(t1[0]!.steps.map(step => step.event), ["fork.spawned", "fork.started", "fork.reported", "fork.merged"]);
    assert.deepEqual(t1[1]!.steps.map(step => step.event), ["fork.spawned", "fork.started", "fork.fenced", "fork.reported", "fork.merged"]);
    assert.equal(t1[1]!.lastAt, at(7).toISOString());
    const all = reread.children("a1");
    assert.deepEqual(all.map(fork => fork.parent), ["main", "main", "feishu-oc_1"], "every child of the agent, in the order sent, each naming its parent");
    assert.equal(all[2]!.status, "dropped");
    assert.equal(reread.tallyLine("t1"), "分了 2 个子任务，1 个完成。");
    assert.equal(reread.tallyLine("t9"), undefined, "a task that forked nothing gets no line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a child that reports anything but done is stuck, with its word; one still out is counted as running", () => {
  const forks = new ForkEvents(null);
  forks.spawned({ id: "pw-1", agentId: "a1", parent: "main", child: "fork/main-z-1", brief: "a", taskId: "t2" });
  forks.spawned({ id: "pw-2", agentId: "a1", parent: "main", child: "fork/main-z-2", brief: "b", taskId: "t2" });
  forks.reported("pw-1", "partial", "half the rows");
  const seen: string[] = [];
  forks.onEvent(event => seen.push(event.event));
  forks.fenced("a1", "fork/main-other-1", "Tasks"); // a child nobody recorded: nothing to show
  assert.deepEqual(forks.ofTask("t2").map(fork => [fork.status, fork.reason]), [["stuck", "partial: half the rows"], ["running", undefined]]);
  assert.equal(forks.tallyLine("t2"), "分了 2 个子任务，0 个完成，1 个仍在进行。");
  assert.deepEqual(seen, [], "only events on a known fork reach a listener");
});
