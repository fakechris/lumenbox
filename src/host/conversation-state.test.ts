/** The four facts per conversation (INV-1625): what counts as activity, what clears it, what the agent waits on, and that a restart keeps all of it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityOfInbound, COMPACT_AT, ConversationState, rowMarker } from "./conversation-state.ts";

const T = (s: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, s)).toISOString();

test("the agent's words, a door's message and the person's own are activity; a teammate's and the host's are not", () => {
  const state = new ConversationState(undefined, () => new Date(T(0)));
  assert.equal(state.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(1) }).unreadCount, 1);
  assert.equal(state.note({ kind: "channelIn", agentId: "ada", conversation: "main", at: T(2) }).unreadCount, 2);
  const before = state.summary("ada", "main");
  assert.deepEqual(state.note({ kind: "peerMessage", agentId: "ada", conversation: "main", at: T(3) }), before, "a teammate's message floats nothing");
  assert.deepEqual(state.note({ kind: "hostPrompt", agentId: "ada", conversation: "main", at: T(4) }), before, "the host's prompt floats nothing");
  const spoke = state.note({ kind: "personSaid", agentId: "ada", conversation: "main", at: T(5) });
  assert.equal(spoke.lastActivityAt, T(5), "the person's message moves the conversation");
  assert.equal(spoke.unreadCount, 2, "but is never unread to them");
  assert.equal(state.summary("bob", "main").unreadCount, 0);
  assert.equal(state.hasUnread("ada", "main"), true);
});

test("viewed clears the count; a message that lands while the person is looking is read as it lands; mark-as-unread puts one back", () => {
  const state = new ConversationState(undefined, () => new Date(T(0)));
  state.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(1) });
  state.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(2) });
  const seen = state.viewed("ada", "main", T(3));
  assert.deepEqual([seen.unreadCount, seen.lastViewedAt], [0, T(3)]);
  assert.equal(state.hasUnread("ada", "main"), false);
  const landed = state.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(4), looking: true });
  assert.deepEqual([landed.unreadCount, landed.lastActivityAt, landed.lastViewedAt], [0, T(4), T(4)]);
  assert.equal(state.hasUnread("ada", "main"), false);
  const back = state.markUnread("ada", "main");
  assert.equal(back.unreadCount, 1);
  assert.ok(back.lastViewedAt! < back.lastActivityAt!, "the view time steps behind the last activity");
  assert.equal(state.hasUnread("ada", "main"), true);
  assert.equal(state.markUnread("ada", "main").unreadCount, 1, "marking twice is one unread, not two");
});

test("awaiting is set by whoever knows, wins over unread on the row, is cleared explicitly or by the person speaking, and the same awaiting twice is written once", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-convstate-"));
  try {
    const path = join(dir, "conversation-state.jsonl");
    const state = new ConversationState(path, () => new Date(T(0)));
    state.setAwaiting("ada", "main", { kind: "approval", reason: "run a command in the box", since: T(1) });
    state.setAwaiting("ada", "main", { kind: "approval", reason: "run a command in the box", since: T(2) });
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1, "the same awaiting is not rewritten");
    assert.equal(rowMarker(state.summary("ada", "main"), true), "blocked", "blocked beats working");
    state.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(3) });
    assert.equal(rowMarker(state.summary("ada", "main"), false), "blocked", "blocked beats unread");
    state.setAwaiting("ada", "main", undefined);
    assert.equal(state.summary("ada", "main").awaiting, undefined);
    assert.equal(rowMarker(state.summary("ada", "main"), true), "unread", "unread beats working");
    state.viewed("ada", "main", T(4));
    assert.equal(rowMarker(state.summary("ada", "main"), true), "working");
    assert.equal(rowMarker(state.summary("ada", "main"), false), undefined);
    state.setAwaiting("ada", "main", { kind: "question", reason: "Which account?", since: T(5) });
    state.note({ kind: "personSaid", agentId: "ada", conversation: "main", at: T(6) });
    assert.equal(state.summary("ada", "main").awaiting, undefined, "the person's answer in the chat clears it");
    state.setAwaiting("ada", "goal-1", { kind: "spend-limit", reason: "paused at the day's spend line", since: T(7) });
    assert.equal(state.summary("ada", "main").awaiting, undefined, "awaiting is per conversation");
    assert.equal(state.summary("ada", "goal-1").awaiting?.kind, "spend-limit");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart keeps every fact; past the line the ledger is rewritten as one state line per conversation and still reads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-convstate-"));
  try {
    const path = join(dir, "conversation-state.jsonl");
    const first = new ConversationState(path, () => new Date(T(0)));
    first.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(1) });
    first.setAwaiting("ada", "main", { kind: "approval", reason: "cp report.md outbox/", since: T(2) });
    first.viewed("bob", "main", T(3));
    first.note({ kind: "channelIn", agentId: "bob", conversation: "feishu-oc_1", at: T(4) });
    const again = new ConversationState(path, () => new Date(T(10)));
    assert.deepEqual(again.summary("ada", "main"), { agentId: "ada", conversation: "main", lastActivityAt: T(1), unreadCount: 1, awaiting: { kind: "approval", reason: "cp report.md outbox/", since: T(2) } });
    assert.deepEqual(again.summary("bob", "main"), { agentId: "bob", conversation: "main", lastViewedAt: T(3), unreadCount: 0 });
    assert.equal(again.all().length, 3);

    for (let i = 0; i < COMPACT_AT + 5; i++) again.note({ kind: "agentSaid", agentId: "ada", conversation: "main", at: T(20) });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.ok(lines.length <= 20, `compacted to ${lines.length} lines`);
    assert.ok(lines.some(line => JSON.parse(line).kind === "state"), "the rewrite is one state line per conversation, followed by what came after it");
    const third = new ConversationState(path);
    assert.equal(third.summary("ada", "main").unreadCount, 1 + COMPACT_AT + 5);
    assert.equal(third.summary("ada", "main").awaiting?.reason, "cp report.md outbox/");
    assert.equal(third.summary("bob", "feishu-oc_1").unreadCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bus message is classified by who wrote it: the person, a door, a teammate, or the host", () => {
  assert.equal(activityOfInbound({ fromId: "user" }), "personSaid");
  assert.equal(activityOfInbound({ fromId: "user", messageId: "om_feishu_1" }), "channelIn");
  assert.equal(activityOfInbound({ fromId: "user", synthetic: true, origin: "host:jobs" }), "hostPrompt");
  assert.equal(activityOfInbound({ fromId: "user", origin: "host:audit" }), "hostPrompt");
  assert.equal(activityOfInbound({ fromId: "agent-bob" }), "peerMessage");
});
