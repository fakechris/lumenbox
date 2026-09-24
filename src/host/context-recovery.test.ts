import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { newContext } from "./context-recovery.ts";
import { Rememberer, EXTRACT_EVERY } from "./remember.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumenbox-recovery-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Nova", boxId: registry.box.id });
  const input = { agentId: agent.id, conversation: "feishu-private", operationId: "m1", identity: "user", privateChat: true };
  return { registry, agent, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("new context is authorised, private, idle, idempotent and never erases history or memory", () => {
  const f = fixture();
  try {
    const { registry, input, agent } = f;
    registry.appendTranscript(agent.id, { role: "user", text: "OLD" }, input.conversation);
    registry.writePlan(agent.id, "OLD PLAN", input.conversation);
    registry.appendMemoryRecords(agent.id, [{ at: new Date().toISOString(), kind: "fact", text: "Deploy in Tokyo" }]);
    let blockers = ["task 25 待交付", "两条请求排队"];
    const deps = { registry, mayReset: () => true, blockers: () => blockers };
    assert.equal(newContext({ ...deps, mayReset: () => false }, input).status, "refused");
    for (const conversation of ["main", "fork/123", "../outside"]) {
      assert.equal(newContext(deps, { ...input, conversation }).status, "refused");
    }
    assert.equal(newContext(deps, { ...input, privateChat: false }).status, "refused");
    assert.match(newContext(deps, input).text, /task 25/);
    assert.equal(registry.contextVersion(agent.id, input.conversation), 0);
    blockers = [];
    assert.equal(newContext(deps, input).status, "switched");
    assert.deepEqual(registry.readTranscript(agent.id, input.conversation), []);
    assert.deepEqual(registry.readDurableState(agent.id, input.conversation), {});
    assert.equal(registry.readAllContextTranscripts(agent.id, input.conversation).length, 1);
    assert.equal(registry.readMemoryRecords(agent.id).length, 1);
    assert.ok(registry.listConversations(agent.id).some(item => item.id === input.conversation));
    blockers = ["a NEW task is running"];
    assert.equal(newContext(deps, input).status, "replayed");
    assert.equal(registry.contextVersion(agent.id, input.conversation), 1);
  } finally { f.cleanup(); }
});

test("late old producers stay on old transcript and cannot publish personal or shared memory", async () => {
  const f = fixture();
  try {
    const { registry, agent, input } = f;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const old = registry.withContext(agent.id, input.conversation, async () => {
      await wait;
      registry.appendTranscript(agent.id, { role: "assistant", text: "late old output" }, input.conversation);
      registry.writePlan(agent.id, "late old plan", input.conversation);
      const record = { at: new Date().toISOString(), kind: "note" as const, text: "old habit" };
      assert.throws(() => registry.appendMemoryRecords(agent.id, [record]), /Stale context/);
      assert.throws(() => registry.appendSharedMemory(agent.id, [record]), /Stale context/);
    });
    registry.contextStore(agent.id, input.conversation).advance("m1", 0);
    release();
    await old;
    assert.deepEqual(registry.readTranscript(agent.id, input.conversation), []);
    assert.deepEqual(registry.readDurableState(agent.id, input.conversation), {});
    assert.match(JSON.stringify(registry.readAllContextTranscripts(agent.id, input.conversation)), /late old output/);
    assert.equal(registry.seedHeardFrom(agent.id, input.conversation, "main"), 0);
  } finally { f.cleanup(); }
});

test("clean context persists, refuses learning, and an ordinary new context explicitly exits it", () => {
  const f = fixture();
  try {
    const deps = { registry: f.registry, mayReset: () => true, blockers: () => [] };
    const clean = newContext(deps, { ...f.input, operationId: "clean", mode: "clean" });
    assert.equal(clean.status, "switched");
    assert.match(clean.text, /干净上下文/);
    assert.equal(f.registry.contextMode(f.agent.id, f.input.conversation), "clean");
    f.registry.withContext(f.agent.id, f.input.conversation, () => {
      const record = { at: new Date().toISOString(), kind: "note" as const, text: "must not escape" };
      assert.throws(() => f.registry.appendMemoryRecords(f.agent.id, [record]), /Clean context/);
      assert.throws(() => f.registry.appendSharedMemory(f.agent.id, [record]), /Clean context/);
      assert.equal(f.registry.contextWriteGuard()(), false);
    });
    assert.equal(newContext(deps, { ...f.input, operationId: "clean", mode: "clean" }).status, "replayed");
    const normal = newContext(deps, { ...f.input, operationId: "normal" });
    assert.match(normal.text, /已退出干净模式/);
    assert.equal(f.registry.contextMode(f.agent.id, f.input.conversation), "normal");
  } finally { f.cleanup(); }
});

test("an in-flight extraction cannot reintroduce the old context after new", async () => {
  const f = fixture();
  try {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const rememberer = new Rememberer({
      registry: f.registry,
      provider: { model: "test", maxTokens: 1024 } as never,
      client: { messages: { create: async () => {
        entered(); await hold;
        return { content: [{ type: "text", text: "Always write seventeen blind spots" }], usage: {} };
      } } } as never,
    });
    const learning = f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.flush(f.agent.id, "old conversation"));
    await started;
    f.registry.contextStore(f.agent.id, f.input.conversation).advance("new", 0);
    release();
    await learning;
    assert.deepEqual(f.registry.readMemoryRecords(f.agent.id), []);
  } finally { f.cleanup(); }
});

test("a buffered old exchange cannot hitchhike in a later new-epoch extraction batch", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const rememberer = new Rememberer({ registry: f.registry, provider: {} as never,
      client: { messages: { create: async () => { calls++; throw new Error("must not extract stale batch"); } } } as never });
    await f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.record({ agentId: f.agent.id, text: "OLD" }));
    f.registry.contextStore(f.agent.id, f.input.conversation).advance("new", 0);
    for (let i = 1; i < EXTRACT_EVERY; i++) {
      await f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.record({ agentId: f.agent.id, text: "NEW" }));
    }
    assert.equal(calls, 0);
  } finally { f.cleanup(); }
});
