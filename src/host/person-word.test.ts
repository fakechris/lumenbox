import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { personWordLine, receiptOf, watchPersonWord } from "./person-word.ts";
import { TaskStore } from "./tasks.ts";
import { fakeModel } from "./testing/fake-model.ts";

const settled = async (done: () => boolean): Promise<void> => { for (let i = 0; i < 300 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10)); };

test("a result sent back with a reason starts the member's turn, and the reason is in what it reads", async () => {
  // 2026-11-19: "send back" on the page wrote the reason to the task and moved it to doing. Nothing told the member:
  // measured here, against the orchestrator the server runs, the send-back was followed by zero model calls.
  const root = mkdtempSync(join(tmpdir(), "person-word-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents")), mia = registry.create({ name: "Mia" }), board = new TaskStore(null), read: string[] = [];
    const orchestrator = new Orchestrator({
      registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks: board, extensions: null, pendingWork: null,
      client: fakeModel(({ params }) => {
        read.push(JSON.stringify(params.messages.at(-1)?.content));
        return { id: "r", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: "On it." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } } as never;
      }),
    });
    const task = board.create({ title: "Fix the export", requester: "web", assigneeId: mia.id, conversation: "main", origin: { kind: "user" }, signOff: true })!;
    board.update(task.id, { status: "doing" }, mia.id);
    board.deliveryCommand(task.id, "submit", mia.id, { evidence: ["npm test"] });
    assert.equal(board.get(task.id)!.status, "review");
    // What POST /api/tasks/update does with { id, status: "doing", note } from the card's "send back".
    board.update(task.id, { status: "doing", note: "The DST branch is still wrong at 02:30 on the change day." }, "web");
    await settled(() => read.length > 0);
    await orchestrator.settle(5000);
    assert.equal(read.length, 1, "one turn, started by the send-back");
    assert.match(read[0]!, /sent it back to you/);
    assert.match(read[0]!, /The DST branch is still wrong at 02:30 on the change day\./, "the reason, as the person wrote it");
    // An answer written on work that waits is heard the same way; an acceptance starts nothing.
    board.update(task.id, { status: "blocked", note: "Please approve: Ship the fix\nWhy you: it changes invoices." }, mia.id);
    board.update(task.id, { note: "Don't ship: wait for the audit." }, "web");
    await settled(() => read.length > 1);
    await orchestrator.settle(5000);
    assert.match(read[1]!, /answered on.*Don't ship: wait for the audit\./s);
    board.update(task.id, { status: "review", note: "Result: shipped nothing.\nNot done or limits: none" }, mia.id);
    board.update(task.id, { status: "done" }, "web");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(read.length, 2, "accepting is not something to act on");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settled wait reads as one line: what was asked, how it ended, by whom; the newest wait is the one that counts", () => {
  const board = new TaskStore(null), isAgent = (id: string) => id === "mia" || id === "ada";
  const task = board.create({ title: "Renewal notices", requester: "web", assigneeId: "mia" })!, now = () => board.get(task.id)!;
  board.update(task.id, { status: "doing" }, "mia");
  assert.equal(receiptOf(now(), isAgent), undefined, "never waited: nothing to settle");
  board.update(task.id, { status: "blocked", note: "请你批准：给 214 位客户发续费通知\n为什么是你：以你的名义发出。", options: ["发出", "不发"] }, "mia");
  assert.equal(receiptOf(now(), isAgent), undefined, "waiting, unanswered");
  board.update(task.id, { note: "noted for the record" }, "host");
  board.update(task.id, { note: "I would not send it." }, "ada");
  assert.equal(receiptOf(now(), isAgent), undefined, "the host's bookkeeping and another agent's remark are not the person's word");
  board.update(task.id, { note: "不发：价目表还没定" }, "web");
  const answered = receiptOf(now(), isAgent)!;
  assert.deepEqual([answered.what, answered.title, answered.by, answered.text], ["answered", "给 214 位客户发续费通知", "web", "不发：价目表还没定"], "about the request by its own title, in the person's words");
  board.update(task.id, { status: "doing" }, "mia");
  assert.equal(receiptOf(now(), isAgent)?.what, "answered", "the member moving on does not unsay it");
  board.deliveryCommand(task.id, "submit", "mia", { note: "Result: drafted, not sent.\nNot done or limits: none" });
  assert.equal(receiptOf(now(), isAgent), undefined, "asked again: a card again, and the old line gives way");
  board.update(task.id, { note: "Looks thin." }, "web");
  board.update(task.id, { status: "doing", note: "Add the price table." }, "web");
  assert.deepEqual([receiptOf(now(), isAgent)!.what, receiptOf(now(), isAgent)!.text], ["returned", "Add the price table."], "the newest answer wins");
  assert.match(personWordLine(now(), receiptOf(now(), isAgent)!), /sent it back to you, saying:\nAdd the price table\./);
  board.deliveryCommand(task.id, "submit", "mia", { note: "Result: table added.\nNot done or limits: none" });
  board.update(task.id, { status: "done" }, "web");
  assert.equal(receiptOf(now(), isAgent)!.what, "accepted");
  // Ended by the host with nobody's word: a line too, and it does not claim anybody decided.
  const quiet = board.create({ title: "Weekly digest", requester: "web", assigneeId: "mia" })!;
  board.deliveryCommand(quiet.id, "submit", "mia", { note: "Result: sent." });
  board.update(quiet.id, { status: "done", note: "ended: nothing waited on a look", closed: "delivery" }, "settle");
  assert.deepEqual([receiptOf(board.get(quiet.id)!, isAgent)!.what, receiptOf(board.get(quiet.id)!, isAgent)!.text], ["closed", undefined]);
  // A word is told once, and only a word that asks something of the member.
  const heard: string[] = [];
  const again = new TaskStore(null);
  watchPersonWord(again, isAgent, (_task, text) => heard.push(text));
  const sent = again.create({ title: "Export", requester: "web", assigneeId: "mia" })!;
  again.deliveryCommand(sent.id, "submit", "mia", { note: "Result: fixed." });
  again.update(sent.id, { status: "doing" }, "web");
  again.update(sent.id, { snoozeUntil: null }, "web");
  assert.equal(heard.length, 1, "sent back without a reason is still told, once");
  assert.match(heard[0]!, /without saying why/);
});
