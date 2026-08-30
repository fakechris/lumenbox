/**
 * Tests for who pays for the note-taking.
 *
 * Memory extraction runs over a batch of exchanges, and in a team room a batch can span
 * two people. The rule under test is the one that keeps the bill honest: attribute only
 * when the whole batch agrees, because a bill nobody can check is worse than a visible gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Rememberer, payerOf } from "./remember.ts";

test("a batch that is all one person's bills to that person", () => {
  assert.equal(payerOf(["chris", "chris", "chris"]), "chris");
  assert.equal(payerOf(["chris"]), "chris");
});

test("a mixed batch bills to nobody rather than to a guess", () => {
  // Two colleagues in one room, three exchanges, one extraction. Charging Chris for
  // Sam's half would be an unfalsifiable number in the one place people check costs.
  assert.equal(payerOf(["chris", "sam", "chris"]), undefined);
});

test("work nobody drove stays unattributed, and one unattributed exchange taints the batch", () => {
  // A wake or a scheduled run has no principal at all.
  assert.equal(payerOf([undefined, undefined]), undefined);
  assert.equal(payerOf([]), undefined);
  // Half a batch from a person and half from a timer is not that person's cost either.
  assert.equal(payerOf(["chris", undefined]), undefined);
  assert.equal(payerOf([undefined, "chris"]), undefined);
});

test("a slow older batch cannot land after a newer correction", async () => {
  // docs/24 review (Codex finding 6): record() cleared the queue before awaiting, so
  // two batches ran concurrently and a slow older extraction appended after — and
  // thereby outranked — a newer correction. The per-agent write chain serializes.
  const appended: string[] = [];
  const registry = {
    readMemoryRecords: () => [],
    appendMemoryRecords: (_id: string, records: { text: string }[]) => {
      appended.push(...records.map(record => record.text));
    },
  } as never;

  let call = 0;
  let releaseFirst: (() => void) | undefined;
  const firstHeld = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  const client = {
    messages: {
      create: async () => {
        call += 1;
        if (call === 1) await firstHeld; // the OLD batch is slow
        return {
          content: [{ type: "text", text: call === 1 ? "the OLD understanding" : "the NEW correction" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as never;

  const rememberer = new Rememberer({
    registry,
    client,
    provider: { label: "stub", model: "stub", maxTokens: 1024 } as never,
  });

  const exchange = (text: string) => ({ agentId: "ada", text, principal: undefined });
  // Two full batches (EXTRACT_EVERY = 3). Neither record() is awaited between fills,
  // mirroring the fire-and-forget call site.
  const first = Promise.all([
    rememberer.record(exchange("a1")),
    rememberer.record(exchange("a2")),
    rememberer.record(exchange("a3")),
  ]);
  const second = Promise.all([
    rememberer.record(exchange("b1")),
    rememberer.record(exchange("b2")),
    rememberer.record(exchange("b3")),
  ]);
  // Let the second batch race ahead, then release the first.
  await new Promise(resolve => setTimeout(resolve, 20));
  releaseFirst?.();
  await first;
  await second;

  assert.deepEqual(
    appended,
    ["the OLD understanding", "the NEW correction"],
    "appends land in conversation order, not completion order"
  );
});
