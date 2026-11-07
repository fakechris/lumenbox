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
import { type Receipt, receiptId } from "../host/receipts.ts";
import type { Task } from "../host/tasks.ts";
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
    const call = (route: string, params = "") => orgKnowledgeRoute(route, {
      ledger, registry, tasks: () => ({ get: id => tasks[id] }), receipts: { byId: id => (id === receiptId(receipt) ? receipt : undefined), forSubject: subject => (subject === receipt.subject ? [receipt] : []) },
      readJson: async () => body, params: new URLSearchParams(params), refusedAdmin: () => !admin, by: () => "p-admin", nameOf: id => (id === "p-ann" ? "Ann" : id === "p-admin" ? "Chris" : id), log: () => {},
    });

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
    body = { version: "x", decision: "maybe" };
    assert.equal((await call("POST /api/org-knowledge/review/decide"))!.status, 400);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
