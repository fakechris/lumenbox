/**
 * When the organisation's knowledge goes stale (INV-1731, docs/98 §7, §10 decision 3).
 *
 * What would be wrong: a passed review date that nobody is told about; a reopened or dropped
 * task, a superseded or canceled Involute item or a superseded document that leaves the item
 * resting on it looking current; a stale item in the prompt unmarked or ahead of a current one;
 * an Involute read that goes to the network in a test or happens inside a turn; an agent that
 * is handed a way to search Involute.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { OrgKnowledge, orgItemId, type OrgKnowledgeItem } from "./org-knowledge.ts";
import { docsDirReader, EvidenceWatch, involuteStateReader, ownerAttention, taskChange } from "./org-knowledge-staleness.ts";
import type { Task } from "./tasks.ts";
import { buildTools } from "./tools.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

const item = (text: string, extra: Partial<OrgKnowledgeItem> = {}): OrgKnowledgeItem => ({
  at: "2026-11-01T00:00:00.000Z", kind: "fact", text, scope: "org", surface: "recall", owner: "p-ann",
  evidence: [], verifiedBy: "p-admin", verifiedAt: "2026-11-02T00:00:00.000Z", ...extra,
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-org-staleness-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const ledger = new OrgKnowledge(join(root, "org-knowledge.jsonl"), { mode: () => "organisation", boxes: () => registry, now: () => NOW });
  return { root, registry, ledger, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type History = Pick<Task, "status" | "history">;
const task = (status: Task["status"], moves: [string, Task["status"]][]): History => ({ status, history: moves.map(([at, to]) => ({ at, by: "web", status: to })) });

test("a passed review date puts the item on its owner's needs-you list, marked review due, and after every current item", () => {
  const { registry, ledger, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const due = ledger.append(item("expenses over 5,000 need two approvals", { pinned: true, reviewBy: "2026-11-05T00:00:00.000Z" }));
    ledger.append(item("customer data stays in the EU region", { pinned: true, reviewBy: "2027-01-01T00:00:00.000Z" }));
    ledger.append(item("nobody stands behind this yet", { pinned: true, verifiedBy: undefined, verifiedAt: undefined, reviewBy: "2026-11-05T00:00:00.000Z" }));

    const lines = ledger.section(ada.id, undefined, "")!.split("\n").filter(line => line.startsWith("- [org:"));
    assert.equal(lines.length, 2, "an unverified item is not shown, stale or not");
    assert.match(lines[0]!, /EU region/, "the current item goes first, though the stale one would otherwise sort ahead of it");
    assert.match(lines[1]!, /two approvals — owner p-ann, verified 2026-11-02 — REVIEW DUE since 2026-11-05: its owner has not re-verified it; check before relying on it$/);
    assert.deepEqual(ledger.recalledFor(ada.id, undefined).map(entry => entry.text), ["customer data stays in the EU region"], "a stale item leaves the Recall tool's search");

    const stale = ledger.staleItems();
    assert.deepEqual(stale.map(entry => entry.id), [orgItemId(due)], "only the verified item is anybody's to re-verify");
    const ann = ownerAttention(stale, owner => owner === "p-ann");
    assert.equal(ann.length, 1);
    assert.equal(ann[0]!.kind, "org-knowledge");
    assert.match(ann[0]!.title, /due for review/);
    assert.match(ann[0]!.detail, /two approvals.*re-verify it, supersede it or retract it/);
    assert.deepEqual(ownerAttention(stale, owner => owner === "p-bob"), [], "it is on the owner's list, not everybody's");
  } finally {
    cleanup();
  }
});

test("a task cited as evidence makes the item stale when it is reopened or dropped after the item was verified, and not otherwise", () => {
  const verified = "2026-11-02T00:00:00.000Z";
  assert.equal(taskChange(task("doing", [["2026-10-30T00:00:00.000Z", "done"], ["2026-11-03T00:00:00.000Z", "doing"]]), verified), "reopened");
  assert.equal(taskChange(task("dropped", [["2026-11-03T00:00:00.000Z", "dropped"]]), verified), "dropped");
  assert.equal(taskChange(task("dropped", [["2026-10-30T00:00:00.000Z", "dropped"]]), verified), undefined, "dropped before the item was verified: re-verifying clears it");
  assert.equal(taskChange(task("done", [["2026-10-30T00:00:00.000Z", "done"], ["2026-11-03T00:00:00.000Z", "doing"], ["2026-11-04T00:00:00.000Z", "done"]]), verified), undefined, "closed again: the evidence stands");
  assert.equal(taskChange(task("doing", [["2026-10-20T00:00:00.000Z", "done"], ["2026-10-25T00:00:00.000Z", "doing"]]), verified), undefined, "reopened before the item was verified: the person saw it that way");
  assert.equal(taskChange(task("doing", [["2026-10-20T00:00:00.000Z", "open"], ["2026-11-03T00:00:00.000Z", "doing"]]), verified), undefined, "never done is no change");
});

test("three kinds of evidence change mark the item stale, read through stand-ins: a task, an Involute item by id, a document", async () => {
  const { root, registry, ledger, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const docs = join(root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "41-old-policy.md"), "<!-- doc: 41-old-policy\n     family: decision\n     status: superseded\n     superseded-by: 77-new-policy\n     why: replaced\n-->\n# Old\n");
    writeFileSync(join(docs, "77-new-policy.md"), "<!-- doc: 77-new-policy\n     family: decision\n     status: current\n-->\n# New\n");

    const tasks = new Map<string, History>([["t12", task("doing", [["2026-10-30T00:00:00.000Z", "done"], ["2026-11-04T00:00:00.000Z", "doing"]])]]);
    const calls: string[] = [];
    const involute: Record<string, Record<string, unknown>> = {
      "INV-10": { teamId: "team", stateId: "s-done", supersededById: null },
      "INV-11": { teamId: "team", stateId: "s-canceled", supersededById: null },
      "INV-12": { teamId: "team", stateId: "s-done", supersededById: "uuid-of-inv-13" },
    };
    const fakeCall = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      calls.push(`${tool} ${String(args.id ?? args.team_id)}`);
      if (tool === "work_catalog") return { nodes: [{ id: "s-done", type: "COMPLETED" }, { id: "s-canceled", type: "CANCELED" }] };
      if (tool === "work_get_context") return { work: involute[String(args.id)] };
      throw new Error(`no ${tool}`);
    };
    const watch = new EvidenceWatch({ task: id => tasks.get(id), doc: docsDirReader(docs), inv: involuteStateReader(fakeCall) });
    ledger.evidence = watch;

    const current = ledger.append(item("the pricing page is the source of truth", { evidence: ["task:t99", "inv:INV-10", "doc:docs/77"] }));
    const byTask = ledger.append(item("the onboarding checklist is final", { evidence: ["task:t12"] }));
    const canceled = ledger.append(item("we ship the partner API in Q4", { evidence: ["inv:INV-11"] }));
    const superseded = ledger.append(item("refunds follow the 2026 policy", { evidence: ["inv:INV-12"] }));
    const byDoc = ledger.append(item("travel is booked through the old portal", { evidence: ["doc:docs/41"] }));

    assert.deepEqual(ledger.staleItems().map(entry => entry.id).sort(), [orgItemId(byTask), orgItemId(byDoc)].sort(), "before the sweep, no Involute state is known: an inv: reference alone makes nothing stale");
    assert.equal(calls.length, 0, "nothing read Involute outside the sweep — not appending, not rendering");
    ledger.section(ada.id, undefined, "pricing onboarding partner refunds travel");
    assert.equal(calls.length, 0, "a turn's read never goes to Involute");

    await watch.sweep(ledger.live());
    assert.deepEqual(calls.filter(call => call.startsWith("work_catalog")), ["work_catalog team"], "the team's states are read once");

    const stale = new Map(ledger.staleItems().map(entry => [entry.id, entry.staleness]));
    assert.equal(stale.has(orgItemId(current)), false);
    assert.deepEqual(stale.get(orgItemId(byTask)), { kind: "evidence", ref: "task:t12", change: "reopened" });
    assert.deepEqual(stale.get(orgItemId(canceled)), { kind: "evidence", ref: "inv:INV-11", change: "canceled" });
    assert.deepEqual(stale.get(orgItemId(superseded)), { kind: "evidence", ref: "inv:INV-12", change: "superseded", detail: "by uuid-of-inv-13" });
    assert.deepEqual(stale.get(orgItemId(byDoc)), { kind: "evidence", ref: "doc:docs/41", change: "superseded", detail: "by 77-new-policy" });

    const attention = ownerAttention(ledger.staleItems(), owner => owner === "p-ann");
    assert.equal(attention.length, 4, "the owner is told about each");
    const canceledRow = attention.find(entry => /stale: inv:INV-11 was canceled/.test(entry.title))!;
    assert.match(canceledRow.detail, /supersede it with an item that cites current evidence, or retract it/, "re-verifying would not clear a canceled item, so the owner is not told to");

    const cited = ledger.forRecall(ada.id, undefined, orgItemId(canceled)).cited!;
    assert.match(cited, /partner API .*STALE: inv:INV-11 was canceled; check before relying on it \(not recalled on its own: stale\)/);

    // A sweep that fails keeps what the last one knew, and the task closing again un-stales its item.
    const failing = involuteStateReader(async () => { throw new Error("offline"); });
    const rewatch = new EvidenceWatch({ task: id => tasks.get(id), inv: failing });
    assert.deepEqual(await rewatch.sweep(ledger.live()), { read: 0, failed: 3 });
    await watch.sweep(ledger.live());
    tasks.set("t12", task("done", [["2026-10-30T00:00:00.000Z", "done"], ["2026-11-04T00:00:00.000Z", "doing"], ["2026-11-05T00:00:00.000Z", "done"]]));
    assert.equal(ledger.staleItems().some(entry => entry.id === orgItemId(byTask)), false, "nothing was written: staleness is a reading of the evidence now");
  } finally {
    cleanup();
  }
});

test("no agent is handed a way to search Involute: the host reads cited items itself", () => {
  const names = buildTools(true, true, undefined, true, true, true, true, false, ["github"]).map(tool => tool.name);
  assert.ok(names.length > 10, "the full tool list was built");
  assert.deepEqual(names.filter(name => /involute|^work_|inv_search/i.test(name)), []);
});
