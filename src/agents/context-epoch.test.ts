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
    assert.equal(f.store.current().mode, "normal");
    assert.equal(f.store.path("transcript", 0), f.paths.transcript);
    const next = f.store.advance("request-1", 0);
    assert.equal(next.epoch, 1);
    assert.equal(next.mode, "normal");
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

test("clean mode is durable per epoch and old state files default to normal", () => {
  const f = fixture();
  try {
    const clean = f.store.advance("clean-1", 0, "clean");
    assert.deepEqual(clean, { epoch: 1, mode: "clean" });
    assert.deepEqual(new ContextEpochStore(f.paths).current(), clean);
    const normal = new ContextEpochStore(f.paths).advance("normal-2", 1);
    assert.deepEqual(normal, { epoch: 2, mode: "normal" });

    const oldRoot = join(f.root, "old.jsonl.epochs");
    mkdirSync(oldRoot, { recursive: true });
    writeFileSync(join(oldRoot, "state.json"), JSON.stringify({
      schema: 1, epoch: 1, operations: [{ id: "legacy", epoch: 1 }],
    }));
    const old = new ContextEpochStore({ transcript: join(f.root, "old.jsonl") });
    assert.deepEqual(old.current(), { epoch: 1, mode: "normal" });
    assert.deepEqual(old.previousOperation("legacy"), { epoch: 1, mode: "normal" });
  } finally { f.cleanup(); }
});

test("a state file cannot claim normal mode for an epoch committed as clean", () => {
  const f = fixture();
  try {
    const root = `${f.paths.transcript}.epochs`;
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "state.json"), JSON.stringify({
      schema: 1, epoch: 1, mode: "normal", operations: [{ id: "clean", epoch: 1, mode: "clean" }],
    }));
    assert.throws(() => f.store.current(), /corrupt context state/);
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
