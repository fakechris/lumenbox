/**
 * The crash sweep (INV-1332): the host dies at every step boundary of one turn, a new host comes up
 * on the same directory, and the rules of docs/04 §16 are checked at each cut rather than at the few
 * the author thought of.
 *
 * The rules: a side effect runs at most once, whatever the cut; a call cut between its dispatch and
 * its result on disk comes back to the model as `outcome_unknown`, never re-run by the host; a call
 * never dispatched comes back `not_started`; a read-only call is re-run; and the resumed turn ends
 * where the uninterrupted one would have, with the same files written.
 *
 * "Dies" is real: the dying host is a child process of this test, running the same orchestrator on
 * the same directory, and at the chosen point it sends itself SIGKILL. Nothing after that point
 * runs, so what is on disk is what a crash there leaves. The box is a directory of real files and
 * a log of effects, so both processes see the same world. Then this process opens the directory
 * again, which is what a restart is. The scripted model does what the resume result asks of a real
 * one: on `outcome_unknown` it looks at the state the call would have changed before repeating it;
 * on `not_started` it calls again.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import type { BoxClient } from "../box/client.ts";
import { Orchestrator } from "./orchestrator.ts";
import { StepLedger, TurnLedger } from "./resume.ts";
import { fakeModel } from "./testing/fake-model.ts";

const HI = "/home/box/work/hi.txt";
const A = "/home/box/work/a.txt";
const B = "/home/box/work/b.txt";

/** The point the dying process dies at. `at` is the kill: nothing after it runs. */
function cutter(point: string | undefined) {
  return (here: string): void => {
    if (here !== point) return;
    process.kill(process.pid, "SIGKILL");
    // SIGKILL is not deliverable to oneself synchronously on every platform; hang until it lands.
    const forever = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(forever, 0, 0);
  };
}

/** A box over real files under `root/boxfs`, with every effect appended to `root/ran.log`, so two processes see one world. */
function fileBox(root: string, at: (here: string) => void): BoxClient {
  const fs = join(root, "boxfs");
  mkdirSync(fs, { recursive: true });
  const real = (path: string) => join(fs, path.replace(/^\/+/, "").replace(/\//g, "__"));
  const ran = (line: string) => appendFileSync(join(root, "ran.log"), `${line}\n`);
  const client = {
    health: async () => ({ ok: true, resolution: undefined }),
    ensureDisplay: async (index: number) => ({ display: index }),
    exec: async (command: string) => {
      at("effect:bash:before");
      if (command.includes("hi.txt")) writeFileSync(real(HI), "hi");
      ran(`bash:${command}`);
      at("effect:bash:after");
      return { stdout: "", stderr: "", exit_code: 0 };
    },
    writeFile: async (path: string, content: string) => {
      const bookkeeping = path.includes("/memory/") || path.includes("/standing/");
      if (!bookkeeping) at("effect:write:before");
      writeFileSync(real(path), content);
      if (!bookkeeping) {
        ran(`write:${path}`);
        at("effect:write:after");
      }
      return { path, bytes_written: content.length };
    },
    readFile: async (path: string) => {
      if (path === A) at("effect:read:before");
      if (!existsSync(real(path))) throw new Error(`${path} does not exist`);
      const content = readFileSync(real(path), "utf8");
      if (path === A) {
        ran(`read:${path}`);
        at("effect:read:after");
      }
      return { path, content, total_lines: 1, truncated: false };
    },
  };
  return new Proxy(client, { get: (target, property) => (property in target ? target[property as keyof typeof target] : async () => ({})) }) as unknown as BoxClient;
}

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "sweep", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
}
const say = (text: string) => message([{ type: "text", text, citations: [] } as unknown as Anthropic.ContentBlock], "end_turn");
const call = (name: string, input: Record<string, unknown>) => message([{ type: "tool_use", id: `c${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, name, input } as Anthropic.ContentBlock], "tool_use");

interface Seen { name: string; input: Record<string, unknown>; result?: string }

/** What the model can see of its own calls so far: each tool_use with the text of its result, if any. */
function seenCalls(params: Anthropic.MessageCreateParams): Seen[] {
  const byId = new Map<string, Seen>();
  for (const entry of params.messages) {
    if (typeof entry.content === "string") continue;
    for (const block of entry.content) {
      if (block.type === "tool_use") byId.set(block.id, { name: block.name, input: block.input as Record<string, unknown> });
      if (block.type === "tool_result") {
        const seen = byId.get(block.tool_use_id);
        if (seen === undefined) continue;
        seen.result = typeof block.content === "string" ? block.content : (block.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("\n");
      }
    }
  }
  return [...byId.values()];
}

/**
 * The task, as a model that reads its own history: run `bash` once (it writes hi.txt), read a.txt,
 * write b.txt, say done. An effect whose result is unknown is checked before it is repeated; one that
 * never started is called again; a read with no usable result is read again.
 */
function respond(params: Anthropic.MessageCreateParams): Anthropic.Message {
  const seen = seenCalls(params);
  const effectState = (name: string, verifyPath: string): "none" | "look" | "ok" => {
    const attempts = seen.filter(s => s.name === name);
    if (attempts.length === 0) return "none";
    const last = attempts[attempts.length - 1]!;
    if (last.result === undefined || /not_started/.test(last.result)) return "none";
    if (/outcome_unknown/.test(last.result)) {
      // Look before redoing: the latest read of what the call would have changed decides.
      const look = [...seen].reverse().find(s => s.name === "read_file" && s.input.path === verifyPath);
      if (look === undefined || look.result === undefined) return "look";
      return /does not exist/.test(look.result) ? "none" : "ok";
    }
    return "ok";
  };
  const bash = effectState("bash", HI);
  if (bash === "none") return call("bash", { command: "echo hi > /home/box/work/hi.txt" });
  if (bash === "look") return call("read_file", { path: HI });
  const reads = seen.filter(s => s.name === "read_file" && s.input.path === A);
  const lastRead = reads[reads.length - 1];
  if (lastRead === undefined || lastRead.result === undefined || /not_started|outcome_unknown/.test(lastRead.result)) return call("read_file", { path: A });
  const write = effectState("write_file", B);
  if (write === "none") return call("write_file", { path: B, content: "B" });
  if (write === "look") return call("read_file", { path: B });
  return say("done");
}

/**
 * Every boundary the sweep cuts at, in the order the uninterrupted turn passes them. The step
 * ledger's own writes are not separate cuts: `pending` is written just before the effect, so a kill
 * after it is `effect:*:before`; `settled` is written just after the results, so a kill after it is
 * the next `model:k`.
 */
const CUTS = [
  "model:0",
  "effect:bash:before", "effect:bash:after", "results:before:1", "results:after:1",
  "model:1",
  "effect:read:before", "effect:read:after", "results:before:2", "results:after:2",
  "model:2",
  "effect:write:before", "effect:write:after", "results:before:3", "results:after:3",
  "model:3",
  "turn:end",
];

const paths = (root: string) => ({ agents: join(root, "agents"), turns: join(root, "turns.jsonl"), steps: join(root, "turn-steps.jsonl") });

/** One host over the directory: the dying one when `point` is set (it kills itself there), the restarted one otherwise. */
function host(root: string, point: string | undefined) {
  const at = cutter(point);
  const p = paths(root);
  const registry = new AgentRegistry(p.agents);
  const steps = new StepLedger(p.steps);
  const turns = new TurnLedger(p.turns);
  if (point !== undefined) {
    const end = turns.end.bind(turns);
    turns.end = ((...args: Parameters<typeof end>) => { at("turn:end"); return end(...args); }) as typeof end;
    let results = 0;
    const append = registry.appendTranscript.bind(registry);
    (registry as unknown as { appendTranscript: typeof append }).appendTranscript = ((agentId, entry, conversation) => {
      if ((entry as { kind?: string }).kind === "results") {
        results += 1;
        at(`results:before:${results}`);
        append(agentId, entry, conversation);
        at(`results:after:${results}`);
        return;
      }
      append(agentId, entry, conversation);
    }) as typeof append;
  }
  let calls = 0;
  const client = fakeModel(({ params }) => {
    at(`model:${calls++}`);
    return respond(params);
  });
  const orch = new Orchestrator({ registry, useBox: true, boxClient: fileBox(root, at), inbox: null, turns, steps, client });
  return { orch, registry, steps, turns };
}

// ── the child: the dying host ───────────────────────────────────────────────────────────────

const childArg = process.argv.indexOf("--child");
if (childArg >= 0) {
  const point = process.argv[childArg + 1]!;
  const root = process.argv[childArg + 2]!;
  process.env.AGENTBOX_HOME = root;
  const dying = host(root, point);
  const ada = dying.registry.create({ name: "Ada" });
  const connected = await dying.orch.connectBox();
  if (!connected.connected) throw new Error(connected.detail);
  dying.orch.bus.sendFromUser(ada.id, "run the three steps", {});
  await dying.orch.bus.wake(ada.id);
  await dying.orch.settle(10_000);
  // Reaching here means the turn ended without passing the cut: the parent reads the exit code.
  process.exit(0);
}

// ── the parent: the restart, and the rules ──────────────────────────────────────────────────

/** The one turn in the turn ledger, by id. */
function turnIdIn(turnsPath: string): string {
  const begin = readFileSync(turnsPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { event?: string; id?: string }).find(row => row.event === "begin");
  return begin?.id ?? "";
}

interface Death { code: number | null; signal: string | null; stderr: string }

/** A directory for one cut, with the box's starting file in it. */
function rootFor(): string {
  const root = mkdtempSync(join(tmpdir(), "agentbox-crash-sweep-"));
  mkdirSync(join(root, "boxfs"), { recursive: true });
  writeFileSync(join(root, "boxfs", "home__box__work__a.txt"), "A");
  return root;
}

/** The dying host as a child of this process, killed at the cut by its own hand. */
function dieAt(point: string, root: string): Promise<Death> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--experimental-transform-types", fileURLToPath(import.meta.url), "--child", point, root], { env: { ...process.env, AGENTBOX_HOME: root }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", (code, signal) => resolve({ code, signal, stderr }));
  });
}

/** The restart on a directory a host died in, and the rules checked against what it finds. */
async function restartAndCheck(point: string, root: string, died: Death): Promise<void> {
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    assert.equal(died.signal, "SIGKILL", `${point}: the host did not die at this cut (exit ${died.code}); the boundary is not where the turn passes.\n${died.stderr.slice(-800)}`);

    // The restart: the same directory, a fresh host in this process.
    const fresh = host(root, undefined);
    const ada = fresh.registry.list()[0]!;
    assert.equal((await fresh.orch.connectBox()).connected, true);
    const resumed = fresh.orch.resumeInterrupted();
    assert.equal(resumed.resumed, 1, `${point}: the dying turn is found open and resumed`);
    void fresh.orch.bus.wake(ada.id);
    await fresh.orch.settle(10_000);

    // The rules, at this cut.
    const ran = existsSync(join(root, "ran.log")) ? readFileSync(join(root, "ran.log"), "utf8").split("\n").filter(Boolean) : [];
    const bashRuns = ran.filter(line => line.startsWith("bash:")).length;
    const writeRuns = ran.filter(line => line.startsWith("write:")).length;
    assert.ok(bashRuns <= 1, `${point}: bash ran ${bashRuns} times`);
    assert.ok(writeRuns <= 1, `${point}: write_file ran ${writeRuns} times`);
    assert.equal(readFileSync(join(root, "boxfs", "home__box__work__hi.txt"), "utf8"), "hi", `${point}: the bash effect happened in the end`);
    assert.equal(readFileSync(join(root, "boxfs", "home__box__work__b.txt"), "utf8"), "B", `${point}: b.txt was written in the end`);
    const transcript = fresh.registry.readTranscript(ada.id) as { role: string; kind?: string; text?: string; blocks?: { type: string; content?: { text?: string }[] | string }[] }[];
    const resultTexts = transcript.filter(e => e.kind === "results").flatMap(e => e.blocks ?? []).map(b => (typeof b.content === "string" ? b.content : (b.content ?? []).map(p => p.text ?? "").join("\n")));
    const unknowns = resultTexts.filter(t => /outcome_unknown/.test(t)).length;
    // `bash` is the one call here the protocol declares unsafe: cut between its dispatch and its
    // result, it is answered outcome_unknown and the model goes to look. `read_file` is a read and
    // `write_file` with the whole content is declared idempotent (INV-525), so both are re-run by the
    // host; the re-run write finds the same content and changes nothing, which is what "at most once" measures.
    if (/^effect:bash:|^results:before:1$/.test(point)) assert.ok(unknowns >= 1, `${point}: a call cut between dispatch and its result reads outcome_unknown`);
    else assert.equal(unknowns, 0, `${point}: only an unsafe call cut mid-flight is called unknown`);
    if (/^effect:(read|write):|^results:before:[23]$/.test(point)) assert.ok(resultTexts.some(t => /Re-run on resume/.test(t)), `${point}: the interrupted read or idempotent write is re-run by the host`);
    if (/^results:after:|^model:|^turn:end$/.test(point)) assert.ok(!resultTexts.some(t => /Re-run on resume|not_started/.test(t)), `${point}: a call whose result is on disk is neither re-run nor restarted`);
    assert.ok(transcript.some(e => e.role === "assistant" && e.text?.includes("done")), `${point}: the turn ends where the uninterrupted one would`);
    assert.deepEqual(new TurnLedger(paths(root).turns).interrupted(), [], `${point}: no turn is left open`);
    assert.deepEqual(new StepLedger(paths(root).steps).stepsOf(turnIdIn(paths(root).turns)).open, [], `${point}: no step is left open`);
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

if (childArg < 0) {
  // The dying hosts are independent of each other and are started ahead of their tests, a few at a
  // time: seventeen boots one after another would put this file over the suite's per-test clock, and
  // seventeen at once would starve the files running beside it.
  const POOL = 4;
  let slot: Promise<unknown> = Promise.resolve();
  const slots: Promise<unknown>[] = [];
  const deaths = new Map(CUTS.map((point, i) => {
    const root = rootFor();
    const after = slots[i - POOL] ?? slot;
    const died = after.then(() => dieAt(point, root));
    slots.push(died.then(() => undefined, () => undefined));
    slot = slots[slots.length - 1]!;
    return [point, { root, died }] as const;
  }));
  for (const point of CUTS) {
    test(`crash sweep: the host dies at ${point}`, async () => {
      const entry = deaths.get(point)!;
      await restartAndCheck(point, entry.root, await entry.died);
    });
  }
}
