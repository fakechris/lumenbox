/**
 * Tests for the spend report.
 *
 * The report exists because fifteen or so throwaway scripts were typed into a shell on
 * 2026-08-26 to answer questions like "what did that cost", none of them kept, several
 * wrong on the first attempt precisely because they were improvised. A number nobody can
 * re-run is a claim.
 *
 * So the properties under test are the ones that make a number trustworthy rather than
 * merely present: the parts sum to the whole, an unpriced model is named rather than
 * costed at zero, and a total over a compacted file says that it is a lower bound.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { UsageRecord } from "./usage.ts";
import { describeSpend, priceOf, summariseSpend } from "./spend.ts";

let seq = 0;
function row(over: Partial<UsageRecord> = {}): UsageRecord {
  seq += 1;
  return {
    seq,
    at: "2026-08-27T09:00:00.000Z",
    agentId: "a-ada",
    agentName: "Ada",
    provider: "minimax",
    model: "MiniMax-M3",
    round: 0,
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

test("the breakdowns sum to the total, so a reader can check the report against itself", () => {
  const records = [
    row({ kind: "turn", agentName: "Ada", outputTokens: 100 }),
    row({ kind: "turn", agentName: "Bob", outputTokens: 40 }),
    row({ kind: "summarize", agentName: "Ada", outputTokens: 10 }),
    row({ kind: "memory", agentName: "Bob", outputTokens: 7 }),
  ];
  const report = summariseSpend(records, {});

  assert.equal(report.totals.outputTokens, 157);
  const sum = (rows: { totals: { outputTokens: number } }[]) =>
    rows.reduce((all, one) => all + one.totals.outputTokens, 0);
  // Three ways of cutting one number. If any of them disagrees the report is lying about
  // at least one of them, and there is no way to tell which from the report alone.
  assert.equal(sum(report.byKind), 157, "kinds account for everything");
  assert.equal(sum(report.byAgent), 157, "agents account for everything");
  assert.equal(sum(report.byModel), 157, "models account for everything");
});

test("a model with no rate is named, not priced at zero", () => {
  const records = [row({ model: "MiniMax-M3" }), row({ model: "claude-opus-5" })];
  const report = summariseSpend(records, { rates: { "claude-opus-5": { inputPerM: 5, outputPerM: 25 } } });

  // The failure this prevents is the worst kind of quiet: an unpriced model contributes
  // nothing to the money column, so the bill reads low and reads *complete*.
  assert.deepEqual(report.unpriced, ["MiniMax-M3"]);
  // And the model that *does* have a rate is not enough to justify a figure. The first
  // version of this test asserted the priced half as the total, which is exactly the
  // partial-bill-presented-as-a-bill it was written to rule out.
  assert.equal(report.money, undefined, "one priced model does not make a priceable window");
  const text = describeSpend(report).join("\n");
  assert.match(text, /MiniMax-M3/, "the model with no rate is named, so it can be fixed");
  assert.match(text, /no rate/i);
});

test("money is only reported when every model in the window has a rate", () => {
  const report = summariseSpend([row()], {});
  // Half a bill presented as a bill is worse than no bill: it is a number a person will act
  // on that is wrong by an unknown amount in a known direction.
  assert.equal(report.money, undefined);
  assert.doesNotMatch(describeSpend(report).join("\n"), /\$0\b/);
});

test("cache reads are priced apart from fresh input", () => {
  const records = [row({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })];
  const rates = { "MiniMax-M3": { inputPerM: 10, outputPerM: 30, cacheReadPerM: 1 } };
  // A cached read at the input rate overstates a long conversation by an order of magnitude,
  // and long conversations are the ones anybody bothers to ask the cost of.
  assert.equal(priceOf(records[0]!, rates), 1);
});

test("one piece of work reports across the turns it took", () => {
  const records = [
    row({ workId: "w1", turnId: "t-1", outputTokens: 100 }),
    row({ workId: "w1", turnId: "t-2", outputTokens: 50 }),
    row({ workId: "w2", turnId: "t-3", outputTokens: 999 }),
  ];
  const report = summariseSpend(records, { workId: "w1" });

  assert.equal(report.totals.outputTokens, 150, "both attempts, one piece of work");
  assert.equal(report.turns, 2, "and it says how many attempts that was");
  assert.equal(report.records, 2);
});

test("a task is costed through the turns its board history names", () => {
  const records = [
    row({ turnId: "t-a", outputTokens: 100 }),
    row({ turnId: "t-b", outputTokens: 25 }),
    row({ turnId: "t-other", outputTokens: 999 }),
  ];
  // This is the question R31 asked and could not answer: "of 46 tasks on the board, zero
  // can be costed". The board records the turn every change was made in; that is the join.
  const report = summariseSpend(records, { turnIds: ["t-a", "t-b"] });
  assert.equal(report.totals.outputTokens, 125);
});

test("a report over a compacted file says it is a lower bound", () => {
  const report = summariseSpend([row()], { compacted: true });
  const text = describeSpend(report).join("\n");
  // The ledger keeps 48 hours and a count tail. A total over that is a floor, and a floor
  // presented as a total is how "we spent X" becomes wrong without anybody lying.
  assert.match(text, /lower bound|at least|incomplete/i);
});

test("an empty window says so instead of reporting zero", () => {
  const text = describeSpend(summariseSpend([], {})).join("\n");
  // Zero and no-records look identical in a total and mean opposite things: one is a quiet
  // day, the other is a filter that matched nothing — usually a mistyped id.
  assert.match(text, /no records/i);
  assert.doesNotMatch(text, /^0 tokens$/m);
});

test("records written before the join key existed say so, rather than reading as free", () => {
  // The first real run of this command asked what t51 cost and got "no records" — because
  // every row on that installation predated turnId by a few hours. A person reads that as
  // "the task was free", which is the precise failure this whole report exists to avoid.
  const old = [row({ outputTokens: 500 }), row({ outputTokens: 300 })];
  const text = describeSpend(summariseSpend(old, { turnIds: ["t-a"] })).join("\n");
  assert.match(text, /before that field existed/);

  // But a filter that legitimately matched nothing is not explained away: once the rows do
  // carry the field, an empty answer means the answer is empty.
  const current = [row({ turnId: "t-b", outputTokens: 500 })];
  const live = describeSpend(summariseSpend(current, { turnIds: ["t-a"] })).join("\n");
  assert.doesNotMatch(live, /before that field existed/);
});
