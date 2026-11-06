/**
 * The host's record of the person reaches every turn (INV-1653): a scripted agent is told the
 * preference on the record; the person retracts it and writes another; the next turn is told
 * the new one and not the old.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, PersonRecords } from "./person.ts";
import { runEpisode } from "./scenario.ts";

test("a changed preference changes what the next turn's agent is told", async () => {
  const people = new PersonRecords();
  const english = people.add(OPERATOR, { field: "preferences", text: "Replies in English, one paragraph", source: "person" })!;
  // One episode makes several model calls (the turn, then the bookkeeping); what matters is what every one of them was told.
  const seen = new Set<string>();
  const script = ({ system }: { system: string }) => {
    const about = system.slice(system.indexOf("## About the operator"));
    seen.add(about.includes("Replies in English") ? "english" : about.includes("Replies in Chinese") ? "chinese" : "none");
    return { say: "Noted." };
  };
  await runEpisode({ team: [{ name: "Ada" }], says: ["Hello."], person: people, script });
  assert.deepEqual([...seen], ["english"]);
  seen.clear();

  people.retract(OPERATOR, english.id, "operator");
  people.add(OPERATOR, { field: "preferences", text: "Replies in Chinese, short", source: "person" });
  await runEpisode({ team: [{ name: "Ada" }], says: ["Hello again."], person: people, script });
  assert.deepEqual([...seen], ["chinese"], "the retracted line is gone, the new one is there");

  // Without a record there is no section at all: an empty record is not an empty heading.
  const bare = new Set<boolean>();
  await runEpisode({ team: [{ name: "Ada" }], says: ["Hi."], person: new PersonRecords(), script: ({ system }: { system: string }) => { bare.add(system.includes("## About")); return { say: "ok" }; } });
  assert.deepEqual([...bare], [false]);
});
