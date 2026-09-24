import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { TaskStore } from "./tasks.ts";
import { recoverTask } from "./task-recovery.ts";
import type { MessageRecord } from "../channels/messages.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "lumenbox-task-recovery-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const agent = registry.create({ name: "Nova", boxId: registry.box.id });
  const tasks = new TaskStore(join(root, "tasks.jsonl"));
  const conversation = "private-chat";
  const source: MessageRecord = {
    schema: "lumenbox.message/v1", id: "source-1", channel: "test", chatKey: "private",
    identity: "wire:user", senderLabel: "User", conversationKey: conversation, receivedAt: new Date().toISOString(),
    text: "回答 25 道题，逐题作答。", textChars: 14,
  };
  const task = tasks.create({ title: "回答 25 道题", description: source.text, requester: "principal-1", sourceMessageId: source.id, assigneeId: agent.id, conversation })!;
  const input = { agentId: agent.id, conversation, operationId: "recover-message-1", principal: "principal-1", privateChat: true, taskId: task.id };
  const deps = { registry, tasks, message: (id: string) => id === source.id ? source : undefined, mayRecover: () => true, blockers: () => [] };
  return { root, registry, agent, tasks, task, input, deps, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("recover creates an idempotent isolated attempt from the verbatim source, not old context", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.agent.id, { role: "assistant", text: "OLD WRONG FRAME" }, f.input.conversation);
    const first = recoverTask(f.deps, f.input);
    assert.equal(first.status, "ready");
    if (first.status !== "ready") return;
    assert.match(first.prompt, /回答 25 道题，逐题作答/);
    assert.doesNotMatch(first.prompt, /OLD WRONG FRAME/);
    assert.equal(f.registry.contextMode(f.agent.id, f.input.conversation), "recover");
    assert.equal(f.tasks.get(f.task.id)?.recoveries?.[0]?.status, "prepared");
    assert.equal(new TaskStore(join(f.root, "tasks.jsonl")).get(f.task.id)?.recoveries?.[0]?.epoch, 1);
    assert.equal(recoverTask(f.deps, f.input).status, "ready", "prepared crash window is resumable");
    f.tasks.setRecoveryStatus(f.task.id, f.input.operationId, "running", "channel");
    assert.equal(recoverTask(f.deps, f.input).status, "replayed", "a running attempt is never doubled");
  } finally { f.cleanup(); }
});

test("recover refuses wrong authority, scope, blockers and missing verbatim source without changing epoch", () => {
  const f = fixture();
  try {
    assert.equal(recoverTask({ ...f.deps, mayRecover: () => false }, f.input).status, "refused");
    assert.equal(recoverTask(f.deps, { ...f.input, conversation: "other-chat" }).status, "refused");
    assert.equal(recoverTask({ ...f.deps, blockers: () => ["unknown delivery"] }, f.input).status, "refused");
    assert.equal(recoverTask({ ...f.deps, message: () => undefined }, f.input).status, "refused");
    assert.equal(recoverTask({ ...f.deps, message: id => ({ ...f.deps.message(id)!, conversationKey: "some-other-room" }) }, f.input).status, "refused");
    assert.equal(f.registry.contextVersion(f.agent.id, f.input.conversation), 0);
    assert.deepEqual(f.tasks.get(f.task.id)?.recoveries, undefined);
  } finally { f.cleanup(); }
});
