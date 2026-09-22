import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseRelevant, memoryProjectionManifest, parseSelection, renderMemory, type MemoryRecord } from "./memory.ts";

const records: MemoryRecord[] = [
  { at: "2026-09-20T00:00:00Z", kind: "note", text: "Always audit seventeen blind spots before answering." },
  { at: "2026-09-21T00:00:00Z", kind: "fact", text: "The deployment region is eu-west-1." },
];

test("an empty selection excludes old conduct notes even below budget, including the index", async () => {
  let asked = 0;
  const result = await chooseRelevant({ records, query: "解释这项技术有什么用", ask: async () => {
    asked++;
    return '{"selected": []}';
  } });
  assert.equal(asked, 1);
  assert.deepEqual(result.records, []);
  assert.doesNotMatch(renderMemory(result), /seventeen|eu-west|not kept anything yet/);
});

test("selected memories do not refill spare space with rejected memories", async () => {
  const result = await chooseRelevant({ records, query: "deployment region", ask: async () => '{"selected": [1]}' });
  assert.deepEqual(result.records, [records[1]]);
  assert.doesNotMatch(renderMemory(result), /seventeen/);
});

test("missing query and failed selection cannot restore an unrelated default", async () => {
  for (const query of ["", "解释这项技术有什么用"]) {
    const result = await chooseRelevant({ records, query, ask: async () => { throw new Error("offline"); } });
    assert.deepEqual(result.records, []);
    assert.doesNotMatch(renderMemory(result), /seventeen|eu-west/);
  }
});

test("failure fallback may retain a lexically relevant fact, but not an automatic conduct note", async () => {
  const result = await chooseRelevant({ records, query: "deployment region blind spots", ask: async () => undefined });
  assert.deepEqual(result.records, [records[1]]);
  assert.doesNotMatch(renderMemory(result), /seventeen/);
});

test("selected records exceeding the body budget are index-only; rejected text stays absent", async () => {
  const result = await chooseRelevant({ records, query: "deployment", budget: 1, ask: async () => '{"selected": [1]}' });
  assert.deepEqual(result.records, []);
  assert.deepEqual(result.omittedRecords, [records[1]]);
  assert.equal(result.excluded, 1);
  assert.match(renderMemory(result), /eu-west-1/);
  assert.doesNotMatch(renderMemory(result), /seventeen/);
  const manifest = memoryProjectionManifest(result);
  assert.equal(manifest.method, "model");
  assert.equal(manifest.index.length, 1);
  assert.match(manifest.index[0]!, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(manifest), /deployment|seventeen/);
});

test("malformed selection does not coerce booleans or strings into memory ids", () => {
  for (const selected of [null, [true], ["1"], [99]]) {
    assert.equal(parseSelection(JSON.stringify({ selected }), records), undefined);
  }
});
