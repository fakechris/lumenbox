/** The Outbox's routes (INV-1739): the answer is on the draft before its consent is settled, and a settled or unknown draft is refused by code. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboxDrafts } from "../host/outbox-drafts.ts";
import { PolicyGate } from "../host/policy.ts";
import { outboxRoute } from "./outbox-routes.ts";

test("approve, edit and reject from the page settle the draft's consent; a second answer, an unknown id and a missing reason are refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-outbox-routes-"));
  try {
    const drafts = new OutboxDrafts(join(root, "outbox-drafts.jsonl"));
    const policy = new PolicyGate({ path: join(root, "policy.jsonl"), limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] }, spentSince: () => 0 });
    const settled: string[] = [];
    policy.onApprovalSettled = (approval, how) => { settled.push(`${drafts.byApproval(approval.id)?.status}:${how}`); };
    const make = () => { const id = drafts.newId(); const approval = policy.requestConfirmation({ agentId: "a1", agentName: "Ada", description: `Outbox ${id}` }); return drafts.record({ id, agentId: "a1", agentName: "Ada", conversation: "main", kind: "message", target: "here", body: "hi", why: "asked", approvalId: approval.id }); };
    const answered: string[] = [];
    const call = (body: Record<string, unknown>, mayAnswer = true) => outboxRoute("POST /api/outbox/decide", { drafts, policy, readJson: async () => body, mayAnswer: () => mayAnswer, answered: (_, how) => answered.push(how), by: () => "Chris" });
    const a = make(), b = make(), c = make();

    assert.equal(((await outboxRoute("GET /api/outbox", { drafts, policy, readJson: async () => ({}), mayAnswer: () => true, by: () => "Chris" }))!.body as { drafts: unknown[] }).drafts.length, 3);
    assert.equal((await call({ id: a.id, decision: "approve" }, false))!.status, 404, "an agent this person cannot drive is not theirs to answer");
    assert.equal((await call({ id: a.id, decision: "maybe" }))!.status, 400);
    assert.equal((await call({ id: c.id, decision: "reject" }))!.status, 400, "a rejection carries a reason");
    assert.equal((await call({ id: a.id, decision: "approve" }))!.status, 200);
    assert.equal((await call({ id: b.id, decision: "edit", body: "hello, all" }))!.status, 200);
    assert.equal((await call({ id: c.id, decision: "reject", reason: "not yet" }))!.status, 200);
    assert.deepEqual(settled, ["approved:allowed", "approved:allowed", "rejected:refused"], "the decision is on file before the consent settles");
    assert.deepEqual(answered, ["allowed", "allowed", "refused"]);
    assert.equal(drafts.get(b.id)?.body, "hello, all");
    assert.equal(drafts.get(c.id)?.reason, "not yet");
    const again = await call({ id: a.id, decision: "reject", reason: "changed my mind" });
    assert.equal(again!.status, 409);
    assert.equal((again!.body as { code: string }).code, "outbox-settled");
    assert.equal(((await call({ id: "ob-nope", decision: "approve" }))!.body as { code: string }).code, "outbox-unknown");
    assert.equal(await outboxRoute("GET /api/tasks", { drafts, policy, readJson: async () => ({}), mayAnswer: () => true, by: () => "Chris" }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
