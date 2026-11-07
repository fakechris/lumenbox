/**
 * Promotion into the organisation's knowledge (INV-1729, docs/98 §5 and §10 decisions 2 and 4).
 *
 * What would be wrong: a proposal anybody reads before a person approves it; an approval without
 * the approver as `verifiedBy`, or with an owner nobody drove; a rejection that leaves no record;
 * a review that some setting turns off; an unfinished task, an evidence-free line or a personal
 * installation reaching L1; a box-scoped proposal approved for a box that is gone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import type { InstallationMode } from "./installation.ts";
import { OrgKnowledge } from "./org-knowledge.ts";
import { decide, ORG_REVIEW_QUESTION, pendingPromotions, promotionOwner, propose, readersOf } from "./org-promotion.ts";
import { receiptId } from "./receipts.ts";
import type { Task } from "./tasks.ts";
import { dispatchTool } from "./tools.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

function fixture(mode: InstallationMode = "organisation") {
  const root = mkdtempSync(join(tmpdir(), "agentbox-org-promotion-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  const registry = new AgentRegistry(join(root, "agents"));
  registry.attachBox({ id: "box-sales", name: "sales", kind: "attached", displayFloor: 10, workDir: "/home/box/work", members: ["p-ann"], createdAt: NOW.toISOString() } as never);
  const state = { mode };
  const ledger = new OrgKnowledge(join(root, "org-knowledge.jsonl"), { mode: () => state.mode, boxes: () => registry, now: () => NOW });
  const bus = new AgentBus(registry, async () => {});
  return {
    root, registry, ledger, state, bus,
    cleanup: () => { if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous; rmSync(root, { recursive: true, force: true }); },
  };
}

const done: Pick<Task, "id" | "title" | "status" | "deliverables"> = { id: "t12", title: "Settle the refund policy", status: "done", deliverables: [{ id: "d1" } as never] };

test("Promote holds the proposal for review: nobody reads it, the owner is the member who drove the turn; approval makes it live with the approver as verifiedBy", async () => {
  const { registry, ledger, bus, root, cleanup } = fixture();
  try {
    // Review is always on: team memory review off (its default, here written down) changes nothing for L1.
    writeFileSync(join(root, "config.json"), JSON.stringify({ teamMemoryReview: false }));
    const ada = registry.create({ name: "Ada" }), bob = registry.create({ name: "Bob" });
    registry.appendMemoryRecords(ada.id, [{ at: "2026-11-05T09:00:00.000Z", kind: "fact", text: "refunds are approved by finance within two days", from: ["main@2026-11-05T09:00"] }]);
    const context = { agent: ada, registry, bus, box: undefined as never, orgKnowledge: ledger, caller: { userId: "p-ann" } };

    const proposed = await dispatchTool("Promote", { memory: "Refunds are approved by finance within two days", scope: "org", evidence: ["inv:INV-1581"] }, context);
    assert.equal(proposed.isError, undefined, proposed.text);
    assert.match(proposed.text, /waiting for an Admin's approval.*nobody reads it, you included/s, "the agent is told it waits");
    const [pending] = pendingPromotions(ledger.lines());
    assert.equal(pending!.item.owner, "p-ann", "the owner is the member who drove the turn");
    assert.equal(pending!.item.via, ada.id);
    assert.equal(pending!.item.held?.question, ORG_REVIEW_QUESTION);
    assert.deepEqual(pending!.item.evidence, ["main@2026-11-05T09:00", "inv:INV-1581"], "the memory's own source, and what the agent added");
    assert.equal(ledger.recalledFor(bob.id, undefined).length, 0, "another agent cannot read a proposal");
    assert.equal(ledger.admittedFor(ada.id, "p-ann").length, 0, "nor can its proposer");
    assert.match((await dispatchTool("Promote", { memory: "refunds are approved by finance within two days", scope: "org" }, context)).text, /already waiting/, "proposing it twice says so");

    const approved = decide(ledger, pending!.version, "approved", "p-admin", id => registry.boxById(id), { now: NOW });
    assert.ok(approved.ok);
    assert.equal(approved.item.verifiedBy, "p-admin");
    assert.equal(approved.item.verifiedAt, NOW.toISOString());
    assert.equal(approved.item.owner, "p-ann", "the approver may be a different person; the owner stays");
    assert.equal(approved.item.held, undefined);
    assert.deepEqual(ledger.recalledFor(bob.id, undefined).map(item => item.text), ["refunds are approved by finance within two days"], "approved, every member's agent reads it");
    assert.equal(pendingPromotions(ledger.lines()).length, 0);
    assert.equal(decide(ledger, pending!.version, "rejected", "p-admin", id => registry.boxById(id)).ok, false, "a decided proposal is not decided twice");

    // A turn nobody drove — a routine's run, the installation's own credential — has nobody to own the item.
    const unowned = await dispatchTool("Promote", { memory: "refunds are approved by finance within two days", scope: "box" }, { ...context, caller: undefined });
    assert.equal(unowned.isError, true);
    assert.match(unowned.text, /no member drove this turn/);
    assert.match((await dispatchTool("Promote", { memory: "x", scope: "org" }, { ...context, orgKnowledge: undefined })).text, /no organisation knowledge/, "an isolated or guest turn has nothing to propose into");
  } finally {
    cleanup();
  }
});

test("the owner rule: the member who drove the turn, else the routine's creator, else nobody", () => {
  assert.equal(promotionOwner({ caller: "p-ann", routineCreator: "p-bob" }), "p-ann");
  assert.equal(promotionOwner({ routineCreator: "p-bob" }), "p-bob");
  assert.equal(promotionOwner({}), undefined);
  assert.equal(promotionOwner({ caller: "" }), undefined);
});

test("a rejection is a record, never live; an unfinished task, a line with no evidence and a personal installation never reach L1", () => {
  const { registry, ledger, state, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const proposed = propose(ledger, { source: { kind: "task", task: done }, text: "refunds under 500 need no second approval", scope: "org", owner: "p-ann" }, NOW);
    assert.ok(proposed.ok);
    assert.deepEqual(proposed.item.evidence, ["task:t12", "deliverable:t12/d1"], "a task gives itself and what it delivered as evidence");
    const rejected = decide(ledger, proposed.version, "rejected", "p-admin", id => registry.boxById(id), { now: NOW });
    assert.ok(rejected.ok);
    assert.deepEqual(rejected.item.review, { of: proposed.version, decision: "rejected", by: "p-admin" });
    assert.ok(rejected.item.held !== undefined, "rejected stays held: nobody reads it");
    assert.equal(ledger.live().length, 0);
    assert.equal(ledger.lines().length, 2, "the proposal and the rejection are both in the history");

    const open = propose(ledger, { source: { kind: "task", task: { ...done, status: "doing" } }, text: "a guess about refunds", scope: "org", owner: "p-ann" });
    assert.equal(open.ok ? "" : open.code, "not-finished");
    const bare = propose(ledger, { source: { kind: "memory", record: { at: NOW.toISOString(), kind: "fact", text: "refunds take a week" }, holder: ada.id }, scope: "org", owner: "p-ann" });
    assert.equal(bare.ok ? "" : bare.code, "no-evidence", "a promotion says what it rests on");
    const receipt = { at: NOW.toISOString(), by: "host", subject: "task:t12", decision: "refunds go through finance", evidence: ["https://example.test/pr/1", "commit:abc1234"] };
    const fromReceipt = propose(ledger, { source: { kind: "receipt", receipt }, scope: "org", owner: "p-ann", text: "refunds go through finance" });
    assert.ok(fromReceipt.ok);
    assert.deepEqual(fromReceipt.item.evidence, [`receipt:${receiptId(receipt)}`, "commit:abc1234"], "a receipt's references that are not evidence are left out, not stored as such");

    state.mode = "single-machine";
    const personal = propose(ledger, { source: { kind: "task", task: done }, text: "refunds are weekly", scope: "org", owner: "p-ann" });
    assert.equal(personal.ok ? "" : personal.code, "personal");
  } finally {
    cleanup();
  }
});

test("the review names who will read it; a proposal for a box that is gone cannot be approved", () => {
  const { registry, ledger, cleanup } = fixture();
  try {
    const boxById = (id: string) => registry.boxById(id);
    assert.deepEqual(readersOf("org", boxById), { kind: "org" });
    assert.deepEqual(readersOf("box:box-sales", boxById), { kind: "box", boxId: "box-sales", boxName: "sales", members: ["p-ann"] });
    assert.deepEqual(readersOf("box:box-gone", boxById), { kind: "nobody" });
    const proposed = propose(ledger, { source: { kind: "task", task: done }, text: "sales quotes expire after 30 days", scope: "box:box-sales", owner: "p-ann" });
    assert.ok(proposed.ok);
    registry.detachBox("box-sales");
    const approved = decide(ledger, proposed.version, "approved", "p-admin", boxById);
    assert.equal(approved.ok ? "" : approved.code, "no-readers");
    assert.equal(pendingPromotions(ledger.lines()).length, 1, "it still waits, to be rejected");
  } finally {
    cleanup();
  }
});
