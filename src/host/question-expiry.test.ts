/**
 * Questions that expire (INV-526): answered clears silently; expired with a default wakes
 * the agent to proceed on it and tells the chat; expired without one is a skip; the window
 * is bounded; a second question in the same conversation supersedes the first. And
 * (INV-533) only the person who was asked answers it, the ledger survives a restart.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUESTION_EXPIRED_CUE, QUESTION_TTL_MAX_MS, QUESTION_TTL_MIN_MS, QUESTION_TTL_MS, QuestionWatch } from "./question-expiry.ts";

const T0 = Date.parse("2026-09-14T09:00:00Z");

test("an answered question clears; an expired one goes to its default and says so; one without a default is skipped", () => {
  const watch = new QuestionWatch();
  watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "EU or US region?", fallback: "EU, as last quarter", now: T0 });
  watch.ask({ agentId: "a2", agentName: "Bob", conversation: "feishu-x", question: "Which account?", now: T0 });
  watch.ask({ agentId: "a3", agentName: "Cy", conversation: "main", question: "Ship Friday?", fallback: "yes", now: T0 });
  assert.equal(watch.list().length, 3);

  // Before the window: nothing due, except the one that was answered.
  const early = watch.sweep(q => q.agentId === "a3", T0 + 60_000);
  assert.deepEqual(early.map(e => [e.question.agentId, e.verdict]), [["a3", "answered"]]);
  assert.equal(watch.list().length, 2);

  const due = watch.sweep(() => false, T0 + QUESTION_TTL_MS + 1);
  assert.deepEqual(due.map(e => [e.question.agentId, e.verdict]), [["a1", "default"], ["a2", "skipped"]]);
  const byDefault = due[0]!;
  assert.ok(byDefault.verdict === "default");
  assert.ok(byDefault.cue.startsWith(QUESTION_EXPIRED_CUE));
  assert.match(byDefault.cue, /No answer in 4 hours to your question "EU or US region\?"\. Proceed on the default you named — EU, as last quarter — and say in one line/);
  assert.match(byDefault.toChat, /^Ada: no answer to "EU or US region\?" in 4 hours — going with the default: EU, as last quarter$/);
  const skipped = due[1]!;
  assert.ok(skipped.verdict === "skipped");
  assert.match(skipped.cue, /The person has moved on; treat it as skipped: decide it yourself/);
  assert.equal(watch.list().length, 0, "settled either way");
  assert.deepEqual(watch.sweep(() => false, T0 + QUESTION_TTL_MS * 2), [], "nothing fires twice");
});

test("the window is bounded, and a second question in the same conversation replaces the first", () => {
  const watch = new QuestionWatch();
  const short = watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "q", ttlMs: 1, now: T0 }).question;
  assert.equal(short.expiresAt - short.askedAt, QUESTION_TTL_MIN_MS);
  const second = watch.ask({ agentId: "a1", agentName: "Ada", conversation: "main", question: "q2", ttlMs: 365 * 86_400_000, now: T0 });
  assert.equal(second.question.expiresAt - second.question.askedAt, QUESTION_TTL_MAX_MS);
  assert.equal(second.superseded?.question, "q", "the first is settled, not silently dropped");
  assert.deepEqual(watch.list().map(q => q.question), ["q2"], "one open question per conversation");
});

test("only the person who was asked answers it (INV-533)", () => {
  const watch = new QuestionWatch();
  const asked = watch.ask({ agentId: "a1", agentName: "Ada", conversation: "feishu-oc_x", question: "Which account — work or personal?", fallback: "work", asker: "feishu:ou_chris", now: T0 }).question;

  // A colleague in the same room says something. The transcript rule would call that an
  // answer; the watch does not, because the question was put to somebody.
  assert.deepEqual(watch.sweep(() => true, T0 + 60_000), [], "somebody else talking is not an answer");
  assert.equal(watch.list().length, 1);

  // Their own reply is.
  assert.deepEqual(watch.noteReply("a1", "feishu:ou_mia", asked.id, asked.conversation, T0 + 1).length, 0, "a reply from the wrong person changes nothing");
  assert.deepEqual(watch.noteReply("a1", "feishu:ou_chris", "wrong", asked.conversation, T0 + 1), []);
  assert.deepEqual(watch.noteReply("a1", "feishu:ou_chris", asked.id, "another-room", T0 + 1), []);
  assert.deepEqual(watch.noteReply("a1", "feishu:ou_chris", asked.id, asked.conversation, T0 + QUESTION_TTL_MS), []);
  assert.deepEqual(watch.noteReply("a1", "feishu:ou_chris", asked.id, asked.conversation, T0 + 1).map(q => q.id), [asked.id]);
  assert.deepEqual(watch.sweep(() => false, T0 + 60_000).map(e => e.verdict), ["answered"]);
});

test("an explicitly answered question cannot apply its default after restart before the sweep", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-answered-"));
  try {
    const path = join(dir, "questions.jsonl");
    const first = new QuestionWatch(path);
    const q = first.ask({ agentId: "a1", agentName: "Ada", conversation: "room", question: "Which?", asker: "one", fallback: "us", now: T0 }).question;
    assert.equal(first.noteReply("a1", "one", q.id, "room", T0 + 1).length, 1);
    assert.equal(first.noteReply("a1", "one", q.id, "room", T0 + 2).length, 0);
    const restored = new QuestionWatch(path);
    assert.deepEqual(restored.list(), []);
    assert.deepEqual(restored.sweep(() => false, T0 + QUESTION_TTL_MS), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a pending question survives a restart, with its default and its clock (INV-533)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-questions-"));
  try {
    const path = join(dir, "questions.jsonl");
    const first = new QuestionWatch(path);
    const asked = first.ask({ agentId: "a1", agentName: "Ada", conversation: "feishu-oc_x", question: "Which account?", fallback: "work", asker: "feishu:ou_chris", now: T0 }).question;
    first.ask({ agentId: "a2", agentName: "Bob", conversation: "main", question: "settled before the restart", now: T0 });
    first.sweep(() => true, T0 + 60_000); // a2's is answered and written as settled

    // The process stops. Everything still open is still open, with the same window.
    const after = new QuestionWatch(path);
    assert.deepEqual(after.list().map(q => [q.id, q.question, q.fallback, q.asker, q.expiresAt]), [[asked.id, "Which account?", "work", "feishu:ou_chris", T0 + QUESTION_TTL_MS]]);
    const due = after.sweep(() => false, T0 + QUESTION_TTL_MS + 1);
    assert.deepEqual(due.map(e => e.verdict), ["default"]);

    // And a third start sees nothing open: the settlement is on the ledger too.
    assert.deepEqual(new QuestionWatch(path).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
