/**
 * The memory-selection invariants over the fixture set (INV-147, Astra's A1–A5), on the
 * deterministic layers: authorization (the registry's box filter), retraction, the scored
 * recall with its near-duplicate collapse, the selector's candidate list, the prompt body
 * and the index. The selector itself is scripted and faithful — it picks what the
 * fixture says is required when it is offered — so a failure here is the machinery's.
 *
 * A comparison report is printed at the end: the same fixtures through recall with the
 * collapse off (the old algorithm) and on, same budgets, so an improvement is a number.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox } from "../box/boxes.ts";
import { MEMORY_FIXTURES, type MemoryFixture } from "./memory-fixtures.ts";
import { chooseRelevant, dedupe, nearDuplicate, recall, renderMemory, renderMemoryIndex, type MemoryRecord } from "./memory.ts";

const NOW = Date.parse("2026-09-13T00:00:00.000Z");

/** Picks, from the numbered candidate list it is shown, whatever the fixture requires. */
function faithfulSelector(fixture: MemoryFixture, shown: string[][]) {
  return async (prompt: string): Promise<string> => {
    const lines = prompt.split("\n");
    const candidates = lines.filter(line => /^\d+\. /.test(line.trim())).map(line => line.trim().replace(/^\d+\. /, ""));
    shown.push(candidates);
    const picks = lines
      .map(line => line.trim())
      .filter(line => fixture.required.some(text => line.endsWith(text) || line.includes(text)))
      .map(line => /^(\d+)\./.exec(line)?.[1])
      .filter((n): n is string => n !== undefined);
    return `{"selected": [${picks.join(",")}]}`;
  };
}

function everywhere(records: readonly MemoryRecord[], recalled: ReturnType<typeof recall>, shown: string[][]): string {
  return [
    renderMemory(recalled),
    ...renderMemoryIndex(recalled.omittedRecords ?? []),
    ...shown.flat(),
    ...dedupe(records).map(record => record.text),
  ].join("\n");
}

for (const fixture of MEMORY_FIXTURES.filter(f => f.shape !== "wrong-box")) {
  test(`${fixture.shape}: ${fixture.id}`, async () => {
    const shown: string[][] = [];
    const recalled = await chooseRelevant({ records: fixture.records, query: fixture.query, budget: fixture.budget, now: NOW, ask: faithfulSelector(fixture, shown) });
    const body = renderMemory(recalled);
    for (const text of fixture.required) {
      assert.ok(recalled.records.some(record => record.text === text), `required in body: ${text}\nbody:\n${body}`);
    }
    const all = everywhere(fixture.records, recalled, shown);
    for (const text of fixture.forbidden) {
      assert.ok(!all.includes(text), `forbidden anywhere: ${text}`);
    }
    if (fixture.shape === "conflict" && fixture.forbidden.length === 0) {
      // Both sides, dated, so the reader can weigh them; nothing merged them into one.
      const days = fixture.required.map(text => recalled.records.find(record => record.text === text)!.at.slice(0, 10));
      assert.equal(new Set(days).size, 2, "the two sides carry their own dates");
      assert.match(body, new RegExp(`\\(${days[0]}\\)`));
    }
    if (fixture.shape === "synonym") {
      const phrasings = fixture.records.filter(record => !fixture.required.includes(record.text));
      const kept = recalled.records.filter(record => phrasings.some(p => p.text === record.text));
      assert.ok(kept.length <= 1, `one phrasing of the repeated fact is enough; kept ${kept.length}`);
      assert.ok(shown.length === 0 || shown[0]!.filter(c => phrasings.some(p => c.includes(p.text))).length <= 1, "and the selector was shown one, not all");
    }
  });
}

test("wrong-box: a shared record from another box is never seen — not in body, index, candidates or the Recall tool's view", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-box-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const tokenFile = join(root, "tok");
    writeFileSync(tokenFile, "tok\n");
    const finance = registry.attachBox(attachedBox({ name: "finance", baseUrl: "http://127.0.0.1:13370/", tokenFile }));
    const ours = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    const theirs = registry.create({ name: "Lee", boxId: finance.id }).id;
    for (const fixture of MEMORY_FIXTURES.filter(f => f.shape === "wrong-box")) {
      const other = new Set(fixture.otherBox ?? []);
      registry.appendSharedMemory(theirs, fixture.records.filter(record => other.has(record.text)));
      registry.appendSharedMemory(ours, fixture.records.filter(record => !other.has(record.text)));
      const visible = registry.readSharedMemory(ours);
      const recalled = recall(visible, fixture.budget, NOW);
      const all = [renderMemory(recalled), ...renderMemoryIndex(recalled.omittedRecords ?? []), ...dedupe(visible).map(r => r.text)].join("\n");
      for (const text of fixture.forbidden) assert.ok(!all.includes(text), `${fixture.id}: forbidden seen: ${text}`);
      for (const text of fixture.required) assert.ok(recalled.records.some(r => r.text === text), `${fixture.id}: required missing: ${text}`);
      // The other box sees its own, and not ours.
      const theirView = registry.readSharedMemory(theirs);
      for (const text of fixture.otherBox ?? []) assert.ok(theirView.some(r => r.text === text));
      for (const text of fixture.required.filter(t => !(fixture.otherBox ?? []).includes(t))) {
        assert.ok(!theirView.some(r => r.text === text), `${fixture.id}: our record leaked to the other box: ${text}`);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nearDuplicate: decoration is a rephrasing, a changed value is a different fact", () => {
  assert.equal(nearDuplicate("the user prefers short answers", "the user prefers short answers, always (confirmed)"), true);
  assert.equal(nearDuplicate("work happens on the develop branch", "the develop branch is where work happens"), true);
  assert.equal(nearDuplicate("the deployment region is eu-west-1", "the deployment region is us-east-1"), false);
  assert.equal(nearDuplicate("Mia owns billing", "Enzo owns billing"), false, "short keys never collapse");
  assert.equal(nearDuplicate("Fact number 1: detail detail", "Fact number 2: detail detail"), false);
});

test("A5: the comparison report — collapse off (old) versus on (new), same budgets", () => {
  const rows: string[] = [];
  let oldRecall = 0;
  let newRecall = 0;
  let oldDup = 0;
  let newDup = 0;
  let required = 0;
  const cases = MEMORY_FIXTURES.filter(f => f.shape !== "wrong-box");
  for (const fixture of cases) {
    const before = recall(fixture.records, fixture.budget, NOW, undefined, { collapseNearDuplicates: false });
    const after = recall(fixture.records, fixture.budget, NOW);
    const hit = (r: ReturnType<typeof recall>) => fixture.required.filter(text => r.records.some(record => record.text === text)).length;
    const dups = (r: ReturnType<typeof recall>) => r.records.filter((a, i) => r.records.slice(0, i).some(b => nearDuplicate(a.text, b.text))).length;
    required += fixture.required.length;
    oldRecall += hit(before);
    newRecall += hit(after);
    oldDup += dups(before);
    newDup += dups(after);
    const chars = (r: ReturnType<typeof recall>) => r.records.reduce((n, record) => n + record.text.length + 4, 0);
    rows.push(`${fixture.id.padEnd(28)} required ${fixture.required.length}  old ${hit(before)}/${dups(before)}dup/${chars(before)}ch  new ${hit(after)}/${dups(after)}dup/${chars(after)}ch`);
  }
  console.log(`memory-eval (${cases.length} fixtures, scored recall only, no selector):\n${rows.join("\n")}\nrecall old ${oldRecall}/${required} → new ${newRecall}/${required}; near-duplicates in body old ${oldDup} → new ${newDup}`);
  assert.ok(newRecall >= oldRecall, "the change must not lose recall");
  assert.equal(newDup, 0, "no phrasing of a kept fact reaches the body twice");
  assert.ok(newRecall > oldRecall || newDup < oldDup, "and it must buy something the fixtures can see");
});
