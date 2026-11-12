/**
 * Seventy objects, some hundreds of tool calls, one plain request (INV-1823, INV-1776).
 *
 * The long-run work was measured by a pack that lives outside the repository, so nothing here would
 * have noticed it breaking. This is that pack's shape, small enough to run in the suite: seventy
 * articles that each need a source read and a link written, asked for once in an ordinary message —
 * no /goal, nobody saying "continue" — and judged by a checker that reads the result, not the
 * agent's word for it.
 *
 * The scripted model knows the steps; what is under test is whether the harness carries them: across
 * turn budgets, through connection resets scattered between working rounds, and past a write whose
 * acknowledgement never arrived. Whether a real model can plan the work is INV-1827's question.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentBus } from "../agents/bus.ts";
import type { AgentRegistry } from "../agents/registry.ts";
import { BoxError } from "../box/client.ts";
import { GoalLoop } from "./goal-loop.ts";
import { runEpisode, type ScriptedReply } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

const COUNT = 70;
const id = (n: number): string => String(n).padStart(2, "0");
const article = (n: number): string => `/home/box/work/articles/a-${id(n)}.txt`;
const source = (n: number): string => `/home/box/work/sources/s-${id(n)}.txt`;
/** Every seventh article has no source that supports it: the right answer is to leave it unlinked. */
const unsupported = (n: number): boolean => n % 7 === 0;

function world(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let n = 1; n <= COUNT; n++) {
    files[article(n)] = `Article ${id(n)}. Claim: the figure for case ${id(n)} is ${n * 13}.`;
    files[source(n)] = unsupported(n) ? `Source ${id(n)} is about something else.` : `Source ${id(n)} states the figure for case ${id(n)} is ${n * 13}.`;
  }
  return files;
}

/** The independent check: every article once, linked exactly when its source supports it, nothing else touched. */
function check(files: ReadonlyMap<string, string>, writes: ReadonlyMap<string, number>): string[] {
  const wrong: string[] = [];
  for (let n = 1; n <= COUNT; n++) {
    const text = files.get(article(n)) ?? "";
    const linked = text.endsWith(` [source: s-${id(n)}]`);
    if (!text.startsWith(`Article ${id(n)}. Claim: the figure for case ${id(n)} is ${n * 13}.`)) wrong.push(`a-${id(n)}: the original text changed`);
    if (unsupported(n) && linked) wrong.push(`a-${id(n)}: linked to a source that does not support it`);
    if (!unsupported(n) && !linked) wrong.push(`a-${id(n)}: not linked`);
    if ((writes.get(article(n)) ?? 0) > 1) wrong.push(`a-${id(n)}: written ${writes.get(article(n))} times`);
  }
  for (const path of files.keys()) if (path.includes("/sources/") && files.get(path) !== world()[path]) wrong.push(`${path}: a source was changed`);
  return wrong;
}

/** The real continuation loop on the episode's bus, its delays shortened. */
function loop() {
  return ({ bus, registry, tasks, files }: { bus: AgentBus; registry: AgentRegistry; tasks: TaskStore | undefined; files: Map<string, string> }) =>
    new GoalLoop({
      tasks: tasks!, modelRecoveryRoot: registry.root, agentName: agentId => registry.tryGet(agentId)?.profile.name, bus,
      manifest: async () => new Map([...files.entries()].map(([path, content]) => [path, `h:${content.length}`])),
      busy: () => [], wakeGate: () => ({ allowed: true }),
      durableState: (agentId, conversation) => registry.readDurableState(agentId, conversation),
      notify: async () => {}, log: () => {},
      schedule: (fn, ms) => { const timer = setTimeout(fn, Math.min(ms, 10)); return { cancel: () => clearTimeout(timer) }; },
    });
}

interface Faults { resets?: number[]; lostAck?: number }
/** What the box client says when a request was sent and its answer never came (client.ts): the words the agent acts on. */
const LOST_CONTACT = "/fs/write lost contact with the box: socket hang up. The outcome is unknown — check its effect or reconcile by operation ID before retrying.";

async function run(faults: Faults) {
  const dir = mkdtempSync(join(tmpdir(), "long-work-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  const writes = new Map<string, number>();
  let files: Map<string, string> | undefined;
  let current = 1, step: "read" | "source" | "write" | "verify" = "read", calls = 0, resets = 0, lost = 0, readBacks = 0, unknownSeen = "";
  const lastResult = (messages: Anthropic.MessageParam[]): { text: string; isError: boolean } => {
    const blocks = messages.at(-1)?.content;
    const result = Array.isArray(blocks) ? blocks.find(block => block.type === "tool_result") : undefined;
    return result?.type === "tool_result" ? { text: JSON.stringify(result.content), isError: result.is_error === true } : { text: "", isError: false };
  };
  const script = ({ offered, messages }: { offered: string[]; messages: Anthropic.MessageParam[] }): ScriptedReply => {
    // The summariser and the handoff writer ask the same model without tools; a ceiling's last round forbids them.
    const last = messages.at(-1);
    if (!offered.includes("write_file") || (typeof last?.content === "string" && last.content.startsWith("[last round]"))) return { say: `Progress: ${current - 1} of ${COUNT} articles handled.` };
    calls++;
    if ((faults.resets ?? []).includes(calls)) { resets++; throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); }
    if (current > COUNT) return { say: `All ${COUNT} articles are handled: linked where the source supports the claim, left alone where it does not.` };
    const before = lastResult(messages);
    if (step === "read") { step = "source"; return { call: "read_file", input: { path: article(current) } }; }
    if (step === "source") { step = "write"; return { call: "read_file", input: { path: source(current) } }; }
    if (step === "write") {
      // Decided from the source itself, not from the last message: a turn budget can fall between the read and the write.
      if (!files!.get(source(current))!.includes(`the figure for case ${id(current)} is`)) { current++; step = "read"; return script({ offered, messages }); }
      step = "verify";
      return { call: "write_file", input: { path: article(current), content: `${files!.get(article(current))} [source: s-${id(current)}]`, overwrite: true } };
    }
    // After a write: an acknowledgement that did not come is settled by reading the article, never by writing it again.
    if (before.isError && /unknown/i.test(before.text)) { readBacks++; unknownSeen = before.text; return { call: "read_file", input: { path: article(current) } }; }
    current++; step = "read";
    return script({ offered, messages });
  };
  const result = await runEpisode({
    team: [{ name: "Nova", tools: ["read_file", "write_file"] }], says: [], tasks, goalLoop: loop(), maxRounds: 1500, files: world(),
    wrote: path => {
      writes.set(path, (writes.get(path) ?? 0) + 1);
      // The write has landed and its acknowledgement does not arrive: the one failure a retry must not answer.
      if (faults.lostAck !== undefined && path === article(faults.lostAck) && lost++ === 0) throw new BoxError(LOST_CONTACT, undefined, "unreachable");
    },
    script: script as never,
    drive: async ({ bus, frontId, files: episodeFiles }) => {
      files = episodeFiles;
      bus.sendFromUser(frontId, `Link each of the ${COUNT} articles to its source where the source supports the claim. Leave the others alone.`);
      await bus.wake(frontId);
      const task = () => tasks.list()[0];
      const until = Date.now() + 40_000;
      while (task()?.status !== "done" && task()?.pursuit?.status !== "paused" && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
      await bus.idle();
    },
  });
  const task = tasks.list()[0]!;
  const outcome = { wrong: check(result.files, writes), task, said: result.score.said.map(row => row.text), calls, resets, readBacks, unknownSeen, writes, cleanup: () => { result.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
  return outcome;
}

function passes(outcome: Awaited<ReturnType<typeof run>>): void {
  assert.deepEqual(outcome.wrong, [], "the independent check");
  const written = [...outcome.writes.keys()].filter(path => path.includes("/articles/")).length;
  assert.equal(written, COUNT - Math.floor(COUNT / 7), "only the supported articles were written at all");
  assert.equal(outcome.task.status, "done", `the request closed (pursuit ${outcome.task.pursuit?.status} ${outcome.task.pursuit?.pausedReason ?? ""})`);
  assert.ok(outcome.said.some(text => text.includes(`All ${COUNT} articles are handled`)), "the answer reached the person");
  assert.ok(!outcome.said.some(text => /tell me to continue|让我继续/.test(text)), "nobody was asked to say continue");
}

test("a plain request over seventy objects is carried to a checked finish across turn budgets", { timeout: 60_000 }, async () => {
  const outcome = await run({});
  try {
    passes(outcome);
    assert.ok(outcome.calls > 180, `several budgets' worth of model calls (${outcome.calls})`);
    assert.ok(outcome.task.pursuit!.spent.continuations >= 3, "continued by the host, not by the person");
  } finally { outcome.cleanup(); }
});

test("connection resets scattered through the work do not end it", { timeout: 60_000 }, async () => {
  const outcome = await run({ resets: [15, 70, 130, 190, 240] });
  try {
    passes(outcome);
    assert.equal(outcome.resets, 5, "every reset was actually injected");
  } finally { outcome.cleanup(); }
});

test("a write whose acknowledgement is lost is read back, not written twice", { timeout: 60_000 }, async () => {
  const outcome = await run({ lostAck: 23 });
  try {
    passes(outcome);
    assert.match(outcome.unknownSeen, /outcome is unknown/i, "the agent was told the outcome is unknown, not that nothing was delivered");
    assert.equal(outcome.readBacks, 1, "and settled it by reading");
    assert.equal(outcome.writes.get(article(23)), 1, "the article was written once");
  } finally { outcome.cleanup(); }
});
