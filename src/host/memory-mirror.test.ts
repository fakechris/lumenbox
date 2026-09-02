/**
 * The mirror writes what changed, only when there is a box, and never lets a failure out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryMirror } from "./memory-mirror.ts";
import { renderMemoryFiles } from "./memory.ts";
import type { MemoryRecord } from "./memory.ts";

function fakeRegistry(records: MemoryRecord[]) {
  const agent = { id: "a1", profile: { name: "Ada Lovelace", description: "" } };
  return {
    records,
    registry: {
      readMemoryRecords: () => records,
      get: (id: string) => (id === "a1" ? agent : undefined),
      list: () => [agent],
    } as never,
  };
}

const fact = (text: string, at = "2026-08-30T10:00:00.000Z"): MemoryRecord => ({ at, kind: "fact", text });

test("profile and monthly logs are rendered from the live view, with retractions applied", () => {
  const files = renderMemoryFiles("Ada Lovelace", [
    fact("the deploy region is us-east-1", "2026-07-01T00:00:00.000Z"),
    { at: "2026-07-02T00:00:00.000Z", kind: "retraction", text: "the deploy region is us-east-1" },
    fact("the deploy region is eu-west-1", "2026-07-03T00:00:00.000Z"),
    { at: "2026-07-05T00:00:00.000Z", kind: "pitfall", text: "npx resolves an old tsc" },
    { at: "2026-07-09T00:00:00.000Z", kind: "note", text: "chris prefers short replies" },
    { at: "2026-08-01T00:00:00.000Z", kind: "episode", text: "ran the weekly retro" },
  ]);
  assert.deepEqual(
    files.map(file => file.path),
    [
      "/home/box/work/memory/ada-lovelace/profile.md",
      "/home/box/work/memory/ada-lovelace/log/2026-07.md",
      "/home/box/work/memory/ada-lovelace/log/2026-08.md",
    ]
  );
  const profile = files[0]!.content;
  assert.match(profile, /read-only mirror/);
  assert.match(profile, /eu-west-1/);
  assert.ok(!profile.includes("us-east-1"), "a retracted fact is not standing");
  assert.match(profile, /## Pitfalls\n\n- 2026-07-05: npx resolves an old tsc/);
  assert.match(files[1]!.content, /\[note\] chris prefers short replies/);
  assert.match(files[2]!.content, /\[episode\] ran the weekly retro/);
});

test("sync writes changed files only, and a box that is not there costs nothing", async () => {
  const { records, registry } = fakeRegistry([fact("one")]);
  const writes: string[] = [];
  let box: { writeFile: (path: string, content: string) => Promise<unknown> } | undefined;
  const mirror = new MemoryMirror({ registry, box: () => box });

  assert.deepEqual(await mirror.sync("a1"), { written: 0 });
  box = { writeFile: async path => void writes.push(path) };
  assert.deepEqual(await mirror.sync("a1"), { written: 1 });
  assert.deepEqual(await mirror.sync("a1"), { written: 0 }, "unchanged content is not rewritten");
  records.push({ at: "2026-08-31T00:00:00.000Z", kind: "note", text: "a new note" });
  assert.deepEqual(await mirror.sync("a1"), { written: 1 }, "only the new month file");
  assert.deepEqual(writes, [
    "/home/box/work/memory/ada-lovelace/profile.md",
    "/home/box/work/memory/ada-lovelace/log/2026-08.md",
  ]);
  assert.deepEqual(await mirror.sync("nobody"), { written: 0 });
});

test("a box that refuses the write is a log line, not a failure", async () => {
  const { registry } = fakeRegistry([fact("one")]);
  const lines: string[] = [];
  const mirror = new MemoryMirror({
    registry,
    box: () => ({
      writeFile: async () => {
        throw new Error("fs/write: 503");
      },
    }),
    log: line => lines.push(line),
  });
  assert.deepEqual(await mirror.sync("a1"), { written: 0 });
  assert.match(lines[0] ?? "", /could not write .*profile\.md \(fs\/write: 503\)/);
  // Not remembered as written: the next sync tries again.
  await mirror.syncAll();
  assert.equal(lines.length, 2);
});
