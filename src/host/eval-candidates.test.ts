/**
 * Candidate evaluation cases against a scripted home (INV-820): a review ledger with every kind of
 * record the command has to tell apart, and transcripts that hold — or no longer hold — the words.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox } from "../box/boxes.ts";
import { parseCorpusFile, taskProblem } from "../evals/corpus.ts";
import { heldValues } from "./audit-export.ts";
import { type Candidate, cmdEval, collectCandidates, confirmedTask } from "./eval-candidates.ts";

const TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab";
const ADDRESS = "42 Wallaby Way, Sydney";
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const RANGE = { from: "2026-11-01T00:00:00Z", to: "2026-11-30T00:00:00Z" };

/** Synthetic throughout: no line here was ever said by anyone. */
function home(): { root: string; registry: AgentRegistry; ada: string } {
  const root = mkdtempSync(join(tmpdir(), "inv820-candidates-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const tokenFile = join(root, "other.token");
  writeFileSync(tokenFile, "tok\n");
  const other = registry.attachBox(attachedBox({ name: "other", baseUrl: "http://127.0.0.1:13370/", tokenFile }));
  const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
  const bob = registry.create({ name: "Bob", boxId: other.id }).id;
  const lines = (rows: unknown[]) => rows.map(row => `${JSON.stringify(row)}\n`).join("");
  // The person's address is a value the vault holds: that is the only way the export's scrubbing knows it.
  writeFileSync(join(root, "vault.json"), JSON.stringify({ secrets: [{ id: "HOME_ADDRESS", value: ADDRESS, grants: [] }] }));

  const asked = { nonAnswer: `Where is the parcel for ${ADDRESS}? The courier token is ${TOKEN}`, bleed: "Summarise the meeting notes", bob: "Is the build green?" };
  const door = (id: string, text: string, receivedAt: string) => ({
    schema: "lumenbox.message/v1", id, channel: "feishu-personal", chatKey: "chat-1", identity: "ou_person", senderLabel: "A person",
    conversationKey: "main", receivedAt, text, textChars: text.length,
  });
  writeFileSync(join(root, "messages.jsonl"), lines([
    door("m-nonanswer", asked.nonAnswer, "2026-11-10T09:00:00Z"),
    door("m-pass", "What time is it?", "2026-11-10T10:00:00Z"),
    door("m-bleed", asked.bleed, "2026-11-02T08:00:00Z"),
    door("m-gone", "This one's turn was never written", "2026-11-11T09:00:00Z"),
    door("m-bob", asked.bob, "2026-11-12T09:00:00Z"),
  ]));

  // An earlier context version: the conversation moved on, the words are still on disk.
  registry.appendTranscript(ada, { role: "user", text: asked.bleed, at: "2026-11-02T08:00:01Z", causedBy: ["m-bleed"], fromPerson: true, turnId: "t-bleed" });
  registry.appendTranscript(ada, { role: "assistant", text: "As the audit rubric from last week says, the score is 7.", at: "2026-11-02T08:00:09Z", turnId: "t-bleed" });
  registry.contextStore(ada, "main").advance("new", 0);

  registry.appendTranscript(ada, { role: "user", text: asked.nonAnswer, at: "2026-11-10T09:00:01Z", causedBy: ["m-nonanswer"], fromPerson: true, turnId: "t-nonanswer" });
  registry.appendTranscript(ada, { role: "assistant", kind: "blocks", blocks: [{ type: "text", text: "looking" }], at: "2026-11-10T09:00:02Z", turnId: "t-nonanswer" });
  registry.appendTranscript(ada, { role: "assistant", text: `I will look into the parcel for ${ADDRESS} and get back to you.`, at: "2026-11-10T09:00:09Z", turnId: "t-nonanswer" });
  registry.appendTranscript(ada, { role: "user", text: "What time is it?", at: "2026-11-10T10:00:01Z", causedBy: ["m-pass"], fromPerson: true, turnId: "t-pass" });
  registry.appendTranscript(ada, { role: "assistant", text: "It is ten.", at: "2026-11-10T10:00:03Z", turnId: "t-pass" });
  // A routine's prompt: it has a turn and a reply, and nobody asked it.
  registry.appendTranscript(ada, { role: "user", text: "Daily check: list what is overdue.", at: "2026-11-10T11:00:01Z", causedBy: ["m-routine"], host: true, turnId: "t-routine" });
  registry.appendTranscript(ada, { role: "assistant", text: "I am continuing to check.", at: "2026-11-10T11:00:05Z", turnId: "t-routine" });
  registry.appendTranscript(bob, { role: "user", text: asked.bob, at: "2026-11-12T09:00:01Z", causedBy: ["m-bob"], fromPerson: true, turnId: "t-bob" });
  registry.appendTranscript(bob, { role: "assistant", text: "Checking now.", at: "2026-11-12T09:00:04Z", turnId: "t-bob" });

  writeFileSync(join(root, "turns.jsonl"), lines([
    { id: "t-nonanswer", event: "begin", agentId: ada, at: "2026-11-10T09:00:01Z", attempt: 1, about: "parcel", model: "model-a", build: { version: "0.3.9", commit: "abc1234" } },
    { id: "t-bleed", event: "begin", agentId: ada, at: "2026-11-02T08:00:01Z", attempt: 1, about: "notes", model: "model-b", build: { version: "0.3.8", commit: "def5678" } },
  ]));

  const review = (messageId: string, at: string, category: string, more: Record<string, unknown> = {}) => ({
    at, agent: "Ada", messageId, conversation: "main", mode: "shadow", requestHash: "0", answerHash: "0", ms: 400, category, confidence: 0.9, reason: `${category} because`, ...more,
  });
  writeFileSync(join(root, "answer-review.jsonl"), lines([
    review("m-nonanswer", "2026-11-10T09:00:10Z", "NON_ANSWER", { requestHash: hash(asked.nonAnswer), reason: `promises to look, and repeats ${ADDRESS}` }),
    review("m-nonanswer", "2026-11-10T09:00:40Z", "NON_ANSWER", { requestHash: hash(asked.nonAnswer) }), // redelivered: judged twice
    review("m-pass", "2026-11-10T10:00:04Z", "PASS"),
    review("m-bleed", "2026-11-02T08:00:10Z", "CONTEXT_BLEED", { requestHash: hash(asked.bleed), answerHash: hash("As the audit rubric from last week says, the score is 7.") }),
    review("m-routine", "2026-11-10T11:00:06Z", "NON_ANSWER"),
    review("m-gone", "2026-11-11T09:00:10Z", "PROCESS_OVER_RESULT"),
    review("m-undecided", "2026-11-11T10:00:10Z", "UNKNOWN"),
    review("m-down", "2026-11-11T11:00:10Z", "UNKNOWN", { unavailable: true, confidence: 0 }),
    review("m-old", "2026-09-01T00:00:00Z", "NON_ANSWER"),
    review("m-bob", "2026-11-12T09:00:05Z", "NON_ANSWER", { agent: "Bob" }),
  ]));
  return { root, registry, ada };
}

test("a reply judged not PASS becomes a candidate with what was asked and answered, scrubbed, and everything else is counted by why it was left out", () => {
  const { root, registry, ada } = home();
  try {
    const run = collectCandidates({ home: root, registry, ...RANGE, box: registry.box.name, held: heldValues(root) });
    const byMessage = new Map(run.candidates.map(one => [one.candidate.messageId, one]));
    assert.deepEqual([...byMessage.keys()].sort(), ["m-bleed", "m-nonanswer"], "PASS, the routine's turn, the missing turn, the undecided, the other box and the other month are not candidates");

    const parcel = byMessage.get("m-nonanswer")!;
    assert.equal(parcel.input.says, "Where is the parcel for <redacted:vault:HOME_ADDRESS>? The courier token is <redacted:github-pat>");
    assert.equal(parcel.candidate.actual, "I will look into the parcel for <redacted:vault:HOME_ADDRESS> and get back to you.", "the turn's last words, not the tool round before them");
    assert.equal(parcel.failureType, "non-answer");
    assert.deepEqual(
      { turnId: parcel.candidate.turnId, model: parcel.candidate.model, build: parcel.candidate.build, agentId: parcel.candidate.agentId },
      { turnId: "t-nonanswer", model: "model-a", build: { version: "0.3.9", commit: "abc1234" }, agentId: ada },
    );
    assert.equal(parcel.candidate.sameAsReviewed.input, true, "the request found is the one the review hashed");
    assert.equal(parcel.candidate.sameAsReviewed.actual, false, "and a reply that is not is said to differ");

    const everything = JSON.stringify(run);
    assert.ok(!everything.includes(TOKEN), "a credential-shaped string does not leave in a candidate");
    assert.ok(!everything.includes(ADDRESS), "nor a value the vault holds, in the request, the reply or the review's reason");
    assert.ok(run.redactions.exact >= 3 && run.redactions.pattern === 1);

    // The conversation switched to a new context version after this turn; the words are found all the same.
    const notes = byMessage.get("m-bleed")!;
    assert.equal(notes.input.says, "Summarise the meeting notes");
    assert.deepEqual(notes.candidate.sameAsReviewed, { input: true, actual: true });
    assert.equal(notes.candidate.epoch, 0);

    assert.deepEqual(run.skipped, { pass: 1, undecided: 1, unavailable: 1, duplicate: 1, host: 1, unverified: 0, missing: 1, undated: 0 });
    assert.deepEqual(run.missing.map(one => one.messageId), ["m-gone"], "a record whose turn is not on disk is named rather than guessed at");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a candidate is one confirmation away from a corpus task: the loader refuses it for its gold alone, and takes it once a person has said what right looks like", () => {
  const { root, registry } = home();
  try {
    const [first] = collectCandidates({ home: root, registry, ...RANGE, held: heldValues(root) }).candidates;
    assert.match(taskProblem(first)!, /gold needs at least one of/, "unconfirmed, it is not a task — and for no other reason");
    const task = confirmedTask({ ...first!, gold: { facts: ["tracking"], forbidden: ["get back to you"] } });
    assert.equal(taskProblem(task), undefined);
    assert.ok(!("candidate" in task), "the reply that failed and where it came from stay out of the corpus");
    assert.equal(parseCorpusFile(`${JSON.stringify(task)}\n`, "dev.jsonl")[0]!.source.kind, "review-ledger");
    assert.throws(() => confirmedTask(first!), /gold needs at least one of/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the command writes one private file outside any repository, says where and what it left out, and refuses a work tree unless told", async () => {
  const { root } = home();
  try {
    const said: string[] = [], errors: string[] = [];
    const io = { home: root, out: (line: string) => said.push(line), err: (line: string) => errors.push(line) };
    const args = ["candidates", "--from", RANGE.from, "--to", RANGE.to];
    assert.equal(await cmdEval(args, io), 0, errors.join("\n"));
    const path = join(root, "exports", "eval-candidates-2026-11-01-2026-11-30.jsonl");
    assert.ok(said.some(line => line.includes(path)), "it says where it wrote");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const written = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Candidate);
    assert.deepEqual(written.map(one => one.candidate.messageId).sort(), ["m-bleed", "m-bob", "m-nonanswer"], "without --box, every box's");
    assert.ok(!readFileSync(path, "utf8").includes(TOKEN) && !readFileSync(path, "utf8").includes(ADDRESS));
    const report = said.join("\n");
    assert.match(report, /3 candidate/);
    assert.match(report, /1 opened by the host/);
    assert.match(report, /1 judged twice/);
    assert.match(report, /m-gone/);

    const repo = join(root, "checkout");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const inside = join(repo, "notes", "candidates.jsonl");
    assert.equal(await cmdEval([...args, "--out", inside], io), 1);
    assert.match(errors.join("\n"), /inside a git work tree/);
    assert.ok(!existsSync(inside), "refused before anything is written");
    assert.equal(await cmdEval([...args, "--out", inside, "--in-repo"], io), 0);
    assert.ok(existsSync(inside));

    assert.equal(await cmdEval(["candidates", "--from", "yesterday"], io), 1);
    assert.equal(await cmdEval(["candidates", "--box", "nowhere"], io), 1);
    assert.equal(await cmdEval(["run"], io), 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
