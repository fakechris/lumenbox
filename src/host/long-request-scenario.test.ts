/**
 * A request that does not fit in one turn's budget is carried by the host (INV-1823).
 *
 * Before this, the long-run work only reached somebody who knew to type `/goal` in a private chat:
 * the same request typed into the app got sixty model calls and "tell me to continue". These episodes
 * are that person's: they say what they want, once, and never say "continue".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { GoalLoop } from "./goal-loop.ts";
import { runEpisode } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

/** The real loop on the episode's bus, its delays shortened: they are for people, not for a test. */
function loop(told: string[]) {
  return ({ bus, registry, tasks, files }: { bus: AgentBus; registry: AgentRegistry; tasks: TaskStore | undefined; files: Map<string, string> }) =>
    new GoalLoop({
      tasks: tasks!,
      modelRecoveryRoot: registry.root,
      agentName: id => registry.tryGet(id)?.profile.name,
      bus,
      manifest: async () => new Map([...files.entries()].map(([path, content]) => [path, `h:${content.length}`])),
      busy: () => [],
      wakeGate: () => ({ allowed: true }),
      durableState: (agentId, conversation) => registry.readDurableState(agentId, conversation),
      notify: async (_task, text) => { told.push(text); },
      log: () => {},
      schedule: (fn, ms) => { const timer = setTimeout(fn, Math.min(ms, 10)); return { cancel: () => clearTimeout(timer) }; },
    });
}

async function settled(predicate: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("did not settle in time");
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

const parts = (files: Map<string, string>): number => [...files.keys()].filter(path => /part-\d+\.txt$/.test(path)).length;

test("a plain request that needs 245 tool calls finishes without /goal and without the person saying continue", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "long-request-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  const told: string[] = [];
  let writes = 0;
  const result = await runEpisode({
    team: [{ name: "Nova", tools: ["write_file"] }], says: [], tasks, goalLoop: loop(told), maxRounds: 400,
    script: ({ offered }) => {
      // The summariser and the handoff writer ask the same model, without tools: answer them in kind.
      if (!offered.includes("write_file")) return { say: "**Threads**\n- finish all 245 artifacts\n**State**\n- continue with the remaining artifacts" };
      if (writes >= 245) return { say: "All 245 artifacts are written." };
      writes++;
      return { call: "write_file", input: { path: `/home/box/work/part-${writes}.txt`, content: `artifact ${writes}` } };
    },
    drive: async ({ bus, frontId, files }) => {
      bus.sendFromUser(frontId, "Write all 245 artifacts, one file each.");
      await bus.wake(frontId);
      const task = () => tasks.list().find(row => row.title.startsWith("Write all 245"));
      await settled(() => task()?.status === "done" || task()?.pursuit?.status === "paused", 15_000);
      assert.equal(parts(files), 245, "every artifact was written");
      const done = task()!;
      assert.equal(done.status, "done", "and the request closed like any answered request");
      assert.equal(done.pursuit?.completion, "answer");
      assert.ok(done.pursuit!.spent.continuations >= 4, "it crossed several turn budgets on the host's own continuation");
      assert.equal(told.length, 0, "nobody was told it had stopped");
    },
  });
  try {
    const said = result.score.said.map(row => row.text);
    assert.ok(said.some(text => text.includes("All 245 artifacts are written.")), "the answer reached the person, not only the record");
    assert.ok(!said.some(text => /tell me to continue|让我继续/.test(text)), "no slice handed the work back");
  } finally {
    result.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request that stops making progress is not continued for ever, and its ceiling is the configured one", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "long-request-ceiling-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  const told: string[] = [];
  let writes = 0;
  const result = await runEpisode({
    team: [{ name: "Nova", tools: ["write_file"] }], says: [], tasks, goalLoop: loop(told), maxRounds: 400,
    longWork: { continuations: 2 },
    script: ({ offered, messages }) => {
      // The ceiling's last round forbids tools by tool_choice, which a provider enforces and a script must honour.
      const last = messages.at(-1);
      const lastRound = last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[last round]");
      if (lastRound || !offered.includes("write_file")) return { say: "Stopped at the ceiling: 180 of an unbounded list written." };
      writes++;
      return { call: "write_file", input: { path: `/home/box/work/part-${writes}.txt`, content: `artifact ${writes}` } };
    },
    drive: async ({ bus, frontId, files }) => {
      bus.sendFromUser(frontId, "Keep writing artifacts until I say stop.");
      await bus.wake(frontId);
      const task = () => tasks.list().find(row => row.title.startsWith("Keep writing"));
      await settled(() => task()?.pursuit?.status === "paused", 15_000);
      assert.equal(task()!.pursuit!.pausedReason, "continuations");
      assert.equal(task()!.pursuit!.limits.continuations, 2, "the ceiling is the operator's setting");
      assert.equal(task()!.status, "blocked", "and the request waits for the person, visibly");
      await bus.idle();
      assert.ok(parts(files) <= 60 * 3, `the first slice and two continuations at most, wrote ${parts(files)}: ${JSON.stringify(task()!.history.map(row => row.note))}`);
    },
  });
  try {
    assert.equal(told.length, 1, "the person is told once where it stopped");
  } finally {
    result.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a request that only talked at the budget line, or a card somebody made by hand, keeps the hand-back", async () => {
  const { continueAcrossBudget, longRequestLimits } = await import("./long-request.ts");
  const tasks = new TaskStore(null);
  const byHand = tasks.create({ title: "A card made by hand", requester: "person", assigneeId: "a1", conversation: "main" })!;
  const limits = longRequestLimits();
  assert.equal(continueAcrossBudget(tasks, { taskId: byHand.id, workId: "w", agentId: "a1", conversation: "main", worked: true }, limits), false);
  assert.equal(continueAcrossBudget(tasks, { taskId: undefined, workId: "w", agentId: "a1", conversation: "main", worked: true }, limits), false);
  assert.equal(tasks.get(byHand.id)!.pursuit, undefined);
});
