import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { Inbox } from "../agents/inbox.ts";
import type { InboundMessage } from "../agents/bus.ts";
import { Orchestrator } from "./orchestrator.ts";
import { TurnLedger } from "./resume.ts";
import { fakeModel } from "./testing/fake-model.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "admission-handoff-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  const registry = new AgentRegistry(join(root, "agents"));
  const agent = registry.list()[0] ?? registry.create({ name: "Ada" });
  const inboxPath = join(root, "inbox.jsonl");
  const turnsPath = join(root, "turns.jsonl");
  const orch = new Orchestrator({
    registry, useBox: false, inbox: new Inbox<InboundMessage>(inboxPath),
    turns: new TurnLedger(turnsPath), mcp: null, hooks: null, tasks: null,
    extensions: null, pendingWork: null,
    client: fakeModel(() => ({
      id: "answer", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 2 },
    } as never)),
  });
  return { root, agent, registry, orch, inboxPath, turnsPath, cleanup: () => {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  } };
}

test("scenario: accepted request remains recoverable while turn setup waits on skills", async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.mock.method(f.orch.skills, "refresh", async () => {
    entered.resolve();
    await release.promise;
    return { skills: [] };
  });
  const running = f.orch.prompt(f.agent.id, "hello", undefined, { messageId: "request-a" });
  try {
    await entered.promise;
    assert.deepEqual(new Inbox<InboundMessage>(f.inboxPath).pending().map(x => x.message.id), ["request-a"]);
    assert.equal(new TurnLedger(f.turnsPath).interrupted().length, 0);
  } finally {
    release.resolve();
    await running;
    f.cleanup();
  }
});

for (const point of ["setup", "begin-before-start", "model"] as const) {
  test(`SIGKILL at ${point}: restart has exactly one owner and delivers one reply`, async () => {
    const root = mkdtempSync(join(tmpdir(), "admission-kill-"));
    const killed = spawnSync(process.execPath, ["--experimental-transform-types",
      fileURLToPath(new URL("./testing/admission-crash.ts", import.meta.url)), root, point],
    { env: { ...process.env, AGENTBOX_HOME: root }, encoding: "utf8", timeout: 10_000 });
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    const pendingBefore = new Inbox<InboundMessage>(join(root, "inbox.jsonl")).pending();
    assert.equal(pendingBefore.length, point === "model" ? 0 : 1);
    const f = fixture(root);
    try {
      assert.equal(new Inbox<InboundMessage>(f.inboxPath).pending().length, point === "setup" ? 1 : 0);
      // Production startup replays the inbox before scheduling ledger resumptions.
      const replayed = f.orch.bus.recover();
      assert.equal(replayed, point === "setup" ? 1 : 0);
      const resumed = f.orch.resumeInterrupted();
      assert.equal(resumed.resumed, point === "setup" ? 0 : 1);
      await f.orch.settle();
      const replies = f.registry.readTranscript(f.agent.id).filter(x => (x as { role?: string }).role === "assistant");
      assert.equal(replies.length, 1, "the accepted request has only one recovery executor");
      assert.deepEqual(new Inbox<InboundMessage>(f.inboxPath).pending(), []);
      assert.deepEqual(new TurnLedger(f.turnsPath).interrupted(), []);
    } finally { f.cleanup(); }
  });
}

test("a failed turn begin leaves admission recoverable and runs no model", async () => {
  const f = fixture();
  try {
    mkdirSync(f.turnsPath);
    await assert.rejects(f.orch.prompt(f.agent.id, "hello", undefined, { messageId: "disk-error" }), /EISDIR/);
    assert.deepEqual(new Inbox<InboundMessage>(f.inboxPath).pending().map(x => x.message.id), ["disk-error"]);
    assert.equal(f.registry.readTranscript(f.agent.id).filter(x => (x as { role?: string }).role === "assistant").length, 0);
  } finally { f.cleanup(); }
});

test("a queued anonymous task does not inherit the preceding human principal", async () => {
  const f = fixture();
  try {
    await f.orch.prompt(f.agent.id, "hello", { userId: "alice" });
    f.orch.bus.sendFromUser(f.agent.id, "hello again", { synthetic: true, steerable: false });
    await f.orch.bus.runExclusive(f.agent.id);
    const rows = readFileSync(join(f.root, "usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(rows.filter(row => row.kind === "turn").map(row => row.principal), ["alice", undefined]);
  } finally { f.cleanup(); }
});

test("scenario: concurrent conversations keep the principal that admitted each request", async t => {
  const f = fixture();
  const entered = deferred();
  const release = deferred();
  t.mock.method(f.orch.skills, "refresh", async () => {
    entered.resolve();
    await release.promise;
    return { skills: [] };
  });
  const a = f.orch.prompt(f.agent.id, "hello Alice", { userId: "alice" }, { conversation: "chat/a" });
  await entered.promise;
  const b = f.orch.prompt(f.agent.id, "hello Bob", { userId: "bob" }, { conversation: "chat/b" });
  release.resolve();
  try {
    await Promise.all([a, b]);
    const rows = readFileSync(join(f.root, "usage.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const turns = rows.filter(row => row.kind === "turn");
    assert.equal(turns.find(row => row.conversation === "chat/a")?.principal, "alice");
    assert.equal(turns.find(row => row.conversation === "chat/b")?.principal, "bob");
  } finally { f.cleanup(); }
});
