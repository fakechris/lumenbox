/** Enough, and nothing in the way (INV-1471): the sufficiency pass after the memory selection, under each switch mode. */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JevAsk, JevResult, SwitchDeps } from "./jev.ts";
import { chooseRelevant, type MemoryRecord } from "./memory.ts";
import { refineSelection } from "./memory-select-jev.ts";

const names = new Map<string, string>();
const record = (id: string, text: string): MemoryRecord => { names.set(text, id); return { kind: "fact", text, at: "2026-10-01T00:00:00.000Z", by: "Ada", confidence: 0.9 } as unknown as MemoryRecord; };
const idsOf = (records: readonly MemoryRecord[]) => records.map(r => names.get(r.text) ?? "?");
const candidates = [record("r1", "Chris deploys to eu-west"), record("r2", "The shop closes at 18:00"), record("r3", "Chris's dog is called Pim"), record("r4", "Deploys go through the relay")];

/** A decision model scripted per request: selection by index, sufficiency by flags, misleading by index. */
function scripted(script: { select?: number[]; enough?: boolean; mislead?: number[] }[]): { ask: JevAsk; calls: string[] } {
  const calls: string[] = [];
  const ask: JevAsk = async request => {
    const step = script.shift();
    if (step === undefined) throw new Error("asked more than scripted");
    const ids = Object.keys(request.questions);
    calls.push(ids.includes("enough") ? "sufficiency" : "select");
    const answers: JevResult["answers"] = {};
    if (ids.includes("enough")) {
      answers.enough = { type: "noul", noul: step.enough ? 0.9 : 0.1 };
      for (const id of ids.filter(key => key.startsWith("x"))) answers[id] = { type: "noul", noul: (step.mislead ?? []).includes(Number(id.slice(1))) ? 0.9 : 0.1 };
    } else {
      for (const id of ids) answers[id] = { type: "noul", noul: (step.select ?? []).includes(Number(id.slice(1))) ? 0.9 : 0.1 };
    }
    return { model: "m", ms: 1, answers };
  };
  return { ask, calls };
}

test("a misleading memory is dropped from the turn; not enough widens the selection once and only once", async () => {
  const chosen = [candidates[0]!, candidates[2]!];
  const one = scripted([{ enough: true, mislead: [1] }]);
  const kept = await refineSelection(one.ask, chosen, candidates, "where do we deploy?", 2);
  assert.deepEqual(idsOf(kept.records), ["r1"], "the dog is not about deploying");
  assert.deepEqual([kept.widened, kept.dropped], [false, 1]);
  assert.deepEqual(one.calls, ["sufficiency"], "enough: no second selection");

  const two = scripted([{ enough: false }, { select: [0, 3] }, { enough: false, mislead: [] }]);
  const wider = await refineSelection(two.ask, [candidates[0]!], candidates, "how do deploys go out?", 2);
  assert.deepEqual(idsOf(wider.records), ["r1", "r4"], "the wider selection found the relay fact");
  assert.equal(wider.widened, true);
  assert.deepEqual(two.calls, ["sufficiency", "select", "sufficiency"], "still not enough after widening: it stops, never a third selection");

  const exhausted = scripted([{ enough: false }]);
  const all = await refineSelection(exhausted.ask, candidates, candidates, "everything", 4);
  assert.equal(all.widened, false, "every candidate was already chosen: nothing wider to select");
  assert.equal(all.records.length, 4);
});

test("off makes no call; shadow records the refinement and injects what was selected; on injects the refinement", async () => {
  const records: { point: string; own?: unknown; jev?: unknown }[] = [];
  const deps = (mode: "off" | "shadow" | "on", script: Parameters<typeof scripted>[0]): SwitchDeps => {
    const model = scripted(script);
    return { mode: point => (point === "memory_sufficiency" ? mode : point === "memory_select" ? "on" : "off"), client: () => model.ask, record: entry => records.push(entry as never), log: () => {} };
  };
  const ask = async () => undefined;
  const off = await chooseRelevant({ records: candidates, query: "where do we deploy?", ask, jev: deps("off", [{ select: [0, 2] }]) });
  assert.deepEqual(idsOf(off.records).sort(), ["r1", "r3"], "the selection as it was, dog included");

  const shadow = await chooseRelevant({ records: candidates, query: "where do we deploy?", ask, jev: deps("shadow", [{ select: [0, 2] }, { enough: true, mislead: [1] }]) });
  assert.deepEqual(idsOf(shadow.records).sort(), ["r1", "r3"], "shadow changes nothing the model sees");
  await new Promise(resolve => setTimeout(resolve, 10));
  const logged = records.find(entry => entry.point === "memory_sufficiency");
  assert.ok(logged !== undefined, "the refinement is on the shadow log");
  assert.deepEqual(logged!.jev, [0], "it would have dropped the dog");

  const on = await chooseRelevant({ records: candidates, query: "where do we deploy?", ask, jev: deps("on", [{ select: [0, 2] }, { enough: true, mislead: [1] }]) });
  assert.deepEqual(idsOf(on.records), ["r1"], "on: the dog is out of this turn");
});
