import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryRecovery } from "./delivery-recovery.ts";
import { Deliveries, type Delivery } from "./deliveries.ts";
import { Outbox } from "./outbox.ts";
import { TaskStore, type Task } from "./tasks.ts";
import { OutboxSender } from "../channels/outbox-sender.ts";
import { describePurpose } from "./outbound.ts";
import { deliveryRecoveryRoute } from "../web/delivery-recovery-routes.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reply-recovery-")), queuePath = join(dir, "deliveries.jsonl"), decisionsPath = join(dir, "decisions.jsonl");
  const deliveries = new Deliveries(queuePath), outbox = new Outbox(join(dir, "outbox.jsonl")), tasks = new TaskStore(null);
  const task = tasks.create({ title: "Explain the speech models", requester: "person", assigneeId: "agent", sourceMessageId: "source", workRoot: { state: { id: "work", owner: "agent", conversation: "main", generation: 1, epoch: 0, status: "answered", messages: ["source"], peers: [], awaiting: [] } } })!;
  let current: Task | undefined = task, content = "The recovered answer", working = false, reads = 0;
  const sent: string[] = [];
  const delivery: Delivery = { id: "owed", messageId: "source", kind: "request", agentId: "agent", conversation: "main", chatKey: "feishu:room", at: NOW.toISOString(), taskId: task.id, before: 0 };
  deliveries.open(delivery);
  const deps = { deliveries, outbox, decisionsPath, task: () => current, reply: () => { reads++; return content; }, isWorking: () => working, now: () => NOW, send: async (_row: Delivery, text: string) => { sent.push(text); } };
  return { dir, queuePath, decisionsPath, deliveries, outbox, task, delivery, sent, deps, recovery: new DeliveryRecovery(deps), setTask: (t: Task | undefined) => { current = t; }, setContent: (s: string) => { content = s; }, setWorking: (v: boolean) => { working = v; }, reads: () => reads, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("verified completed work can send its owed reply once without accepting or rewriting the task", async () => {
  const f = fixture(); try {
    f.setTask({ ...f.task, status: "done" });
    const before = JSON.stringify(f.deps.task());
    f.setWorking(true); assert.equal(f.recovery.preview("owed")!.phase, "waiting");
    await f.recovery.sweep(); assert.equal(f.sent.length, 0); f.setWorking(false);
    assert.equal(f.recovery.preview("owed")!.phase, "ready");
    await f.recovery.sweep(); await new DeliveryRecovery(f.deps).sweep();
    assert.deepEqual(f.sent, ["The recovered answer"]);
    assert.equal(JSON.stringify(f.deps.task()), before);
    assert.equal(f.recovery.preview("owed")!.phase, "sent");
    assert.equal(f.deliveries.entries().length, 0);
  } finally { f.cleanup(); }
});

test("missing requests, changed assignees and completed interactions are held with readable reasons", async () => {
  const f = fixture(); try {
    f.setTask(undefined); f.setContent("");
    let view = f.recovery.preview("owed")!;
    assert.match(view.title, /2026-11-11/); assert.equal(view.source, "missing"); assert.equal(view.canSend, false);
    await f.recovery.sweep(); assert.equal(f.sent.length, 0);
    await assert.rejects(f.recovery.send("owed", view.token, "operator"));
    f.setContent("The original answer"); f.setTask({ ...f.task, assigneeId: "other" });
    view = f.recovery.preview("owed")!; assert.equal(view.source, "conflict"); assert.equal(view.phase, "needs_review");
    await f.recovery.sweep(); assert.equal(f.sent.length, 0);
    f.setTask({ ...f.task, workRoot: { ...f.task.workRoot!, state: { ...f.task.workRoot!.state, conversation: "other-conversation" } } });
    assert.equal(f.recovery.preview("owed")!.source, "conflict");
    f.setTask({ ...f.task, workRoot: { ...f.task.workRoot!, state: { ...f.task.workRoot!.state, status: "cancelled" } } });
    assert.equal(f.recovery.preview("owed")!.canSend, false);
    assert.equal(f.recovery.allowReceipt({ purpose: describePurpose({ kind: "answer", deliveryId: "owed" }) }), false);
    f.setTask({ ...f.task, status: "done" }); f.deliveries.open({ ...f.delivery, kind: "interaction" });
    view = f.recovery.preview("owed")!; assert.match(view.reason, /interaction has ended/); assert.equal(view.phase, "needs_review");
  } finally { f.cleanup(); }
});

test("an operator previews a legacy reply before sending; changed contents invalidate its action token", async () => {
  const f = fixture(); try {
    f.deliveries.open({ ...f.delivery, messageId: undefined, at: "2026-09-01T00:00:00Z" });
    let view = f.recovery.preview("owed")!; assert.equal(view.phase, "needs_review");
    await f.recovery.sweep(); assert.equal(f.sent.length, 0);
    f.setContent("Changed answer");
    await assert.rejects(f.recovery.send("owed", view.token, "operator"), /changed/);
    view = f.recovery.preview("owed")!;
    const sent = await f.recovery.send("owed", view.token, "operator");
    assert.equal(sent.phase, "sent"); assert.deepEqual(f.sent, ["Changed answer"]);
  } finally { f.cleanup(); }
});

test("discard survives queue loss and restart, blocks already queued outbox retries, and leaves unrelated work alone", async () => {
  const f = fixture(); try {
    const purpose = describePurpose({ kind: "answer", deliveryId: "owed" });
    f.outbox.enqueue({ id: "receipt", chatKey: f.delivery.chatKey, purpose, text: "old reply" });
    const discarded = f.recovery.discard("owed", f.recovery.preview("owed")!.token, "operator");
    assert.equal(discarded.phase, "discarded"); assert.equal(f.outbox.pending().length, 0);
    writeFileSync(f.queuePath, ""); // A compacted queue is not the authority for this decision.
    const restarted = new DeliveryRecovery(f.deps);
    f.deliveries.open(f.delivery); // A stale callback tries to re-open the old debt.
    await restarted.sweep(); assert.equal(f.sent.length, 0);
    assert.equal(restarted.allowReceipt({ purpose }), false);
    assert.equal(restarted.allowReceipt({ purpose: "notice: other work" }), true);
    assert.equal(restarted.allowReceipt({ purpose: "answer owed as " }), false);
    assert.equal(restarted.preview("owed")!.phase, "discarded");
  } finally { f.cleanup(); }
});

test("a lost send is unknown after restart, never automatically repeated or called undone", async () => {
  const f = fixture(); let finish!: () => void;
  try {
    const recovery = new DeliveryRecovery({ ...f.deps, send: async () => new Promise<void>(resolve => { finish = resolve; }) });
    const sending = recovery.send("owed", recovery.preview("owed")!.token, "operator");
    const restarted = new DeliveryRecovery(f.deps), view = restarted.preview("owed")!;
    assert.equal(view.phase, "unknown");
    await restarted.sweep(); assert.equal(f.sent.length, 0);
    const discarded = restarted.discard("owed", view.token, "operator");
    assert.equal(discarded.externalEffectUnconfirmed, true);
    finish(); await sending;
    assert.equal(restarted.preview("owed")!.phase, "discarded");
    assert.equal(restarted.preview("owed")!.externalEffectUnconfirmed, true);
  } finally { f.cleanup(); }
});

test("outbox rechecks disposition after backoff instead of reviving a discarded recovery", async () => {
  const f = fixture(); let release!: () => void, waiting!: () => void;
  try {
    const paused = new Promise<void>(resolve => { waiting = resolve; });
    let calls = 0;
    const sender = new OutboxSender(f.outbox, () => {}, async () => { waiting(); await new Promise<void>(resolve => { release = resolve; }); }, () => NOW, undefined, receipt => recovery.allowReceipt(receipt));
    const recovery = new DeliveryRecovery({ ...f.deps, send: async (row, text) => {
      const result = await sender.send({ adapter: { sendToChat: async () => { calls++; throw new Error("connection lost"); } }, chatKey: row.chatKey, text, purpose: { kind: "answer", deliveryId: row.id } });
      if (!result.delivered) throw new Error(result.why);
    } });
    const sending = recovery.send("owed", recovery.preview("owed")!.token, "operator");
    await paused; recovery.discard("owed", recovery.preview("owed")!.token, "operator"); release(); await sending;
    assert.equal(calls, 1); assert.equal(recovery.preview("owed")!.phase, "discarded");
    await new DeliveryRecovery(f.deps).sweep(); assert.equal(f.sent.length, 0);
  } finally { f.cleanup(); }
});

test("the inventory is paged before loading content, and reads do not close replaced-channel records", () => {
  const f = fixture(); try {
    for (let n = 0; n < 1600; n++) f.deliveries.open({ ...f.delivery, id: `old-${n}` });
    assert.equal(f.recovery.list(50).length, 50); assert.equal(f.reads(), 0);
    assert.equal(f.recovery.list(50, 50)[0]!.id, "old-49");
    const before = readFileSync(f.queuePath, "utf8");
    const replaced = new Deliveries(f.queuePath, { incarnationOf: () => 2 });
    const recovery = new DeliveryRecovery({ ...f.deps, deliveries: replaced });
    assert.equal(recovery.preview("owed")!.phase, "cancelled");
    assert.equal(readFileSync(f.queuePath, "utf8"), before);
  } finally { f.cleanup(); }
});

test("route access and stale previews protect disposition; corrupt decisions fail closed", async () => {
  const f = fixture(); try {
    const row = f.recovery.preview("owed")!, url = new URL("http://localhost/api/deliveries/recovery?id=owed");
    const deps = { recovery: f.recovery, refused: () => false, readJson: async () => ({ id: "owed", action: "discard", token: row.token }), mayRead: () => false, by: "operator" };
    assert.equal((await deliveryRecoveryRoute("POST /api/deliveries/recovery", url, deps))!.status, 404);
    assert.equal(f.deliveries.entries().length, 1);
    assert.equal((await deliveryRecoveryRoute("POST /api/deliveries/recovery", url, { ...deps, mayRead: () => true }))!.status, 200);
    writeFileSync(f.decisionsPath, "{broken cancellation record\n");
    assert.throws(() => f.recovery.preview("owed"));
  } finally { f.cleanup(); }
});


test("a durable discard still fences recovery when closing the old queue fails", async () => {
  const f = fixture(); try {
    const preview = f.recovery.preview("owed")!;
    f.deliveries.close = () => { throw new Error("queue unavailable after durable decision"); };
    assert.throws(() => f.recovery.discard("owed", preview.token, "operator"));
    const restarted = new DeliveryRecovery({ ...f.deps, deliveries: new Deliveries(f.queuePath) });
    assert.equal(restarted.preview("owed")!.phase, "discarded");
    await restarted.sweep(); assert.equal(f.sent.length, 0);
    assert.equal(restarted.discard("owed", preview.token, "operator").phase, "discarded", "a repeated discard is idempotent");
  } finally { f.cleanup(); }
});
