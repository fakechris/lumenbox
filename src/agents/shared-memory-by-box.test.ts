/**
 * Memory follows the place (INV-424, docs/50 H1).
 *
 * A shared record is stamped with the box it was kept in and read back only by that
 * box's agents, unless it was promoted to everyone. Records from before boxes stay
 * visible everywhere: nothing is withdrawn by the change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";

test("a box's agents read their own box's shared memory, what was promoted, and what predates boxes", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-shared-box-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    const grok = registry.attachBox({
      id: "box-grok",
      name: "grok",
      kind: "attached",
      displayFloor: 10,
      workDir: "/home/box/work",
      members: "everyone",
      createdAt: new Date().toISOString(),
    } as never);
    const bob = registry.create({ name: "Bob", boxId: grok.id });

    registry.appendSharedMemory(ada.id, [{ at: "2026-09-11T01:00:00.000Z", kind: "fact", text: "Ada's box uses the staging cluster" }]);
    registry.appendSharedMemory(bob.id, [
      { at: "2026-09-11T02:00:00.000Z", kind: "fact", text: "Bob's box deploys on Fridays" },
      { at: "2026-09-11T03:00:00.000Z", kind: "fact", text: "The person prefers 中文", audience: "everyone" },
    ]);
    // A record from before boxes existed: no box field at all.
    const legacy = { at: "2026-09-10T00:00:00.000Z", kind: "fact", text: "Old shared note" };
    const adaShard = registry.sharedMemoryPathFor(ada.id);
    const raw = readFileSync(adaShard, "utf8");
    assert.match(raw, new RegExp(`"box":"${registry.box.id}"`), "the writer's box is stamped on write");
    appendFileSync(adaShard, `${JSON.stringify(legacy)}\n`);

    const adaSees = registry.readSharedMemory(ada.id).map(record => record.text);
    assert.deepEqual(adaSees, ["Old shared note", "Ada's box uses the staging cluster", "The person prefers 中文"]);
    const bobSees = registry.readSharedMemory(bob.id).map(record => record.text);
    assert.deepEqual(bobSees, ["Old shared note", "Bob's box deploys on Fridays", "The person prefers 中文"]);
    // The installation-level read, for compaction and the admin view, is everything.
    assert.equal(registry.readSharedMemory().length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── a topic inherits the room it opened in (INV-436) ────────────────────────────────
test("a fresh thread is seeded from the room's recent chatter once, marked as from the room, and never again", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-thread-seed-"));
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });
    const room = "feishu-oc_room";
    const thread = "feishu-oc_room-om_topic";
    assert.equal(registry.isFreshConversation(ada.id, thread), true);
    for (let i = 1; i <= 15; i++) {
      registry.appendHeard(ada.id, room, { at: `2026-09-11T10:${String(i).padStart(2, "0")}:00.000Z`, sender: "bob", text: `room line ${i}` });
    }
    const seeded = registry.seedHeardFrom(ada.id, thread, room);
    assert.equal(seeded, 12, "bounded to the last dozen lines");
    const heard = registry.readHeard(ada.id, thread);
    assert.equal(heard[0]?.text, "[from the room] room line 4");
    assert.equal(heard[heard.length - 1]?.text, "[from the room] room line 15");
    assert.equal(registry.isFreshConversation(ada.id, thread), false);
    // The thread has context now; a second seed does nothing.
    assert.equal(registry.seedHeardFrom(ada.id, thread, room), 0);
    assert.equal(registry.readHeard(ada.id, thread).length, 12);
    // A thread with a transcript but nothing heard is not fresh either.
    const other = "feishu-oc_room-om_other";
    registry.appendTranscript(ada.id, { role: "user", text: "hi", at: "2026-09-11T11:00:00.000Z" } as never, other);
    assert.equal(registry.isFreshConversation(ada.id, other), false);
    assert.equal(registry.seedHeardFrom(ada.id, other, room), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
