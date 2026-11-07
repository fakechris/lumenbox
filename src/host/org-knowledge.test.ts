/**
 * The organisation knowledge ledger (INV-1726, docs/98 §3, §6, §8 and §10 decision 1).
 *
 * What would be wrong: a restart that forgets an item or chokes on a torn line; a pinned budget
 * that grows with the ledger, or keeps the wrong items when it overflows; an item of a box the
 * reader cannot enter, a held promotion or a stale one reaching recall; a personal installation
 * that writes L1; a guest turn with a path to it; an answer with no id to cite.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import type { InstallationMode } from "./installation.ts";
import { versionOf } from "./memory-admin.ts";
import { OrgKnowledge, orgItemId, PersonalInstallationNeverWrites, PINNED_CHAR_BUDGET, type OrgKnowledgeItem } from "./org-knowledge.ts";
import { fakeModel } from "./testing/fake-model.ts";
import { dispatchTool } from "./tools.ts";
import { runTurn } from "./turn.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

function fixture(mode: InstallationMode = "organisation") {
  const root = mkdtempSync(join(tmpdir(), "agentbox-org-knowledge-"));
  const registry = new AgentRegistry(join(root, "agents"));
  registry.attachBox({ id: "box-sales", name: "sales", kind: "attached", displayFloor: 10, workDir: "/home/box/work", members: ["p-ann"], createdAt: NOW.toISOString() } as never);
  const path = join(root, "org-knowledge.jsonl");
  const state = { mode };
  const open = () => new OrgKnowledge(path, { mode: () => state.mode, boxes: () => registry, now: () => NOW });
  return { registry, path, state, open, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const item = (text: string, extra: Partial<OrgKnowledgeItem> = {}): OrgKnowledgeItem => ({
  at: "2026-11-01T00:00:00.000Z", kind: "fact", text, scope: "org", surface: "recall", owner: "p-ann",
  evidence: ["doc:docs/98"], verifiedBy: "p-admin", verifiedAt: "2026-11-02T00:00:00.000Z", ...extra,
});

test("the ledger is append-only and replayed at start; a torn last line is skipped and the next append stays whole", () => {
  const { path, open, cleanup } = fixture();
  try {
    const ledger = open();
    ledger.append(item("expenses over 5,000 need two approvals", { pinned: true }));
    ledger.append(item("the release train leaves on Thursdays"));
    appendFileSync(path, '{"at":"2026-11-03T00:00:00.000Z","kind":"fact","te'); // a crash mid-append
    const replayed = open();
    assert.deepEqual(replayed.lines().map(line => line.text), ["expenses over 5,000 need two approvals", "the release train leaves on Thursdays"]);
    assert.equal(replayed.lines()[0]!.pinned, true, "every field survives the replay");
    replayed.append(item("customer data stays in the EU region"));
    assert.equal(open().lines().length, 3, "the torn tail was closed before the next line");
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 4, "nothing was rewritten: the torn line is still in the history");

    // Correction appends: a supersession and a retraction leave the old lines in the file and out of what stands.
    const old = replayed.lines()[1]!;
    replayed.append(item("the release train leaves on Wednesdays", { supersedes: versionOf(old), at: "2026-11-05T00:00:00.000Z" }));
    replayed.append(item("customer data stays in the EU region", { kind: "retraction", at: "2026-11-06T00:00:00.000Z" }));
    assert.deepEqual(open().live().map(line => line.text).sort(), ["expenses over 5,000 need two approvals", "the release train leaves on Wednesdays"]);

    assert.throws(() => replayed.append(item("an agent's own note", { scope: "agent" })), /scope/);
    assert.throws(() => replayed.append(item("nobody owns this", { owner: undefined })), /owner/);
    assert.throws(() => replayed.append(item("rests on a rumour", { evidence: ["rumour"] })), /evidence reference/);
  } finally {
    cleanup();
  }
});

test("pinned items take a fixed budget; overflow keeps the latest review date, then the latest verification, and says how many more", () => {
  const { registry, open, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const ledger = open();
    for (let n = 0; n < 40; n++) {
      ledger.append(item(`how we work rule number ${n} — say it the same way to every customer, every time`, { pinned: true, at: `2026-11-01T00:00:${String(n).padStart(2, "0")}.000Z`, reviewBy: `2027-0${1 + (n % 9)}-01T00:00:00.000Z` }));
    }
    ledger.append(item("the newest rule, reviewed furthest out", { pinned: true, reviewBy: "2028-01-01T00:00:00.000Z" }));
    ledger.append(item("a rule with no review date", { pinned: true }));
    const section = ledger.section(ada.id, undefined, "")!;
    const pinnedLines = section.split("\n").filter(line => line.startsWith("- [org:"));
    assert.ok(pinnedLines.join("\n").length <= PINNED_CHAR_BUDGET, "the pinned lines never exceed their budget, however long the ledger");
    assert.match(pinnedLines[0]!, /reviewed furthest out/, "the latest review date keeps its place first");
    assert.ok(!section.includes("no review date"), "an item with no review date is the first to give way");
    const more = Number(/(\d+) more pinned items are not shown/.exec(section)?.[1]);
    assert.equal(more + pinnedLines.length, 42, "what was left out is counted, not lost");
    assert.match(section, /cite its id/, "the section asks that an answer cite the item");
    assert.match(pinnedLines[0]!, /^- \[org:[0-9a-f]{12}\] .* — owner p-ann, verified 2026-11-02, review by 2028-01-01$/);
  } finally {
    cleanup();
  }
});

test("only admitted, recall-surfaced, verified and current items are recalled; the rest are read by id with their state", async () => {
  const { registry, open, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" }); // in the installation's own box
    const ledger = open();
    ledger.append(item("refunds are approved by finance within two days"));
    ledger.append(item("the sales refund playbook is in the shared drive", { scope: "box:box-sales" }));
    ledger.append(item("refunds pending a promotion review", { held: { question: "waiting for review", confidence: 1 } }));
    const citeOnly = ledger.append(item("the refunds audit trail is under receipt r9", { surface: "cite-only" }));
    const stale = ledger.append(item("refunds over 1,000 need the CFO", { reviewBy: "2026-11-01T00:00:00.000Z" }));
    ledger.append(item("refunds are unverified hearsay", { verifiedBy: undefined, verifiedAt: undefined }));
    ledger.append(item("refunds of an unknown scope", { scope: "box:box-gone" }));

    assert.deepEqual(ledger.recalledFor(ada.id, undefined).map(line => line.text), ["refunds are approved by finance within two days"], "another box's item, a held one, cite-only, stale and unverified are not recalled");
    const section = ledger.section(ada.id, undefined, "who approves refunds?")!;
    assert.match(section, /Related to this conversation:\n- \[org:[0-9a-f]{12}\] refunds are approved by finance/);
    assert.doesNotMatch(section, /playbook|pending|audit trail|CFO|hearsay|unknown scope/);

    const cited = ledger.forRecall(ada.id, undefined, orgItemId(stale)).cited!;
    assert.match(cited, /CFO.*not recalled on its own/, "a stale item stays readable by id, and says why it is not recalled");
    assert.match(ledger.forRecall(ada.id, undefined, orgItemId(citeOnly)).cited!, /audit trail[^\n]*\nEvidence: doc:docs\/98/);
    const sales = ledger.lines().find(line => line.scope === "box:box-sales")!;
    assert.match(ledger.forRecall(ada.id, undefined, orgItemId(sales)).cited!, /No organisation item/, "an id is no way around admission");

    // The same reach through the turn and the tool: the prompt section and Recall.
    const bus = new AgentBus(registry, async () => {});
    const recall = await dispatchTool("Recall", { search: "refunds" }, { agent: ada, registry, bus, box: undefined as never, orgKnowledge: ledger });
    assert.match(recall.text, /\[organisation org:[0-9a-f]{12}\] \(2026-11-01\) refunds are approved by finance/);
    assert.doesNotMatch(recall.text, /playbook|pending|CFO|hearsay/);
    const systems: string[] = [];
    const client = fakeModel(({ params }) => {
      systems.push((params.system as Anthropic.TextBlockParam[]).map(block => block.text).join("\n"));
      return { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    });
    await runTurn(ada, [{ id: "m1", fromId: "user", fromName: "user", text: "who approves refunds?", priority: false, receivedAt: "" }], new AbortController().signal, { client, registry, bus, box: undefined, resolution: undefined, orgKnowledge: ledger });
    assert.match(systems[0]!, /## How we work: the organisation's knowledge[\s\S]*refunds are approved by finance/, "a member turn reads it");
    assert.doesNotMatch(systems[0]!, /CFO|playbook/);
  } finally {
    cleanup();
  }
});

test("a box item is read only by that box's agents for a person who may enter it", () => {
  const { registry, open, cleanup } = fixture();
  try {
    const sam = registry.create({ name: "Sam", boxId: "box-sales" });
    const ada = registry.create({ name: "Ada" });
    const ledger = open();
    ledger.append(item("the sales refund playbook is in the shared drive", { scope: "box:box-sales" }));
    assert.equal(ledger.recalledFor(sam.id, "p-ann").length, 1, "a member of the box, in the box");
    assert.equal(ledger.recalledFor(sam.id, "p-zed").length, 0, "a person not on the box's members reads nothing of it");
    assert.equal(ledger.recalledFor(ada.id, "p-ann").length, 0, "an agent of another box reads nothing of it, whoever drives");
  } finally {
    cleanup();
  }
});

test("a personal installation never writes the organisation's knowledge, and has none to read", () => {
  const { registry, path, state, open, cleanup } = fixture("organisation");
  try {
    const ada = registry.create({ name: "Ada" });
    open().append(item("expenses over 5,000 need two approvals", { pinned: true }));
    state.mode = "single-machine";
    const ledger = open();
    assert.throws(() => ledger.append(item("the Owner's note")), PersonalInstallationNeverWrites);
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 1, "nothing reached the file");
    assert.deepEqual(ledger.admittedFor(ada.id, undefined), []);
    assert.equal(ledger.section(ada.id, undefined, "expenses"), undefined, "no section on a personal installation");
  } finally {
    cleanup();
  }
});

test("a guest turn has no path to the ledger: nothing it imports, however indirectly, reaches org-knowledge.ts", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/^import (?!type )[^;]*? from "(\.{1,2}\/[^"]+)";/gm)) visit(resolve(dirname(file), match[1]!));
  };
  visit(join(here, "guest-turn.ts"));
  assert.ok(seen.size > 1, "the walk followed the guest turn's imports");
  for (const reachable of ["org-knowledge.ts", "turn.ts", "orchestrator.ts", "tools.ts"]) {
    assert.ok(![...seen].some(file => file === join(here, reachable)), `a guest turn reaches ${reachable}`);
  }
});
