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

// ── INV-1190: a switch that carries a handoff, and only ever moves forward ─────────────────

const OPENING = `${JSON.stringify({ role: "user", kind: "summary", covers: 0, handoff: { fromEpoch: 0 }, text: "## Goals\nship it", at: "2026-10-15T00:00:00.000Z" })}\n`;

test("a handoff becomes entry 0 of the new epoch, and the operation records it", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "old transcript\n");
    const next = f.store.advance("h1", 0, "normal", { opening: OPENING });
    assert.deepEqual([next.epoch, next.opening], [1, "handoff"]);
    assert.equal(readFileSync(f.store.path("transcript", 1), "utf8"), OPENING);
    assert.equal(readFileSync(f.store.path("transcript", 0), "utf8"), "old transcript\n", "legacy bytes preserved");
    assert.equal(new ContextEpochStore(f.paths).previousOperation("h1")?.opening, "handoff", "a replayed /new can say what it carried");
    assert.equal(existsSync(join(`${f.paths.transcript}.epochs`, "staging", "h1.jsonl")), false, "staging is cleaned up");
  } finally { f.cleanup(); }
});

test("a crash after prepare finishes the switch with its handoff on restart", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "old\n");
    const crashing = new ContextEpochStore(f.paths, () => { throw new Error("crash after prepare"); });
    assert.throws(() => crashing.advance("h2", 0, "normal", { opening: OPENING }), /crash/);
    const restarted = new ContextEpochStore(f.paths);
    assert.equal(restarted.current().epoch, 1);
    assert.equal(readFileSync(restarted.path("transcript", 1), "utf8"), OPENING, "never an empty current epoch");
    assert.equal(readFileSync(restarted.path("transcript", 0), "utf8"), "old\n");
  } finally { f.cleanup(); }
});

test("a staged handoff lost after prepare completes forward with a placeholder, never a rollback", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "old\n");
    const staging = join(`${f.paths.transcript}.epochs`, "staging", "h3.jsonl");
    const crashing = new ContextEpochStore(f.paths, () => { rmSync(staging); throw new Error("crash"); });
    assert.throws(() => crashing.advance("h3", 0, "normal", { opening: OPENING }), /crash/);
    const restarted = new ContextEpochStore(f.paths);
    assert.equal(restarted.current().epoch, 1, "moved forward");
    assert.match(readFileSync(restarted.path("transcript", 1), "utf8"), /Handoff from the previous context was lost/);
    assert.equal(restarted.previousOperation("h3")?.opening, "placeholder", "the reply can say so");
    assert.equal(readFileSync(restarted.path("transcript", 0), "utf8"), "old\n", "legacy history still readable");
  } finally { f.cleanup(); }
});

test("an opening already installed is kept when its staging is gone", () => {
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "old\n");
    const root = `${f.paths.transcript}.epochs`;
    const crashing = new ContextEpochStore(f.paths, () => {
      mkdirSync(join(root, "1"), { recursive: true });
      writeFileSync(join(root, "1", "transcript"), OPENING);
      rmSync(join(root, "staging", "h4.jsonl"));
      throw new Error("crash");
    });
    assert.throws(() => crashing.advance("h4", 0, "normal", { opening: OPENING }), /crash/);
    const restarted = new ContextEpochStore(f.paths);
    assert.equal(readFileSync(restarted.path("transcript", 1), "utf8"), OPENING);
    assert.equal(restarted.previousOperation("h4")?.opening, "handoff");
  } finally { f.cleanup(); }
});

test("a handoff that cannot be staged changes nothing, and never rides a clean switch", async () => {
  const { OpeningStagingError } = await import("./context-epoch.ts");
  const f = fixture();
  try {
    writeFileSync(f.paths.transcript, "old\n");
    mkdirSync(`${f.paths.transcript}.epochs`, { recursive: true });
    writeFileSync(join(`${f.paths.transcript}.epochs`, "staging"), "not a directory");
    assert.throws(() => f.store.advance("h5", 0, "normal", { opening: OPENING }), (error: unknown) => error instanceof OpeningStagingError);
    assert.equal(f.store.current().epoch, 0, "no prepare was written");
    assert.equal(readFileSync(f.paths.transcript, "utf8"), "old\n", "no migration happened");
    assert.throws(() => f.store.advance("h6", 0, "clean", { opening: OPENING }), /only rides a normal switch/);
  } finally { f.cleanup(); }
});
