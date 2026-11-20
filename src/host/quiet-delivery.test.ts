import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InboundMessage } from "../agents/admitted-message.ts";
import { HeardRecord } from "../agents/heard-record.ts";
import { OutboxSender } from "../channels/outbox-sender.ts";
import type { OutboundPurpose } from "./outbound.ts";
import { Outbox } from "./outbox.ts";
import { answeringPerson, quietChatDoor, type QueuedMessage, QuietQueue, quietSettings, quietVerdict, waitsForQuiet } from "./quiet-delivery.ts";
import { lastPersonMessage } from "./routine-idle.ts";

const MINUTE = 60_000;
const at = (minutes: number) => Date.parse("2026-11-20T09:00:00Z") + minutes * MINUTE;
const rule = { windowMs: 3 * MINUTE, capMs: 30 * MINUTE, answering: false };

test("a message nobody asked for goes when no person has written for the window, waits while one is being answered, and never waits past the cap (INV-1928)", () => {
  assert.deepEqual(quietVerdict({ ...rule, now: at(10), queuedAt: at(10) }), { go: true, why: "quiet" }, "a conversation no person has written in is quiet");
  assert.deepEqual(quietVerdict({ ...rule, now: at(10), queuedAt: at(10), lastPersonAt: at(8) }), { go: false, until: at(11) }, "a person wrote two minutes ago: it waits for the third");
  assert.deepEqual(quietVerdict({ ...rule, now: at(11), queuedAt: at(10), lastPersonAt: at(8) }), { go: true, why: "quiet" });
  assert.deepEqual(quietVerdict({ ...rule, now: at(20), queuedAt: at(10), lastPersonAt: at(1), answering: true }), { go: false, until: at(40) }, "a member is still answering them: not quiet however long ago they wrote");
  assert.deepEqual(quietVerdict({ ...rule, now: at(40), queuedAt: at(10), lastPersonAt: at(39), answering: true }), { go: true, why: "cap" }, "thirty minutes is the most anything waits");
  assert.deepEqual(quietVerdict({ ...rule, now: at(10), queuedAt: at(10), lastPersonAt: at(10), answering: true, urgent: true }), { go: true, why: "urgent" });
  assert.deepEqual(quietVerdict({ ...rule, windowMs: 0, now: at(10), queuedAt: at(10), lastPersonAt: at(10) }), { go: true, why: "off" }, "a window of 0 turns the waiting off");
});

test("only a notice waits, and not one that carries a question, is an operator's line, is marked urgent, or is of a kind the person listed", () => {
  const notice = (about: string, more: object = {}): OutboundPurpose => ({ kind: "notice", about, ...more });
  for (const about of ["report from a1", "follow-up sweep", "daily digest", "board: t1 done", "rescued t4", "routines paused: nobody is writing"]) assert.equal(waitsForQuiet(notice(about)), true, about);
  for (const about of ["question text form", "question q7 expired", "console", "console reply", "board: t1 blocked"]) assert.equal(waitsForQuiet(notice(about)), false, about);
  assert.equal(waitsForQuiet(notice("report from a1", { urgent: true })), false, "what its sender marked as needing the person");
  assert.equal(waitsForQuiet(notice("rescued t4"), ["rescued"]), false, "a kind the person said never waits");
  assert.equal(waitsForQuiet(notice("report from a1"), ["rescued", " "]), true);
  for (const purpose of [{ kind: "answer", deliveryId: "d1" }, { kind: "ack", messageId: "m1" }, { kind: "attention", ref: "t1", question: "?" }, { kind: "draft", id: "o1" }] as OutboundPurpose[]) {
    assert.equal(waitsForQuiet(purpose), false, `${purpose.kind} is owed to a person or approved by one`);
  }
  assert.deepEqual(quietSettings(undefined), { windowMinutes: 3, capMinutes: 30, urgent: [] });
  assert.deepEqual(quietSettings({ minutes: 0, capMinutes: 10, urgent: ["rescued", 4, ""] }), { windowMinutes: 0, capMinutes: 10, urgent: ["rescued"] });
  assert.deepEqual(quietSettings({ minutes: -1, capMinutes: 1.5 }), { windowMinutes: 3, capMinutes: 30, urgent: [] }, "a setting out of range keeps the default");
});

let seq = 0;

/** A chat door over the real outbox and the real heard record, with the clock in the test's hand. */
function room(dir: string, clock: { at: number }) {
  const heard = new HeardRecord(join(dir, "heard"));
  const sent: string[] = [], open: { agentId: string; conversation?: string; causedBy?: string[] }[] = [];
  const queue = new QuietQueue({
    path: join(dir, "quiet-queue.jsonl"), now: () => clock.at,
    lastPersonAt: conversation => lastPersonMessage(heard, ["a1"], conversation)?.getTime(),
    answering: conversation => answeringPerson(open, heard, conversation),
  });
  const outbox = new OutboxSender(new Outbox(join(dir, "outbox.jsonl"), () => new Date(clock.at)), () => {}, async () => {}, () => new Date(clock.at));
  const adapter = { sendToChat: async (_chatKey: string, text: string) => { sent.push(text); } };
  const door = quietChatDoor(outbox, queue, { conversationOf: chatKey => chatKey.replace(":", "-"), push: (chatKey, text, purpose) => outbox.send({ adapter, chatKey, text, purpose }) });
  const push = (text: string, more: object = {}) => door.send({ adapter, chatKey: "feishu:oc_room", text, purpose: { kind: "notice", about: "report from a1", from: "a1", ...more } });
  const message = (fromId: string, more: Partial<InboundMessage> = {}): InboundMessage =>
    ({ id: `m${++seq}`, fromId, fromName: fromId, text: "…", priority: false, receivedAt: new Date(clock.at).toISOString(), ...more }) as InboundMessage;
  const hears = (fromId: string, more: Partial<InboundMessage> = {}) => { const heardNow = message(fromId, more); heard.note("a1", "feishu-oc_room", [heardNow], id => id === "a2"); return heardNow.id; };
  return { heard, queue, sent, open, push, hears, door };
}

test("held while a person is in the conversation, delivered in order once it is quiet; what the member and the host say in between does not restart the wait (INV-1928)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-quiet-")), clock = { at: at(0) };
  try {
    const { heard, queue, sent, push, hears } = room(dir, clock);
    assert.equal((await push("Before anybody wrote.")).delivered, true);
    assert.deepEqual(sent, ["Before anybody wrote."], "a conversation no person is in is not waited for");

    hears("user");
    clock.at = at(1);
    const first = await push("Brief: two invoices are overdue.");
    assert.deepEqual([first.delivered, "queued" in first && first.queued], [true, "q1"], "taken, and answered as taken: the queue owes its delivery");
    clock.at = at(2);
    await push("Brief: the export finished.");
    assert.equal(await queue.sweep(), 0);
    assert.deepEqual(sent, ["Before anybody wrote."], "nothing lands in the middle of the exchange");

    // What the member says, a routine's prompt, a teammate and a host notice are none of them a person writing.
    heard.said("a1", "feishu-oc_room", "turn-1", "Here is the March figure.", "reply");
    hears("user", { synthetic: true });
    hears("a2");
    hears("user", { origin: "host:jobs" });
    await push("The key is rejected.", { urgent: true });
    assert.deepEqual(sent.slice(1), ["The key is rejected."], "an urgent message goes at once, past the ones waiting");

    clock.at = at(3) - 1;
    assert.equal(await queue.sweep(), 0, "one millisecond short of three minutes since the person wrote");
    clock.at = at(3);
    assert.equal(await queue.sweep(), 2, "three minutes after the person's last message — not after the member's, the routine's or the urgent one");
    assert.deepEqual(sent.slice(2), ["Brief: two invoices are overdue.", "Brief: the export finished."], "in the order they were queued, word for word");
    assert.equal(await queue.sweep(), 0);
    assert.deepEqual(queue.waiting(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a conversation that never goes quiet does not keep a message for ever: at the cap it is delivered, and one queued later waits for its own (INV-1928)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-quiet-")), clock = { at: at(0) };
  try {
    const { queue, sent, open, push, hears } = room(dir, clock);
    const asked = hears("user");
    open.push({ agentId: "a1", conversation: "feishu-oc_room", causedBy: [asked] });
    await push("Brief: two invoices are overdue.");
    clock.at = at(20);
    await push("Brief: the export finished.");
    assert.equal(await queue.sweep(), 0, "twenty minutes after the person wrote, the member is still answering them");
    for (let minute = 22; minute < 30; minute += 2) { clock.at = at(minute); hears("user"); assert.equal(await queue.sweep(), 0); }
    clock.at = at(30);
    hears("user");
    assert.equal(await queue.sweep(), 1);
    assert.deepEqual(sent, ["Brief: two invoices are overdue."], "thirty minutes is the most it waits, whoever is talking");
    assert.deepEqual(queue.waiting().map(message => message.id), ["q2"], "the later one has waited ten");
    open.length = 0;
    clock.at = at(33);
    assert.equal(await queue.sweep(), 1, "the turn ended and three minutes passed");
    assert.deepEqual(sent.slice(1), ["Brief: the export finished."]);

    const routineTurn = hears("user", { synthetic: true });
    open.push({ agentId: "a1", conversation: "feishu-oc_room", causedBy: [routineTurn] }, { agentId: "a1", conversation: "main", causedBy: [asked] });
    clock.at = at(40);
    await push("Brief: nothing new.");
    assert.equal(sent.length, 3, "a routine's own turn there, or a person being answered in another conversation, holds nothing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a queued message survives a restart and is delivered once — also when the process stopped after the send and before the queue wrote it down (INV-1928)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-quiet-")), clock = { at: at(0) };
  try {
    const before = room(dir, clock);
    before.hears("user");
    await before.push("Brief: two invoices are overdue.");
    await before.push("Brief: the export finished.");
    assert.equal(before.queue.waiting().length, 2);

    // The process stops. A new one reads the same files.
    const after = room(dir, clock);
    assert.deepEqual(after.queue.waiting().map(message => [message.id, message.text]), [["q1", "Brief: two invoices are overdue."], ["q2", "Brief: the export finished."]]);
    assert.equal(await after.queue.sweep(), 0, "the person wrote before the restart, and that is still on record");
    clock.at = at(3);
    assert.equal(await after.queue.sweep(), 2);
    assert.deepEqual(after.sent, ["Brief: two invoices are overdue.", "Brief: the export finished."]);
    const third = await after.push("Brief: nothing new.");
    assert.equal("queued" in third, false);
    assert.equal(after.queue.waiting().length, 0);

    const again = room(dir, clock);
    assert.deepEqual(again.queue.waiting(), [], "what went is not waiting in the next process");
    assert.equal(await again.queue.sweep(), 0);
    assert.deepEqual(again.sent, []);

    // A crash between the door taking it and the queue's own line: the queue offers it again, and the outbox's receipt says it went.
    clock.at = at(10);
    const crashing = room(dir, clock);
    crashing.hears("user");
    await crashing.push("Brief: the audit closed.");
    let died = false;
    crashing.queue.door("chat", async held => { await crashing.door.send({ adapter: { sendToChat: async (_key: string, text: string) => { crashing.sent.push(text); } }, chatKey: "feishu:oc_room", text: held.text, purpose: { kind: "notice", about: "report from a1", urgent: true } }); died = true; throw new Error("the process stopped here"); });
    clock.at = at(13);
    assert.equal(await crashing.queue.sweep(), 0);
    assert.deepEqual([died, crashing.sent], [true, ["Brief: the audit closed."]]);
    const recovered = room(dir, clock);
    assert.equal(recovered.queue.waiting().length, 1, "the queue never wrote that it went");
    assert.equal(await recovered.queue.sweep(), 1);
    assert.deepEqual(recovered.sent, [], "and the chat does not get it a second time");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a member takes back a waiting message of its own, or puts new words in its place where it stood; nobody else's (INV-1928)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-quiet-")), clock = { at: at(0) };
  try {
    const { queue, sent, push, hears } = room(dir, clock);
    hears("user");
    for (const text of ["Three invoices are overdue.", "The export finished.", "The audit closed."]) await push(text);
    assert.equal(queue.amend("q1", "a2"), undefined, "another member's message is not this one's to take back");
    assert.equal(queue.amend("q1", "a1", "Two invoices are overdue; the third was paid this morning.")?.text, "Three invoices are overdue.");
    assert.equal(queue.amend("q2", "a1")?.id, "q2");
    assert.equal(queue.amend("q2", "a1"), undefined, "taken back once");
    let doorsUp = false;
    const starting = new QuietQueue({ path: join(dir, "quiet-queue.jsonl"), lastPersonAt: () => undefined, answering: () => false, ready: () => doorsUp });
    const restarted: readonly QueuedMessage[] = starting.waiting(), early: string[] = [];
    assert.deepEqual(restarted.map(message => message.id), ["q1", "q3"], "and a restart does not bring it back");
    starting.door("chat", async message => { early.push(message.id); });
    assert.equal(await starting.sweep(), 0, "a process whose chat doors are still starting hands nothing to them");
    assert.deepEqual([early, starting.waiting().length], [[], 2]);
    doorsUp = true;
    clock.at = at(3);
    await queue.sweep();
    assert.deepEqual(sent, ["Two invoices are overdue; the third was paid this morning.", "The audit closed."]);
    assert.equal(queue.amend("q1", "a1"), undefined, "what has gone cannot be taken back");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
