/** One record of the person (INV-1653): lines by field, the person's own first, retract and expire, rendered for the prompt, absorbed from judged memories. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldOf, OPERATOR, PersonRecords } from "./person.ts";

test("lines are added once per field and text, the person's own come first, retraction and expiry hide them, and a restart keeps the rest", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-person-"));
  try {
    const now = { at: new Date("2026-11-06T09:00:00Z") };
    const people = new PersonRecords(join(root, "people.jsonl"), () => now.at);
    const learned = people.add(OPERATOR, { field: "preferences", text: "Replies in Chinese, short.", source: "agent:ada" })!;
    const own = people.add(OPERATOR, { field: "preferences", text: "No messages after 23:00.", source: "person" })!;
    assert.equal(people.add(OPERATOR, { field: "preferences", text: "replies in chinese, short.", source: "person" }), undefined, "the same text on the same field is one line");
    const temp = people.add(OPERATOR, { field: "projects", text: "Shipping LumenBox 0.4 this month", source: "routine:sense", expiresAt: "2026-11-30T00:00:00Z" })!;
    assert.deepEqual(people.live(OPERATOR).map(e => e.id), [own.id, learned.id, temp.id]);
    assert.equal(people.retract(OPERATOR, learned.id, "p-chris"), true);
    assert.equal(people.retract(OPERATOR, learned.id, "p-chris"), false);
    now.at = new Date("2026-12-01T09:00:00Z");
    assert.deepEqual(people.live(OPERATOR).map(e => e.id), [own.id], "retracted and expired are gone");
    const again = new PersonRecords(join(root, "people.jsonl"), () => now.at);
    assert.deepEqual(again.live(OPERATOR).map(e => e.id), [own.id]);
    assert.deepEqual(again.live("p-mia"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the prompt section names the person, groups by field, marks what was learned, and is nothing when empty", () => {
  const people = new PersonRecords();
  assert.equal(people.render(OPERATOR, "Chris"), undefined);
  people.add(OPERATOR, { field: "responsibilities", text: "Runs the LumenBox product", source: "person" });
  people.add(OPERATOR, { field: "habits", text: "Reviews in the evening, Shanghai time", source: "agent:ada" });
  const text = people.render(OPERATOR, "Chris")!;
  assert.match(text, /^## About Chris\n/);
  assert.match(text, /Responsibilities:\n- Runs the LumenBox product\n/);
  assert.match(text, /Habits and working hours:\n- Reviews in the evening, Shanghai time \(learned\)/);
  assert.doesNotMatch(text, /Preferences:/);
});

test("a judged memory becomes a line for the person driving, under the field its words point at; held, episodic or impersonal ones do not", () => {
  const people = new PersonRecords();
  const added = people.absorb([
    { kind: "fact", text: "Prefers replies in Chinese", types: { episodic: 0.1, semantic: 0.3, procedural: 0, preference: 0.9 } },
    { kind: "fact", text: "Chris is working on the 0.4 release", types: { episodic: 0.2, semantic: 0.8, procedural: 0, preference: 0.1 } },
    { kind: "fact", text: "Chris usually reviews in the evening", types: { episodic: 0.2, semantic: 0.8, procedural: 0, preference: 0.2 }, held: { question: "contradicts", confidence: 0.7 } },
    { kind: "episode", text: "The build failed twice", types: { episodic: 0.9, semantic: 0.1, procedural: 0, preference: 0 } },
    { kind: "fact", text: "The box runs Debian", types: { episodic: 0, semantic: 0.9, procedural: 0, preference: 0 } },
    { kind: "fact", text: "Mia leads the data team", about: "p-mia", types: { episodic: 0, semantic: 0.9, procedural: 0, preference: 0 } },
  ], "ada", { principal: "p-chris", name: "Chris" });
  assert.deepEqual(added.map(e => [e.field, e.source]), [["preferences", "agent:ada"], ["projects", "agent:ada"]], "the Debian fact names nobody; Mia's line is about Mia and does not name Chris");
  assert.deepEqual(people.live("p-chris").map(e => e.field).sort(), ["preferences", "projects"]);
  assert.deepEqual(people.live("p-mia"), []);
  assert.equal(fieldOf("He is responsible for billing"), "responsibilities");
  assert.equal(fieldOf("wants to run a marathon next year"), "goals");
  assert.equal(fieldOf("喜欢看推理小说"), "interests");
  assert.equal(fieldOf("每天上午九点开始工作"), "habits");
  assert.equal(fieldOf("something else", true), "preferences");
});
