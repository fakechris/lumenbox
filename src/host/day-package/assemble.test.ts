/**
 * Tests for gathering a day.
 *
 * The property that carries this file is not "it finds things". It is that a day it could
 * not see fully says so. A package assembled from a host running an older build is missing
 * whole categories of material and looks exactly like a quiet day, and the difference
 * between those two is the difference between a record and a decoration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleDay,
  BOX_DIGEST_DIR,
  dayWindow,
  deliverPackageToBox,
  describeDay,
  verifyPackage,
} from "./assemble.ts";
import { keepFetchedPage } from "../fetched.ts";

function home(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-day-"));
  mkdirSync(join(path, "agents", "a1", "conversations"), { recursive: true });
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Local noon on the day under test, so no assertion depends on the runner's zone. */
const DAY = "2026-09-20";
const at = (hour: number, minute = 0): string =>
  new Date(2026, 8, 20, hour, minute, 0, 0).toISOString();

function writeLines(path: string, rows: unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
}

function aDay(root: string): void {
  writeLines(
    join(root, "messages.jsonl"),
    [0, 1, 2, 3, 4, 5].map(n => ({
      schema: "lumenbox.message/v1",
      id: `m-${n}`,
      channel: "feishu-personal",
      chatKey: "feishu-personal:oc_room",
      identity: "feishu-personal:ou_person",
      senderLabel: "宋传胜",
      conversationKey: "feishu-personal:oc_room",
      receivedAt: at(9 + n),
      text: n === 3 ? `a long one: ${"字".repeat(9_000)}` : `message ${n} about evaluation`,
      textChars: n === 3 ? 9_012 : 26,
      ...(n === 5 ? { files: [{ name: "notes.pdf", bytes: 4096 }] } : {}),
    }))
  );
  writeLines(
    join(root, "turns.jsonl"),
    [
      { id: "t-1", event: "begin", agentId: "a1", at: at(9, 1), attempt: 1, about: "read the first link", model: "claude-opus-5", build: { version: "0.2.1", commit: "abc1234" }, conversation: "feishu-personal-oc_room" },
      { id: "t-1", event: "end", at: at(9, 9), how: "done", evidence: [{ path: "/gone.md", sha256: "0".repeat(64), chars: 10, at: at(9, 2) }] },
      { id: "t-2", event: "begin", agentId: "a1", at: at(11), attempt: 1, about: "read the second link", model: "claude-opus-5", conversation: "feishu-personal-oc_room" },
      { id: "t-2", event: "end", at: at(11, 30), how: "done" },
      { id: "t-3", event: "begin", agentId: "a1", at: at(15), attempt: 1, about: "failed on the third", model: "claude-opus-5", conversation: "feishu-personal-oc_room" },
      { id: "t-3", event: "end", at: at(15, 2), how: "failed", category: "provider" },
      // Yesterday's turn, which must not appear.
      { id: "t-old", event: "begin", agentId: "a1", at: new Date(2026, 8, 19, 12).toISOString(), attempt: 1, about: "yesterday" },
      { id: "t-old", event: "end", at: new Date(2026, 8, 19, 12, 5).toISOString(), how: "done" },
    ]
  );
  writeLines(join(root, "agents", "a1", "conversations", "feishu-personal-oc_room.jsonl"), [
    { role: "assistant", text: "Here is what the first link says.", at: at(9, 8), turnId: "t-1" },
    { role: "assistant", text: "And the second.", at: at(11, 29), turnId: "t-2" },
  ]);
}

function aSource(root: string, n: number, text: string, hour: number, turnId?: string) {
  return keepFetchedPage(
    {
      url: `https://example.com/${n}`,
      finalUrl: `https://example.com/${n}`,
      title: `Source ${n}`,
      text,
      contentType: "text/html",
      bytes: text.length * 2,
      clipped: false,
      completeness: "full",
      meta: {},
      agent: { id: "a1", name: "Nova" },
      ...(turnId !== undefined ? { turnId } : {}),
      fetchedAt: new Date(at(hour)),
    },
    root
  );
}

test("a day comes back whole: every message, every turn, every source, every reply", () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    aSource(path, 0, "the first source said something worth quoting.", 9, "t-1");
    aSource(path, 1, "the second source disagreed.", 11, "t-2");

    const { manifest, dir } = assembleDay(DAY, { home: path });
    assert.equal(manifest.messages.length, 6);
    assert.equal(manifest.turns.length, 3, "yesterday's turn is not this day's");
    assert.equal(manifest.sources.length, 2);
    assert.equal(manifest.replies.length, 2);

    // Whole, not the inbox's clamped copy: the long one is all there.
    const long = manifest.messages.find(one => one.chars > 8_000)!;
    assert.ok(long.text.endsWith("字"), "the long message is not truncated");
    assert.equal(long.source, "ledger");
    // Attachments travel as a listing.
    assert.deepEqual(manifest.messages.at(-1)!.files, [{ name: "notes.pdf", bytes: 4096 }]);
    // A failed turn is still a turn, with why.
    const failed = manifest.turns.find(one => one.how === "failed")!;
    assert.equal(failed.category, "provider");
    assert.equal(manifest.turns[0]!.build?.commit, "abc1234");

    // The reply text is a file, and the manifest points at it.
    assert.match(readFileSync(join(dir, manifest.replies[0]!.path), "utf8"), /what the first link says/);
    assert.ok(readFileSync(join(dir, `sources/${manifest.sources[0]!.key}.md`), "utf8").includes("worth quoting"));
  } finally {
    cleanup();
  }
});

test("a package verifies against its own READY, and READY is written last", () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    aSource(path, 0, "a source", 9);
    const { dir } = assembleDay(DAY, { home: path });

    const first = verifyPackage(dir);
    assert.ok(first.verified >= 3, `only ${first.verified} files checked`);
    assert.deepEqual(first.mismatched, []);
    assert.deepEqual(first.missing, []);

    // A file edited after the fact is caught, which is the point of writing READY at all.
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")} `);
    assert.deepEqual(verifyPackage(dir).mismatched, ["manifest.json"]);
  } finally {
    cleanup();
  }
});

test("the same day twice is the same bytes, because evidence that changes is not evidence", () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    aSource(path, 0, "a source", 9);
    const hashes = (dir: string) =>
      readFileSync(join(dir, "READY"), "utf8")
        .split("\n")
        .filter(line => !line.startsWith("#") && line.trim() !== "");

    const first = assembleDay(DAY, { home: path, now: new Date(at(23)) });
    const before = hashes(first.dir);
    const manifestBefore = readFileSync(join(first.dir, "manifest.json"), "utf8");

    const second = assembleDay(DAY, { home: path, now: new Date(at(23, 30)) });
    assert.equal(second.dir, first.dir, "the same day is the same package");
    // Every hashed file, the manifest included, is a pure function of the day's material.
    // So "did anything about this day change" is two numbers compared, not a diff read.
    assert.deepEqual(hashes(second.dir), before);
    assert.equal(readFileSync(join(second.dir, "manifest.json"), "utf8"), manifestBefore);
    // The instant the package was made is recorded, just not where it would poison that.
    assert.match(readFileSync(join(second.dir, "READY"), "utf8"), /^# generated 2026-/);
  } finally {
    cleanup();
  }
});

test("a day the host could not fully see says so, and says which build it was", () => {
  const { path, cleanup } = home();
  try {
    // A day from before the ledgers: a transcript and nothing else, which is what every
    // day before each of these changes was deployed actually looks like.
    writeLines(join(path, "turns.jsonl"), [
      { id: "t-1", event: "begin", agentId: "a1", at: at(10), attempt: 1, about: "an old turn", build: { version: "0.2.0", commit: "cc71f82" } },
      { id: "t-1", event: "end", at: at(10, 5), how: "done" },
    ]);
    writeLines(join(path, "agents", "a1", "conversation.jsonl"), [
      { role: "user", text: "what does this link say", at: at(10) },
      { role: "assistant", text: "it says a thing", at: at(10, 4) },
    ]);

    const { manifest } = assembleDay(DAY, { home: path });
    assert.equal(manifest.messages.length, 1);
    assert.equal(manifest.messages[0]!.source, "transcript");

    const reasons = Object.fromEntries(manifest.gaps.map(gap => [gap.what, gap.why]));
    assert.match(reasons.messages!, /cut at 8,000 characters/);
    assert.match(reasons.messages!, /INV-613/);
    // Named, with the commit it actually saw — so a reader can check the claim.
    assert.match(reasons.evidence!, /cc71f82/);
    assert.match(reasons.results!, /INV-633/);
    assert.match(reasons.replies!, /matched by turnId/);

    const said = describeDay(manifest, "/tmp/x").join("\n");
    assert.match(said, /this package is incomplete and here is why/);
    assert.doesNotMatch(said, /no gaps/);
  } finally {
    cleanup();
  }
});

test("a complete day says it is complete, which is a different statement from being quiet", () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    mkdirSync(join(path, "results"), { recursive: true });
    aSource(path, 0, "a source", 9, "t-1");
    const { manifest } = assembleDay(DAY, { home: path });
    assert.deepEqual(manifest.gaps, []);
    assert.match(describeDay(manifest, "/tmp/x").join("\n"), /no gaps: everything this day produced/);
  } finally {
    cleanup();
  }
});

test("an expired source keeps its row and loses only its body", () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    const kept = aSource(path, 0, "this one is still here", 9, "t-1");
    const { manifest, dir } = assembleDay(DAY, { home: path });
    // The one that exists travels whole.
    const live = manifest.sources.find(one => one.sha256 === kept.sha256)!;
    assert.equal(live.state, "kept");
    assert.ok(readFileSync(join(dir, `sources/${live.key}.md`), "utf8").includes("still here"));
    // And a turn's pointer to something already pruned does not crash the assembly: the
    // turn's own record still names it, which is INV-659 earning its keep.
    assert.deepEqual(manifest.turns[0]!.read, ["/gone.md"]);
  } finally {
    cleanup();
  }
});

test("secrets do not travel, and the package says how much it removed", () => {
  const { path, cleanup } = home();
  try {
    const secret = "sk-live-0123456789abcdef0123";
    writeLines(join(path, "messages.jsonl"), [
      { schema: "lumenbox.message/v1", id: "m-0", chatKey: "c", receivedAt: at(9), text: `the key is ${secret} please use it`, textChars: 40 },
    ]);
    writeLines(join(path, "turns.jsonl"), []);
    const held = new Map([["vault:SHOP_KEY", secret]]);
    const { manifest, dir } = assembleDay(DAY, { home: path, held });

    assert.ok(manifest.redactions.exact > 0);
    assert.doesNotMatch(manifest.messages[0]!.text, new RegExp(secret));
    assert.match(manifest.messages[0]!.text, /<redacted:vault:SHOP_KEY>/);
    assert.doesNotMatch(readFileSync(join(dir, "manifest.json"), "utf8"), new RegExp(secret));
  } finally {
    cleanup();
  }
});

test("a day with nothing in it is a package, not an error", () => {
  const { path, cleanup } = home();
  try {
    const { manifest, dir } = assembleDay(DAY, { home: path });
    assert.deepEqual(manifest.messages, []);
    assert.deepEqual(manifest.turns, []);
    assert.equal(verifyPackage(dir).mismatched.length, 0);
    assert.ok(readFileSync(join(dir, "READY"), "utf8").includes("manifest.json"));
  } finally {
    cleanup();
  }
});

test("the window is the local day, and it records the offset so the boundary can be redone", () => {
  const window = dayWindow("2026-09-20");
  assert.equal(window.date, "2026-09-20");
  assert.equal(Date.parse(window.to) - Date.parse(window.from), 24 * 3_600_000);
  assert.equal(window.offsetMinutes, -new Date(2026, 8, 20).getTimezoneOffset());
  // Local midnight, whatever the runner's zone: a person asking for "today" means the day
  // they lived through, not a UTC window that cuts their evening in half.
  assert.equal(new Date(window.from).getHours(), 0);
  assert.throws(() => dayWindow("20th September"), /Not a date/);
});

test("a package is delivered where the reader can reach it, READY last", async () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    aSource(path, 0, "a source the digest will cite", 9, "t-1");
    const { dir, manifest } = assembleDay(DAY, { home: path });

    // The skill runs inside the box, which cannot see the host's directory. Getting this
    // wrong shipped an unrunnable skill once (INV-670 follow-up), so the delivery is
    // asserted rather than assumed.
    const uploaded: string[] = [];
    await deliverPackageToBox(dir, manifest.runKey, {
      uploadFile: async (at: string) => {
        uploaded.push(at);
      },
    });

    assert.ok(uploaded.length >= 4, `only ${uploaded.length} files delivered`);
    for (const at of uploaded) {
      assert.ok(at.startsWith(`${BOX_DIGEST_DIR}/${manifest.runKey}/package/`), at);
    }
    assert.ok(uploaded.some(at => at.endsWith("/manifest.json")));
    assert.ok(uploaded.some(at => at.includes("/sources/")));
    assert.ok(uploaded.some(at => at.includes("/turns/t-1/reply.md")), "nested paths survive");
    // Last, for the same reason it is written last: a half-delivered package that already
    // claims to be ready is worse than one that has not arrived.
    assert.ok(uploaded.at(-1)!.endsWith("/READY"), uploaded.at(-1) ?? "nothing was delivered");
  } finally {
    cleanup();
  }
});

test("a delivery that fails partway says which files, and does not claim the package arrived", async () => {
  const { path, cleanup } = home();
  try {
    aDay(path);
    const { dir, manifest } = assembleDay(DAY, { home: path });
    const said: string[] = [];
    const result = await deliverPackageToBox(
      dir,
      manifest.runKey,
      {
        uploadFile: async (at: string) => {
          if (at.endsWith("manifest.json")) throw new Error("box is full");
        },
      },
      line => said.push(line)
    );
    assert.deepEqual(result.failed, ["manifest.json"]);
    assert.ok(result.delivered >= 1);
    assert.match(said.join("\n"), /could not deliver manifest\.json: box is full/);
  } finally {
    cleanup();
  }
});
