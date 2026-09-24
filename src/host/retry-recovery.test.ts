import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentRegistry } from "../agents/registry.ts";
import { MESSAGES_SCHEMA, type MessageRecord } from "../channels/messages.ts";
import { retryLastAnswer } from "./retry-recovery.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-retry-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Nova" });
  const conversation = "private-user";
  const records = new Map<string, MessageRecord>();
  const add = (id: string, text: string) => records.set(id, {
    schema: MESSAGES_SCHEMA, id, channel: "test", chatKey: conversation, identity: "test:user",
    senderLabel: "User", conversationKey: conversation, receivedAt: "2026-09-24T00:00:00Z",
    text, textChars: text.length,
  });
  add("m1", "回答二十五道题");
  add("m2", "每题给直接答案");
  registry.appendTranscript(agent.id, { role: "user", text: "回答二十五道题\n\n每题给直接答案", at: "2026-09-24T00:00:00Z", causedBy: ["m1", "m2"], fromPerson: true, turnId: "turn-1" }, conversation);
  registry.appendTranscript(agent.id, { role: "assistant", text: "我转给 Nova 了。", at: "2026-09-24T00:01:00Z", turnId: "turn-1" }, conversation);
  const input = { agentId: agent.id, conversation, operationId: "retry-1", identity: "test:user", privateChat: true };
  const deps = { registry, message: (id: string) => records.get(id), mayRetry: () => true, blockers: () => [] as string[] };
  return { root, registry, agent, conversation, records, input, deps };
}

test("retry enters one isolated epoch from verbatim source messages and is idempotent", () => {
  const f = fixture();
  try {
    f.registry.appendTranscript(f.agent.id, { role: "user", text: "[timer] nightly", at: "2026-09-24T00:02:00Z", turnId: "turn-2" }, f.conversation);
    f.registry.appendTranscript(f.agent.id, { role: "assistant", text: "scheduled report", at: "2026-09-24T00:03:00Z", turnId: "turn-2" }, f.conversation);
    const result = retryLastAnswer(f.deps, f.input);
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.match(result.prompt, /回答二十五道题/);
    assert.match(result.prompt, /每题给直接答案/);
    assert.doesNotMatch(result.prompt, /我转给 Nova 了/);
    assert.equal(f.registry.contextMode(f.agent.id, f.conversation), "recover");
    assert.equal(retryLastAnswer(f.deps, f.input).status, "replayed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retry refuses incomplete provenance, busy work, foreign identity and an already isolated context without switching", () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => ({ ...f.deps, message: () => undefined }),
    (f: ReturnType<typeof fixture>) => ({ ...f.deps, blockers: () => ["delivery pending"] }),
    (f: ReturnType<typeof fixture>) => f.deps,
  ];
  for (const [index, makeDeps] of cases.entries()) {
    const f = fixture();
    try {
      const input = index === 2 ? { ...f.input, identity: "test:other" } : f.input;
      assert.equal(retryLastAnswer(makeDeps(f), input).status, "refused");
      assert.equal(f.registry.contextVersion(f.agent.id, f.conversation), 0);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = fixture();
  try {
    f.registry.contextStore(f.agent.id, f.conversation).advance("clean-first", 0, "clean");
    assert.equal(retryLastAnswer(f.deps, f.input).status, "refused");
    assert.equal(f.registry.contextVersion(f.agent.id, f.conversation), 1);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("retry refuses an attachment request because the durable message ledger has metadata, not the file bytes", () => {
  const f = fixture();
  try {
    f.records.set("m1", { ...f.records.get("m1")!, files: [{ name: "input.pdf", bytes: 42 }] });
    assert.equal(retryLastAnswer(f.deps, f.input).status, "refused");
    assert.equal(f.registry.contextVersion(f.agent.id, f.conversation), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
