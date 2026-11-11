import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { WorkAttention, workStateConversation } from "../agents/work-attention.ts";
import { conversationProgress } from "./work-attention.ts";

test("the progress read model shows the foreground plan, preserves legacy records and cannot show work from an older context", () => {
  const dir = mkdtempSync(join(tmpdir(), "attention-progress-"));
  try {
    const registry = new AgentRegistry(dir); const agent = registry.create({ name: "Mia" });
    const attention = new WorkAttention(undefined, (id, conversation) => registry.contextVersion(id, conversation));
    const bus = new AgentBus(registry, async () => {}, () => {}, undefined, false, undefined, attention);
    registry.writeTodos(agent.id, [{ text: "Old audit", status: "doing" }]);
    const work = attention.begin(agent.id, "main", [{ id: "request", fromId: "user", fromName: "Chris", text: "Install", priority: false, receivedAt: new Date().toISOString() }])!;
    registry.writeTodos(agent.id, [{ text: "Install", status: "blocked" }], workStateConversation(work, "main"));
    attention.settle(work, "waiting", "computer offline");
    const shown = conversationProgress(registry, bus, agent.id, "main");
    assert.equal(shown.todos![0]!.text, "Install"); assert.equal(shown.attention!.status, "waiting");
    assert.equal(registry.readDurableState(agent.id).todos![0]!.text, "Old audit");
    assert.equal(registry.listConversations(agent.id).some(item => item.id.startsWith("work-")), false, "internal execution stores are not user conversation choices");
    attention.begin(agent.id, "private", [{id:"older-private",fromId:"user",fromName:"Chris",text:"Old private work",priority:false,receivedAt:new Date().toISOString()}]);
    registry.contextStore(agent.id, "private").advance("new", 0, "normal");
    assert.equal(conversationProgress(registry, bus, agent.id, "private").attention, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
