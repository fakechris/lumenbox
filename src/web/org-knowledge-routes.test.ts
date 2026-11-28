/**
 * The organisation knowledge routes (INV-1729): admin only; an Admin's promotion waits like an
 * agent's, owned by that Admin; what waits names its scope and its readers; there is no switch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { versionOf } from "../host/memory-admin.ts";
import { OrgKnowledge } from "../host/org-knowledge.ts";
import { propose } from "../host/org-promotion.ts";
import { type Receipt, receiptId } from "../host/receipts.ts";
import type { Task } from "../host/tasks.ts";
import { mayEnterBox } from "../box/membership.ts";
import { orgKnowledgeRoute } from "./org-knowledge-routes.ts";

test("admin only; an Admin's promotion waits, names its readers, and a decision makes it live and pinned; review has no switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-org-routes-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    registry.attachBox({ id: "box-sales", name: "sales", kind: "attached", displayFloor: 10, workDir: "/home/box/work", members: ["p-ann"], createdAt: "2026-11-07T00:00:00.000Z" } as never);
    const ada = registry.create({ name: "Ada" });
    registry.appendMemoryRecords(ada.id, [{ at: "2026-11-05T09:00:00.000Z", kind: "fact", text: "quotes expire after 30 days", from: ["main@2026-11-05T09:00"] }]);
    const memory = registry.readMemoryRecords(ada.id)[0]!;
    const ledger = new OrgKnowledge(join(root, "org-knowledge.jsonl"), { mode: () => "organisation", boxes: () => registry });
    const tasks: Record<string, Task> = { t1: { id: "t1", title: "Draft", status: "doing" } as Task };
    const receipt: Receipt = { at: "2026-11-06T00:00:00.000Z", by: "host", subject: "task:t1", decision: "quotes go out from the shared inbox", because: "one place to answer from" };
    let admin = false;
    let body: Record<string, unknown> = {};
    let me: string | undefined = "p-admin";
    const mayReadAgent = (id: string) => mayEnterBox(registry.boxOf(id), me);
    const call = (route: string, params = "") => orgKnowledgeRoute(route, {
      ledger, registry, tasks: () => ({ get: id => tasks[id] }), receipts: { byId: id => [receipt, beasReceipt].find(entry => receiptId(entry) === id), forSubject: subject => [receipt, beasReceipt].filter(entry => entry.subject === subject) },
      readJson: async () => body, params: new URLSearchParams(params), refusedAdmin: () => !admin, by: () => me ?? "operator", nameOf: id => (id === "p-ann" ? "Ann" : id === "p-admin" ? "Chris" : id), log: () => {},
      mayReadAgent, mayReadTask: task => task.assigneeId === undefined || mayReadAgent(task.assigneeId),
    });
    // Bea's personal box (INV-2297): an Admin who is not in it may not promote from it, nor read its task's receipts; Bea may.
    registry.attachBox({ id: "box-bea", name: "Bea's box", kind: "attached", displayFloor: 11, workDir: "/home/box/work", members: ["p-bea"], createdAt: "2026-11-07T00:00:00.000Z" } as never);
    const beas = registry.create({ name: "Bea's agent", boxId: "box-bea" });
    registry.appendMemoryRecords(beas.id, [{ at: "2026-11-05T09:00:00.000Z", kind: "fact", text: "my bank login is in the blue notebook", from: ["main@2026-11-05T09:00"] }]);
    tasks.t2 = { id: "t2", title: "Bea's errand", status: "done", assigneeId: beas.id } as Task;
    const beasReceipt: Receipt = { at: "2026-11-06T00:00:00.000Z", by: beas.id, subject: "task:t2", decision: "paid the rent" };

    assert.deepEqual(await call("GET /api/org-knowledge/review"), { status: 0, body: null }, "a non-admin is refused");
    assert.equal(await call("GET /api/memory/team-review"), undefined, "other routes are not this module's");
    admin = true;
    body = { on: false };
    assert.equal((await call("POST /api/org-knowledge/review/setting"))!.status, 404, "there is no switch to turn organisation review off");

    body = { agent: ada.id, tier: "own", version: versionOf(memory), scope: "box", box: "box-sales" };
    const promoted = (await call("POST /api/org-knowledge/promote"))!;
    assert.equal(promoted.status, 200);
    const [waiting] = (promoted.body as { pending: Record<string, unknown>[] }).pending;
    assert.equal(waiting!.text, "quotes expire after 30 days");
    assert.equal(waiting!.scope, "box:box-sales");
    assert.deepEqual(waiting!.readers, { kind: "box", boxId: "box-sales", boxName: "sales", members: ["Ann"] }, "the review says who will read it, by name");
    assert.equal(waiting!.owner, "p-admin", "an Admin's promotion is owned by that Admin");
    assert.equal(ledger.live().length, 0, "an Admin's own promotion waits too");
    assert.equal((await call("POST /api/org-knowledge/promote"))!.status, 409, "the same proposal twice is refused");

    body = { task: "t1", scope: "org", text: "drafts go to the shared inbox" };
    const unfinished = (await call("POST /api/org-knowledge/promote"))!;
    assert.equal((unfinished.body as { code: string }).code, "org-not-finished");
    body = { receipt: receiptId(receipt), task: "t1", scope: "org" };
    assert.equal((await call("POST /api/org-knowledge/promote"))!.status, 200, "a receipt's decision is its statement when none is given");
    const listed = (await call("GET /api/org-knowledge/receipts", "task=t1"))!.body as { receipts: { id: string }[] };
    assert.deepEqual(listed.receipts.map(entry => entry.id), [receiptId(receipt)]);

    body = { version: waiting!.version, decision: "approved", pinned: true };
    const decided = (await call("POST /api/org-knowledge/review/decide"))!;
    assert.equal(decided.status, 200);
    const live = ledger.live().find(item => item.text === "quotes expire after 30 days")!;
    assert.equal(live.verifiedBy, "p-admin");
    assert.equal(live.pinned, true, "the reviewer decides whether it is read on every turn");
    assert.equal(((await call("POST /api/org-knowledge/review/decide"))!.body as { code: string }).code, "org-not-pending");
    // A proposal to replace a live item (maintenance's supersession, INV-1732) says on the review what approving it retires.
    assert.equal(propose(ledger, { source: { kind: "memory", record: memory, holder: ada.id }, text: "quotes expire after 14 days", scope: "box:box-sales", owner: "p-ann", via: ada.id, supersedes: versionOf(live) }).ok, true);
    const replacing = ((await call("GET /api/org-knowledge/review"))!.body as { pending: { text: string; replaces?: unknown }[] }).pending.find(item => item.text === "quotes expire after 14 days")!;
    assert.deepEqual(replacing.replaces, { id: `org:${versionOf(live)}`, text: "quotes expire after 30 days" });
    body = { version: "x", decision: "maybe" };
    assert.equal((await call("POST /api/org-knowledge/review/decide"))!.status, 400);

    const beasMemory = { agent: beas.id, tier: "own", version: versionOf(registry.readMemoryRecords(beas.id)[0]!), scope: "org" };
    for (const [what, attempt] of [["her agent's memory", beasMemory], ["her task", { task: "t2", scope: "org", text: "rent is paid on the 1st" }], ["her task's receipt", { receipt: receiptId(beasReceipt), scope: "org" }]] as const) {
      body = attempt;
      const refused = (await call("POST /api/org-knowledge/promote"))!;
      assert.deepEqual([refused.status, (refused.body as { code: string }).code], [403, "box-not-yours"], `an Admin outside Bea's box may not promote ${what}`);
    }
    assert.equal(((await call("GET /api/org-knowledge/review"))!.body as { pending: { text: string }[] }).pending.some(item => item.text.includes("blue notebook")), false, "and nothing of hers waits for review");
    assert.equal((await call("GET /api/org-knowledge/receipts", "task=t2"))!.status, 403, "nor may they read her task's receipts");
    me = "p-bea";
    assert.equal(((await call("GET /api/org-knowledge/receipts", "task=t2"))!.body as { receipts: unknown[] }).receipts.length, 1, "Bea reads her own task's receipts");
    body = beasMemory;
    assert.equal((await call("POST /api/org-knowledge/promote"))!.status, 200, "Bea promotes from her own box");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
