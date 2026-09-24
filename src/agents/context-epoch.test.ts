import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEpochStore } from "./context-epoch.ts";
import { AgentRegistry } from "./registry.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumenbox-context-"));
  const paths = { transcript: join(root, "chat.jsonl"), plan: join(root, "chat.plan.md") };
  return { root, paths, store: new ContextEpochStore(paths), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("new epoch preserves legacy bytes, clears the active view, survives restart, and rejects stale revision", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, 'old transcript\n');
    writeFileSync(f.paths.plan, "old plan");
    assert.equal(f.store.current().epoch, 0);
    assert.equal(f.store.path("transcript", 0), f.paths.transcript);
    const next = f.store.advance("request-1", 0);
    assert.equal(next.epoch, 1);
    assert.equal(readFileSync(f.store.path("transcript", 0), "utf8"), 'old transcript\n');
    assert.equal(readFileSync(f.store.path("plan", 0), "utf8"), "old plan");
    assert.equal(existsSync(f.store.path("transcript", 1)), false);
    assert.throws(() => readFileSync(f.paths.transcript, "utf8"), "old binaries must not silently read polluted legacy context");
    const restarted = new ContextEpochStore(f.paths);
    assert.equal(restarted.current().epoch, 1);
    assert.deepEqual(restarted.advance("request-1", 0), next, "redelivery is idempotent even with an old revision");
    assert.throws(() => restarted.advance("request-2", 0), /revision/);
    assert.equal(restarted.advance("request-2", 1).epoch, 2);
    assert.equal(restarted.advance("request-1", 0).epoch, 1, "old command cannot reset a newer topic");
  } finally { f.cleanup(); }
});

test("a crash after prepare completes the same operation on restart", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "original");
    const crashing = new ContextEpochStore(f.paths, () => { throw new Error("crash after prepare"); });
    assert.throws(() => crashing.advance("m1", 0), /crash/);
    const restarted = new ContextEpochStore(f.paths);
    assert.equal(restarted.current().epoch, 1);
    assert.equal(restarted.advance("m1", 0).epoch, 1);
    assert.equal(readFileSync(restarted.path("transcript", 0), "utf8"), "original");
  } finally { f.cleanup(); }
});

test("conversation discovery lists an epoch-backed chat once and ignores unrelated jsonl directories", () => {
  const root = mkdtempSync(join(tmpdir(), "lumenbox-context-list-"));
  try {
    const registry = new AgentRegistry(root);
    const agent = registry.create({ name: "Nova", boxId: registry.box.id });
    registry.appendTranscript(agent.id, { role: "user", text: "old" }, "private-chat");
    registry.contextStore(agent.id, "private-chat").advance("m1", 0);
    mkdirSync(join(registry.dirFor(agent.id), "conversations", "not-a-chat.jsonl"));
    assert.deepEqual(registry.listConversations(agent.id).map(item => item.id), ["main", "private-chat"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
