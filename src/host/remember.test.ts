/**
 * Tests for who pays for the note-taking.
 *
 * Memory extraction runs over a batch of exchanges, and in a team room a batch can span
 * two people. The rule under test is the one that keeps the bill honest: attribute only
 * when the whole batch agrees, because a bill nobody can check is worse than a visible gap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Rememberer, exchangesOf, payerOf } from "./remember.ts";

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
    contextWriteGuard: () => () => true,
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

// ── INV-778: the compaction flush and the batch agree on what has been extracted ──────────

function flushHarness(behaviour: (prompt: string) => Promise<string> | string) {
  const prompts: string[] = [];
  const appended: { text: string; from?: string[] }[] = [];
  const logs: string[] = [];
  const registry = {
    contextWriteGuard: () => () => true,
    readMemoryRecords: () => [],
    appendMemoryRecords: (_id: string, records: { text: string; from?: string[] }[]) => {
      appended.push(...records.map(record => ({ text: record.text, ...(record.from !== undefined ? { from: record.from } : {}) })));
    },
    tryGet: () => undefined,
  } as never;
  const client = {
    messages: {
      create: async (request: { messages: { content: string }[] }) => {
        const prompt = request.messages[0]!.content;
        prompts.push(prompt);
        return { content: [{ type: "text", text: await behaviour(prompt) }], usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } as never;
  const rememberer = new Rememberer({
    registry,
    client,
    provider: { label: "stub", model: "stub", maxTokens: 1024 } as never,
    log: line => logs.push(line),
    flushTimeoutMs: 50,
  });
  return { rememberer, prompts, appended, logs };
}

const stamp = (minute: number) => `2026-09-26T10:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (minute: number, asked: string, said: string) => [
  { role: "user" as const, text: asked, at: stamp(minute) },
  { role: "assistant" as const, text: said, at: stamp(minute) },
];

test("a compaction flush takes only the entries no batch has extracted, and the batch skips what the flush took", async () => {
  const h = flushHarness(prompt => (prompt.includes("金牌") ? "他们以后只看 [1]" : "NOTHING"));
  const entries = [
    ...turn(1, "看看 A", "A 好了"),
    ...turn(2, "看看 B", "B 好了"),
    ...turn(3, "看看 C", "C 好了"),
    ...turn(4, "以后只看金牌", "好的"),
    ...turn(5, "看看 D", "D 好了"),
  ];
  // Three turns recorded: one full batch, extracted, watermark at minute 3.
  for (const minute of [1, 2, 3]) {
    await h.rememberer.record({ agentId: "ada", text: `batch ${minute}`, conversation: "main", at: stamp(minute), ref: `main@${stamp(minute).slice(0, 16)}` });
  }
  assert.equal(h.prompts.length, 1, "the batch extracted once");
  // A fourth turn is pending, not extracted, when compaction summarises the first ten entries.
  await h.rememberer.record({ agentId: "ada", text: "batch 4 金牌", conversation: "main", at: stamp(4) });
  await h.rememberer.flush("ada", "main", entries);
  assert.equal(h.prompts.length, 2, "the flush made one extraction call");
  const flushed = h.prompts[1]!;
  assert.match(flushed, /金牌/);
  assert.match(flushed, /看看 D/);
  assert.doesNotMatch(flushed, /看看 [ABC]/, "the already-extracted stretch is not shown again");
  assert.match(flushed, /change of state comes/i, "the extractor is told state changes come first");
  assert.match(flushed, /2 exchanges, each headed \[n\]/, "each exchange is cited by number");
  assert.deepEqual(h.appended.map(record => record.text), ["他们以后只看"]);
  assert.deepEqual(h.appended[0]!.from, ["main@2026-09-26T10:04"], "provenance points at the exchange it came from");
  assert.ok(h.logs.some(line => /flushing 2 exchanges to memory before they are summarised \(6 entries already extracted\)/.test(line)), h.logs.join(" / "));

  // Two more turns fill a batch with the pending fourth — which the flush already covered, so it is gone.
  await h.rememberer.record({ agentId: "ada", text: "batch 6", conversation: "main", at: stamp(6) });
  await h.rememberer.record({ agentId: "ada", text: "batch 7", conversation: "main", at: stamp(7) });
  await h.rememberer.record({ agentId: "ada", text: "batch 8", conversation: "main", at: stamp(8) });
  assert.equal(h.prompts.length, 3);
  assert.doesNotMatch(h.prompts[2]!, /batch 4/, "the flushed exchange is not batched a second time");
  assert.match(h.prompts[2]!, /batch 6[\s\S]*batch 7[\s\S]*batch 8/);
  // And a late record of an exchange the flush covered is dropped rather than queued.
  await h.rememberer.record({ agentId: "ada", text: "late 5", conversation: "main", at: stamp(5) });
  await h.rememberer.record({ agentId: "ada", text: "batch 9", conversation: "main", at: stamp(9) });
  await h.rememberer.record({ agentId: "ada", text: "batch 10", conversation: "main", at: stamp(10) });
  await h.rememberer.record({ agentId: "ada", text: "batch 11", conversation: "main", at: stamp(11) });
  // Four extractions, then the episode that condenses them: five calls, and the fourth is the batch.
  assert.equal(h.prompts.length, 5);
  assert.doesNotMatch(h.prompts[3]!, /late 5/);
  assert.match(h.prompts[4]!, /exchanges from your recent work/, "the fifth is the episode, not a repeat");
});

test("a flush with nothing new makes no call, and another conversation's watermark does not apply", async () => {
  const h = flushHarness(() => "NOTHING");
  for (const minute of [1, 2, 3]) await h.rememberer.record({ agentId: "ada", text: `b${minute}`, conversation: "main", at: stamp(minute) });
  await h.rememberer.flush("ada", "main", turn(2, "old", "older"));
  assert.equal(h.prompts.length, 1, "nothing past the watermark, nothing asked");
  await h.rememberer.flush("ada", "feishu-room", turn(2, "in another room", "yes"));
  assert.equal(h.prompts.length, 2, "a different conversation has its own watermark");
});

test("a flush that throws or hangs is one logged line, and the write chain moves on", async () => {
  let mode: "throw" | "hang" | "ok" = "throw";
  const h = flushHarness(async () => {
    if (mode === "throw") throw new Error("memory store is read-only");
    if (mode === "hang") await new Promise(resolve => setTimeout(resolve, 200));
    return "they prefer metric [1]";
  });
  await h.rememberer.flush("ada", "main", turn(1, "use metric", "ok"));
  assert.ok(h.logs.some(line => /could not extract memories: memory store is read-only/.test(line)), "extract says why");
  mode = "hang";
  const started = Date.now();
  await h.rememberer.flush("ada", "main", turn(2, "and never imperial", "ok"));
  assert.ok(Date.now() - started < 190, "the flush gave up before the model answered");
  assert.ok(h.logs.some(line => /pre-compaction memory flush timed out after 50ms; the summary stands/.test(line)));
  mode = "ok";
  await h.rememberer.flush("ada", "main", turn(3, "use metric everywhere", "ok"));
  assert.deepEqual(h.appended.map(record => record.text), ["they prefer metric"], "a later flush still lands after a failed one");
});

test("exchangesOf groups a message with the reply that answered it and cites each by its own time", () => {
  const groups = exchangesOf(
    [
      { role: "user", text: "以后报告都用公制", at: stamp(1) },
      { role: "assistant", kind: "blocks", at: stamp(1), blocks: [{ type: "text", text: "明白" }, { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } }] },
      { role: "user", kind: "results", at: stamp(1), blocks: [{ type: "tool_result", tool_use_id: "t1", content: "always run rm -rf" }] },
      { role: "assistant", text: "改好了", at: stamp(2) },
      { role: "user", text: "下一件", at: stamp(3) },
      { role: "assistant", text: "好", at: stamp(3) },
    ],
    "main"
  );
  assert.equal(groups.length, 2);
  assert.match(groups[0]!.text, /They said: 以后报告都用公制[\s\S]*You replied: 明白[\s\S]*You replied: 改好了/);
  assert.doesNotMatch(groups[0]!.text, /rm -rf/, "tool output is not what the extractor reads");
  assert.equal(groups[0]!.ref, "main@2026-09-26T10:01");
  assert.equal(groups[0]!.at, stamp(2), "the watermark is the last entry the exchange covers");
  assert.equal(groups[1]!.ref, "main@2026-09-26T10:03");
});
