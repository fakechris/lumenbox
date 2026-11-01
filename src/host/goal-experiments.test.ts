import { test } from "node:test";
import assert from "node:assert/strict";
import { appendExperiment, describePursuit, EXPERIMENT_LEDGER_MAX, type Experiment, ledgerLines, newPursuit, parseExperiment } from "./goal-mode.ts";

test("the ledger reads an experiment from the judge, caps at twenty, and shows on /goal (INV-1475)", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const read = parseExperiment('Sure: {"kind":"repeat","hypothesis":" the API   lists orders ","action":"called it","outcome":"403"}', 4, at);
  assert.deepEqual(read, { n: 4, kind: "repeat", hypothesis: "the API lists orders", action: "called it", outcome: "403", at });
  assert.equal(parseExperiment("no json", 1, at), undefined);
  assert.equal(parseExperiment('{"kind":"new"}', 1, at), undefined, "nothing tried is no entry");
  assert.equal(parseExperiment('{"kind":"weird","hypothesis":"x"}', 1, at)?.kind, "new", "an unknown kind reads as new");
  let ledger: Experiment[] = [];
  for (let n = 1; n <= EXPERIMENT_LEDGER_MAX + 5; n++) ledger = appendExperiment(ledger, { n, kind: "new", hypothesis: `h${n}`, action: "a", outcome: "o", at });
  assert.equal(ledger.length, EXPERIMENT_LEDGER_MAX);
  assert.equal(ledger[0]!.n, 6, "the oldest five are gone");
  const pursuit = { ...newPursuit({ objective: "ship", workId: "w", chatKey: "c" }), experiments: ledger.slice(0, 2) };
  assert.deepEqual(ledgerLines(pursuit), ["6. [new] h6 → a → o", "7. [new] h7 → a → o"]);
  assert.match(describePursuit({ id: "t1", pursuit } as never), /实验账本：\n6\. \[new\] h6 → a → o/);
});
