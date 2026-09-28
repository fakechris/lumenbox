/**
 * The mirror writes what changed, only when there is a box, and never lets a failure out.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryMirror } from "./memory-mirror.ts";
import { renderMemoryFiles } from "./memory.ts";
import type { MemoryRecord } from "./memory.ts";
import { readStanding, standingBoxDir, standingFileOf, writeStanding } from "./standing.ts";

function fakeRegistry(records: MemoryRecord[], agents: { id: string; name: string }[] = [{ id: "a1", name: "Ada Lovelace" }]) {
  const list = agents.map(a => ({ id: a.id, profile: { name: a.name, description: "" } }));
  const homes = new Map(list.map(a => [a.id, mkdtempSync(join(tmpdir(), "agentbox-mirror-standing-"))]));
  return {
    records,
    homes,
    registry: {
      readMemoryRecords: () => records,
      get: (id: string) => list.find(a => a.id === id),
      list: () => list,
      // The standing files (INV-777) ride the same sync; they need a host directory to be seeded in.
      dirFor: (id: string) => homes.get(id),
    } as never,
  };
}

/** A box that keeps its files in a Map: what the mirror wrote, and what a shell in the box may move. */
function fakeBox(files = new Map<string, string>(), writes: string[] = []) {
  return {
    files,
    writes,
    box: {
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
        writes.push(path);
      },
      readFile: async (path: string) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`${path} does not exist`);
        return { content };
      },
    },
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
  const { writes, box: live } = fakeBox();
  let box: typeof live | undefined;
  const mirror = new MemoryMirror({ registry, box: () => box });

  assert.deepEqual(await mirror.sync("a1"), { written: 0 });
  box = live;
  // The profile, and the four standing files (INV-777) that ride the same sync.
  assert.deepEqual(await mirror.sync("a1"), { written: 5 });
  assert.deepEqual(await mirror.sync("a1"), { written: 0 }, "unchanged content is not rewritten");
  records.push({ at: "2026-08-31T00:00:00.000Z", kind: "note", text: "a new note" });
  assert.deepEqual(await mirror.sync("a1"), { written: 1 }, "only the new month file");
  assert.deepEqual(writes, [
    "/home/box/work/memory/ada-lovelace/profile.md",
    "/home/box/work/standing/a1/AGENTS.md",
    "/home/box/work/standing/a1/SOUL.md",
    "/home/box/work/standing/a1/USER.md",
    "/home/box/work/standing/a1/HEARTBEAT.md",
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
      readFile: async () => {
        throw new Error("fs/read: 503");
      },
    }),
    log: line => lines.push(line),
  });
  assert.deepEqual(await mirror.sync("a1"), { written: 0 });
  assert.match(lines[0] ?? "", /could not write .*profile\.md \(fs\/write: 503\)/);
  // Not remembered as written: the next sync tries again — every file, the standing four included.
  await mirror.syncAll();
  assert.equal(lines.length, 10);
});

test("a shell edit of a standing file in the box is overwritten by the host copy on the next sync, said once (INV-803)", async () => {
  const { registry, homes } = fakeRegistry([fact("one")]);
  const { files, writes, box } = fakeBox();
  const lines: string[] = [];
  const mirror = new MemoryMirror({ registry, box: () => box, log: line => lines.push(line) });
  const path = "/home/box/work/standing/a1/AGENTS.md";

  await mirror.sync("a1");
  const host = readStanding(homes.get("a1")!, "Ada Lovelace")["AGENTS.md"];
  assert.equal(files.get(path), host);
  assert.deepEqual(lines, [], "a fresh box getting its first copy is not a shell edit");
  assert.deepEqual(await mirror.sync("a1"), { written: 0 }, "a box copy that matches is left alone");

  // `bash` edits the box copy: the host hash has not moved, and the old sync wrote nothing.
  files.set(path, "## Lessons\n\n- WRITTEN_BY_BASH\n");
  assert.deepEqual(await mirror.sync("a1"), { written: 1 });
  assert.equal(files.get(path), host, "the host copy is back; the box copy is not adopted");
  assert.equal(readStanding(homes.get("a1")!, "Ada Lovelace")["AGENTS.md"], host, "the host copy did not change");
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /AGENTS\.md was changed in the box outside the tools; restored the host copy/);
  assert.deepEqual(await mirror.sync("a1"), { written: 0 });
  assert.equal(lines.length, 1, "said once");

  // A person's host edit is an ordinary sync, not a shell edit: written down, nothing logged.
  writeStanding(homes.get("a1")!, "Ada Lovelace", "USER.md", "# USER.md\n\n- Call me: Skipper\n", "person");
  assert.deepEqual(await mirror.sync("a1"), { written: 1 });
  assert.equal(files.get("/home/box/work/standing/a1/USER.md"), "# USER.md\n\n- Call me: Skipper\n");
  assert.equal(lines.length, 1);
  assert.ok(writes.length > 0);
});

test("a standing file deleted in the box is restored from the host copy on the next sync (INV-803)", async () => {
  const { registry, homes } = fakeRegistry([fact("one")]);
  const { files, box } = fakeBox();
  const lines: string[] = [];
  const mirror = new MemoryMirror({ registry, box: () => box, log: line => lines.push(line) });
  const path = "/home/box/work/standing/a1/SOUL.md";

  await mirror.sync("a1");
  files.delete(path);
  assert.deepEqual(await mirror.sync("a1"), { written: 1 });
  assert.equal(files.get(path), readStanding(homes.get("a1")!, "Ada Lovelace")["SOUL.md"]);
  assert.match(lines[0]!, /SOUL\.md was deleted in the box outside the tools; restored the host copy/);
  assert.equal(lines.length, 1);
});

test("two agents whose names slug identically get distinct mirror directories and cannot see each other's files (INV-803)", async () => {
  const { registry, homes } = fakeRegistry([], [
    { id: "id-zhang", name: "张三" },
    { id: "id-li", name: "李四" },
  ]);
  const { files, box } = fakeBox();
  const mirror = new MemoryMirror({ registry, box: () => box });
  await mirror.syncAll();

  assert.notEqual(standingBoxDir("id-zhang"), standingBoxDir("id-li"));
  assert.equal(standingBoxDir("id-zhang"), "/home/box/work/standing/id-zhang");
  // One agent's lesson lands in its own box directory only.
  writeStanding(homes.get("id-zhang")!, "张三", "AGENTS.md", "## Lessons\n\n- ZHANG_ONLY\n", "agent");
  await mirror.syncAll();
  assert.match(files.get("/home/box/work/standing/id-zhang/AGENTS.md")!, /ZHANG_ONLY/);
  assert.doesNotMatch(files.get("/home/box/work/standing/id-li/AGENTS.md")!, /ZHANG_ONLY/);
  assert.doesNotMatch(readStanding(homes.get("id-li")!, "李四")["AGENTS.md"], /ZHANG_ONLY/);
  // A path under the other agent's directory is not one of this agent's standing files, so the
  // tools would not write it back into this agent's host copy.
  assert.equal(standingFileOf("/home/box/work/standing/id-zhang/AGENTS.md", "id-li"), undefined);
  assert.equal(standingFileOf("/home/box/work/standing/id-li/AGENTS.md", "id-li"), "AGENTS.md");
});
