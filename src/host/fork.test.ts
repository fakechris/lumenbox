/**
 * Fork: the fan-out over material too large to read in one context.
 *
 * The claims that matter are about isolation and cost — each fork starts blank, they
 * run at once rather than in sequence, one failing is a gap rather than a collapse,
 * and a fork cannot fork again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentBus, type InboundMessage } from "../agents/bus.ts";
import { AgentRegistry } from "../agents/registry.ts";
import { dispatchTool, FORK_PREFIX, MAX_FORKS } from "./tools.ts";

/**
 * A bus whose turns answer with whatever the brief asked for, recording the
 * conversation each ran in — which is where isolation is visible.
 */
function harness() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-fork-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Ada" });
  const seen: { conversation: string; text: string }[] = [];
  let concurrent = 0;
  let peak = 0;

  const bus = new AgentBus(
    registry,
    async (record, inbound: readonly InboundMessage[], _signal, conversation) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      const brief = inbound.map(message => message.text).join(" ");
      seen.push({ conversation, text: brief });
      await new Promise(resolve => setTimeout(resolve, brief.includes("SLOW") ? 300 : 30));
      concurrent -= 1;
      if (brief.includes("BREAK")) throw new Error("this piece was unreadable");
      registry.appendTranscript(
        record.id,
        { role: "assistant", text: `read ${brief}`, at: new Date().toISOString() },
        conversation
      );
    }
  );

  const context = { agent, registry, bus, box: undefined } as unknown as Parameters<
    typeof dispatchTool
  >[2];

  return {
    context,
    seen,
    peak: () => peak,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("forks run at once, each in its own conversation, and only answers come back", async () => {
  const { context, seen, peak, cleanup } = harness();
  try {
    const result = await dispatchTool(
      "Fork",
      { briefs: ["chapter one", "chapter two", "chapter three"] },
      context
    );

    // Each got its own brief and nothing else — no shared history to leak through.
    assert.deepEqual(
      seen.map(entry => entry.text).sort(),
      ["chapter one", "chapter three", "chapter two"]
    );
    assert.equal(new Set(seen.map(entry => entry.conversation)).size, 3, "three conversations");
    assert.ok(
      seen.every(entry => entry.conversation.startsWith(FORK_PREFIX)),
      "and they are recognisable as forks"
    );
    assert.ok(peak() > 1, "they overlap rather than queueing behind each other");

    // What comes back is the findings, labelled, for the caller to combine.
    assert.match(result.text, /3 forks finished/);
    assert.match(result.text, /read chapter one/);
    assert.match(result.text, /read chapter three/);
    assert.match(result.text, /combining them is yours/);
  } finally {
    cleanup();
  }
});

test("one fork failing is a gap in the findings, not a collapse of the fan-out", async () => {
  const { context, cleanup } = harness();
  try {
    const result = await dispatchTool("Fork", { briefs: ["good one", "BREAK"] }, context);
    assert.ok(!result.isError, "the others still answered");
    assert.match(result.text, /read good one/);
    assert.match(result.text, /fork 2 FAILED/);
    assert.match(result.text, /unreadable/, "and it says what went wrong, in place");
  } finally {
    cleanup();
  }
});

test("a fork cannot fork, and a hundred at once is refused with a number", async () => {
  const { context, cleanup } = harness();
  try {
    const nested = await dispatchTool(
      "Fork",
      { briefs: ["deeper"] },
      { ...context, conversation: `${FORK_PREFIX}main-abc-1` }
    );
    assert.ok(nested.isError);
    assert.match(nested.text, /cannot fork again/);

    const tooMany = await dispatchTool(
      "Fork",
      { briefs: Array.from({ length: MAX_FORKS + 1 }, (_, index) => `piece ${index}`) },
      context
    );
    assert.ok(tooMany.isError);
    assert.match(tooMany.text, new RegExp(String(MAX_FORKS)), "says the limit rather than truncating");

    const empty = await dispatchTool("Fork", { briefs: [] }, context);
    assert.ok(empty.isError);
  } finally {
    cleanup();
  }
});

test("an instruction arriving mid-join wakes the coordinator; late forks report as messages (R8)", async () => {
  const { context, seen, cleanup } = harness();
  try {
    const started = Date.now();
    const pending = dispatchTool("Fork", { briefs: ["quick one", "SLOW SLOW SLOW"] }, context);
    // The person speaks while fork 2 is still working.
    setTimeout(() => context.bus.sendFromUser(context.agent.id, "actually, stop and summarise"), 60);
    const result = await pending;
    assert.ok(Date.now() - started < 250, `the join returned on the steer, not on the slow fork (${Date.now() - started}ms)`);
    assert.match(result.text, /join was cut short: 1 of 2 finished/);
    assert.match(result.text, /fork 2 is still running/);
    assert.match(result.text, /read quick one/);
    assert.doesNotMatch(result.text, /read SLOW/);
    // The steering itself is untouched: the turn reads it at its next boundary.
    assert.equal(context.bus.pendingCount(context.agent.id), 1);

    // The slow fork lands later, as a system message into the conversation that forked.
    await new Promise(resolve => setTimeout(resolve, 400));
    const late = seen.find(entry => entry.conversation === "main" && entry.text.includes("fork 2"));
    assert.ok(late, "the late fork's findings were delivered into the parent conversation");
    assert.match(late.text, /has finished/);
  } finally {
    cleanup();
  }
});

// ── docs/32: the fork ledger ─────────────────────────────────────────────────────────────

test("every fork is recorded before its message is queued, admitted with its inbox seq, and committed only by the engine", async () => {
  const { context, cleanup } = harness();
  const root = mkdtempSync(join(tmpdir(), "agentbox-fork-ledger-"));
  try {
    const { PendingWork } = await import("./pending-work.ts");
    const ledger = new PendingWork(join(root, "pending-work.jsonl"));
    const withLedger = { ...context, pendingWork: ledger, workId: "w-1", turnId: "t-1" } as typeof context;
    const result = await dispatchTool("Fork", { briefs: ["chapter one", "chapter two"] }, withLedger);
    assert.match(result.text, /2 forks finished/);
    // The tool hands the engine what to commit; it does not commit itself.
    assert.deepEqual(result.commit?.map(entry => entry.how), ["done", "done"]);
    const open = ledger.open();
    assert.equal(open.length, 2, "open until the engine commits after the results entry is on disk");
    assert.ok(open.every(fork => fork.admitted), "admitted after sendFromUser");
    assert.ok(open.every(fork => fork.child.startsWith("fork/main-")));
    // A failing fork commits as failed, not done.
    const mixed = await dispatchTool("Fork", { briefs: ["fine", "BREAK"] }, withLedger);
    assert.deepEqual(mixed.commit?.map(entry => entry.how), ["done", "failed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("a ledger that cannot be written stops the fork before any message is queued", async () => {
  const { context, seen, cleanup } = harness();
  const root = mkdtempSync(join(tmpdir(), "agentbox-fork-noledger-"));
  try {
    const { PendingWork } = await import("./pending-work.ts");
    // The path is a directory: no record can be appended.
    const broken = { ...context, pendingWork: new PendingWork(root) } as typeof context;
    const result = await dispatchTool("Fork", { briefs: ["chapter one"] }, broken);
    assert.equal(result.isError, true);
    assert.match(result.text, /nothing was started/);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(seen.length, 0, "no child ran");
    assert.equal(context.bus.pendingCount(context.agent.id), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    cleanup();
  }
});

test("a fork child is fenced: the withheld tools are not offered, and a forged call is refused at dispatch (docs/32 §2)", async () => {
  const { context, cleanup } = harness();
  try {
    const { buildTools, FORK_WITHHELD_TOOLS } = await import("./tools.ts");
    const main = buildTools(true, true, undefined, false, true, true, true).map(tool => tool.name);
    const fork = buildTools(true, true, undefined, false, false, true, true, true).map(tool => tool.name);
    for (const name of FORK_WITHHELD_TOOLS) assert.ok(!fork.includes(name), `${name} withheld`);
    for (const name of ["SendToAgent", "Tasks", "RememberFact", "Fork", "OtherThreads"]) assert.ok(main.includes(name), `${name} offered to the main conversation`);
    for (const name of ["bash", "read_file", "list_dir", "SetTodos", "Recall", "ReadHistory"]) assert.ok(fork.includes(name), `${name} kept for a fork`);

    // Offered or not, the dispatcher refuses it in a fork conversation.
    const teammate = context.registry.create({ name: "Bob" });
    const inFork = { ...context, conversation: "fork/main-abc-1" } as typeof context;
    const refused = await dispatchTool("SendToAgent", { agent_id: teammate.id, text: "help" }, inFork);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not available in a fork/);
    assert.equal(context.bus.pendingCount(teammate.id), 0, "nothing was sent");
  } finally {
    cleanup();
  }
});
