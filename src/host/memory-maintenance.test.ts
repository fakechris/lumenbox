/**
 * The memory maintenance pass (INV-781): the model proposes, the code verifies, the code
 * applies — and the code is what these tests hold to account. The model is scripted;
 * every case is about what the verify step lets through and what apply writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryView, versionOf } from "./memory-admin.ts";
import {
  buildMaintenancePrompt,
  describeMaintenanceSource,
  parseMaintenanceProposals,
  recordsOfPlan,
  snapshotForMaintenance,
  verifyMaintenanceProposals,
  type MaintenanceProposal,
} from "./memory-maintenance.ts";
import { dedupe, recall, type MemoryRecord } from "./memory.ts";
import { Rememberer } from "./remember.ts";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY).toISOString();
const fact = (text: string, daysAgo = 1, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({ at: at(daysAgo), kind: "fact", text, ...extra });

function idOf(records: readonly MemoryRecord[], text: string) {
  const candidate = snapshotForMaintenance(records).find(entry => entry.text === text);
  assert.ok(candidate, `snapshot has ${text}`);
  return { id: candidate.id, version: candidate.version };
}

function proposal(records: readonly MemoryRecord[], op: MaintenanceProposal["op"], texts: string[], rest: Partial<MaintenanceProposal> = {}): MaintenanceProposal {
  const refs = texts.map(text => idOf(records, text));
  return { op, ids: refs.map(ref => ref.id), versions: refs.map(ref => ref.version), reason: "test", ...rest };
}

test("duplicates are merged into one wording that keeps every source, and the sources are retracted, not deleted", () => {
  const records = [
    fact("the deployment region is eu-west-1", 30, { from: ["main@2026-08-01T10:00"] }),
    fact("deployment region: eu-west-1 (confirmed)", 20, { from: ["main@2026-08-10T10:00"] }),
    fact("Chris signs off every release", 5),
  ];
  const merge = proposal(records, "merge", ["the deployment region is eu-west-1", "deployment region: eu-west-1 (confirmed)"], { text: "the deployment region is eu-west-1 (confirmed)" });
  const plan = verifyMaintenanceProposals([merge], snapshotForMaintenance(records), records, { now: NOW });
  assert.equal(plan.dropped.length, 0, JSON.stringify(plan.dropped));
  assert.equal(plan.changes.length, 1);
  const written = recordsOfPlan(plan);
  assert.equal(written.length, 3, "two retractions and one replacement");
  assert.deepEqual(written.slice(0, 2).map(record => record.kind), ["retraction", "retraction"]);
  const replacement = written[2]!;
  assert.equal(replacement.kind, "fact");
  assert.deepEqual(replacement.from, ["main@2026-08-01T10:00", "main@2026-08-10T10:00"], "provenance is the union of the sources");

  // The file afterwards: originals still there, the view shows them superseded by the new version.
  const after = [...records, ...written];
  const view = memoryView(after);
  const superseded = view.filter(entry => entry.status === "retracted");
  assert.equal(superseded.length, 2);
  for (const entry of superseded) assert.equal(entry.retractedBy, `superseded by ${versionOf(replacement)} (merged)`);
  const live = dedupe(after).map(record => record.text);
  assert.deepEqual(live.sort(), ["Chris signs off every release", "the deployment region is eu-west-1 (confirmed)"]);
});

test("a merge that adds a name or a number, or drops a source's detail, is refused with the reason", () => {
  const records = [fact("Mia owns the billing service", 10), fact("Mia owns the billing service, confirmed", 9)];
  const snapshot = snapshotForMaintenance(records);
  const sources = ["Mia owns the billing service", "Mia owns the billing service, confirmed"];
  const invented = verifyMaintenanceProposals([proposal(records, "merge", sources, { text: "Mia and Enzo own the billing service" })], snapshot, records, { now: NOW });
  assert.equal(invented.changes.length, 0);
  assert.match(invented.dropped[0]!.why, /adds enzo/);
  const numbered = verifyMaintenanceProposals([proposal(records, "merge", sources, { text: "Mia owns the billing service since 2024" })], snapshot, records, { now: NOW });
  assert.match(numbered.dropped[0]!.why, /adds 2024/);
  const thin = verifyMaintenanceProposals([proposal(records, "merge", sources, { text: "Mia owns it" })], snapshot, records, { now: NOW });
  assert.match(thin.dropped[0]!.why, /drops part of/);
});

test("a dated, expired record is retired: retraction written, view says when it expired, recall no longer returns it", () => {
  const records = [fact("the design review is on 2026-09-10 at 14:00", 30), fact("the deployment region is eu-west-1", 30)];
  const retire = proposal(records, "retire", ["the design review is on 2026-09-10 at 14:00"], { expiredOn: "2026-09-10" });
  const plan = verifyMaintenanceProposals([retire], snapshotForMaintenance(records), records, { now: NOW });
  assert.equal(plan.dropped.length, 0, JSON.stringify(plan.dropped));
  const written = recordsOfPlan(plan);
  assert.equal(written.length, 1);
  assert.equal(written[0]!.kind, "retraction");
  assert.equal(written[0]!.source, "maintenance:expired:2026-09-10");

  const after = [...records, ...written];
  assert.equal(after.length, 3, "the original line is archived in place, never removed");
  const retired = memoryView(after).find(entry => entry.text.startsWith("the design review"));
  assert.equal(retired?.status, "retracted");
  assert.equal(retired?.retractedBy, "retired: expired on 2026-09-10");
  const recalled = recall(after, 4_000, NOW.getTime());
  assert.deepEqual(recalled.records.map(record => record.text), ["the deployment region is eu-west-1"]);
});

test("retire is refused for a date that has not passed and for a line with nothing to expire by", () => {
  const records = [fact("the design review is on 2026-12-10", 1), fact("the user prefers tabs", 400)];
  const snapshot = snapshotForMaintenance(records);
  const future = verifyMaintenanceProposals([proposal(records, "retire", ["the design review is on 2026-12-10"], { expiredOn: "2026-12-10" })], snapshot, records, { now: NOW });
  assert.match(future.dropped[0]!.why, /has not passed/);
  const old = verifyMaintenanceProposals([proposal(records, "retire", ["the user prefers tabs"], { expiredOn: "2026-09-01" })], snapshot, records, { now: NOW });
  assert.match(old.dropped[0]!.why, /neither a date nor a relative time/);
  assert.equal(old.changes.length, 0);
});

test("a version conflict — the line moved after the snapshot — is dropped and says so", () => {
  const records = [fact("work happens on the develop branch", 5), fact("work happens on the develop branch, confirmed", 4)];
  const snapshot = snapshotForMaintenance(records);
  const merge = proposal(records, "merge", ["work happens on the develop branch", "work happens on the develop branch, confirmed"], { text: "work happens on the develop branch" });
  // Between snapshot and apply, somebody re-recorded the first line: it is a new version now.
  const moved = [...records, fact("work happens on the develop branch", 0)];
  const plan = verifyMaintenanceProposals([merge], snapshot, moved, { now: NOW });
  assert.equal(plan.changes.length, 0);
  assert.match(plan.dropped[0]!.why, /version conflict/);
  const wrongVersion = verifyMaintenanceProposals([{ ...merge, versions: ["000000000000", merge.versions[1]!] }], snapshot, records, { now: NOW });
  assert.match(wrongVersion.dropped[0]!.why, /does not match the snapshot/);
  const unknown = verifyMaintenanceProposals([{ ...merge, ids: ["m99", merge.ids[1]!] }], snapshot, records, { now: NOW });
  assert.match(unknown.dropped[0]!.why, /no such id m99/);
});

test("a rewrite may resolve a relative time into a date within reach, and may not introduce any other date", () => {
  const records = [
    fact("the demo is next Tuesday", 10),
    fact("the user prefers tabs", 20),
  ];
  const snapshot = snapshotForMaintenance(records);
  const resolved = verifyMaintenanceProposals([proposal(records, "rewrite", ["the demo is next Tuesday"], { text: "the demo is on 2026-09-22 (Tuesday)" })], snapshot, records, { now: NOW });
  assert.equal(resolved.dropped.length, 0, JSON.stringify(resolved.dropped));
  const written = recordsOfPlan(resolved);
  assert.equal(written[0]!.kind, "retraction");
  assert.equal(written[1]!.text, "the demo is on 2026-09-22 (Tuesday)");
  assert.equal(memoryView([...records, ...written]).find(entry => entry.text === "the demo is next Tuesday")?.retractedBy, `superseded by ${versionOf(written[1]!)} (rewritten)`);

  const invented = verifyMaintenanceProposals([proposal(records, "rewrite", ["the user prefers tabs"], { text: "the user prefers tabs since 2026-01-01" })], snapshot, records, { now: NOW });
  assert.equal(invented.changes.length, 0);
  assert.match(invented.dropped[0]!.why, /adds a date .* no relative time/);
  const farAway = verifyMaintenanceProposals([proposal(records, "rewrite", ["the demo is next Tuesday"], { text: "the demo is on 2027-09-22" })], snapshot, records, { now: NOW });
  assert.match(farAway.dropped[0]!.why, /not within 90 days/);
});

test("the per-pass cap holds and the same line cannot be changed twice in one pass", () => {
  const records = Array.from({ length: 6 }, (_, i) => fact(`meeting ${i} is on 2026-09-0${i + 1}`, 30 - i));
  const snapshot = snapshotForMaintenance(records);
  const retire = (i: number) => proposal(records, "retire", [`meeting ${i} is on 2026-09-0${i + 1}`], { expiredOn: `2026-09-0${i + 1}` });
  const capped = verifyMaintenanceProposals([retire(0), retire(1), retire(2), retire(3)], snapshot, records, { now: NOW, maxChanges: 2 });
  assert.equal(capped.changes.length, 2);
  assert.equal(capped.dropped.length, 2);
  assert.match(capped.dropped[0]!.why, /per-pass cap of 2/);
  const twice = verifyMaintenanceProposals([retire(0), retire(0)], snapshot, records, { now: NOW });
  assert.equal(twice.changes.length, 1);
  assert.match(twice.dropped[0]!.why, /already changed/);
});

test("the reply is read leniently and every unreadable proposal is dropped with a reason", () => {
  const parsed = parseMaintenanceProposals('Here you go:\n[{"op":"retire","ids":"m1","version":"abc","expiredOn":"2026-09-01","reason":"past"},{"op":"delete","ids":["m2"]},{"op":"merge"}]');
  assert.equal(parsed.proposals.length, 1);
  assert.deepEqual(parsed.proposals[0]!.ids, ["m1"]);
  assert.deepEqual(parsed.proposals[0]!.versions, ["abc"]);
  assert.equal(parsed.dropped.length, 2);
  assert.equal(parseMaintenanceProposals("[]").proposals.length, 0);
  assert.equal(parseMaintenanceProposals("I would rather not.").dropped[0]!.why, "reply was not a JSON list");
  assert.equal(describeMaintenanceSource("web:chris"), undefined);
});

test("the snapshot is bounded, most-duplicated first, and the prompt carries id, version, kind, date and text", () => {
  const records = [
    fact("the user prefers tabs", 300),
    fact("the user prefers short answers", 2),
    fact("the user prefers short answers, always", 2),
    fact("the user prefers short answers, confirmed", 1),
  ];
  const snapshot = snapshotForMaintenance(records, 3);
  assert.equal(snapshot.length, 3);
  assert.ok(snapshot.every(entry => entry.text.includes("short answers")), "the duplicate cluster comes first; the lone old fact is past the bound");
  assert.deepEqual(snapshot.map(entry => entry.id), ["m1", "m2", "m3"]);
  const prompt = buildMaintenancePrompt(snapshot, NOW);
  assert.match(prompt, /Today is 2026-09-26/);
  assert.ok(prompt.includes(`"version":"${snapshot[0]!.version}"`));
  assert.match(prompt, /"kind":"fact"/);
  assert.match(prompt, /propose nothing/);
});

// ── through the Rememberer ────────────────────────────────────────────────────────────

function harness(records: MemoryRecord[], reply: (prompt: string) => string) {
  const appended: MemoryRecord[] = [];
  const prompts: string[] = [];
  const logs: string[] = [];
  const registry = {
    contextWriteGuard: () => () => true,
    readMemoryRecords: () => [...records, ...appended],
    appendMemoryRecords: (_id: string, batch: MemoryRecord[]) => {
      appended.push(...batch);
    },
    tryGet: () => undefined,
  } as never;
  const client = {
    messages: {
      create: async (request: { messages: { content: string }[]; max_tokens: number }) => {
        const prompt = request.messages[0]!.content;
        prompts.push(prompt);
        return { content: [{ type: "text", text: reply(prompt) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as never;
  const rememberer = new Rememberer({ registry, client, provider: { label: "stub", model: "stub", maxTokens: 4096 } as never, log: line => logs.push(line) });
  return { rememberer, appended, prompts, logs };
}

const isMaintenance = (prompt: string) => prompt.includes("--- memories ---");

function scriptedMerge(prompt: string): string {
  const lines = prompt.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as { id: string; version: string; text: string });
  const pair = lines.filter(line => line.text.includes("develop"));
  return JSON.stringify([{ op: "merge", ids: pair.map(line => line.id), versions: pair.map(line => line.version), text: "work happens on the develop branch, not main", reason: "same fact twice" }]);
}

test("dry run: the pass proposes, verifies, logs what it would do, and writes nothing", async () => {
  const records = [fact("work happens on the develop branch", 5), fact("work happens on the develop branch, not main", 4)];
  const { rememberer, appended, logs } = harness(records, scriptedMerge);
  const plan = await rememberer.maintain("ada", { dryRun: true, now: NOW });
  assert.equal(plan?.changes.length, 1);
  assert.deepEqual(appended, [], "nothing written");
  assert.ok(logs.some(line => /dry run: would apply 1 change\(s\) \(merge\) as 3 record\(s\); nothing written/.test(line)), logs.join("\n"));
});

test("a real pass writes the retractions and the replacement in one append, and logs what was dropped", async () => {
  const records = [fact("work happens on the develop branch", 5), fact("work happens on the develop branch, not main", 4), fact("the user prefers tabs", 9)];
  const { rememberer, appended, logs } = harness(records, prompt => {
    const good = JSON.parse(scriptedMerge(prompt)) as unknown[];
    return JSON.stringify([...good, { op: "retire", ids: ["m77"], versions: ["nope"], expiredOn: "2026-01-01", reason: "gone" }]);
  });
  await rememberer.maintain("ada", { dryRun: false, now: NOW });
  assert.equal(appended.length, 3);
  assert.deepEqual(appended.map(record => record.kind), ["retraction", "retraction", "fact"]);
  assert.ok(logs.some(line => line === "maintenance dropped retire of m77: no such id m77"), logs.join("\n"));
  assert.ok(logs.some(line => /maintenance applied 1 change\(s\) \(merge\)/.test(line)), logs.join("\n"));
  const view = memoryView([...records, ...appended]);
  assert.equal(view.filter(entry => entry.status === "live").length, 2);
});

test("the pass runs on the condense cadence: after MAINTAIN_EVERY episodes, on the agent's write chain", async () => {
  // EXTRACT_EVERY 3 × EPISODE_EVERY 4 × MAINTAIN_EVERY 2 = 24 exchanges to one pass.
  const records = [fact("work happens on the develop branch", 5), fact("the user prefers tabs", 9)];
  const { rememberer, prompts, appended } = harness(records, prompt => (isMaintenance(prompt) ? "[]" : "NOTHING"));
  for (let i = 0; i < 24; i++) await rememberer.record({ agentId: "ada", text: `exchange ${i}` });
  await rememberer.settle("ada");
  assert.equal(prompts.filter(isMaintenance).length, 1, "one maintenance pass after two episodes");
  assert.equal(appended.length, 0, "an empty proposal list writes nothing");
  for (let i = 0; i < 12; i++) await rememberer.record({ agentId: "ada", text: `more ${i}` });
  await rememberer.settle("ada");
  assert.equal(prompts.filter(isMaintenance).length, 1, "one more episode is below the cadence");
});
