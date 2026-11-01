/** Four type scores on a memory line, asked at write and of the message at select; a lean on the order, never an admission (INV-1472). */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { JevAsk, JevResult } from "./jev.ts";
import type { MemoryRecord } from "./memory.ts";
import { leanedByType, type MemoryTypes, typeAffinity } from "./memory-types.ts";
import { dispose, jevJudge } from "./memory-judge.ts";
import { jevSelect } from "./memory-select-jev.ts";

const types = (episodic: number, semantic: number, procedural: number, preference: number): MemoryTypes => ({ episodic, semantic, procedural, preference });

test("affinity is the cosine over the four axes; a line or a request without scores is neutral; weight 0 changes nothing", () => {
  const howTo = { types: types(0.1, 0.2, 0.9, 0.1) };
  assert.ok(typeAffinity(howTo, types(0, 0.1, 1, 0)) > 0.9, "a how-to line for a how-to request");
  assert.ok(typeAffinity(howTo, types(0, 0, 0, 1)) < 0.3, "not for a taste request");
  assert.equal(typeAffinity({}, types(1, 0, 0, 0)), 0.5, "an old line without scores is neutral");
  assert.equal(typeAffinity(howTo, undefined), 0.5, "no request profile: neutral");
  assert.equal(leanedByType(0.8, howTo, types(0, 0, 0, 1), 0), 0.8, "weight 0: the probability as it was");
  assert.ok(leanedByType(0.8, howTo, types(0, 0, 1, 0), 0.2) > 0.8 && leanedByType(0.8, howTo, types(0, 0, 0, 1), 0.2) < 0.8);
});

/** A decision model that answers every noul from a table, by question id suffix. */
function tabled(answerFor: (id: string) => number): { ask: JevAsk; ids: string[] } {
  const ids: string[] = [];
  const ask: JevAsk = async request => {
    const answers: JevResult["answers"] = {};
    for (const [id, question] of Object.entries(request.questions)) {
      ids.push(id);
      answers[id] = question.type === "noul" ? { type: "noul", noul: answerFor(id) } : { type: "choice", choice: "none", confidence: 0.9, probabilities: { none: 0.9 } };
    }
    return { model: "m", ms: 1, answers };
  };
  return { ask, ids };
}

test("the judge asks four more questions per candidate and the scores ride the kept line; the cheap-profile judge leaves them absent", async () => {
  const model = tabled(id => (id.endsWith("_type_procedural") ? 0.93 : id.includes("_type_") ? 0.1 : 0.05));
  const verdicts = await jevJudge(model.ask)({ conversation: "how do we deploy?", candidates: ["Deploys go through the relay"], known: ["The shop closes at 18:00"] });
  assert.deepEqual(model.ids.filter(id => id.includes("_type_")), ["c0_type_episodic", "c0_type_semantic", "c0_type_procedural", "c0_type_preference"], "four type nouls beside the safety questions");
  assert.deepEqual(verdicts[0]!.types, types(0.1, 0.1, 0.93, 0.1));
  const candidate: MemoryRecord = { at: "2026-11-01T00:00:00.000Z", kind: "fact", text: "Deploys go through the relay" };
  const out = dispose([candidate], verdicts, [{ at: "2026-10-01T00:00:00.000Z", kind: "fact", text: "The shop closes at 18:00" }]);
  assert.deepEqual(out.keep[0]!.types, types(0.1, 0.1, 0.93, 0.1), "stored on the line");
  const plain = dispose([candidate], [{ fromContent: { answer: false, confidence: 1 }, narrowsRules: { answer: false, confidence: 1 }, contradicts: { answer: false, confidence: 1 }, duplicate: { answer: false, confidence: 1 } }], []);
  assert.equal(plain.keep[0]!.types, undefined, "an unscored verdict adds no field");
});

test("at selection the message is scored on the same axes and the order leans toward matching lines, below the line nothing is admitted", async () => {
  const relay: MemoryRecord = { at: "2026-10-01T00:00:00.000Z", kind: "fact", text: "Deploys go through the relay", types: types(0.1, 0.2, 0.9, 0.1) };
  const likes: MemoryRecord = { at: "2026-10-01T00:00:00.000Z", kind: "fact", text: "Chris likes terse replies", types: types(0.1, 0.2, 0.1, 0.9) };
  const dog: MemoryRecord = { at: "2026-10-01T00:00:00.000Z", kind: "fact", text: "Chris's dog is Pim" };
  const model = tabled(id => (id === "q_procedural" ? 0.95 : id.startsWith("q_") ? 0.05 : id === "m2" ? 0.2 : 0.7));
  const chosen = await jevSelect(model.ask, [likes, relay, dog], "how do deploys go out?", 2);
  assert.ok(model.ids.includes("q_procedural") && model.ids.includes("q_preference"), "the message was scored on the four axes in the same request");
  assert.deepEqual(chosen.map(r => r.text), ["Deploys go through the relay", "Chris likes terse replies"], "equal probabilities: the how-to line comes first for a how-to request");
  assert.ok(!chosen.some(r => r.text.includes("dog")), "below the line stays out whatever its type");
});
