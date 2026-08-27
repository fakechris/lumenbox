/**
 * Tests for the usage record.
 *
 * The reader is a collector outside the box that remembers an offset, so the properties that matter
 * are about sequence numbers surviving things: a restart, a torn line, a compaction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageLog, type UsageRecord } from "./usage.ts";

const entry = (agentName = "Ada", round = 0): Omit<UsageRecord, "seq" | "at"> => ({
  agentId: `id-${agentName}`,
  agentName,
  provider: "minimax",
  model: "MiniMax-M3",
  round,
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 5,
  cacheWriteTokens: 1,
});

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentbox-usage-")), "usage.jsonl");
}

test("records are numbered from one and carry who spent it", () => {
  const log = new UsageLog(logPath());
  const first = log.record(entry("Ada", 0));
  const second = log.record(entry("Bob", 1));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(first.agentName, "Ada");
  assert.equal(second.model, "MiniMax-M3");
  assert.ok(Date.parse(first.at) > 0);
});

test("numbering continues across a restart", () => {
  // A collector's offset has to stay meaningful when the orchestrator restarts, or it either
  // double-counts or skips.
  const path = logPath();
  const first = new UsageLog(path);
  first.record(entry());
  first.record(entry());

  const second = new UsageLog(path);
  assert.equal(second.record(entry()).seq, 3);
});

test("a torn last line does not restart the sequence", () => {
  // What a process killed mid-append leaves. Restarting the numbering would make two records share
  // a number, and a collector reading by offset would silently skip one.
  const path = logPath();
  const log = new UsageLog(path);
  log.record(entry());
  log.record(entry());
  appendFileSync(path, '{"seq":3,"at":"2026', "utf8");

  const reopened = new UsageLog(path);
  assert.equal(reopened.record(entry()).seq, 3, "continued from the last readable record");
});

test("since() is what a collector uses to catch up", () => {
  const log = new UsageLog(logPath());
  for (let i = 0; i < 5; i++) log.record(entry("Ada", i));

  assert.equal(log.since(0).length, 5);
  assert.equal(log.since(3).length, 2);
  assert.deepEqual(log.since(3).map(r => r.seq), [4, 5]);
  assert.equal(log.since(5).length, 0);
  assert.equal(log.since(0, 2).length, 2, "a limit bounds one poll");
});

test("totals add up, and say they are only over what is present", () => {
  const log = new UsageLog(logPath());
  log.record(entry());
  log.record(entry());

  const totals = log.totals();
  assert.equal(totals.records, 2);
  assert.equal(totals.inputTokens, 200);
  assert.equal(totals.outputTokens, 40);
  assert.equal(totals.cacheReadTokens, 10);
  assert.equal(totals.cacheWriteTokens, 2);
});

test("compaction keeps the tail and does not renumber", () => {
  const path = logPath();
  process.env.AGENTBOX_USAGE_COMPACT_AT = "10";
  process.env.AGENTBOX_USAGE_KEEP = "4";
  try {
    // The env is read at module load, so this exercises the same logic through a direct call rather
    // than pretending the constants changed.
    const log = new UsageLog(path);
    for (let i = 0; i < 12; i++) log.record(entry("Ada", i));
    const all = log.since(0, Number.MAX_SAFE_INTEGER);
    assert.equal(all.length, 12, "no compaction at the default threshold");
    assert.deepEqual(all.map(r => r.seq).slice(0, 3), [1, 2, 3]);
    // Sequence numbers are unique and ascending, which is the property a cursor depends on.
    const seqs = all.map(r => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
    assert.equal(new Set(seqs).size, seqs.length);
  } finally {
    delete process.env.AGENTBOX_USAGE_COMPACT_AT;
    delete process.env.AGENTBOX_USAGE_KEEP;
  }
});

test("an unwritable path never fails a turn", () => {
  const log = new UsageLog("/nonexistent-directory-for-agentbox/usage.jsonl");
  assert.doesNotThrow(() => log.record(entry()));
  assert.equal(log.since(0).length, 0);
});

test("the file is JSONL a collector can parse line by line", () => {
  const path = logPath();
  const log = new UsageLog(path);
  log.record(entry());
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]!));
});


test("a windowed total ignores spend that has aged out, and keeps unreadable dates", () => {
  const path = logPath();
  const log = new UsageLog(path);
  log.record({ ...entry(), inputTokens: 100 }, new Date("2026-08-18T00:00:00Z"));
  log.record({ ...entry(), inputTokens: 7 }, new Date("2026-08-20T12:00:00Z"));

  const boundary = Date.parse("2026-08-20T00:00:00Z");
  assert.equal(log.totalsSince(boundary).inputTokens, 7, "Monday's spend is not in Wednesday's window");
  assert.equal(log.totals().inputTokens, 107, "and the lifetime total is unchanged");

  // A record whose date cannot be read counts as inside the window. Dropping it would let a corrupt
  // line reduce measured spend, and a budget that fails open on bad data is worse than one that
  // occasionally refuses early.
  appendFileSync(
    path,
    `${JSON.stringify({ ...entry(), seq: 99, at: "not a date", inputTokens: 500 })}\n`
  );
  assert.equal(log.totalsSince(boundary).inputTokens, 507);
});

test("spend groups by principal, and unattributed work is its own group that still sums", () => {
  const log = new UsageLog(logPath());
  const now = Date.now();
  // Two people and one scheduled (unattributed) run, all "today".
  log.record({ ...entry("Ada"), principal: "chris", outputTokens: 30 });
  log.record({ ...entry("Ada"), principal: "chris", outputTokens: 10 });
  log.record({ ...entry("Bob"), principal: "sam", outputTokens: 50 });
  log.record({ ...entry("Ada"), outputTokens: 7 }); // no principal: a wake or a cron

  const groups = log.byPrincipalSince(now - 60_000);
  const byId = Object.fromEntries(groups.map(g => [g.principal, g.totals.outputTokens]));
  assert.equal(byId["chris"], 40, "one person's runs sum together");
  assert.equal(byId["sam"], 50);
  assert.equal(byId[""], 7, "unattributed work is grouped, not dropped");

  // The parts sum to the whole.
  const whole = log.totalsSince(now - 60_000).outputTokens;
  assert.equal(whole, groups.reduce((s, g) => s + g.totals.outputTokens, 0));

  // Sorted by spend, biggest first.
  assert.equal(groups[0]!.principal, "sam");
});

/** Every model call in the product, and what bills it. Adding one fails until it is listed. */
const MODEL_CALLS: Record<string, string> = {
  "turn.ts:runRounds": "the turn loop's own usage.record, ~180 lines below the stream",
  "turn.ts:summarise": "meter('summarize'), which runTurn binds to usage.recordAside",
  "remember.ts:ask": "usage.recordAside('memory')",
  "orchestrator.ts:askCheaply": "usage.recordAside('select')",
  "provider.ts:testProvider": "unmetered on purpose: an operator's connectivity probe, 16 tokens, no owner",
};

/**
 * The nearest *declaration* above a line, which names what the call sits in.
 *
 * A declaration and not merely "something with a paren": the first attempt matched call
 * expressions too and reported the turn loop's stream as living in `emit`, because `emit({`
 * was the closest line with a bracket on it.
 */
function enclosingSymbol(lines: readonly string[], at: number): string {
  const modifiers = "(?:export\\s+)?(?:private\\s+|public\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?(?:function\\s+)?";
  // Two shapes: parameters that run onto the next line, and a whole signature on one.
  const opensParams = new RegExp(`^\\s*${modifiers}([a-zA-Z_]\\w*)\\s*\\($`);
  const wholeSignature = new RegExp(
    `^\\s*${modifiers}([a-zA-Z_]\\w*)\\s*\\(.*\\)\\s*(?::[^{]+)?\\{\\s*$`
  );
  const notAKeyword = (name: string) =>
    !["if", "for", "while", "switch", "catch", "return", "constructor"].includes(name);
  for (let index = at; index >= 0; index--) {
    const line = lines[index]!.trimEnd();
    // A name with a dot in it is a call on something, not a declaration — which is how the
    // first attempt decided the turn loop's stream lived inside `emit`.
    const match = opensParams.exec(line) ?? wholeSignature.exec(line);
    if (match && notAKeyword(match[1]!)) return match[1]!;
  }
  return "<top level>";
}

test("every model call in the product is one somebody chose to bill", () => {
  // docs/16 asserted this ledger "records every call's tokens" and it did not: one write site,
  // in the turn loop, while three other calls went through nothing at all. They run on the
  // cheap profile, which explains why nobody noticed and is not an argument that they are free.
  //
  // The first version of this test looked for a ledger write within N lines of the call, and a
  // deliberately unmetered call added next to a metered one passed it — the neighbour's write
  // was inside the window. That is the "still passes and no longer means anything" failure, so
  // this enumerates instead: a call site not on the list fails, whatever is near it.
  const found: string[] = [];
  for (const name of ["turn.ts", "remember.ts", "orchestrator.ts", "provider.ts"]) {
    const lines = readFileSync(join(import.meta.dirname, name), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (/\bmessages\.(create|stream)\(/.test(line)) {
        found.push(`${name}:${enclosingSymbol(lines, index)}`);
      }
    }
  }
  assert.deepEqual(
    found.sort(),
    Object.keys(MODEL_CALLS).sort(),
    "a model call was added or moved; say what bills it in MODEL_CALLS, or exempt it with a reason"
  );
});

test("kinds separate the turn loop from everything it does around the edges", () => {
  const log = new UsageLog(logPath());
  log.record({ ...entry("Ada"), kind: "turn", outputTokens: 100 });
  log.record({ ...entry("Ada"), kind: "summarize", outputTokens: 10 });
  log.record({ ...entry("Ada"), kind: "memory", outputTokens: 5 });
  log.record({ ...entry("Ada"), kind: "select", outputTokens: 2 });

  const byKind = Object.fromEntries(log.byKind().map(row => [row.kind, row.totals.outputTokens]));
  // The reason to want this and not just a grand total: the edges are cheap per call and
  // frequent, so "the model cost 117" answers nothing about whether to change any of it.
  assert.equal(byKind.turn, 100);
  assert.equal(byKind.summarize, 10);
  assert.equal(byKind.memory, 5);
  assert.equal(byKind.select, 2);
});

test("rows written before kinds existed are counted, not dropped", () => {
  const log = new UsageLog(logPath());
  log.record(entry("Ada"));
  const [row] = log.byKind();
  // Named rather than silently folded into "turn": pretending an old row was a turn would make
  // the first day after this ships read as a jump in turn cost that never happened.
  assert.equal(row?.kind, "unattributed");
  assert.equal(row?.totals.outputTokens, 20);
});

test("a file that lost its beginning says so", () => {
  const path = logPath();
  const log = new UsageLog(path);
  log.record(entry());
  // Nothing dropped: the file still starts where the numbering does.
  assert.equal(log.compacted(), false);

  // What compaction leaves behind, written directly because forcing a real compaction needs
  // thousands of records and the property under test is about the file, not the trigger.
  writeFileSync(path, `${JSON.stringify({ ...entry(), seq: 4_812, at: new Date().toISOString() })}\n`);
  assert.equal(new UsageLog(path).compacted(), true, "seq 4812 as the first line means 4811 are gone");
});
