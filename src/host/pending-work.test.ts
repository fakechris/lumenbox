import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingWork } from "./pending-work.ts";
import { Inbox } from "../agents/inbox.ts";
import { TurnLedger } from "./resume.ts";

function home(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "agentbox-pending-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fork is prepared before it is admitted, and open until the engine commits it (docs/32 §1)", () => {
  const { root, cleanup } = home();
  try {
    const path = join(root, "pending-work.jsonl");
    const ledger = new PendingWork(path);
    const id = ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-1", brief: "  read   chapter one  ", workId: "w1", turnId: "t1" });
    const lines = () => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; id: string; brief?: string; inboxSeq?: number; how?: string });
    assert.deepEqual(lines().map(line => line.event), ["prepared"], "durable before anything else happens");
    assert.equal(lines()[0]?.brief, "read chapter one");
    assert.deepEqual(new PendingWork(path).open().map(fork => [fork.id, fork.admitted]), [[id, false]]);

    ledger.admitted(id, 7);
    assert.deepEqual(new PendingWork(path).open().map(fork => [fork.id, fork.admitted, fork.inboxSeq]), [[id, true, 7]]);

    ledger.commit([{ id, how: "done" }]);
    assert.deepEqual(new PendingWork(path).open(), [], "committed is settled");
    assert.deepEqual(lines().map(line => line.event), ["prepared", "admitted", "committed"]);
  } finally {
    cleanup();
  }
});

test("prepare throws when the record cannot be written, so the caller can refuse to start", () => {
  const { root, cleanup } = home();
  try {
    // A directory where the file should be: the append cannot succeed.
    const ledger = new PendingWork(root);
    assert.throws(() => ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-1", brief: "b" }));
    // No ledger at all is not an error: forks simply go unrecorded.
    assert.match(new PendingWork(null).prepare({ agentId: "a1", parent: "main", child: "c", brief: "b" }), /^pw-/);
  } finally {
    cleanup();
  }
});

test("the sweep cancels the admission, ends the child's turn, drops the record and tells the parent once", () => {
  const { root, cleanup } = home();
  try {
    const path = join(root, "pending-work.jsonl");
    const inboxPath = join(root, "inbox.jsonl");
    const turnsPath = join(root, "turns.jsonl");

    // The last process: a fork admitted to the inbox, its child turn begun, then death.
    const before = new PendingWork(path);
    const inbox = new Inbox<{ text: string }>(inboxPath);
    const seq = inbox.admit("a1", { text: "read chapter two" });
    const id = before.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-2", brief: "read chapter two" });
    before.admitted(id, seq);
    const unadmitted = before.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-3", brief: "never sent" });
    const turns = new TurnLedger(turnsPath);
    turns.begin({ id: "child-turn", agentId: "a1", about: "read chapter two", conversation: "fork/main-x-2" });
    turns.begin({ id: "main-turn", agentId: "a1", about: "the parent", conversation: "main" });

    // This process: the sweep runs before any replay.
    const delivered: { agentId: string; text: string; conversation: string }[] = [];
    const ended: [string, string][] = [];
    const after = new PendingWork(path);
    const dropped = after.sweep({
      dropAdmission: s => new Inbox<{ text: string }>(inboxPath).drop(s),
      endTurnsIn: (conversation, how) => {
        ended.push([conversation, how]);
        return new TurnLedger(turnsPath).endIn(conversation, how);
      },
      lastWordsOf: () => "I had read half of it when",
      deliver: (agentId, text, conversation) => delivered.push({ agentId, text, conversation }),
      agentExists: () => true,
    });
    assert.deepEqual(dropped.map(fork => [fork.id, fork.admitted]), [[id, true], [unadmitted, false]]);
    assert.deepEqual(new PendingWork(path).open(), [], "both settled");

    // The inbox will not replay the child's message; the child's turn is no longer interrupted;
    // the parent's own turn still is.
    assert.deepEqual(new Inbox<{ text: string }>(inboxPath).pending(), []);
    assert.deepEqual(ended, [["fork/main-x-2", "dropped-fork"], ["fork/main-x-3", "dropped-fork"]]);
    assert.deepEqual(new TurnLedger(turnsPath).interrupted().map(turn => turn.id), ["main-turn"]);

    // The parent is told, with the child's last words, no path, and the never-admitted one says so.
    assert.equal(delivered.length, 2);
    assert.equal(delivered[0]?.conversation, "main");
    assert.match(delivered[0]?.text ?? "", /dropped by a restart/);
    assert.match(delivered[0]?.text ?? "", /Its last words: "I had read half of it when"/);
    assert.match(delivered[0]?.text ?? "", /nothing was re-run/);
    assert.doesNotMatch(delivered[0]?.text ?? "", /\.jsonl/);
    assert.match(delivered[1]?.text ?? "", /had not even been admitted/);
    const why = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; why?: string }).filter(line => line.event === "dropped").map(line => line.why);
    assert.deepEqual(why, ["restart", "unrecorded"]);
  } finally {
    cleanup();
  }
});

test("a fork child's interrupted turn is never resumed, ledger or no ledger", () => {
  const { root, cleanup } = home();
  try {
    const turns = new TurnLedger(join(root, "turns.jsonl"));
    turns.begin({ id: "c", agentId: "a1", about: "slice", conversation: "fork/main-x-1" });
    turns.begin({ id: "m", agentId: "a1", about: "main", conversation: "main" });
    assert.deepEqual(turns.interrupted().map(turn => turn.id), ["m"]);
    assert.deepEqual(turns.interrupted({ includeForks: true }).map(turn => turn.id), ["c", "m"]);
  } finally {
    cleanup();
  }
});
