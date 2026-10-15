/**
 * The context steward prepares a handoff for a long private chat at rest and never switches it
 * (INV-1190, design v3). Every give-up path leaves the chat exactly as it was; a prepared draft
 * is bound to the context it was written from; the suggestion is one per context, through the
 * shared proactive budget.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { ContextSteward, HANDOFF_HEADINGS, keepRealAnchors, parseStewardDecision, STEWARD_COOLDOWN_MS, SUGGESTION_TEXT } from "./context-steward.ts";
import { readHandoffDraft } from "./handoff-draft.ts";
import { FollowUpBudget } from "./follow-up-budget.ts";
import { newContext } from "./context-recovery.ts";
import { historyToMessages } from "./turn.ts";

const CONVERSATION = "feishu-private";
const NOTE = HANDOFF_HEADINGS.map(heading => `## ${heading}\n- ${heading === "Where to look" ? "the constraint is at [e0#0]" : "x"}`).join("\n");

function harness(options: { decide?: string; notes?: { text: string; truncated?: boolean }[]; during?: () => void; spent?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "steward-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Nova", boxId: registry.box.id });
  registry.appendTranscript(agent.id, { role: "user", text: "永远不要直接推 main", at: "2026-10-15T00:00:00.000Z", fromPerson: true }, CONVERSATION);
  for (let i = 0; i < 6; i++) {
    registry.appendTranscript(agent.id, { role: "assistant", text: `step ${i} ${"z".repeat(400)}`, at: `2026-10-15T00:0${i}:30.000Z` }, CONVERSATION);
  }
  const asks: { kind: string; prompt: string }[] = [];
  const notes = [...(options.notes ?? [{ text: NOTE }])];
  const pushed: string[] = [];
  const followUps = new FollowUpBudget();
  for (let i = 0; i < (options.spent ?? 0); i++) followUps.record("feishu:private");
  let clock = Date.parse("2026-10-15T01:00:00Z");
  const steward = new ContextSteward({
    registry,
    ask: async (_id, request) => {
      asks.push({ kind: request.kind, prompt: request.prompt });
      if (request.kind === "steward") return { text: options.decide ?? '{"action":"switch","reason":"done"}', truncated: false };
      options.during?.();
      const next = notes.shift();
      return next === undefined ? undefined : { text: next.text, truncated: next.truncated === true };
    },
    triggerTokens: () => 100,
    followUps,
    push: async (_chat, text) => { pushed.push(text); return { delivered: true }; },
    log: () => {},
    now: () => clock,
  });
  const look = () => steward.consider({ agentId: agent.id, conversation: CONVERSATION, chatKey: "feishu:private" });
  return {
    registry, agent, asks, pushed, followUps, look,
    advance: (ms: number) => { clock += ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("below the check line the steward does not even ask", async () => {
  const h = harness();
  try {
    const small = new ContextSteward({ registry: h.registry, ask: async () => { throw new Error("must not ask"); }, triggerTokens: () => 1_000_000, followUps: h.followUps, push: async () => ({ delivered: true }), log: () => {} });
    assert.equal(await small.consider({ agentId: h.agent.id, conversation: CONVERSATION, chatKey: "c" }), "below-line");
  } finally { h.cleanup(); }
});

test("compact, an unreadable answer, or a note that never has its headings leaves no draft and says nothing", async () => {
  for (const [decide, notes, expected] of [
    ['{"action":"compact","reason":"still working"}', undefined, "compact"],
    ["I think maybe", undefined, "no-decision"],
    [undefined, [{ text: "## Goals\n- x" }, { text: "## Goals\n- still short" }], "note-failed"],
  ] as const) {
    const h = harness({ ...(decide !== undefined ? { decide } : {}), ...(notes !== undefined ? { notes: [...notes] } : {}) });
    try {
      assert.equal(await h.look(), expected);
      assert.equal(readHandoffDraft(h.registry, h.agent.id, CONVERSATION), undefined);
      assert.deepEqual(h.pushed, []);
    } finally { h.cleanup(); }
  }
});

test("a cut-off note is asked for again, shorter, and a good second one is kept", async () => {
  const h = harness({ notes: [{ text: NOTE, truncated: true }, { text: NOTE }] });
  try {
    assert.equal(await h.look(), "prepared-and-suggested");
    assert.match(h.asks.filter(ask => ask.kind === "handoff")[1]!.prompt, /cut off/);
  } finally { h.cleanup(); }
});

test("a prepared handoff is bound to its context, labelled for ReadHistory, and suggested once through the shared budget", async () => {
  const h = harness();
  try {
    assert.equal(await h.look(), "prepared-and-suggested");
    assert.deepEqual(h.pushed, [SUGGESTION_TEXT]);
    assert.match(h.asks[0]!.prompt, /\[?e0#0 /, "the steward reads entries by the labels ReadHistory resolves");
    const draft = readHandoffDraft(h.registry, h.agent.id, CONVERSATION);
    assert.equal(draft?.status, "valid");
    const opening = JSON.parse((draft as { opening: string }).opening);
    assert.deepEqual(opening.personWords.map((word: { source: string }) => word.source), ["e0#0"]);
    assert.match(opening.text, /Handoff from the previous context/);
    // A later look in the same context neither rewrites nor re-suggests.
    h.advance(STEWARD_COOLDOWN_MS + 1);
    assert.equal(await h.look(), "unchanged");
    assert.equal(h.pushed.length, 1);
  } finally { h.cleanup(); }
});

test("the suggestion waits when today's follow-ups for the room are spent; the draft is still prepared", async () => {
  const h = harness({ spent: 2 });
  try {
    assert.equal(await h.look(), "prepared");
    assert.deepEqual(h.pushed, []);
    assert.equal(readHandoffDraft(h.registry, h.agent.id, CONVERSATION)?.status, "valid");
  } finally { h.cleanup(); }
});

test("a note written while the conversation moved on is not saved as current", async () => {
  let h!: ReturnType<typeof harness>;
  h = harness({ during: () => h.registry.appendTranscript(h.agent.id, { role: "user", text: "wait, one more thing", at: "2026-10-15T00:59:00.000Z", fromPerson: true }, CONVERSATION) });
  try {
    assert.equal(await h.look(), "context-moved");
    assert.equal(readHandoffDraft(h.registry, h.agent.id, CONVERSATION), undefined);
    assert.deepEqual(h.pushed, []);
  } finally { h.cleanup(); }
});

test("a clean context is never looked at", async () => {
  const h = harness();
  try {
    h.registry.contextStore(h.agent.id, CONVERSATION).advance("clean-op", 0, "clean");
    assert.equal(await h.look(), "ineligible");
  } finally { h.cleanup(); }
});

test("labels that point at nothing are dropped from the note", () => {
  const { note, dropped } = keepRealAnchors("see [e0#1] and [e0#99] and e3#2", anchor => anchor.epoch === 0 && anchor.index < 5);
  assert.equal(dropped, 2);
  assert.match(note, /\[e0#1\]/);
  assert.doesNotMatch(note, /e0#99|e3#2/);
});

test("the steward's answer is the last JSON object that names an action", () => {
  assert.equal(parseStewardDecision('it said {"action":"switch"} but {"action":"compact","reason":"x"}'), "compact");
  assert.equal(parseStewardDecision("no json"), undefined);
});

test("end to end: the steward prepares, the person sends /new, the new context opens with the handoff and their words", async () => {
  const h = harness();
  try {
    await h.look();
    const result = newContext({
      registry: h.registry,
      mayReset: () => true,
      blockers: () => [],
      handoffDraft: () => readHandoffDraft(h.registry, h.agent.id, CONVERSATION),
    }, { agentId: h.agent.id, conversation: CONVERSATION, operationId: "op-new", identity: "user", privateChat: true });
    assert.match(result.text, /已带入上一段对话的交接笔记/);
    const request = JSON.stringify(historyToMessages(h.registry.readTranscript(h.agent.id, CONVERSATION) as never));
    assert.match(request, /## Goals/);
    assert.match(request, /永远不要直接推 main/);
    assert.match(request, /e0#0/, "with the label that opens the original message");
  } finally { h.cleanup(); }
});

test("the channel offers a conversation to the steward only after a private task succeeded", async () => {
  const { ChannelManager } = await import("../channels/manager.ts");
  for (const [privateChat, fails, expected] of [[true, false, 1], [true, true, 0], [false, false, 0]] as const) {
    const idle: string[] = [];
    let receive!: (message: never) => Promise<string | undefined>;
    const manager = new ChannelManager({
      mayDrive: () => true,
      log: () => {},
      ask: async () => { if (fails) throw new Error("model down"); return "done"; },
      contextIdle: (input: { conversationKey: string }) => { idle.push(input.conversationKey); },
    } as never);
    manager.register({ name: "feishu", start: async (handler: never) => { receive = handler; }, stop() {}, send: async () => undefined } as never, true, "test");
    manager.start();
    await new Promise(resolve => setImmediate(resolve));
    await receive({ identity: "feishu:user", chatKey: "feishu:private", privateChat, senderLabel: "user", text: "do it", messageId: "m1" } as never);
    await manager.idle();
    manager.stop();
    assert.equal(idle.length, expected, `privateChat=${privateChat} fails=${fails}`);
  }
});
