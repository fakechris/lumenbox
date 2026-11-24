/** The People list's "last active" reads only what the logs gained since the last request, and agrees with a whole read (INV-2082). */

import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newestByKey } from "./newest-by-key.ts";

/** What a whole read says: the oracle the incremental one must agree with. */
function whole(path: string): Map<string, string> {
  const newest = new Map<string, string>();
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    try {
      const line = JSON.parse(raw) as { identity?: unknown; receivedAt?: unknown };
      if (typeof line.identity === "string" && typeof line.receivedAt === "string" && (newest.get(line.identity) ?? "") < line.receivedAt) newest.set(line.identity, line.receivedAt);
    } catch { /* torn or blank */ }
  }
  return newest;
}

const line = (identity: string, receivedAt: string) => `${JSON.stringify({ identity, receivedAt, text: "héllo — 你好" })}\n`;

test("appends, a line caught half-written, a rewrite and a removal all read as a whole read would", () => {
  const dir = mkdtempSync(join(tmpdir(), "newest-"));
  try {
    const path = join(dir, "messages.jsonl");
    const read = () => new Map(newestByKey(path, "identity", "receivedAt"));
    assert.deepEqual(read(), new Map(), "no log yet");

    writeFileSync(path, line("web:a", "2026-11-01T00:00:00Z") + line("web:b", "2026-11-02T00:00:00Z"));
    assert.deepEqual(read(), whole(path));

    appendFileSync(path, line("web:a", "2026-11-03T00:00:00Z") + "not json\n" + line("web:b", "2026-10-01T00:00:00Z"));
    assert.deepEqual(read(), whole(path));
    assert.equal(read().get("web:a"), "2026-11-03T00:00:00Z", "the appended tail moved a forward");

    // A writer caught mid-line: the half is not a line yet; once finished, it counts.
    const next = line("web:c", "2026-11-04T00:00:00Z");
    appendFileSync(path, next.slice(0, 20));
    assert.equal(read().get("web:c"), undefined);
    appendFileSync(path, next.slice(20));
    assert.equal(read().get("web:c"), "2026-11-04T00:00:00Z");
    assert.deepEqual(read(), whole(path));

    // Replaced atomically (a new file renamed over it): read again from the start, so a vanished row vanishes.
    writeFileSync(`${path}.partial`, line("web:d", "2026-11-05T00:00:00Z"));
    renameSync(`${path}.partial`, path);
    assert.deepEqual(read(), new Map([["web:d", "2026-11-05T00:00:00Z"]]));

    // Rewritten in place to something longer: the first bytes differ, so it is not mistaken for an append.
    writeFileSync(path, line("web:e", "2026-11-06T00:00:00Z") + line("web:e", "2026-11-07T00:00:00Z"));
    assert.deepEqual(read(), whole(path));
    assert.equal(read().has("web:d"), false);

    rmSync(path);
    assert.deepEqual(read(), new Map(), "a removed log says nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
