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

test("the sweep cancels every fork admission, ends the children's turns, tells the parent, then settles (docs/32 §1)", () => {
  const { root, cleanup } = home();
  try {
    const path = join(root, "pending-work.jsonl");
    const inboxPath = join(root, "inbox.jsonl");
    const turnsPath = join(root, "turns.jsonl");
    type Msg = { text: string; conversation?: string };

    // The last process: one fork admitted and recorded, one admitted but never recorded (the
    // crash landed between the two appends), one prepared and never sent; the children's
    // turns begun; the parent's own turn open too.
    const before = new PendingWork(path);
    const inbox = new Inbox<Msg>(inboxPath);
    const seq2 = inbox.admit("a1", { text: "read chapter two", conversation: "fork/main-x-2" });
    const id2 = before.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-2", brief: "read chapter two" });
    before.admitted(id2, seq2);
    const id3 = before.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-3", brief: "chapter three" });
    inbox.admit("a1", { text: "chapter three", conversation: "fork/main-x-3" }); // admitted, never recorded
    const id4 = before.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-4", brief: "never sent" });
    inbox.admit("a1", { text: "the parent's own next message" }); // main: must survive
    const turns = new TurnLedger(turnsPath);
    turns.begin({ id: "child-2", agentId: "a1", about: "two", conversation: "fork/main-x-2" });
    turns.begin({ id: "child-3", agentId: "a1", about: "three", conversation: "fork/main-x-3" });
    turns.begin({ id: "main-turn", agentId: "a1", about: "the parent", conversation: "main" });

    // This process: the sweep runs before any replay.
    const delivered: { agentId: string; text: string; conversation: string }[] = [];
    const after = new PendingWork(path);
    const dropped = after.sweep({
      dropForkAdmissions: () => new Inbox<Msg>(inboxPath).dropWhere(item => (item.message.conversation ?? "main").startsWith("fork/")),
      endForkTurns: how => new TurnLedger(turnsPath).endWhere(conversation => conversation.startsWith("fork/"), how),
      lastWordsOf: (_agent, conversation) => (conversation === "fork/main-x-2" ? "I had read half of it when" : undefined),
      deliver: (agentId, text, conversation) => {
        delivered.push({ agentId, text, conversation });
        return true;
      },
      noteQueued: () => false,
      agentExists: () => true,
    });
    assert.deepEqual(dropped.map(fork => fork.id), [id2, id3, id4]);
    assert.deepEqual(new PendingWork(path).open(), [], "all settled");

    // Every fork admission is gone — recorded or not — and the parent's own message is not.
    assert.deepEqual(new Inbox<Msg>(inboxPath).pending().map(item => item.message.text), ["the parent's own next message"]);
    // The children's turns are ended; the parent's is still interrupted.
    assert.deepEqual(new TurnLedger(turnsPath).interrupted().map(turn => turn.id), ["main-turn"]);

    // The parent is told about each, tagged, with last words where there were any, no path.
    assert.equal(delivered.length, 3);
    assert.ok(delivered.every(note => note.conversation === "main"));
    assert.match(delivered[0]!.text, new RegExp(`^\\[fork ${id2}\\] A fork you started was dropped by a restart`));
    assert.match(delivered[0]!.text, /Its last words: "I had read half of it when"/);
    assert.match(delivered[0]!.text, /nothing was re-run/);
    assert.doesNotMatch(delivered[0]!.text, /\.jsonl/);
    assert.match(delivered[1]!.text, /may never have been admitted/);
    const why = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; why?: string }).filter(line => line.event === "dropped").map(line => line.why);
    assert.deepEqual(why, ["restart", "unrecorded", "unrecorded"]);
  } finally {
    cleanup();
  }
});

test("the sweep is told first and settles second; a late result already queued is delivered, not dropped", () => {
  const { root, cleanup } = home();
  try {
    const path = join(root, "pending-work.jsonl");
    const ledger = new PendingWork(path);
    const stuck = ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-1", brief: "one" });
    ledger.admitted(stuck, 1);
    const late = ledger.prepare({ agentId: "a1", parent: "main", child: "fork/main-x-2", brief: "two" });
    ledger.admitted(late, 2);

    // A note that cannot be admitted leaves the record open for the next start.
    const refused = new PendingWork(path).sweep({
      dropForkAdmissions: () => 0,
      endForkTurns: () => 0,
      lastWordsOf: () => undefined,
      deliver: () => false,
      noteQueued: () => false,
      agentExists: () => true,
    });
    assert.deepEqual(refused, []);
    assert.equal(new PendingWork(path).open().length, 2, "nothing settled while the parent could not be told");

    // The late fork's result reached the parent's inbox before the crash: committed late.
    const notes: string[] = [];
    const dropped = new PendingWork(path).sweep({
      dropForkAdmissions: () => 0,
      endForkTurns: () => 0,
      lastWordsOf: () => undefined,
      deliver: (_a, text) => {
        notes.push(text);
        return true;
      },
      noteQueued: (_a, _c, tag) => tag === `[fork ${late}]`,
      agentExists: () => true,
    });
    assert.deepEqual(dropped.map(fork => fork.id), [stuck]);
    assert.equal(notes.length, 1, "no dropped note for work that was delivered");
    const events = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; id: string; how?: string });
    assert.ok(events.some(entry => entry.event === "committed" && entry.id === late && entry.how === "late"));
    assert.deepEqual(new PendingWork(path).open(), []);
  } finally {
    cleanup();
  }
});

test("inbox.drop counts only what was pending, and an unreadable ledger is reported rather than read as empty", () => {
  const { root, cleanup } = home();
  try {
    const inbox = new Inbox<{ text: string }>(join(root, "inbox.jsonl"));
    const a = inbox.admit("a1", { text: "a" });
    const b = inbox.admit("a1", { text: "b" });
    inbox.start([a]);
    assert.equal(inbox.drop(a), false, "already started: not counted");
    assert.equal(inbox.drop(999), false, "unknown: not counted");
    assert.equal(inbox.drop(b), true);
    assert.equal(inbox.drop(b), false, "twice: not counted twice");
    assert.deepEqual(inbox.pending(), []);

    assert.equal(new PendingWork(join(root, "absent.jsonl")).unreadable(), undefined);
    assert.match(new PendingWork(root).unreadable() ?? "", /EISDIR|illegal operation|directory/i);
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
