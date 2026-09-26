import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { TaskStore } from "./tasks.ts";
import { dispatchTool } from "./tools.ts";
import { ForgetPlans, forgetOutcomeReport, forgetPlanReport, executeForget, inventory } from "./forget.ts";
import { fetchedDir } from "./fetched.ts";
import { resultsDir } from "./results.ts";
import { loadSkills } from "./skills.ts";
import { Scheduler } from "./schedule.ts";

const SECRET = "HbA1c 7.9";

/** A box with real directories, so skills load the way they do on a real box. */
function fakeBox(files: Map<string, string>) {
  return {
    files,
    listDir: async (path: string) => {
      const prefix = `${path.replace(/\/$/, "")}/`;
      const children = new Map<string, "file" | "directory">();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const [head, ...tail] = rest.split("/");
        children.set(head!, tail.length > 0 ? "directory" : "file");
      }
      if (children.size === 0) throw new Error(`${path} does not exist`);
      return { path, entries: [...children].map(([name, type]) => ({ name, type, size: 0 })) };
    },
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      return { path, content, total_lines: content.split("\n").length, truncated: false };
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
      return { path, bytes: content.length };
    },
  };
}

function world() {
  const home = mkdtempSync(join(tmpdir(), "agentbox-forget-"));
  const registry = new AgentRegistry(join(home, "agents"));
  const ada = registry.create({ name: "Ada", boxId: registry.box.id });
  const tasks = new TaskStore(join(home, "tasks.jsonl"));
  const box = fakeBox(new Map([
    // A routine that would write it back every Monday.
    ["/home/box/work/skills/health-digest/SKILL.md", `---\nname: health-digest\ndescription: Use when asked for a health digest.\nschedule: "0 9 * * 1"\n---\nEvery Monday, remind them their ${SECRET} and suggest a follow-up.\n`],
    // A skill that only mentions it: the person's to edit.
    ["/home/box/work/skills/notes/SKILL.md", `---\nname: notes\ndescription: Use when asked about notes.\n---\nExample: ${SECRET}.\n`],
    ["/home/box/work/skills/unrelated/SKILL.md", `---\nname: unrelated\ndescription: Use when asked for something else.\n---\nNothing here.\n`],
  ]));
  registry.appendMemoryRecords(ada.id, [
    { at: new Date().toISOString(), kind: "fact", text: `Their last ${SECRET} was high` },
    { at: new Date().toISOString(), kind: "fact", text: "They prefer mornings" },
  ]);
  registry.appendSharedMemory(ada.id, [{ at: new Date().toISOString(), kind: "fact", text: `Team knows ${SECRET}` }]);
  // What the person said stays in the record: counted as kept, never removed.
  registry.appendTranscript(ada.id, { role: "user", text: `my ${SECRET} came back`, at: new Date(Date.now() - 60_000).toISOString(), fromPerson: true }, "feishu-u1");
  const page = join(fetchedDir(home), "2026-09", "abc-1.md");
  mkdirSync(dirname(page), { recursive: true });
  writeFileSync(page, `---\nurl: https://lab.example\n---\nResult: ${SECRET}\n`);
  const result = join(resultsDir(home), "2026-09", "t1-u1.txt");
  mkdirSync(dirname(result), { recursive: true });
  writeFileSync(result, `lab export ${SECRET}`);
  const task = tasks.create({ title: `Book a follow-up about ${SECRET}`, requester: ada.id })!;
  tasks.update(task.id, { title: "Book a follow-up" }, ada.id); // the old wording survives only in an earlier snapshot
  writeFileSync(join(home, "commitments.jsonl"), `${JSON.stringify({ text: `recheck ${SECRET}` })}\n${JSON.stringify({ text: "ship it" })}\n`);
  return { home, registry, ada, tasks, box, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("the plan finds every place, and its report never repeats the words", async () => {
  const w = world();
  try {
    const found = await inventory(SECRET, { registry: w.registry, tasks: w.tasks, box: w.box as never, home: w.home });
    assert.equal(found.memory, 1);
    assert.equal(found.sharedMemory, 1);
    assert.equal(found.fetchedPages, 1);
    assert.equal(found.keptResults, 1);
    assert.equal(found.commitments, 1);
    assert.deepEqual(found.routines, ["health-digest"], "the routine is the producer");
    assert.deepEqual(found.skills, ["notes"], "a skill that mentions it is listed, not rewritten");
    const report = forgetPlanReport(found, "forget-1");
    assert.doesNotMatch(report, /HbA1c|7\.9/i, "the plan names places and counts, never the words");
    assert.match(report, /nothing has been changed yet/);
  } finally { w.cleanup(); }
});

test("a plan is confirmed only in a later turn, after the person has spoken", () => {
  let now = 1_000;
  const plans = new ForgetPlans(60_000, () => now);
  const id = plans.hold({ phrase: SECRET, agentId: "a", conversation: "c", turnId: "t1" });
  const request = (turnId: string, spoke: boolean) => ({ agentId: "a", conversation: "c", turnId, personSpokeSince: () => spoke });
  assert.match((plans.take(id, request("t1", true)) as { refused: string }).refused, /turn that made it/);
  assert.match((plans.take(id, request("t2", false)) as { refused: string }).refused, /not answered/);
  assert.match((plans.take(id, { ...request("t2", true), conversation: "other" }) as { refused: string }).refused, /another conversation/);
  assert.deepEqual(plans.take(id, request("t2", true)), { phrase: SECRET });
  assert.match((plans.take(id, request("t3", true)) as { refused: string }).refused, /No such plan/, "used once");
  const stale = plans.hold({ phrase: SECRET, agentId: "a", conversation: "c", turnId: "t1" });
  now += 61_000;
  assert.match((plans.take(stale, request("t2", true)) as { refused: string }).refused, /expired/);
});

test("forget end to end: plan, the person's yes, confirm — producer paused first, every copy gone, checked again, never repeated (INV-757)", async () => {
  const w = world();
  try {
    const context = (turnId: string) => ({
      agent: w.ada, registry: w.registry, bus: {} as never, box: w.box as never, tasks: w.tasks,
      conversation: "feishu-u1", turnId, fetchedHome: w.home,
    }) as unknown as Parameters<typeof dispatchTool>[2];

    const plan = await dispatchTool("Forget", { action: "plan", about: SECRET }, context("turn-1"));
    assert.ok(!plan.isError, plan.text);
    const id = /Plan (forget-[a-f0-9]+)/.exec(plan.text)![1]!;
    assert.doesNotMatch(plan.text, /HbA1c/);

    // The same turn cannot confirm its own plan.
    const early = await dispatchTool("Forget", { action: "confirm", plan: id }, context("turn-1"));
    assert.ok(early.isError);
    assert.match(early.text, /turn that made it/);

    // Something new lands after the plan: the execute step searches again, so it goes too.
    await new Promise(resolve => setTimeout(resolve, 5));
    w.registry.appendMemoryRecords(w.ada.id, [{ at: new Date().toISOString(), kind: "note", text: `Mentioned ${SECRET} again` }]);
    // The person answers.
    w.registry.appendTranscript(w.ada.id, { role: "user", text: "yes, forget it", at: new Date().toISOString(), fromPerson: true }, "feishu-u1");

    const done = await dispatchTool("Forget", { action: "confirm", plan: id }, context("turn-2"));
    assert.ok(!done.isError, done.text);
    assert.doesNotMatch(done.text, /HbA1c/, "the outcome names places and counts, never the words");
    assert.match(done.text, /none of those places holds it now/);
    assert.match(done.text, /paused 1 routine/);
    assert.match(done.text, /Kept by design and not removed: the record of what was said — 1 transcript entry/);
    assert.match(done.text, /earlier wording in the board's task history/);

    // The producer is paused, so the next Monday does not write it back.
    const skills = (await loadSkills(w.box as never)).skills;
    assert.equal(skills.find(skill => skill.slug === "health-digest")?.paused, true);
    const fired: string[] = [];
    const scheduler = new Scheduler({
      due: async () => skills.filter(skill => skill.schedule !== undefined).map(skill => ({ slug: skill.slug, name: skill.name, path: skill.path, schedule: skill.schedule!, ...(skill.paused ? { paused: true } : {}) })),
      run: async (_agent, _prompt, _deliver, slug) => { fired.push(slug ?? ""); },
      defaultAgent: () => w.ada.id,
      now: () => new Date("2026-09-28T09:00:30"),
      path: null,
    });
    await scheduler.tick();
    assert.deepEqual(fired, [], "a paused routine does not fire");

    // Every copy is gone — the late note included — and the rest is untouched.
    const memory = readFileSync(w.registry.memoryRecordsPathFor(w.ada.id), "utf8");
    assert.doesNotMatch(memory, /HbA1c/);
    assert.match(memory, /prefer mornings/, "only what mentions it goes");
    assert.doesNotMatch(readFileSync(w.registry.sharedMemoryPathFor(w.ada.id), "utf8"), /HbA1c/);
    assert.equal(existsSync(join(fetchedDir(w.home), "2026-09", "abc-1.md")), false);
    assert.equal(existsSync(join(resultsDir(w.home), "2026-09", "t1-u1.txt")), false);
    assert.equal(w.tasks.fileMentions(SECRET), false, "the board's earlier snapshots are rewritten too");
    assert.doesNotMatch(readFileSync(join(w.home, "commitments.jsonl"), "utf8"), /HbA1c/);
    assert.match(readFileSync(join(w.home, "commitments.jsonl"), "utf8"), /ship it/);
    assert.match(w.box.files.get("/home/box/work/skills/notes/SKILL.md")!, /HbA1c/, "a skill that only mentions it is the person's to edit");

    // The plan is gone with it: a second confirm finds nothing.
    const again = await dispatchTool("Forget", { action: "confirm", plan: id }, context("turn-3"));
    assert.ok(again.isError);
  } finally { w.cleanup(); }
});

test("the outcome says what is still there rather than claiming it is forgotten", async () => {
  const w = world();
  try {
    const outcome = await executeForget(SECRET, { registry: w.registry, tasks: w.tasks, box: w.box as never, home: w.home });
    const pretendLeft = { ...outcome, after: { ...outcome.after, fetchedPages: 2 } };
    const report = forgetOutcomeReport(pretendLeft);
    assert.match(report, /STILL in: 2 kept page/);
    assert.match(report, /do not say it is forgotten/);
  } finally { w.cleanup(); }
});

test("a goal is set up once per area; asking again follows the open one up (INV-757)", async () => {
  const w = world();
  try {
    const context = { agent: w.ada, registry: w.registry, bus: {} as never, box: undefined, tasks: w.tasks, conversation: "c" } as unknown as Parameters<typeof dispatchTool>[2];
    const first = await dispatchTool("Tasks", { action: "create", title: "Run a half marathon by spring", goal_area: "fitness", commitment: "run 3 times a week", due: "2026-10-03" }, context);
    assert.ok(!first.isError, first.text);
    const again = await dispatchTool("Tasks", { action: "create", title: "Get fit", goal_area: "Fitness" }, context);
    assert.ok(again.isError);
    assert.match(again.text, /already an open fitness goal/);
    assert.match(again.text, /Follow that one up/);
    const other = await dispatchTool("Tasks", { action: "create", title: "Save for a flat", goal_area: "money" }, context);
    assert.ok(!other.isError, "a different area is a different goal");
    assert.equal(w.tasks.openGoalIn("fitness")?.goal?.commitment, "run 3 times a week");
  } finally { w.cleanup(); }
});
