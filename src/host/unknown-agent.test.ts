/**
 * An id that is not an agent cannot take the server down (INV-1542).
 *
 * Ids made up for a test reached the task board through the web API. A note the system wrote for
 * one of them went to the memory mirror, whose `registry.get` threw; the throw was an unhandled
 * rejection, and the server exited — five times in one day. Each layer now holds on its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentNotFoundError, AgentRegistry } from "../agents/registry.ts";
import { MemoryMirror } from "./memory-mirror.ts";
import { Orchestrator } from "./orchestrator.ts";
import { TaskStore } from "./tasks.ts";
import { UnknownAgentError } from "./task-agents.ts";
import { TurnLedger } from "./resume.ts";

const MADE_UP = "7c3e91a4-0000-4000-8000-000000000001";
const note = { at: "2026-11-03T05:13:28.000Z", kind: "pitfall" as const, text: "Check the reviewer first.", source: "pitfall:self-accept-refused" };

function home() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-unknown-agent-"));
  process.env.AGENTBOX_HOME = root;
  const registry = new AgentRegistry(join(root, "agents"));
  return { root, registry, cleanup: () => { delete process.env.AGENTBOX_HOME; rmSync(root, { recursive: true, force: true }); } };
}

test("memory is written for agents only: a made-up id is refused, and gets no directory", () => {
  const { root, registry, cleanup } = home();
  try {
    const changed: string[] = [];
    registry.onMemoryChanged = id => changed.push(id);
    assert.throws(() => registry.appendMemoryRecords(MADE_UP, [note]), AgentNotFoundError);
    assert.equal(existsSync(join(root, "agents", MADE_UP)), false, "no stray directory");
    assert.deepEqual(changed, [], "nothing to mirror");
    const ada = registry.create({ name: "Ada" });
    registry.appendMemoryRecords(ada.id, [note]);
    assert.deepEqual(changed, [ada.id]);
  } finally {
    cleanup();
  }
});

test("the mirror resolves for an id that is not an agent, against the real registry", async () => {
  const { registry, cleanup } = home();
  try {
    const mirror = new MemoryMirror({ registry, box: () => ({ writeFile: async () => {}, readFile: async () => ({ content: "" }) }) as never, log: () => {} });
    assert.deepEqual(await mirror.sync(MADE_UP), { written: 0 });
  } finally {
    cleanup();
  }
});

test("the board refuses a made-up assignee or reviewer and names the agents; a store on its own takes any id", () => {
  const store = new TaskStore(null);
  assert.ok(store.create({ title: "unchecked", requester: "web", assigneeId: MADE_UP }), "no check wired: tests and tools keep working");
  store.agents = { has: id => id === "a1", describe: () => "Ada (a1)" };
  assert.throws(() => store.create({ title: "x", requester: "web", assigneeId: MADE_UP }), (error: unknown) =>
    error instanceof UnknownAgentError && error.role === "assignee" && /The agents are: Ada \(a1\)/.test(error.message));
  assert.throws(() => store.create({ title: "x", requester: "web", assigneeId: "a1", reviewerId: "Bob" }), UnknownAgentError);
  const real = store.create({ title: "real", requester: "web", assigneeId: "a1", reviewerId: "a1" })!;
  assert.throws(() => store.update(real.id, { reviewerId: MADE_UP }, "web"), UnknownAgentError);
  assert.equal(store.get(real.id)!.reviewerId, "a1", "the refused update changed nothing");
  assert.ok(store.update(real.id, { reviewerId: null, assigneeId: null }, "web"), "clearing is not naming");
});

test("the orchestrator wires both: its board knows the team, and a memory change for a made-up id is no crash", async () => {
  const { root, registry, cleanup } = home();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const orchestrator = new Orchestrator({ registry, useBox: false, inbox: null, tasks: new TaskStore(null), turns: new TurnLedger(join(root, "turns.jsonl")) });
    const ada = registry.create({ name: "Ada" });
    assert.throws(() => orchestrator.tasks!.create({ title: "x", requester: "web", assigneeId: MADE_UP }), /The agents are: Ada/);
    assert.ok(orchestrator.tasks!.create({ title: "y", requester: "web", assigneeId: ada.id }));
    registry.onMemoryChanged!(MADE_UP); // what an old board's made-up assignee used to set off
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(rejections, [], "no unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
    cleanup();
  }
});
