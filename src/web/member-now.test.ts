/** A member's row line is the step it marks as doing, while a turn runs and the list is fresh (INV-1926). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import type { AgentBus } from "../agents/bus.ts";
import { ConversationState } from "../host/conversation-state.ts";
import { AgentFacts } from "./agent-facts.ts";
import { memberNow, NOW_FRESH_MS } from "./member-now.ts";

test("the row's line follows the member's own list as it moves, and goes when the turn ends or the list goes stale", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-member-now-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  try {
    const registry = new AgentRegistry(join(home, "agents"));
    const mia = registry.create({ name: "Mia", boxId: registry.box.id }).id;
    const running = new Set<string>();
    const bus = { activeConversationsOf: () => [...running], workAttention: undefined } as unknown as AgentBus;
    let clock = Date.now();
    const facts = new AgentFacts(new ConversationState(), {
      approvals: () => [], questions: () => [], pausedForSpend: () => [], working: () => running.size > 0, now: id => memberNow(registry, bus, id, clock),
    });
    const line = () => facts.forAgent(mia).now?.text;

    running.add("feishu-1");
    assert.equal(line(), undefined, "working, and no list: nothing in its words, the row says it is working");
    // What SetTodos writes, two steps apart.
    registry.writeTodos(mia, [{ text: "Find the October statement", status: "doing" }, { text: "Match it against the ledger", status: "pending" }], "feishu-1");
    assert.equal(line(), "Find the October statement");
    registry.writeTodos(mia, [{ text: "Find the October statement", status: "done" }, { text: "Match it against the ledger", status: "doing" }], "feishu-1");
    assert.deepEqual(facts.forAgent(mia).now && { text: facts.forAgent(mia).now!.text, conversation: facts.forAgent(mia).now!.conversation }, { text: "Match it against the ledger", conversation: "feishu-1" });
    registry.writeTodos(mia, [{ text: "Find the October statement", status: "done" }, { text: "Match it against the ledger", status: "done" }], "feishu-1");
    assert.equal(line(), undefined, "nothing marked doing: nothing said to be in hand");

    // The turn ends with a step still marked doing: an idle member is not doing it.
    registry.writeTodos(mia, [{ text: "Write the summary", status: "doing" }], "feishu-1");
    assert.equal(line(), "Write the summary");
    running.clear();
    assert.equal(line(), undefined, "no turn running: no line, whatever the list says");
    // A turn that runs on without touching its list: fresh for a while, then plain "working" again.
    running.add("feishu-1");
    clock = Date.now() + NOW_FRESH_MS - 60_000;
    assert.equal(line(), "Write the summary");
    clock = Date.now() + NOW_FRESH_MS + 60_000;
    assert.equal(line(), undefined, "written longer ago than the window: stale");
    // The newest words win across two conversations it is working in.
    clock = Date.now();
    registry.writeTodos(mia, [{ text: "Draft the renewal notice", status: "doing" }], "main");
    const old = new Date(Date.now() - 60_000);
    utimesSync(registry.todosPathFor(mia, "feishu-1"), old, old);
    running.add("main");
    assert.equal(line(), "Draft the renewal notice");
    // A long step is cut for the row; the page cuts it shorter and shows the whole on hover.
    registry.writeTodos(mia, [{ text: `Check ${"every invoice ".repeat(30)}`, status: "doing" }], "main");
    assert.ok(line()!.length <= 201 && line()!.endsWith("…"));
  } finally {
    if (previous === undefined) delete process.env.AGENTBOX_HOME; else process.env.AGENTBOX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
