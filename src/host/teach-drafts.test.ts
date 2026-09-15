import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeachDrafts, parseTeachingResponse } from "./teach-drafts.ts";

const skill = "---\nname: Search shop\ndescription: Find an item by search term\nscope: global\n---\nOpen https://shop.test and search for {term}. Offer a dry run first.\n";

test("a teaching draft survives restart but enters the skill directory only after approval of its exact content", async () => {
  const root = mkdtempSync(join(tmpdir(), "teach-drafts-"));
  try {
    const original = new TeachDrafts(root).create({ boxId: "box-a", agentId: "ada", sessionId: "teach-1", eventsPath: "/trace/events.jsonl", skill, question: null });
    const drafts = new TeachDrafts(root);
    assert.equal(drafts.list()[0]?.status, "draft");
    const writes: string[] = [];
    const publish = async (_box: string, _path: string, content: string) => { writes.push(content); };
    await assert.rejects(drafts.approve(original.id, "stale-content", "human:chris", publish), /changed/);
    assert.deepEqual(writes, []);
    const published = await drafts.approve(original.id, original.digest, "human:chris", publish);
    assert.equal(published.status, "published");
    assert.deepEqual(writes, [skill]);
    await drafts.approve(original.id, original.digest, "human:chris", publish);
    assert.deepEqual(writes, [skill], "double click does not republish");
    assert.equal(new TeachDrafts(root).get(original.id).approvedBy, "human:chris");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publication retries after a lost response use the approved text, while rejection cannot race a pending publication", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-publish-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drafts = new TeachDrafts(root);
  const draft = drafts.create({ boxId: "box-a", agentId: "ada", sessionId: "teach-1", eventsPath: "/trace", skill, question: null });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = drafts.approve(draft.id, draft.digest, "chris", async () => { await waiting; throw new Error("response lost"); });
  assert.throws(() => drafts.reject(draft.id, draft.digest), /already been approved/);
  release();
  await assert.rejects(first, /response lost/);
  const restarted = new TeachDrafts(root);
  assert.equal(restarted.get(draft.id).status, "publishing");
  const retry = await restarted.approve(draft.id, draft.digest, "another-operator", async (box, path, content) => {
    assert.equal(box, "box-a");
    assert.match(path, /^\/home\/box\/work\/skills\/taught-[a-f0-9]+\/SKILL.md$/);
    assert.equal(content, skill);
  });
  assert.equal(retry.approvedBy, "chris", "retry preserves the original approval actor");
  assert.equal(retry.status, "published");
});

test("corrupt drafts, questions and rejected skills cannot be published", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-corrupt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drafts = new TeachDrafts(root);
  const input = { boxId: "box-a", agentId: "ada", sessionId: "teach-1", eventsPath: "/trace", skill, question: null };
  const question = drafts.create({ ...input, sessionId: "teach-question", skill: null, question: "What is the goal?" });
  const forbidden = async () => { assert.fail("unapproved text must never reach the box"); };
  await assert.rejects(drafts.approve(question.id, question.digest, "chris", forbidden), /cannot be published/);
  const rejected = drafts.create(input);
  drafts.reject(rejected.id, rejected.digest);
  await assert.rejects(drafts.approve(rejected.id, rejected.digest, "chris", forbidden), /cannot be published/);
  writeFileSync(join(root, `${rejected.id}.json`), JSON.stringify({ ...rejected, skill: skill + "Different content" }));
  await assert.rejects(drafts.approve(rejected.id, rejected.digest, "chris", forbidden), /Corrupt/);
  assert.throws(() => drafts.create({ ...input, sessionId: "scheduled", skill: skill.replace("scope: global", "scope: global\nschedule: @daily") }), /schedule/);
  assert.throws(() => drafts.create({ ...input, sessionId: "listener", skill: skill.replace("scope: global", "scope: global\ntrigger: webhook\nlistener: on") }), /execution metadata/);
  assert.throws(() => drafts.create({ ...input, sessionId: "control", skill: skill + "Read tasks.jsonl" }), /protected control surface/);
  assert.throws(() => drafts.create({ ...input, sessionId: "long", skill: skill + "\n".repeat(2000) }), /at most 1000 lines/);
  assert.throws(() => drafts.create({ ...input, sessionId: "invalid-display", display: 0 }), /Invalid teaching display/);
  assert.equal(drafts.create({ ...input, sessionId: "last-display", display: 32 }).display, 32);
});

test("answering a teaching question preserves its history and requires review of the new draft", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-clarify-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drafts = new TeachDrafts(root);
  const input = { boxId: "box-a", agentId: "ada", sessionId: "teach-question", eventsPath: "/trace", skill: null, question: "What should happen after download?" };
  const original = drafts.create(input);
  const revised = await drafts.clarify(original.id, original.digest, "Save the file and report its name.", "operator", async (source, answer) => {
    assert.equal(source.question, input.question);
    assert.equal(answer, "Save the file and report its name.");
    return { skill, question: null };
  });
  assert.equal(revised.id, original.id);
  assert.notEqual(revised.digest, original.digest);
  assert.equal(revised.status, "draft", "clarification never approves publication");
  assert.equal(revised.clarifications?.[0]?.question, input.question);
  assert.equal(revised.clarifications?.[0]?.answer, "Save the file and report its name.");
  assert.equal(revised.clarifications?.[0]?.actor, "operator");
  assert.equal(revised.clarifications?.[0]?.digest, original.digest);
  assert.equal(new TeachDrafts(root).get(original.id).digest, revised.digest);
  assert.equal(drafts.create(input).digest, revised.digest, "queue replay cannot restore the old question");
  const published: string[] = [];
  const publish = async (_box: string, _path: string, content: string) => { published.push(content); };
  await assert.rejects(drafts.approve(original.id, original.digest, "operator", publish), /changed/);
  assert.deepEqual(published, []);
  await drafts.approve(revised.id, revised.digest, "operator", publish);
  assert.deepEqual(published, [skill]);
});

test("a late clarification cannot reopen a rejected draft or replace a newer answer", async t => {
  const root = mkdtempSync(join(tmpdir(), "teach-clarify-race-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const drafts = new TeachDrafts(root);
  const question = drafts.create({ boxId: "box-a", agentId: "ada", sessionId: "teach-race", eventsPath: "/trace", skill: null, question: "Where should it go?" });
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const pending = drafts.clarify(question.id, question.digest, "Save locally.", "operator", async () => { await wait; return { skill, question: null }; });
  drafts.reject(question.id, question.digest);
  finish();
  await assert.rejects(pending, /question|draft|rejected/i);
  assert.equal(drafts.get(question.id).status, "rejected");
  assert.equal(drafts.get(question.id).skill, null);
  const fresh = drafts.create({ boxId: "box-a", agentId: "ada", sessionId: "teach-newer", eventsPath: "/trace", skill: null, question: "Where should it go?" });
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const old = drafts.clarify(fresh.id, fresh.digest, "First answer.", "operator", async () => { await delayed; return { skill, question: null }; });
  const newer = await drafts.clarify(fresh.id, fresh.digest, "Second answer.", "operator", async () => ({ skill, question: null }));
  release();
  await assert.rejects(old, /changed/);
  assert.equal(drafts.get(fresh.id).digest, newer.digest);
});


test("teaching responses accept a single JSON fence without accepting prose or weakening draft validation", () => {
  const value = { skill, question: null };
  assert.deepEqual(parseTeachingResponse(JSON.stringify(value)), value);
  assert.deepEqual(parseTeachingResponse("```json\n" + JSON.stringify(value) + "\n```"), value);
  assert.deepEqual(parseTeachingResponse(JSON.stringify({ skill: "```markdown\n" + skill + "```", question: null })), { skill: skill.trimEnd(), question: null });
  for (const response of ["Here is the proposal:\n" + JSON.stringify(value), "```json\n{}\n```\nRun it now", "null", "[]", '{"skill":7,"question":null}']) {
    assert.throws(() => parseTeachingResponse(response), /Teaching response/);
  }
  const root = mkdtempSync(join(tmpdir(), "teach-response-"));
  try {
    const drafts = new TeachDrafts(root);
    const invalid = parseTeachingResponse(JSON.stringify({ skill: skill.replace("scope: global", "scope: agent"), question: null }));
    assert.throws(() => drafts.create({ boxId: "b", agentId: "a", sessionId: "s", eventsPath: "/trace", ...invalid }), /scope: global/);
    assert.deepEqual(drafts.list(), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
