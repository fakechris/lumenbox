/**
 * Tests for durable admission.
 *
 * The claim being pinned: work that was accepted and never begun survives a restart, and work that
 * had already begun does not come back. The second half matters as much as the first — replaying a
 * turn that had started would repeat whatever it had already done.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "./registry.ts";
import { AgentBus, type InboundMessage } from "./bus.ts";
import { Inbox } from "./inbox.ts";

function tempPath(name = "inbox.jsonl"): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-inbox-"));
  return { path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const message = (text: string): InboundMessage => ({
  fromId: "user",
  fromName: "user",
  text,
  priority: false,
  receivedAt: "2026-08-20T10:00:00.000Z",
});

test("what was accepted and never started comes back; what started does not", () => {
  const { path, cleanup } = tempPath();
  try {
    const inbox = new Inbox<InboundMessage>(path);
    const first = inbox.admit("agent-1", message("look at the logs"));
    const second = inbox.admit("agent-1", message("and then deploy"));
    assert.ok(first !== undefined && second !== undefined);

    // A turn takes the first one. Marked before anything runs, which is what makes replay safe:
    // the window this covers is the one where nothing has executed.
    inbox.start([first]);

    const afterRestart = new Inbox<InboundMessage>(path).pending();
    assert.equal(afterRestart.length, 1, "only the one no turn ever took");
    assert.equal(afterRestart[0]?.message.text, "and then deploy");
    assert.equal(afterRestart[0]?.agentId, "agent-1");
  } finally {
    cleanup();
  }
});

test("admission order survives, because a queue that reorders is not the same queue", () => {
  const { path, cleanup } = tempPath();
  try {
    const inbox = new Inbox<InboundMessage>(path);
    for (const text of ["one", "two", "three"]) inbox.admit("a", message(text));
    assert.deepEqual(
      new Inbox<InboundMessage>(path).pending().map(item => item.message.text),
      ["one", "two", "three"]
    );
  } finally {
    cleanup();
  }
});

test("a torn last line loses one message, not the file", () => {
  const { path, cleanup } = tempPath();
  try {
    const inbox = new Inbox<InboundMessage>(path);
    inbox.admit("a", message("intact"));
    appendFileSync(path, '{"seq":9,"event":"admitted","agentId":"a","at":"2026');

    const pending = new Inbox<InboundMessage>(path).pending();
    assert.deepEqual(pending.map(item => item.message.text), ["intact"]);
  } finally {
    cleanup();
  }
});

test("sequence numbers continue across a restart, so a new record cannot cancel an old one", () => {
  const { path, cleanup } = tempPath();
  try {
    const first = new Inbox<InboundMessage>(path);
    const seq = first.admit("a", message("still waiting"));

    // A fresh process admits something new. If numbering restarted, its `started` record would
    // cancel the message above instead of its own.
    const second = new Inbox<InboundMessage>(path);
    const next = second.admit("a", message("new work"));
    assert.notEqual(next, seq);
    second.start([next]);

    assert.deepEqual(
      new Inbox<InboundMessage>(path).pending().map(item => item.message.text),
      ["still waiting"]
    );
  } finally {
    cleanup();
  }
});

test("an unwritable inbox does not stop a message being delivered", () => {
  const warnings: string[] = [];
  // A directory that does not exist and cannot be created, because its parent is a file.
  const { path, cleanup } = tempPath("afile");
  try {
    const inbox = new Inbox<InboundMessage>(path);
    inbox.admit("a", message("recorded fine"));
    const blocked = new Inbox<InboundMessage>(join(path, "nested", "inbox.jsonl"), line =>
      warnings.push(line)
    );
    assert.equal(
      blocked.admit("a", message("cannot be recorded")),
      undefined,
      "no handle, so the turn knows there is nothing to mark started"
    );
    assert.ok(warnings.some(line => /cannot write/.test(line)), "and it is said, not swallowed");
  } finally {
    cleanup();
  }
});

test("no inbox configured means no file and no handles", () => {
  // `null`, not `undefined`: a default parameter fires on an explicit `undefined` too, so the two
  // had to be different words. Asking for no inbox with `undefined` wrote into the real state
  // directory, which is how this test found the bug.
  const inbox = new Inbox<InboundMessage>(null);
  assert.equal(inbox.admit("a", message("x")), undefined);
  assert.deepEqual(inbox.pending(), []);
});

// ── through the bus ───────────────────────────────────────────────────────────────────

test("a message accepted before a restart is run after it, once", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-inbox-bus-"));
  const { path, cleanup } = tempPath();
  try {
    const registry = new AgentRegistry(root);
    const ada = registry.create({ name: "Ada" });

    // The process that accepted the work and died before running it. Nothing consumes the queue.
    const accepting = new AgentBus(
      registry,
      async () => {},
      () => {},
      new Inbox<InboundMessage>(path)
    );
    accepting.sendFromUser(ada.id, "write the report");

    // Its replacement.
    const seen: string[] = [];
    const successor = new AgentBus(
      registry,
      async (_agent, inbound) => {
        for (const item of inbound) seen.push(item.text);
      },
      () => {},
      new Inbox<InboundMessage>(path)
    );
    assert.equal(successor.recover(), 1);
    await successor.idle();
    assert.deepEqual(seen, ["write the report"]);

    // And a third process does not run it again: the successor marked it started before running it.
    const third = new AgentBus(
      registry,
      async () => {
        throw new Error("nothing should be left to run");
      },
      () => {},
      new Inbox<InboundMessage>(path)
    );
    assert.equal(third.recover(), 0);
    await third.idle();
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("work for an agent that no longer exists is not resurrected", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-inbox-gone-"));
  const { path, cleanup } = tempPath();
  try {
    const registry = new AgentRegistry(root);
    const inbox = new Inbox<InboundMessage>(path);
    inbox.admit("agent-that-was-deleted", message("do the thing"));

    const bus = new AgentBus(registry, async () => {}, () => {}, new Inbox<InboundMessage>(path));
    assert.equal(bus.recover(), 0, "queuing for a missing agent would throw on every wake");
    // The record is still on disk rather than quietly rewritten — nothing here deletes evidence.
    assert.ok(readFileSync(path, "utf8").includes("agent-that-was-deleted"));
  } finally {
    cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});
