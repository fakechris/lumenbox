/** A transcript is parsed once and then only what was appended, and reads the same as parsing the file (INV-1564). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptCache } from "./transcript-cache.ts";

/** The read the cache replaces, verbatim: what every answer must equal. */
function uncached(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter(line => line.trim() !== "").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-transcript-cache-"));
  return { dir, path: join(dir, "conversation.jsonl"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const line = (i: number) => `${JSON.stringify({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `turn ${i}` }] })}\n`;

test("read twice, parsed once; appended to, only the new lines are parsed; always what the file says", () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, [0, 1, 2].map(line).join(""));
    const cache = new TranscriptCache();
    assert.deepEqual(cache.read(path), uncached(path));
    assert.deepEqual(cache.read(path), uncached(path));
    assert.deepEqual(cache.counts, { full: 1, appended: 0, hits: 1 });
    appendFileSync(path, line(3) + line(4));
    assert.deepEqual(cache.read(path), uncached(path));
    assert.deepEqual(cache.counts, { full: 1, appended: 1, hits: 1 });
    // A torn line (a write caught midway) reads as the plain parse does, and is settled once whole.
    appendFileSync(path, '{"role":"user","content":[{"type":"te');
    assert.deepEqual(cache.read(path), uncached(path));
    appendFileSync(path, 'xt","text":"turn 5"}]}\n');
    assert.deepEqual(cache.read(path), uncached(path));
    assert.equal(cache.read(path).length, 6);
  } finally {
    cleanup();
  }
});

test("a file rewritten — in place and larger, or replaced by rename — is read whole, not appended to", () => {
  const { dir, path, cleanup } = scratch();
  try {
    writeFileSync(path, [0, 1].map(line).join(""));
    const cache = new TranscriptCache();
    cache.read(path);
    writeFileSync(path, [10, 11, 12].map(line).join("")); // same inode, longer, different bytes
    assert.deepEqual(cache.read(path), uncached(path));
    const replacement = join(dir, "next.jsonl");
    writeFileSync(replacement, line(20));
    renameSync(replacement, path); // what a rewrite-then-rename does: a new inode
    assert.deepEqual(cache.read(path), uncached(path));
    assert.equal(cache.counts.full, 3);
  } finally {
    cleanup();
  }
});

test("each epoch's file is its own entry, and a missing file is empty", () => {
  const { dir, cleanup } = scratch();
  try {
    const first = join(dir, "transcript-1.jsonl"), second = join(dir, "transcript-2.jsonl");
    writeFileSync(first, line(1));
    writeFileSync(second, line(2) + line(3));
    const cache = new TranscriptCache();
    assert.deepEqual([cache.read(first).length, cache.read(second).length], [1, 2]);
    assert.deepEqual(cache.read(join(dir, "nope.jsonl")), []);
  } finally {
    cleanup();
  }
});

test("entries are shared and frozen, so a caller cannot change what the next reader sees; the array is its own", () => {
  const { path, cleanup } = scratch();
  try {
    writeFileSync(path, line(0));
    const cache = new TranscriptCache();
    const first = cache.read(path);
    assert.throws(() => { (first[0] as { role: string }).role = "system"; }, TypeError);
    first.push({ role: "user" });
    assert.equal(cache.read(path).length, 1, "pushing to a returned array does not touch the kept one");
  } finally {
    cleanup();
  }
});

test("bounded: idle entries are let go, and least recently used first past the byte ceiling", () => {
  const { dir, cleanup } = scratch();
  try {
    let clock = 0;
    const cache = new TranscriptCache({ maxBytes: 150, idleMs: 1_000, now: () => clock });
    const paths = [0, 1, 2].map(i => join(dir, `t${i}.jsonl`));
    for (const p of paths) writeFileSync(p, line(1)); // ~70 bytes each
    cache.read(paths[0]!);
    clock = 10;
    cache.read(paths[1]!);
    clock = 20;
    cache.read(paths[2]!); // three past 150 bytes: the least recently used (t0) goes
    cache.read(paths[0]!);
    assert.equal(cache.counts.full, 4, "t0 was let go and read whole again");
    clock = 5_000;
    cache.read(paths[1]!);
    assert.equal(cache.counts.full, 5, "idle past a second: read whole again");
  } finally {
    cleanup();
  }
});
