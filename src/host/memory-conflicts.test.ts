/**
 * Knowledge that disagrees across layers (INV-1732, docs/98 §7).
 *
 * What would be wrong: two items that disagree merged, or one of them quietly chosen; a pair shown
 * without its layers, dates and sources, or with the lower layer presented as winning; a pair shown
 * to a reader who may not read one of its sides; a pair that outlives the correction of one side;
 * a maintenance pass that changes an organisation item — a retraction, a merge, or a supersession
 * that takes effect before the item's owner approved it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import type { InstallationMode } from "./installation.ts";
import { versionOf } from "./memory-admin.ts";
import { MemoryConflicts, recordAcrossLayers } from "./memory-conflicts.ts";
import { decide, ORG_REVIEW_QUESTION, pendingPromotions } from "./org-promotion.ts";
import { buildMaintenancePrompt, referenceForMaintenance, snapshotForMaintenance, verifyMaintenanceProposals } from "./memory-maintenance.ts";
import type { MemoryRecord } from "./memory.ts";
import { OrgKnowledge, type OrgKnowledgeItem } from "./org-knowledge.ts";
import { Rememberer } from "./remember.ts";
import { fakeModel } from "./testing/fake-model.ts";
import { runTurn } from "./turn.ts";

const NOW = new Date("2026-11-07T12:00:00.000Z");

const orgItem = (text: string, extra: Partial<OrgKnowledgeItem> = {}): OrgKnowledgeItem => ({
  at: "2026-10-01T00:00:00.000Z", kind: "fact", text, scope: "org", surface: "recall", owner: "p-ann",
  evidence: ["inv:INV-1581"], verifiedBy: "p-admin", verifiedAt: "2026-10-02T00:00:00.000Z", ...extra,
});
const fact = (text: string, at: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({ at, kind: "fact", text, from: ["c1@2026-11-05T09:00:00Z"], ...extra });

function fixture(mode: InstallationMode = "organisation") {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-conflicts-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const state = { mode };
  const org = new OrgKnowledge(join(root, "org-knowledge.jsonl"), { mode: () => state.mode, boxes: () => registry, now: () => NOW });
  const conflictsPath = join(root, "memory-conflicts.jsonl");
  const conflicts = new MemoryConflicts(conflictsPath);
  return { root, registry, org, conflicts, conflictsPath, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** A Rememberer whose cheap model answers maintenance with `reply(prompt)`. */
function rememberer(registry: AgentRegistry, org: OrgKnowledge, conflicts: MemoryConflicts, reply: (prompt: string) => string) {
  const prompts: string[] = [];
  const logs: string[] = [];
  const client = {
    messages: {
      create: async (request: { messages: { content: string }[] }) => {
        const prompt = request.messages[0]!.content;
        prompts.push(prompt);
        return { content: [{ type: "text", text: reply(prompt) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as never;
  const self = new Rememberer({ registry, client, provider: { label: "stub", model: "stub", maxTokens: 4096 } as never, log: line => logs.push(line), orgKnowledge: org, conflicts });
  return { self, prompts, logs };
}

/** The ids the maintenance prompt gave each line, by a word of its text. */
function idsIn(prompt: string): Map<string, string> {
  const ids = new Map<string, string>();
  for (const line of prompt.split("\n").filter(line => line.startsWith("{"))) {
    const parsed = JSON.parse(line) as { id: string; text: string };
    ids.set(parsed.text, parsed.id);
  }
  return ids;
}

test("maintenance names a disagreement across layers; the turn shows it as one dated pair, higher layer first, to a reader of both sides", async () => {
  const { registry, org, conflicts, conflictsPath, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bea = registry.create({ name: "Bea" });
    const releases = org.append(orgItem("the release train leaves on Thursdays"));
    registry.appendMemoryRecords(ada.id, [fact("the release train leaves on Fridays now", "2026-11-05T09:00:00.000Z"), fact("the user likes short answers", "2026-11-04T00:00:00.000Z")]);
    registry.appendSharedMemory(bea.id, [fact("staging is reset every Monday", "2026-11-03T00:00:00.000Z")]);
    registry.appendMemoryRecords(ada.id, [fact("staging is reset every Sunday", "2026-11-06T00:00:00.000Z")]);

    const { self, prompts, logs } = rememberer(registry, org, conflicts, prompt => {
      const ids = idsIn(prompt);
      return JSON.stringify([
        { op: "conflict", ids: [ids.get("the release train leaves on Fridays now"), ids.get("the release train leaves on Thursdays")], reason: "Friday against Thursday" },
        { op: "conflict", ids: [ids.get("staging is reset every Sunday"), ids.get("staging is reset every Monday")], reason: "Sunday against Monday" },
        // Within one layer: corrected there, not recorded as a pair.
        { op: "conflict", ids: [ids.get("the user likes short answers"), ids.get("the release train leaves on Fridays now")], reason: "unrelated" },
      ]);
    });
    const plan = await self.maintain(ada.id, { dryRun: false, now: NOW });
    const prompt = prompts[0]!;
    assert.match(prompt, /--- box and organisation items \(read only\) ---/);
    assert.match(prompt, /"layer":"organisation"[^\n]*Thursdays/);
    assert.match(prompt, /"layer":"box"[^\n]*Monday/);
    assert.equal(plan?.conflicts.length, 2);
    assert.equal(plan?.changes.length, 0, "a disagreement is never settled by merging or retiring");
    assert.ok(plan?.dropped.some(({ why }) => /within one layer/.test(why)), JSON.stringify(plan?.dropped));
    assert.ok(logs.some(line => /recorded 2 disagreement\(s\) across layers/.test(line)), logs.join("\n"));
    assert.equal(new MemoryConflicts(conflictsPath).pairs().length, 2, "the pairs are on disk, replayed at start");
    assert.equal(org.lines().length, 1, "the organisation's ledger is untouched");
    assert.equal(registry.readMemoryRecords(ada.id).length, 3, "and so is the agent's own memory");

    // The pair in the prompt: layers, dates, sources, and which one outranks.
    const systems: string[] = [];
    const client = fakeModel(({ params }) => {
      systems.push((params.system as Anthropic.TextBlockParam[]).map(block => block.text).join("\n"));
      return { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    });
    const bus = new AgentBus(registry, async () => {});
    const turn = (agent: typeof ada) => runTurn(agent, [{ id: `m-${agent.id}`, fromId: "user", fromName: "user", text: "when does the release train leave?", priority: false, receivedAt: "" }], new AbortController().signal, { client, registry, bus, box: undefined, resolution: undefined, orgKnowledge: org, conflicts });
    await turn(ada);
    const section = systems[0]!.slice(systems[0]!.indexOf("## These disagree"));
    assert.match(section, /^## These disagree\n\n[^\n]*Neither has been merged or chosen for you[^\n]*organisation item outranks your box's memory, and your box's outranks your own/);
    assert.match(section, new RegExp(`- Organisation \\(L1\\), verified 2026-10-02 by p-admin, owner p-ann \\[org:${versionOf(releases)}\\]; evidence inv:INV-1581: "the release train leaves on Thursdays"\\n  disagrees with Your own memory \\(L3\\), 2026-11-05; from c1@2026-11-05T09:00:00Z: "the release train leaves on Fridays now"\\n  Outranks: Organisation \\(L1\\)\\. Noticed 2026-11-07: Friday against Thursday\\.`));
    assert.match(section, /- Your box \(L2\), 2026-11-03, learned by [^;]+; from c1@[^:]+:\d\d:\d\dZ: "staging is reset every Monday"\n  disagrees with Your own memory \(L3\), 2026-11-06[^\n]*Sunday"\n  Outranks: Your box \(L2\)/);

    // Bea reads both box and organisation items, but not Ada's own memory: no pair is hers to see.
    await turn(bea);
    assert.doesNotMatch(systems[1]!, /These disagree/);

    // Correcting one side ends the pair: Ada forgets her line, and the pair is no longer shown.
    registry.appendMemoryRecords(ada.id, [{ at: "2026-11-07T13:00:00.000Z", kind: "retraction", text: "the release train leaves on Fridays now" }]);
    await turn(ada);
    assert.doesNotMatch(systems[2]!, /release train leaves on Fridays now"\n  /);
    assert.match(systems[2]!, /These disagree[\s\S]*staging is reset every Monday/, "the other pair still stands");
  } finally {
    cleanup();
  }
});

test("maintenance may propose replacing an organisation item, held for its owner; it never changes the item itself", async () => {
  const { registry, org, conflicts, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const releases = org.append(orgItem("the release train leaves on Thursdays"));
    registry.appendMemoryRecords(ada.id, [fact("the release train leaves on Fridays now", "2026-11-05T09:00:00.000Z"), fact("the user likes short answers", "2026-11-04T00:00:00.000Z")]);
    const { self } = rememberer(registry, org, conflicts, prompt => {
      const ids = idsIn(prompt);
      const mine = ids.get("the release train leaves on Fridays now")!;
      const theirs = ids.get("the release train leaves on Thursdays")!;
      return JSON.stringify([
        { op: "supersede", ids: [mine], of: theirs, reason: "moved to Fridays in November" },
        // Every way of changing the item directly is refused.
        { op: "retire", ids: [theirs], versions: [versionOf(releases)], expiredOn: "2026-11-01", reason: "old" },
        { op: "merge", ids: [mine, theirs], versions: ["x", "y"], text: "the release train leaves on Fridays now", reason: "same" },
        { op: "rewrite", ids: [theirs], versions: [versionOf(releases)], text: "the release train leaves on Fridays", reason: "fix" },
      ]);
    });
    const plan = await self.maintain(ada.id, { dryRun: false, now: NOW });
    assert.equal(plan?.supersessions.length, 1);
    assert.equal(plan?.changes.length, 0);
    assert.equal(plan?.dropped.filter(({ why }) => /an organisation item, which maintenance never changes/.test(why)).length, 3, JSON.stringify(plan?.dropped));

    const proposed = org.lines()[1]!;
    assert.equal(org.lines().length, 2, "one line added, and it is a proposal");
    assert.deepEqual(proposed.held, { question: ORG_REVIEW_QUESTION, confidence: 1 }, "it waits in the organisation review every promotion waits in");
    assert.deepEqual(pendingPromotions(org.lines()).map(pending => pending.item.text), ["the release train leaves on Fridays now"]);
    assert.equal(proposed.via, ada.id);
    assert.equal(proposed.supersedes, versionOf(releases));
    assert.equal(proposed.owner, "p-ann", "it goes to the replaced item's owner");
    assert.equal(proposed.verifiedBy, undefined, "nobody stands behind it yet");
    assert.ok(!org.lines().some(line => line.kind === "retraction"));
    assert.deepEqual(org.recalledFor(ada.id, undefined).map(line => line.text), ["the release train leaves on Thursdays"], "the organisation item stands until its owner approves the replacement");

    const pair = conflicts.pairs()[0]!;
    assert.equal(pair.proposal, versionOf(proposed));
    const section = conflicts.section({ agentId: ada.id, agent: registry.readMemoryRecords(ada.id), box: [], org: org.recalledFor(ada.id, undefined) })!;
    assert.match(section, /A replacement from your memory is waiting for p-ann's review; until it is approved the organisation item stands\./);

    // The owner approves it through the organisation review (INV-1729): only then is the old item replaced.
    assert.equal(decide(org, versionOf(proposed), "approved", "p-ann", id => registry.boxById(id), { now: new Date("2026-11-08T00:00:00.000Z") }).ok, true);
    assert.deepEqual(org.recalledFor(ada.id, undefined).map(line => line.text), ["the release train leaves on Fridays now"]);
  } finally {
    cleanup();
  }
});

test("a supersession is refused for a line older than the item's verification, and on a personal installation the pair is still kept", () => {
  const { registry, org, conflicts, state, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const releases = org.append(orgItem("the release train leaves on Thursdays"));
    const own = [fact("the release train leaves on Fridays", "2026-09-01T00:00:00.000Z"), fact("the release train leaves on Fridays now", "2026-11-05T00:00:00.000Z")];
    const candidates = snapshotForMaintenance(own);
    const reference = referenceForMaintenance(candidates, { org: org.recalledFor(ada.id, undefined) });
    assert.deepEqual(reference.map(entry => entry.id), ["o1"]);
    assert.match(buildMaintenancePrompt(candidates, NOW, reference), /"op":"supersede"/);
    assert.doesNotMatch(buildMaintenancePrompt(candidates, NOW), /"op":"supersede"|read only/, "without other layers the prompt is as it was");
    const id = (text: string) => candidates.find(candidate => candidate.text === text)!.id;
    const plan = verifyMaintenanceProposals([
      { op: "supersede", ids: [id("the release train leaves on Fridays")], versions: [], of: "o1", reason: "older" },
      { op: "supersede", ids: [id("the release train leaves on Fridays now")], versions: [], of: "o1", reason: "newer" },
    ], candidates, own, { now: NOW, reference, holder: ada.id });
    assert.equal(plan.supersessions.length, 1);
    assert.match(plan.dropped[0]!.why, /not newer than o1/);

    // A personal installation has no L1 to propose into: the ledger refuses, the pair is still recorded.
    state.mode = "single-machine";
    const logs: string[] = [];
    const written = recordAcrossLayers(plan, { agentId: ada.id, conflicts, orgKnowledge: org, now: NOW, log: line => logs.push(line) });
    assert.deepEqual(written, { pairs: 1, proposals: 0 });
    assert.match(logs[0]!, /could not propose replacing org:[0-9a-f]{12}: A personal installation has no organisation knowledge/);
    assert.equal(conflicts.pairs()[0]!.proposal, undefined);
    assert.deepEqual(org.lines(), [releases], "nothing was written into L1");
  } finally {
    cleanup();
  }
});

test("the pairs keep their budget: the newest whole, the rest counted", () => {
  const conflicts = new MemoryConflicts(undefined);
  const agent: MemoryRecord[] = [];
  const box: MemoryRecord[] = [];
  for (let n = 0; n < 6; n++) {
    const mine = fact(`deploy window ${n} is in the morning ${"x".repeat(150)}`, `2026-11-0${n + 1}T00:00:00.000Z`);
    const theirs = fact(`deploy window ${n} is in the evening ${"y".repeat(150)}`, `2026-10-0${n + 1}T00:00:00.000Z`);
    agent.push(mine);
    box.push(theirs);
    conflicts.record({ at: `2026-11-0${n + 1}T00:00:00.000Z`, sides: [{ layer: "agent", version: versionOf(mine), holder: "ada" }, { layer: "box", version: versionOf(theirs) }], by: "ada", reason: "" });
  }
  const section = conflicts.section({ agentId: "ada", agent, box, org: [] }, 900)!;
  assert.match(section, /deploy window 5 is in the evening/, "newest first");
  assert.match(section, /\d more disagreeing pairs are not shown\./);
  assert.ok(section.length < 900 + 600, "bounded by its budget");
  assert.equal(conflicts.record({ at: "2026-11-09T00:00:00.000Z", sides: [{ layer: "box", version: versionOf(box[0]!) }, { layer: "agent", version: versionOf(agent[0]!), holder: "ada" }], by: "bea", reason: "again" }).by, "ada", "a pair already recorded, in either order, is not recorded twice");
  assert.throws(() => conflicts.record({ at: "2026-11-09T00:00:00.000Z", sides: [{ layer: "agent", version: "a", holder: "ada" }, { layer: "agent", version: "b", holder: "ada" }], by: "ada", reason: "" }), /across layers/);
});
