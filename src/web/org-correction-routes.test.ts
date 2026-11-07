/**
 * Settings → Memory → the organisation's knowledge (INV-1730).
 *
 * What would be wrong: a member reading an item of a box they cannot enter; a member who is not
 * the owner retracting or superseding; a refusal with no stable code; a verb that edits in place.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrgKnowledge, orgItemId, type OrgKnowledgeItem } from "../host/org-knowledge.ts";
import { orgCorrectionRoute } from "./org-correction-routes.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const boxes = [{ id: "box-main", members: "everyone" as const }, { id: "box-sales", members: ["p-ann"] }];
const item = (text: string, extra: Partial<OrgKnowledgeItem> = {}): OrgKnowledgeItem => ({
  at: "2026-11-01T00:00:00.000Z", kind: "fact", text, scope: "org", surface: "recall", owner: "p-ann",
  evidence: ["doc:docs/98"], verifiedBy: "p-admin", verifiedAt: "2026-11-02T00:00:00.000Z", ...extra,
});

test("a member reads what their boxes admit and may unverify it; only the owner or an Admin retracts or supersedes", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-org-routes-"));
  try {
    const ledger = new OrgKnowledge(join(root, "org-knowledge.jsonl"), { mode: () => "organisation", boxes: () => ({ boxOf: () => boxes[0]!, boxById: id => boxes.find(box => box.id === id) }), now: () => NOW });
    ledger.isAdmin = principalId => principalId === undefined || principalId === "p-admin";
    const whole = ledger.append(item("refunds are approved by finance within two days"));
    ledger.append(item("the sales playbook is in the shared drive", { scope: "box:box-sales" }));
    const call = (route: string, principalId: string | undefined, body: Record<string, unknown> = {}) =>
      orgCorrectionRoute(route, { ledger, readJson: async () => body, refused: () => false, principalId, nameOf: id => id.replace("p-", ""), boxName: () => undefined, log: () => {} });
    const items = async (principalId: string | undefined) => ((await call("GET /api/memory/org/items", principalId))!.body as { items: { id: string; text: string; may: Record<string, boolean>; state: string; correction?: { byName: string } }[] }).items;

    assert.deepEqual((await items("p-zed")).map(row => row.text), ["refunds are approved by finance within two days"], "a box item is not shown to someone who cannot enter the box");
    assert.equal((await items("p-ann")).length, 2);
    assert.equal((await items("p-admin")).length, 2);
    assert.deepEqual((await items("p-zed"))[0]!.may, { unverify: true, retract: false, supersede: false });

    const refused = await call("POST /api/memory/org/correct", "p-zed", { verb: "retract", id: orgItemId(whole), reason: "wrong" });
    assert.equal(refused!.status, 403);
    assert.equal((refused!.body as { code: string }).code, "org-correction-not-owner");
    assert.match((refused!.body as { error: string }).error, /owner \(ann\)/);
    assert.equal(((await call("POST /api/memory/org/correct", "p-zed", { verb: "edit", id: orgItemId(whole) }))!.body as { code: string }).code, "org-correction-verb", "there is no edit verb");

    const done = await call("POST /api/memory/org/correct", "p-zed", { verb: "unverify", id: orgItemId(whole), reason: "five days now" });
    assert.equal(done!.status, 200);
    const row = (await items("p-zed"))[0]!;
    assert.deepEqual([row.state, row.correction?.byName, row.may.unverify], ["unverified", "zed", false]);

    const superseded = await call("POST /api/memory/org/correct", "p-admin", { verb: "supersede", id: orgItemId(whole), text: "refunds are approved by finance within five days", evidence: [" "] });
    assert.equal(superseded!.status, 200, "an Admin's word may stand without evidence");
    const after = await items("p-zed");
    assert.deepEqual(after.map(entry => entry.state), ["standing", "superseded"], "newest first, the old item kept as history");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
