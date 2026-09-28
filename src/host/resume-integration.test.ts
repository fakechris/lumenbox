/**
 * Resumption through the orchestrator, which is where the claim actually has to hold.
 *
 * The unit tests cover the ledger; these cover what a restart does with it: that an interrupted
 * turn comes back as a turn, that nothing is re-executed to make that happen, and that a turn which
 * kills the process is eventually left alone instead of killing it again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { Orchestrator } from "./orchestrator.ts";
import { MAX_RESUMES, TurnLedger } from "./resume.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-resume-"));
  // The orchestrator opens several ledgers off `agentboxHome()` — the usage log first.
  // Until the hermetic runner refused the default (2026-09-01), these tests appended to
  // the live installation's `usage.jsonl` on every run: a passing test writing into a
  // person's real spend record, which is the silent half of the failure resume.ts
  // already carried a scar for.
  process.env.AGENTBOX_HOME = root;
  const registry = new AgentRegistry(join(root, "agents"));
  const ledgerPath = join(root, "turns.jsonl");
  return {
    registry,
    ledgerPath,
    ledger: () => new TurnLedger(ledgerPath),
    /** An orchestrator that never talks to a model or a box: only the startup path is on test. */
    orchestrator: () =>
      new Orchestrator({
        registry,
        useBox: false,
        inbox: null,
        turns: new TurnLedger(ledgerPath),
      }),
    cleanup: () => {
      delete process.env.AGENTBOX_HOME;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("an interrupted turn comes back as a turn, carrying what it may not assume", () => {
  const { registry, ledger, orchestrator, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    // The process that died mid-turn.
    ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });

    const orch = orchestrator();
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });

    // Queued AND woken: resumeInterrupted used to only enqueue, so a resumed turn sat until some
    // unrelated later traffic happened to run it. (Here the runner is a no-op, so the queue drains.)
    void orch;

    // It is queued as work for that agent, and the text is the resumption note rather than a copy
    // of the original request — re-sending the request would be asking for the whole thing again.
    assert.equal(orch.bus.pendingCount(ada.id), 1);
    const queued = orch.bus.drain(ada.id);
    assert.match(queued[0]?.text ?? "", /\[resumed\]/);
    assert.match(queued[0]?.text ?? "", /deploy the release/);
    assert.match(queued[0]?.text ?? "", /may well have succeeded/);

    // And the old entry is closed before the new turn opens, so a crash during the resumption
    // leaves exactly one unfinished turn rather than two.
    assert.deepEqual(ledger().interrupted(), []);
  } finally {
    cleanup();
  }
});

test("a turn that keeps killing the process is eventually left alone", () => {
  const { registry, ledger, orchestrator, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    // Already resumed as many times as it is allowed to be.
    ledger().begin({
      id: "t9",
      agentId: ada.id,
      about: "the allocation that will not fit",
      attempt: MAX_RESUMES,
    });

    const orch = orchestrator();
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 0, abandoned: 1 });
    assert.equal(orch.bus.pendingCount(ada.id), 0, "not queued again");

    // Said in the conversation, because a task that stopped without explanation is the failure this
    // whole feature exists to remove — and here a person is the one who can act on it.
    const transcript = JSON.stringify(registry.readTranscript(ada.id));
    assert.match(transcript, /not being picked up again/);
    assert.match(transcript, /needs a person to look/);
    assert.deepEqual(ledger().interrupted(), []);
  } finally {
    cleanup();
  }
});

test("a turn belonging to a deleted agent is closed, not resurrected", () => {
  const { ledger, orchestrator, cleanup } = fixture();
  try {
    ledger().begin({ id: "t1", agentId: "an-agent-that-is-gone", about: "whatever it was" });
    const orch = orchestrator();
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 0, abandoned: 0 });
    assert.deepEqual(ledger().interrupted(), [], "closed rather than retried forever");
  } finally {
    cleanup();
  }
});

test("a second interruption counts as a second attempt, which is what ends the loop", async () => {
  // The chain is the whole crash-loop guard: if a resumed turn recorded itself as fresh work, a
  // turn that kills the process would be picked up forever, and the system would restart into the
  // same death every time.
  const { registry, ledger, ledgerPath, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    ledger().begin({ id: "t1", agentId: ada.id, about: "the thing that kills us" });

    // A client that never returns, standing in for the process dying inside the turn.
    const wedged = {
      messages: {
        stream() {
          return {
            on() {
              return this;
            },
            finalMessage: () => new Promise<never>(() => {}),
          };
        },
      },
    } as unknown as never;

    const orch = new Orchestrator({
      registry,
      useBox: false,
      inbox: null,
      turns: new TurnLedger(ledgerPath),
      client: wedged,
    });
    assert.equal(orch.resumeInterrupted().resumed, 1);

    // Let the resumed turn start and hang where the model call is.
    void orch.bus.wake(ada.id);
    await new Promise(resolve => setTimeout(resolve, 50));

    const outstanding = ledger().interrupted();
    assert.equal(outstanding.length, 1, "the resumed turn is itself now interrupted");
    assert.equal(outstanding[0]?.attempt, 2, "and it is counted as the second attempt");

    // Which is enough for the next startup to stop rather than try a third time.
    assert.ok(MAX_RESUMES <= 2);
    const successor = new Orchestrator({
      registry,
      useBox: false,
      inbox: null,
      turns: new TurnLedger(ledgerPath),
      client: wedged,
    });
    assert.deepEqual(successor.resumeInterrupted(), { resumed: 0, abandoned: 1 });
  } finally {
    cleanup();
  }
});

test("nothing outstanding means nothing happens", () => {
  const { registry, orchestrator, cleanup } = fixture();
  try {
    registry.create({ name: "Ada" });
    assert.deepEqual(orchestrator().resumeInterrupted(), { resumed: 0, abandoned: 0 });
  } finally {
    cleanup();
  }
});


test("a resumed turn actually runs, not just sits in the queue", async () => {
  // resumeInterrupted enqueued the resumption but never woke the agent, so nothing ran it until
  // unrelated later traffic arrived. It wakes now.
  const { registry, ledger, ledgerPath, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    ledger().begin({ id: "t1", agentId: ada.id, about: "finish the deploy" });

    let ran: string[] = [];
    const orch = new Orchestrator({
      registry,
      useBox: false,
      inbox: null,
      turns: new TurnLedger(ledgerPath),
      client: {
        messages: {
          stream() {
            return {
              on() {
                return this;
              },
              finalMessage: async () => ({
                id: "m",
                type: "message",
                role: "assistant",
                model: "claude-opus-5",
                content: [{ type: "text", text: "resumed and done" }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              }),
            };
          },
        },
      } as never,
    });

    assert.equal(orch.resumeInterrupted().resumed, 1);
    await orch.settle();
    ran = (registry.readTranscript(ada.id) as { role?: string }[]).filter(e => e.role === "assistant").map(() => "x");
    assert.ok(ran.length >= 1, "the resumed turn produced an assistant reply, so it ran");
  } finally {
    cleanup();
  }
});

// ── turn checkpoints (INV-774): a restart continues the same turn from the pending step ────

import { StepLedger } from "./resume.ts";
import { fakeModel } from "./testing/fake-model.ts";
import type { BoxClient } from "../box/client.ts";
import type Anthropic from "@anthropic-ai/sdk";

function reply(content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    model: "scenario",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}
const say = (text: string) => reply([{ type: "text", text, citations: [] } as unknown as Anthropic.ContentBlock]);
const call = (id: string, name: string, input: Record<string, unknown>) =>
  reply([{ type: "tool_use", id, name, input } as Anthropic.ContentBlock], "tool_use");

/** A box that counts what ran, so "not re-run" is a number rather than a belief. */
function countingBox(files: Map<string, string>, ran: string[]): BoxClient {
  const box = {
    health: async () => ({ ok: true, resolution: undefined }),
    ensureDisplay: async (index: number) => ({ display: index }),
    exec: async (command: string) => {
      ran.push(`bash:${command}`);
      return { stdout: "", stderr: "", exit_code: 0 };
    },
    writeFile: async (path: string, content: string) => {
      // The host's own memory and standing-file projections are bookkeeping, not steps of the task.
      if (!path.includes("/memory/") && !path.includes("/standing/")) ran.push(`write:${path}`);
      files.set(path, content);
      return { path, bytes_written: content.length };
    },
    readFile: async (path: string) => {
      // `write_file` reads before it writes (the version check); only a file that exists is a read the task made.
      // The mirror reads the standing files back every sync (INV-803): bookkeeping, like its writes.
      if (files.has(path) && !path.includes("/standing/")) ran.push(`read:${path}`);
      const content = files.get(path);
      if (content === undefined) throw new Error(`${path} does not exist`);
      return { path, content, total_lines: 1, truncated: false };
    },
  };
  return new Proxy(box, {
    get: (target, property) => (property in target ? target[property as keyof typeof target] : async () => ({})),
  }) as unknown as BoxClient;
}

function stepFixture() {
  const base = fixture();
  const stepsPath = join(base.ledgerPath, "..", "turn-steps.jsonl");
  const files = new Map<string, string>();
  const ran: string[] = [];
  const capture: { params: Anthropic.MessageCreateParams[] } = { params: [] };
  return {
    ...base,
    files,
    ran,
    capture,
    steps: () => new StepLedger(stepsPath),
    /** The process after the restart: a scripted model, a counting box, the same state directory. */
    restart: async (respond: Parameters<typeof fakeModel>[0]) => {
      const orch = new Orchestrator({
        registry: base.registry,
        useBox: true,
        boxClient: countingBox(files, ran),
        inbox: null,
        turns: new TurnLedger(base.ledgerPath),
        steps: new StepLedger(stepsPath),
        client: fakeModel(respond, { capture }),
      });
      assert.equal((await orch.connectBox()).connected, true);
      return orch;
    },
  };
}

/** The transcript as the dying process left it: the turn's opening line, then whatever rounds it wrote. */
function leave(registry: AgentRegistry, agentId: string, turnId: string, entries: unknown[]): void {
  registry.appendTranscript(agentId, { role: "user", text: "deploy the release", at: "2026-09-26T09:00:00.000Z", fromPerson: true, turnId });
  for (const entry of entries) registry.appendTranscript(agentId, entry);
}
const blocks = (turnId: string, ...uses: { id: string; name: string; input: Record<string, unknown> }[]) => ({
  role: "assistant",
  kind: "blocks",
  blocks: uses.map(use => ({ type: "tool_use", ...use })),
  at: "2026-09-26T09:00:01.000Z",
  turnId,
});
const results = (turnId: string, ...pairs: [string, string][]) => ({
  role: "user",
  kind: "results",
  blocks: pairs.map(([id, text]) => ({ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] })),
  at: "2026-09-26T09:00:02.000Z",
  turnId,
});
const entriesOf = (registry: AgentRegistry, agentId: string) =>
  registry.readTranscript(agentId) as { role: string; kind?: string; text?: string; turnId?: string; blocks?: { tool_use_id?: string; content?: { text: string }[] }[] }[];
const resultText = (registry: AgentRegistry, agentId: string, toolUseId: string) =>
  entriesOf(registry, agentId)
    .filter(entry => entry.kind === "results")
    .flatMap(entry => entry.blocks ?? [])
    .filter(block => block.tool_use_id === toolUseId)
    .map(block => block.content?.[0]?.text ?? "")
    .join("\n");

test("killed after dispatch and before the result: the same turn continues, and the call reads outcome_unknown", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "bash", input: { command: "make deploy" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "bash");

    const orch = await f.restart(() => say("checked the deploy log; it went out"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    void orch.bus.wake(ada.id);
    await orch.settle();

    assert.match(resultText(f.registry, ada.id, "c1"), /outcome_unknown/);
    assert.match(resultText(f.registry, ada.id, "c1"), /do not retry blindly/);
    assert.deepEqual(f.ran, [], "the unsafe call was not re-run");
    // The model met the unknown result as the next observation of its own call, with no new user message.
    const last = f.capture.params.at(-1)!.messages;
    const tail = last.at(-1)!;
    assert.equal(tail.role, "user");
    assert.ok(Array.isArray(tail.content) && (tail.content[0] as { type: string }).type === "tool_result");
    assert.ok(!JSON.stringify(last).includes("[resumed]"));
    // No resume prompt anywhere in the record either: the wake carried no user text.
    assert.ok(!entriesOf(f.registry, ada.id).some(entry => entry.text?.includes("[resumed]")));
    // And the reply belongs to the same turn.
    const replyEntry = entriesOf(f.registry, ada.id).find(entry => entry.role === "assistant" && entry.text?.includes("went out"));
    assert.equal(replyEntry?.turnId, "t1");
    assert.deepEqual(f.ledger().interrupted(), []);
    assert.deepEqual(f.steps().stepsOf("t1").open, []);
  } finally {
    f.cleanup();
  }
});

test("settled steps are never re-run; a pending read is answered fresh", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    f.files.set("/home/box/work/a.txt", "A");
    f.files.set("/home/box/work/b.txt", "B");
    leave(f.registry, ada.id, "t1", [
      blocks("t1", { id: "c1", name: "read_file", input: { path: "/home/box/work/a.txt" } }),
      results("t1", ["c1", "A"]),
      blocks("t1", { id: "c2", name: "read_file", input: { path: "/home/box/work/b.txt" } }, { id: "c3", name: "bash", input: { command: "rm b" } }),
    ]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    const steps = f.steps();
    steps.pending("t1", "c1", "read_file");
    steps.settled("t1", "c1");
    steps.pending("t1", "c2", "read_file");
    // c3 was never dispatched: the process died between c2 and it.

    const orch = await f.restart(() => say("done"));
    orch.resumeInterrupted();
    void orch.bus.wake(ada.id);
    await orch.settle();

    assert.deepEqual(f.ran, ["read:/home/box/work/b.txt"], "only the interrupted read ran; the settled one did not");
    assert.match(resultText(f.registry, ada.id, "c2"), /Re-run on resume[\s\S]*B/);
    assert.match(resultText(f.registry, ada.id, "c3"), /not_started/);
    assert.equal(resultText(f.registry, ada.id, "c1"), "A", "the settled result stands as written");
  } finally {
    f.cleanup();
  }
});

test("an operation_id on a bash call does not make it replayable: no executor honours it (INV-798)", async () => {
  // The field used to count as an idempotency contract. It is not one: `bash` never
  // forwards it to the box, and the job ids boxd does dedupe are minted per dispatch by
  // the tool. A keyed command that took effect before the crash must not run twice.
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    leave(f.registry, ada.id, "t1", [
      blocks(
        "t1",
        { id: "c1", name: "bash", input: { command: "echo keyed", operation_id: "op-1" } },
        { id: "c2", name: "bash", input: { command: "echo bare" } }
      ),
    ]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "bash");
    f.steps().pending("t1", "c2", "bash");

    const orch = await f.restart(() => say("done"));
    orch.resumeInterrupted();
    void orch.bus.wake(ada.id);
    await orch.settle();

    assert.deepEqual(f.ran, [], "neither command ran again: the effect is not duplicated");
    assert.match(resultText(f.registry, ada.id, "c1"), /outcome_unknown/);
    assert.match(resultText(f.registry, ada.id, "c2"), /outcome_unknown/);
  } finally {
    f.cleanup();
  }
});

test("a resumed read whose policy now says ask is put before a person, not run (INV-798)", async () => {
  // The pending line is written before the gate is consulted, so this open step may be one the
  // gate never saw; and the rules may have changed while the host was down. Either way the
  // transcript is not authorisation.
  const f = stepFixture();
  process.env.AGENTBOX_APPROVAL_TOOLS = "read_file";
  try {
    const ada = f.registry.create({ name: "Ada" });
    f.files.set("/home/box/work/secret.txt", "S");
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "read_file", input: { path: "/home/box/work/secret.txt" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "read_file");

    const orch = await f.restart(() => say("waiting on you"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    void orch.bus.wake(ada.id);
    await orch.settle();

    assert.deepEqual(f.ran, [], "the read did not run");
    assert.equal(orch.policy.pending().length, 1, "an approval was requested instead");
    assert.match(resultText(f.registry, ada.id, "c1"), /approv/i);
    assert.doesNotMatch(resultText(f.registry, ada.id, "c1"), /Re-run on resume/);
    assert.ok(!JSON.stringify(f.registry.readTranscript(ada.id)).includes('"S"'), "the file's content reached nobody");
  } finally {
    delete process.env.AGENTBOX_APPROVAL_TOOLS;
    f.cleanup();
  }
});

test("a resumed read whose policy now says deny is refused, not run (INV-798)", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    // A rule written while the host was down.
    const rules = join(f.ledgerPath, "..", "rules");
    mkdirSync(rules, { recursive: true });
    writeFileSync(join(rules, "no-reads.md"), "---\nname: no-reads\neffect: deny\ntool: read_file\n---\nNo agent reads files here.\n");
    f.files.set("/home/box/work/a.txt", "A");
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "read_file", input: { path: "/home/box/work/a.txt" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "read_file");

    const orch = await f.restart(() => say("understood"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    void orch.bus.wake(ada.id);
    await orch.settle();

    assert.deepEqual(f.ran, [], "the read did not run");
    assert.match(resultText(f.registry, ada.id, "c1"), /Refused by rule no-reads/);
    assert.equal(orch.policy.pending().length, 0, "a deny asks nobody");
  } finally {
    f.cleanup();
  }
});

test("scenario: an approval outstanding at restart parks the turn, even though its refusal was already on the record (INV-798)", async () => {
  // The whole path, not a hand-built ledger: a turn hits an approval, the host dies inside the
  // model request that follows, and the process that replaces it must wait for the person —
  // the step used to be settled with the rest of its batch, so the restart continued as if
  // nothing were pending and the later grant found nothing to wake.
  const f = stepFixture();
  process.env.AGENTBOX_APPROVAL_TOOLS = "bash";
  try {
    const ada = f.registry.create({ name: "Ada" });
    let round = 0;
    const first = await f.restart(() => {
      round += 1;
      if (round === 1) return call("c1", "bash", { command: "rm -rf build" });
      // The model request after the refusal: the process dies inside it.
      return new Promise<never>(() => {});
    });
    void first.prompt(ada.id, "clean the build");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(round, 2, "the process is inside the model request after the approval was asked");
    assert.equal(first.policy.pending().length, 1);
    const approvalId = first.policy.pending()[0]!.id;
    assert.deepEqual(f.ran, [], "the command never ran");
    const turnId = f.ledger().interrupted()[0]!.id;
    assert.deepEqual(
      f.steps().stepsOf(turnId).open.map(step => ({ id: step.toolUseId, approvalId: step.approvalId })),
      [{ id: "c1", approvalId }],
      "the step is still open, keyed to the approval, though its refusal is on disk"
    );
    assert.match(resultText(f.registry, ada.id, "c1"), /approv/i);

    // The restart. The approval is replayed from policy.jsonl and still waiting.
    const second = await f.restart(() => say("cleaned it"));
    assert.deepEqual(second.resumeInterrupted(), { resumed: 0, abandoned: 0, parked: 1 });
    assert.equal(second.bus.pendingCount(ada.id), 0, "nothing runs until the person answers");
    assert.equal(f.ledger().interrupted().length, 1, "still an open turn: waiting, not lost");

    assert.equal(second.policy.grant(approvalId, "chris"), true);
    await second.settle();
    const entries = entriesOf(f.registry, ada.id);
    assert.ok(entries.some(entry => entry.turnId === turnId && /allowed this bash call[\s\S]*call it again/.test(entry.text ?? "")), "the answer reached the turn");
    assert.ok(entries.some(entry => entry.turnId === turnId && entry.text === "cleaned it"), "and the turn went on, as itself");
    assert.deepEqual(f.ran, [], "the grant is held; the call is the model's to make again");
    assert.deepEqual(f.ledger().interrupted(), []);
    assert.deepEqual(f.steps().stepsOf(turnId).open, []);
  } finally {
    delete process.env.AGENTBOX_APPROVAL_TOOLS;
    f.cleanup();
  }
});

test("a step waiting on a person closes when the person answers, while the turn is still alive (INV-798)", () => {
  // The other half of keeping approval steps open: a grant or refusal during a live turn
  // must settle the step, or a later restart would park on an approval nobody is waiting on.
  const f = stepFixture();
  try {
    const steps = f.steps();
    steps.pending("t1", "c1", "bash");
    steps.awaitingApproval("t1", "c1", "ap-1");
    steps.pending("t1", "c2", "read_file");
    assert.equal(steps.settleApproval("ap-1"), true);
    assert.deepEqual(f.steps().stepsOf("t1").open.map(step => step.toolUseId), ["c2"]);
    assert.equal(steps.settleApproval("ap-1"), false, "nothing left waiting on it");
  } finally {
    f.cleanup();
  }
});

test("killed while awaiting approval: the turn parks on the answer and continues from that step when it comes", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    // The dying process asked the person; the approval is in policy.jsonl and replays.
    const before = await f.restart(() => say("unused"));
    const asked = before.policy.check({ kind: "tool", agentId: ada.id, agentName: "Ada", tool: "bash", input: { command: "rm -rf build" }, irreversible: "deletes the build" });
    assert.ok(!asked.allow && asked.approval !== undefined);
    const approvalId = (!asked.allow && asked.approval?.id) as string;
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "bash", input: { command: "rm -rf build" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "bash");
    f.steps().awaitingApproval("t1", "c1", approvalId);

    const orch = await f.restart(() => say("carrying on"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 0, abandoned: 0, parked: 1 });
    assert.equal(orch.bus.pendingCount(ada.id), 0, "nothing runs until the person answers");
    assert.equal(f.ledger().interrupted().length, 1, "still an open turn: it is waiting, not lost");

    assert.equal(orch.policy.grant(approvalId, "chris"), true);
    await orch.settle();
    assert.match(resultText(f.registry, ada.id, "c1"), /allowed this bash call[\s\S]*call it again/);
    assert.deepEqual(f.ran, [], "the answer re-attaches to the turn; the call itself is the model's to make again");
    assert.ok(entriesOf(f.registry, ada.id).some(entry => entry.text?.includes("carrying on") && entry.turnId === "t1"));
    assert.deepEqual(f.ledger().interrupted(), []);
  } finally {
    f.cleanup();
  }
});

test("a refusal while parked continues the turn with the refusal as the call's result", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    const before = await f.restart(() => say("unused"));
    const asked = before.policy.check({ kind: "tool", agentId: ada.id, agentName: "Ada", tool: "bash", input: { command: "rm -rf build" }, irreversible: "deletes the build" });
    const approvalId = (!asked.allow && asked.approval?.id) as string;
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "bash", input: { command: "rm -rf build" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "bash");
    f.steps().awaitingApproval("t1", "c1", approvalId);

    const orch = await f.restart(() => say("understood"));
    assert.equal(orch.resumeInterrupted().parked, 1);
    assert.equal(orch.policy.deny(approvalId, "chris"), true);
    await orch.settle();
    assert.match(resultText(f.registry, ada.id, "c1"), /refused this bash call/);
  } finally {
    f.cleanup();
  }
});

test("killed mid model stream: the turn continues with no results to invent and no new message", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    leave(f.registry, ada.id, "t1", [
      blocks("t1", { id: "c1", name: "read_file", input: { path: "/x" } }),
      results("t1", ["c1", "X"]),
    ]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });
    f.steps().pending("t1", "c1", "read_file");
    f.steps().settled("t1", "c1");

    const orch = await f.restart(() => say("finished"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    void orch.bus.wake(ada.id);
    await orch.settle();

    const entries = entriesOf(f.registry, ada.id);
    assert.equal(entries.filter(entry => entry.kind === "results").length, 1, "no results entry was added");
    assert.ok(!entries.some(entry => entry.text?.includes("[resumed]")));
    assert.deepEqual(f.ran, []);
    assert.equal(entries.at(-1)?.text, "finished");
    assert.equal(entries.at(-1)?.turnId, "t1");
  } finally {
    f.cleanup();
  }
});

test("a turn the step ledger never saw keeps the resume-prompt path", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "bash", input: { command: "make" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "deploy the release" });

    const orch = await f.restart(() => say("ok"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    assert.match(orch.bus.drain(ada.id)[0]?.text ?? "", /\[resumed\]/);
  } finally {
    f.cleanup();
  }
});

test("a checkpointed turn is still given up after MAX_RESUMES, and its steps are closed", async () => {
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    leave(f.registry, ada.id, "t1", [blocks("t1", { id: "c1", name: "bash", input: { command: "make" } })]);
    f.ledger().begin({ id: "t1", agentId: ada.id, about: "the thing that kills us", attempt: MAX_RESUMES });
    f.steps().pending("t1", "c1", "bash");

    const orch = await f.restart(() => say("never"));
    assert.deepEqual(orch.resumeInterrupted(), { resumed: 0, abandoned: 1 });
    assert.equal(orch.bus.pendingCount(ada.id), 0);
    assert.match(JSON.stringify(f.registry.readTranscript(ada.id)), /not being picked up again/);
    assert.deepEqual(f.steps().stepsOf("t1").open, []);
  } finally {
    f.cleanup();
  }
});

test("scenario: a three-step task killed at step 2 restarts running only step 3", async () => {
  // The whole episode on the real stack: a process runs steps 1 and 2 and dies inside 2; the
  // process that replaces it, over the same state directory, sees step 2 as unknown and the
  // model's next call is step 3 — and only step 3 runs on the box.
  const f = stepFixture();
  try {
    const ada = f.registry.create({ name: "Ada" });
    let round = 0;
    let dying: Promise<never> | undefined;
    const first = await f.restart(() => {
      round += 1;
      if (round === 1) return call("s1", "write_file", { path: "/home/box/work/1.txt", content: "one" });
      // Step 2 is asked for; the box never answers because the process dies inside it.
      if (round === 2) return call("s2", "bash", { command: "make step2" });
      return say("unreachable");
    });
    const hang = new Promise<never>(() => {});
    (first.boxFor(ada.id) as unknown as { exec: unknown }).exec = () => (dying = hang);
    void first.prompt(ada.id, "run the three steps");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(dying !== undefined, "the process is inside step 2");
    assert.deepEqual(f.ran, ["write:/home/box/work/1.txt"]);
    assert.equal(f.ledger().interrupted().length, 1);
    const turnId = f.ledger().interrupted()[0]!.id;
    assert.deepEqual(f.steps().stepsOf(turnId).open.map(step => step.name), ["bash"]);

    // The restart. The same model script, now seeing step 2's unknown result, asks for step 3.
    f.ran.length = 0;
    let after = 0;
    const second = await f.restart(() => {
      after += 1;
      if (after === 1) return call("s3", "write_file", { path: "/home/box/work/3.txt", content: "three" });
      return say("steps 1 and 3 done; step 2's outcome is unknown, check before redoing");
    });
    assert.deepEqual(second.resumeInterrupted(), { resumed: 1, abandoned: 0 });
    void second.bus.wake(ada.id);
    await second.settle();

    assert.deepEqual(f.ran, ["write:/home/box/work/3.txt"], "step 3 ran; steps 1 and 2 did not run again");
    assert.match(resultText(f.registry, ada.id, "s2"), /outcome_unknown/);
    assert.equal(f.files.get("/home/box/work/3.txt"), "three");
    assert.ok(entriesOf(f.registry, ada.id).every(entry => entry.turnId === undefined || entry.turnId === turnId), "one turn, not two");
    assert.deepEqual(f.ledger().interrupted(), []);
    assert.deepEqual(f.steps().stepsOf(turnId).open, []);
  } finally {
    f.cleanup();
  }
});
