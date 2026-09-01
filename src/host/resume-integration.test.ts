/**
 * Resumption through the orchestrator, which is where the claim actually has to hold.
 *
 * The unit tests cover the ledger; these cover what a restart does with it: that an interrupted
 * turn comes back as a turn, that nothing is re-executed to make that happen, and that a turn which
 * kills the process is eventually left alone instead of killing it again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
