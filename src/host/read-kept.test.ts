/**
 * Tests for getting back what the cut took.
 *
 * INV-633 made the cut keep what it cuts, deliberately out of the agent's reach: the path
 * is on the host, outside the box. That is right for an audit trail and it is the one
 * place this design took the lossy side of Manus's rule, that you may only remove
 * something from context if it can be got back (docs/71 §1).
 *
 * So the way back is host-mediated: the agent names a call it made, not a file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";
import { parseReadOutcome } from "./read-outcome.ts";
import { keepToolResult } from "./results.ts";
import { storableResult } from "./turn.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-readkept-"));
  const registry = new AgentRegistry(join(root, "agents"));
  const nova = registry.create({ name: "Nova" });
  const ada = registry.create({ name: "Ada" });
  const contextFor = (agent: typeof nova, conversation = "feishu-personal-oc_x") =>
    ({
      agent,
      registry,
      bus: new AgentBus(registry, async () => {}),
      box: undefined,
      fetchedHome: root,
      conversation,
    }) as unknown as ToolContext;
  return { root, registry, nova, ada, contextFor, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Past MAX_TEXT on purpose: a result read back is still subject to the limit that cut it. */
const LONG = "the page went on at some length about the evaluation of agents. ".repeat(700);

test("what the cut took can be asked for again, by the call that produced it", async () => {
  const { root, nova, contextFor, cleanup } = fixture();
  try {
    // Exactly as a turn would: the result is cut, the whole of it is kept.
    const stored = storableResult(
      { type: "tool_result", tool_use_id: "toolu_01abc", content: [{ type: "text", text: LONG }] },
      undefined,
      { turnId: "turn-1", agent: { id: nova.id, name: "Nova" }, tool: "browser_read", conversation: "feishu-personal-oc_x", home: root }
    );
    assert.ok((stored.content as { text: string }[])[0]!.text.length < LONG.length / 4, "it really was cut");

    const back = await dispatchTool("ReadKept", { call: "toolu_01abc" }, contextFor(nova));
    assert.ok(!back.isError, back.text.slice(0, 200));
    const parsed = parseReadOutcome(back.text);
    assert.equal(parsed?.completeness, "clipped", "still bounded: being read back is not an exemption");
    assert.match(back.text, /browser_read returned this at 2026-/);
    assert.match(back.text, /ask for another range/);
    assert.match(back.text, /the page went on at some length/);
    // No host path is handed over.
    assert.doesNotMatch(back.text, /agentbox-readkept-/);
  } finally {
    cleanup();
  }
});

test("a range comes back as a range, and the whole of a short one comes back as full", async () => {
  const { root, nova, contextFor, cleanup } = fixture();
  try {
    const text = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen";
    keepToolResult(
      { text, turnId: "t", toolUseId: "toolu_short", tool: "read_file", agent: { id: nova.id, name: "Nova" }, conversation: "feishu-personal-oc_x", at: new Date(Date.UTC(2026, 8, 22)) },
      root
    );
    const whole = await dispatchTool("ReadKept", { call: "toolu_short" }, contextFor(nova));
    assert.equal(parseReadOutcome(whole.text)?.completeness, "full");
    assert.ok(whole.text.endsWith(text));

    const part = await dispatchTool("ReadKept", { call: "toolu_short", from: 4, to: 13 }, contextFor(nova));
    assert.equal(parseReadOutcome(part.text)?.completeness, "clipped");
    assert.match(part.text, new RegExp(`${text.length}`), "and says how much there was");
    assert.ok(part.text.endsWith("two three"));
  } finally {
    cleanup();
  }
});

test("another agent's call, and another conversation's, answer as if there were nothing there", async () => {
  const { root, nova, ada, contextFor, cleanup } = fixture();
  try {
    keepToolResult(
      { text: LONG, turnId: "t", toolUseId: "toolu_novas", tool: "browser_read", agent: { id: nova.id, name: "Nova" }, conversation: "feishu-personal-oc_x", at: new Date() },
      root
    );

    // Telling "not yours" from "does not exist" would be a way for one agent to ask what
    // calls another has made. Both answers are the same answer.
    const stranger = await dispatchTool("ReadKept", { call: "toolu_novas" }, contextFor(ada));
    const absent = await dispatchTool("ReadKept", { call: "toolu_never_happened" }, contextFor(ada));
    assert.equal(parseReadOutcome(stranger.text)?.completeness, "unavailable");
    assert.equal(parseReadOutcome(absent.text)?.completeness, "unavailable");
    assert.equal(stranger.text.replace("toolu_novas", "X"), absent.text.replace("toolu_never_happened", "X"));

    // Nova's own, from a different room, is a different room's.
    const elsewhere = await dispatchTool("ReadKept", { call: "toolu_novas" }, contextFor(nova, "feishu-personal-oc_other"));
    assert.equal(parseReadOutcome(elsewhere.text)?.completeness, "unavailable");
  } finally {
    cleanup();
  }
});

test("a withheld result was never kept, so it cannot be read back", async () => {
  const { root, nova, contextFor, cleanup } = fixture();
  try {
    // The secret was the reason for withholding it (INV-633); nothing was written, so there
    // is nothing here to reach. The guarantee comes from the write path, not from a check.
    storableResult(
      { type: "tool_result", tool_use_id: "toolu_secret", content: [{ type: "text", text: `token=${"s".repeat(9_000)}` }] },
      "ran a command on the host",
      { turnId: "turn-1", agent: { id: nova.id, name: "Nova" }, tool: "RunOnHost", conversation: "feishu-personal-oc_x", home: root }
    );
    const back = await dispatchTool("ReadKept", { call: "toolu_secret" }, contextFor(nova));
    assert.equal(parseReadOutcome(back.text)?.completeness, "unavailable");
    assert.doesNotMatch(back.text, /token=/);
  } finally {
    cleanup();
  }
});

test("asked for nothing, it says what it needs rather than searching for an empty id", async () => {
  const { nova, contextFor, cleanup } = fixture();
  try {
    const back = await dispatchTool("ReadKept", {}, contextFor(nova));
    assert.ok(back.isError);
    assert.match(back.text, /Which call\?/);
  } finally {
    cleanup();
  }
});

test("past the retention window there is nothing to find, and it says where the description still is", async () => {
  const { root, nova, contextFor, cleanup } = fixture();
  try {
    // Nothing was ever written for this id, which is what an aged-out result looks like.
    const back = await dispatchTool("ReadKept", { call: "toolu_aged_out" }, contextFor(nova));
    assert.equal(parseReadOutcome(back.text)?.completeness, "unavailable");
    // Not a dead end: INV-659 put the size and the digest in the pointer, and this says so.
    assert.match(back.text, /how big it was and what its digest was/);
    assert.ok(root.length > 0);
  } finally {
    cleanup();
  }
});
