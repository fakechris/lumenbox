/**
 * Dependencies between tasks, on the real stack (INV-1740, docs/43): Ada splits a launch into three
 * cards, A ← B ← C — draft, review, publish — with C for Bob. Taking B before A is done is refused;
 * A done releases B and wakes Ada for it; B done releases C and wakes Bob, who was told of C when it
 * was made and could not start it then. A fifth card waits on a legal sign-off nobody is doing; the
 * person takes the blocker off, and Bob is woken for it at once.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { localizeScript } from "../web/page-locale.ts";
import { TASK_DEPS_JS } from "../web/task-deps-ui.ts";
import { runEpisode, type Script, type ScriptContext } from "./scenario.ts";
import { dependencyView } from "./task-deps.ts";
import { TaskStore } from "./tasks.ts";

/** The text of the newest message in the call: the tool result just returned, or what opened the turn. */
function latest(context: ScriptContext): string {
  return JSON.stringify(context.messages.at(-1)?.content ?? "");
}

/** The agents' ids, known once the episode has made them; the cards name assignees by id. */
const ids: { ada?: string; bob?: string } = {};

const adaPlan = (): { call: string; input: Record<string, unknown> }[] => [
  { call: "Tasks", input: { action: "create", title: "Draft the launch post", assignee: ids.ada } },
  { call: "Tasks", input: { action: "create", title: "Review the post", assignee: ids.ada, blocked_by: ["t1"] } },
  { call: "Tasks", input: { action: "create", title: "Publish the post", assignee: ids.bob, blocked_by: ["t2"] } },
  { call: "Tasks", input: { action: "create", title: "Legal sign-off" } },
  { call: "Tasks", input: { action: "create", title: "Announce in the team chat", assignee: ids.bob, blocked_by: ["t4"] } },
  { call: "Tasks", input: { action: "take", id: "t2" } },
  { call: "Tasks", input: { action: "take", id: "t1" } },
  { call: "Tasks", input: { action: "update", id: "t1", status: "done", note: "drafted in post.md" } },
];

const script: Script = context => {
  const last = latest(context);
  if (context.agent === "Ada") {
    if (/\[t2 .{0,40}is ready/.test(last)) return { call: "Tasks", input: { action: "take", id: "t2" } };
    if (/You are on it: t2/.test(last)) return { call: "Tasks", input: { action: "update", id: "t2", status: "done", note: "reviewed" } };
    if (/t2 \[done\]/.test(last)) return { say: "Reviewed; Bob publishes next." };
    return adaPlan()[(context.messages.length - 1) / 2] ?? { say: "The launch is split: I draft, then review, then Bob publishes." };
  }
  // Bob: told of his cards when they are made, and woken by the board when one is ready.
  if (/\[t3 .{0,40}is ready/.test(last)) return { call: "Tasks", input: { action: "take", id: "t3" } };
  if (/\[t5 .{0,60}is ready/.test(last)) return { call: "Tasks", input: { action: "take", id: "t5" } };
  if (/You are on it: t3/.test(last)) return { call: "Tasks", input: { action: "update", id: "t3", status: "done", note: "published" } };
  if (/You are on it: t5/.test(last)) return { call: "Tasks", input: { action: "update", id: "t5", status: "done", note: "announced" } };
  if (/Task t3 is assigned to you/.test(last) && !/blocked by/.test(last)) return { call: "Tasks", input: { action: "take", id: "t3" } };
  return { say: "Noted." };
};

test("A ← B ← C: taking follows the dependencies, each release wakes the next assignee, and a person's edit takes effect at once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-deps-ep-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  let beforeEdit: { t3: string; t5: string } | undefined;
  const episode = await runEpisode({
    team: [{ name: "Ada" }, { name: "Bob" }],
    says: [],
    tasks,
    script,
    drive: async ({ bus, registry, say }) => {
      ids.ada = registry.list().find(record => record.profile.name === "Ada")!.id;
      ids.bob = registry.list().find(record => record.profile.name === "Bob")!.id;
      await say("Split the launch post into cards and get it out.");
      beforeEdit = { t3: tasks.get("t3")!.status, t5: tasks.get("t5")!.status };
      // The person decides no sign-off is needed and takes the blocker off the board card.
      tasks.update("t5", { blockedBy: [] }, "p-chris");
      await bus.idle();
    },
  });
  try {
    const ada = episode.registry.list().find(record => record.profile.name === "Ada")!.id;
    const bob = episode.registry.list().find(record => record.profile.name === "Bob")!.id;
    // Taking B before A was finished was refused, in words that say why.
    assert.ok(episode.score.refusals.some(line => /Ada: t2 is blocked by t1, which is not finished/.test(line)), episode.score.refusals.join("\n"));
    // The order the board allowed: each card started only after the one it waits on was finished, each by its own assignee.
    const when = (id: string, status: string) => tasks.get(id)!.history.find(change => change.status === status)!.at;
    assert.ok(when("t2", "doing") >= when("t1", "done"), "B started after A finished");
    assert.ok(when("t3", "doing") >= when("t2", "done"), "C started after B finished");
    assert.deepEqual(["t1", "t2", "t3", "t5"].map(id => [id, tasks.get(id)!.status]), [["t1", "done"], ["t2", "done"], ["t3", "done"], ["t5", "done"]]);
    assert.equal(tasks.get("t2")!.assigneeId, ada);
    assert.equal(tasks.get("t3")!.assigneeId, bob);
    // What woke Ada for B and Bob for C was the board: the release line is in each card's history.
    assert.ok(tasks.get("t2")!.history.some(change => change.by === "host" && /is ready: t1 is finished/.test(change.note ?? "")));
    assert.ok(tasks.get("t3")!.history.some(change => change.by === "host" && /is ready: t2 is finished/.test(change.note ?? "")));
    const bobTakes = episode.observations.filter(o => o.kind === "call" && o.agent === "Bob" && o.name === "Tasks" && o.input?.action === "take").map(o => String(o.input?.id));
    assert.ok(bobTakes.includes("t3") && bobTakes.includes("t5"));
    // Before the person's edit, Bob's t3 had been released (t2 done) but t5 still waited on the sign-off.
    assert.deepEqual(beforeEdit, { t3: "done", t5: "open" });
    assert.equal(tasks.get("t4")!.status, "open", "the sign-off itself is untouched");
    assert.ok(tasks.get("t5")!.history.some(change => change.note === "waits on nothing" && change.by === "p-chris"), "the person's edit is on the record");

    // The card as the page renders it, from what /api/tasks sends.
    const window: Record<string, unknown> = {};
    runInNewContext(localizeScript(TASK_DEPS_JS, "en"), { window, document: { addEventListener: () => {} }, esc: (text: unknown) => String(text) });
    const chip = window.taskDepsChip as (task: unknown) => string;
    const fresh = new TaskStore(null);
    fresh.create({ title: "A", requester: "p" });
    fresh.create({ title: "B", requester: "p" });
    fresh.create({ title: "C", requester: "p", blockedBy: ["t1", "t2"] });
    fresh.update("t1", { status: "done" }, "p");
    assert.match(chip({ ...fresh.get("t3")!, ...dependencyView(fresh.get("t3")!, fresh) }), /waiting on 1 of 2 · after t1, t2/);
    assert.match(chip({ ...fresh.get("t2")!, ...dependencyView(fresh.get("t2")!, fresh) }), /blocks t3/);
  } finally {
    episode.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
