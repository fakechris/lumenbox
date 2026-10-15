import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { contextTaskBlockers, newContext } from "./context-recovery.ts";
import { Rememberer, EXTRACT_EVERY } from "./remember.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumenbox-recovery-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Nova", boxId: registry.box.id });
  const input = { agentId: agent.id, conversation: "feishu-private", operationId: "m1", identity: "user", privateChat: true };
  return { registry, agent, input, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("review tasks stay on the board but do not trap a finished conversation", () => {
  const tasks = [
    { id: "t11", status: "review" as const, conversation: "feishu-private" },
    { id: "t12", status: "review" as const, conversation: "feishu-private" },
    { id: "t13", status: "doing" as const, conversation: "another-room" },
  ];
  assert.deepEqual(contextTaskBlockers(tasks, "feishu-private"), []);
  assert.deepEqual(contextTaskBlockers([...tasks, { id: "t14", status: "blocked", conversation: "feishu-private" }], "feishu-private"), ["任务 t14：blocked"]);
});

test("a running pursuit holds the conversation and names the way out; a paused one does not (INV-769)", () => {
  const pursuit = (status: "active" | "verifying" | "paused") => ({ status, workId: "w", objective: "x", checklist: [], limits: { continuations: 30, activeMs: 1 }, spent: { continuations: 0, idleStreak: 0, rejections: 0, activeMs: 0, cost: 0 }, createdAt: "2026-09-27T00:00:00Z" });
  const tasks = [
    { id: "t1", status: "doing" as const, conversation: "feishu-private", pursuit: pursuit("active") },
    { id: "t2", status: "blocked" as const, conversation: "feishu-private", pursuit: pursuit("paused") },
    { id: "t3", status: "doing" as const, conversation: "feishu-private" },
  ];
  assert.deepEqual(contextTaskBlockers(tasks, "feishu-private"), ["目标 t1 正在推进（active）：先 /goal pause 或 /goal clear", "任务 t3：doing"]);
  assert.deepEqual(contextTaskBlockers([tasks[1]!], "feishu-private"), [], "paused: the board keeps it, /goal resume brings it back");
  assert.deepEqual(contextTaskBlockers([{ ...tasks[0]!, pursuit: pursuit("verifying") }], "feishu-private"), ["目标 t1 正在推进（verifying）：先 /goal pause 或 /goal clear"]);
});

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
    assert.match(normal.text, /已退出隔离模式/);
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
    const learning = f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.flush(f.agent.id, f.input.conversation, [{ role: "user", text: "old conversation", at: new Date().toISOString() }]));
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
    // The old exchange must never reach the extractor; the new ones may (INV-1214: dropping
    // them along with it was the bug, not the protection).
    const prompts: string[] = [];
    const rememberer = new Rememberer({ registry: f.registry, provider: {} as never,
      client: { messages: { create: async (request: { messages: { content: string }[] }) => {
        prompts.push(request.messages.map(message => message.content).join("\n"));
        return { content: [{ type: "text", text: "NOTHING" }], usage: { input_tokens: 1, output_tokens: 1 } };
      } } } as never });
    await f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.record({ agentId: f.agent.id, text: "OLD" }));
    f.registry.contextStore(f.agent.id, f.input.conversation).advance("new", 0);
    for (let i = 1; i < EXTRACT_EVERY; i++) {
      await f.registry.withContext(f.agent.id, f.input.conversation, () => rememberer.record({ agentId: f.agent.id, text: "NEW" }));
    }
    await rememberer.settle(f.agent.id);
    assert.equal(prompts.some(prompt => prompt.includes("OLD")), false, "the old-epoch exchange never reaches the extractor");
  } finally { f.cleanup(); }
});

// ── INV-1190: a /new that carries the handoff prepared for the context it leaves ───────────

import { readHandoffDraft, snapshotOf, writeHandoffDraft } from "./handoff-draft.ts";
import { historyToMessages } from "./turn.ts";

const handoffLine = (text: string) =>
  `${JSON.stringify({ role: "user", kind: "summary", covers: 0, handoff: { fromEpoch: 0 }, text, personWords: [{ source: "e0#0", text: "永远不要直接推 main", at: "2026-10-15T00:00:00.000Z" }], at: "2026-10-15T00:00:00.000Z" })}\n`;

function draftFixture() {
  const f = fixture();
  f.registry.appendTranscript(f.agent.id, { role: "user", text: "永远不要直接推 main", at: "2026-10-15T00:00:00.000Z", fromPerson: true }, f.input.conversation);
  f.registry.appendTranscript(f.agent.id, { role: "assistant", text: "好的", at: "2026-10-15T00:00:01.000Z" }, f.input.conversation);
  const deps = (extra: string[] = []) => ({
    registry: f.registry,
    mayReset: () => true,
    blockers: () => extra,
    handoffDraft: () => readHandoffDraft(f.registry, f.agent.id, f.input.conversation),
  });
  return { ...f, deps };
}

test("a /new installs the matching handoff as entry 0 of the new context, and the next request opens with it", () => {
  const f = draftFixture();
  try {
    const captured = snapshotOf(f.registry, f.agent.id, f.input.conversation);
    assert.equal(writeHandoffDraft(f.registry, f.agent.id, f.input.conversation, captured, handoffLine("## Goals\n发布报告")), true);
    const result = newContext(f.deps(), f.input);
    assert.equal(result.status, "switched");
    assert.match(result.text, /已带入上一段对话的交接笔记/);
    const fresh = f.registry.readTranscript(f.agent.id, f.input.conversation);
    assert.equal(fresh.length, 1);
    const request = JSON.stringify(historyToMessages(fresh as never));
    assert.match(request, /发布报告/);
    assert.match(request, /永远不要直接推 main/, "the person's words ride along verbatim");
    // A replayed /new says the same thing it did the first time.
    assert.match(newContext(f.deps(), f.input).text, /已带入上一段对话的交接笔记/);
  } finally { f.cleanup(); }
});

test("a handoff written before the conversation went on is not carried, and the reply says why", () => {
  const f = draftFixture();
  try {
    const captured = snapshotOf(f.registry, f.agent.id, f.input.conversation);
    writeHandoffDraft(f.registry, f.agent.id, f.input.conversation, captured, handoffLine("old note"));
    f.registry.appendTranscript(f.agent.id, { role: "user", text: "还有一件事", at: "2026-10-15T00:01:00.000Z", fromPerson: true }, f.input.conversation);
    const result = newContext(f.deps(), f.input);
    assert.equal(result.status, "switched");
    assert.match(result.text, /交接笔记没有带入：写好之后对话又继续了/);
    assert.deepEqual(f.registry.readTranscript(f.agent.id, f.input.conversation), [], "a plain new context");
  } finally { f.cleanup(); }
});

test("an old note is never saved as current: a draft whose context moved during writing is refused", () => {
  const f = draftFixture();
  try {
    const captured = snapshotOf(f.registry, f.agent.id, f.input.conversation);
    f.registry.appendTranscript(f.agent.id, { role: "user", text: "meanwhile", at: "2026-10-15T00:02:00.000Z", fromPerson: true }, f.input.conversation);
    assert.equal(writeHandoffDraft(f.registry, f.agent.id, f.input.conversation, captured, handoffLine("note")), false);
    assert.equal(readHandoffDraft(f.registry, f.agent.id, f.input.conversation), undefined);
  } finally { f.cleanup(); }
});

test("/new --clean never carries a handoff, even a matching one", () => {
  const f = draftFixture();
  try {
    const captured = snapshotOf(f.registry, f.agent.id, f.input.conversation);
    writeHandoffDraft(f.registry, f.agent.id, f.input.conversation, captured, handoffLine("note"));
    const result = newContext(f.deps(), { ...f.input, mode: "clean" as const });
    assert.match(result.text, /已进入干净上下文/);
    assert.deepEqual(f.registry.readTranscript(f.agent.id, f.input.conversation), []);
  } finally { f.cleanup(); }
});

test("a handoff never bypasses the blockers of a /new", () => {
  const f = draftFixture();
  try {
    const captured = snapshotOf(f.registry, f.agent.id, f.input.conversation);
    writeHandoffDraft(f.registry, f.agent.id, f.input.conversation, captured, handoffLine("note"));
    const result = newContext(f.deps(["任务 t1：doing"]), f.input);
    assert.equal(result.status, "refused");
    assert.equal(f.registry.contextVersion(f.agent.id, f.input.conversation), 0);
  } finally { f.cleanup(); }
});
