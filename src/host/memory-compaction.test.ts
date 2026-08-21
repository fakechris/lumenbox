/**
 * Tests for bounding the memory files themselves.
 *
 * Memory was the one durable log that never compacted its file — usage, policy, claims, the inbox
 * and the turn ledger all rewrite their tail, and `memory.jsonl` only grew. The invariant every
 * test here circles: **the view is identical before and after**, because compaction keeps exactly
 * the records `dedupe` already shows every reader, with their original bytes and timestamps.
 *
 * The dangerous half is shared memory, where a retraction in one shard withdraws a fact in
 * another: dropping the retraction while the fact remains resurrects it. The rule under test is
 * that a retraction is only dropped once nothing it could kill remains on disk — which makes every
 * crash point safe and converges over two passes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import {
  compactMemoryLines,
  compactSharedShardLines,
  dedupe,
  MEMORY_COMPACT_AT,
  type MemoryRecord,
} from "./memory.ts";

const line = (record: object): string => JSON.stringify(record);
const at = (n: number) => `2026-08-${String(Math.floor(n / 100) + 1).padStart(2, "0")}T${String(n % 100).padStart(2, "0")}:00:00Z`;

test("compaction keeps exactly what every reader already sees", () => {
  const lines = [
    line({ at: at(1), kind: "fact", text: "deployment region is us-east-1" }),
    line({ at: at(2), kind: "note", text: "they mentioned the deadline is friday" }),
    // Supersedes the first fact (same key after normalisation is not the case here — different key,
    // so this is an ordinary live record).
    line({ at: at(3), kind: "retraction", text: "deployment region is us-east-1" }),
    line({ at: at(4), kind: "fact", text: "deployment region is eu-west-1" }),
    // A duplicate phrasing of the note: same dedupe key, later wins.
    line({ at: at(5), kind: "note", text: "They mentioned the deadline is Friday!" }),
  ];

  const kept = compactMemoryLines(lines);
  assert.ok(kept, "there was plenty to drop");

  // As sets: dedupe's return order is map-insertion order, which is meaningless — recall sorts
  // chronologically for the prompt. What must not move is which records exist, with which times.
  const parse = (ls: readonly string[]) => ls.map(l => JSON.parse(l) as MemoryRecord);
  const viewBefore = dedupe(parse(lines)).map(r => `${r.at} ${r.text}`).sort();
  const viewAfter = dedupe(parse(kept)).map(r => `${r.at} ${r.text}`).sort();
  assert.deepEqual(viewAfter, viewBefore, "the reader-visible view is untouched");

  // The retracted fact and the retraction both went; the live records kept their timestamps, so
  // decay is unchanged.
  const texts = kept.join("\n");
  assert.ok(!texts.includes("us-east-1"));
  assert.ok(!texts.includes("retraction"));
  assert.ok(texts.includes(at(4)), "original timestamp survives");
});

test("kept lines are the original bytes, so unknown fields survive an older writer", () => {
  // A field this version does not know about — written by a newer version, or an operator's
  // annotation — must not be silently stripped by re-serialising through today's type.
  const lines = [
    line({ at: at(1), kind: "fact", text: "one", futureField: { nested: true }, weight9000: 1 }),
    line({ at: at(1), kind: "fact", text: "one" }), // duplicate, later wins... same key, earlier dropped
    line({ at: at(2), kind: "fact", text: "two" }),
  ];
  const kept = compactMemoryLines(lines);
  assert.ok(kept);
  // The duplicate pair: later record wins, and the loser was the one CARRYING the future field —
  // dedupe chose, not us. The survivor "two" keeps its exact bytes.
  assert.ok(kept.includes(lines[2]!), "byte-identical line preserved");
});

test("a file of genuinely live records reports nothing to gain, not an empty rewrite", () => {
  const lines = Array.from({ length: 50 }, (_, i) =>
    line({ at: at(i + 1), kind: "fact", text: `distinct fact number ${i} about topic ${i}` })
  );
  assert.equal(compactMemoryLines(lines), undefined, "no shrink available is said, not faked");
});

test("unparseable lines are dropped — no reader has ever seen them", () => {
  const lines = [
    line({ at: at(1), kind: "fact", text: "real" }),
    '{"at":"2026-08-01T00:00:00Z","kind":"fact","text":', // torn
    "not json at all",
  ];
  const kept = compactMemoryLines(lines);
  assert.ok(kept);
  assert.deepEqual(kept, [lines[0]]);
});

// ── shared shards: the resurrection hazard ───────────────────────────────────────────

test("a cross-shard retraction is kept until its target is gone, then dropped — never the reverse", () => {
  // Rex recorded a fact; Ada later retracted it from her own shard. Pass one may drop the dead
  // fact (always safe) but must keep the retraction — its target was on disk when the pass was
  // decided. Pass two, with the fact genuinely gone, drops the retraction. At no point between any
  // two writes does replaying the on-disk state show the fact alive.
  const rex = [line({ at: at(1), kind: "fact", text: "the deploy key lives in vault nine" })];
  const ada = [line({ at: at(2), kind: "retraction", text: "the deploy key lives in vault nine" })];

  const pass1 = compactSharedShardLines(
    new Map([
      ["rex.jsonl", rex],
      ["ada.jsonl", ada],
    ])
  );
  assert.ok(pass1, "the dead fact shrinks pass one");
  assert.deepEqual(pass1.get("rex.jsonl"), [], "the dead fact went");
  assert.deepEqual(pass1.get("ada.jsonl"), ada, "the retraction stayed — its target was on disk");

  // Every intermediate on-disk state replays to "fact is dead". State A: only rex rewritten.
  const replay = (shards: Map<string, readonly string[]>) => {
    const records = [...shards.values()]
      .flat()
      .map(l => JSON.parse(l) as MemoryRecord)
      .sort((a, b) => a.at.localeCompare(b.at));
    return dedupe(records).map(r => r.text);
  };
  assert.deepEqual(
    replay(new Map([["rex.jsonl", pass1.get("rex.jsonl")!], ["ada.jsonl", ada]])),
    [],
    "crash after rewriting rex only: still dead"
  );

  // Pass two: fact gone from disk, retraction now inert and droppable.
  const pass2 = compactSharedShardLines(
    new Map([
      ["rex.jsonl", pass1.get("rex.jsonl")!],
      ["ada.jsonl", pass1.get("ada.jsonl")!],
    ])
  );
  assert.ok(pass2);
  assert.deepEqual(pass2.get("ada.jsonl"), [], "the inert retraction went on the second pass");
});

test("a fact re-recorded after its retraction stays live through compaction", () => {
  // Recorded, retracted, re-learned. The final fact is live; the old fact and — once nothing older
  // than it remains — the retraction are droppable. The re-record must never be treated as a
  // target of the earlier retraction.
  const shard = [
    line({ at: at(1), kind: "fact", text: "staging box is at 10.0.0.4" }),
    line({ at: at(2), kind: "retraction", text: "staging box is at 10.0.0.4" }),
    line({ at: at(3), kind: "fact", text: "staging box is at 10.0.0.4" }),
  ];
  const pass1 = compactSharedShardLines(new Map([["ada.jsonl", shard]]));
  assert.ok(pass1);
  const kept1 = pass1.get("ada.jsonl")!;
  assert.ok(kept1.includes(shard[2]!), "the re-record survives");
  assert.ok(!kept1.includes(shard[0]!), "the dead original went");

  const pass2 = compactSharedShardLines(new Map([["ada.jsonl", kept1]]));
  if (pass2 !== undefined) {
    assert.deepEqual(pass2.get("ada.jsonl"), [shard[2]], "only the live fact remains");
  } else {
    assert.deepEqual(kept1, [shard[2]], "already converged to just the live fact");
  }
});

// ── through the registry ─────────────────────────────────────────────────────────────

test("past the threshold, the file shrinks and the agent's view does not move", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memcompact-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });

    // The same fact re-recorded over and over — the accumulation pattern extraction produces —
    // plus a handful of distinct live ones.
    for (let i = 0; i < MEMORY_COMPACT_AT + 40; i++) {
      registry.appendMemoryRecords(ada.id, [
        { at: at((i % 90) + 1), kind: "note", text: `the build is green again ${i % 3}` },
      ]);
    }
    registry.appendMemoryRecords(ada.id, [
      { at: at(95), kind: "fact", text: "deployment region is eu-west-1" },
    ]);

    const path = registry.memoryRecordsPathFor(ada.id);
    const lines = readFileSync(path, "utf8").split("\n").filter(l => l.trim() !== "");
    assert.ok(
      lines.length <= MEMORY_COMPACT_AT + 2,
      `the file is bounded now: ${lines.length} lines`
    );

    const view = dedupe(registry.readMemoryRecords(ada.id)).map(r => r.text);
    assert.ok(view.includes("deployment region is eu-west-1"));
    assert.equal(view.filter(t => t.startsWith("the build is green")).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that cannot shrink is not rewritten on every append", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memfloor-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    for (let i = 0; i < MEMORY_COMPACT_AT + 5; i++) {
      registry.appendMemoryRecords(ada.id, [
        { at: at((i % 90) + 1), kind: "fact", text: `distinct live fact ${i} topic ${i * 7}` },
      ]);
    }
    const path = registry.memoryRecordsPathFor(ada.id);
    // The probe is the inode: a rewrite is temp-plus-rename, which replaces it; an append keeps it.
    // (A junk-line marker would not do — an unparseable line is itself droppable, so the marker
    // would manufacture exactly the shrink whose absence it was meant to prove.)
    const inodeBefore = statSync(path).ino;
    registry.appendMemoryRecords(ada.id, [
      { at: at(96), kind: "fact", text: "one more distinct live fact entirely" },
    ]);
    assert.equal(statSync(path).ino, inodeBefore, "no futile rewrite: the floor held");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
