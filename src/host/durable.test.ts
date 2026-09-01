/**
 * Tests for the plan and todo list.
 *
 * The claim being tested is the one that matters for a long task: this state cannot be lost by
 * compaction. That is verified in turn.test.ts, where a summarised history still carries the plan.
 * Here: that absent renders as nothing rather than as an empty container, that refusals say what
 * would be accepted, and that the survival property comes from placement rather than from a
 * mechanism.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";
import { recall, renderMemory } from "./memory.ts";
import { FileVersions } from "./files.ts";
import { Claims } from "./claims.ts";
import {
  describeTodos,
  isTodoStatus,
  MAX_PLAN_CHARS,
  MAX_TODOS,
  MAX_TODO_CHARS,
  renderDurableBlocks,
  validatePlan,
  validateTodos,
  type TodoItem,
} from "./durable.ts";

test("nothing renders as nothing, not as an empty plan", () => {
  // A heading with nothing under it tells the model a plan exists and is empty, which reads as
  // "there is no work to do" — worse than silence.
  assert.equal(renderDurableBlocks({}), "");
  assert.equal(renderDurableBlocks({ plan: "" }), "");
  assert.equal(renderDurableBlocks({ plan: "   \n  " }), "");
  assert.equal(renderDurableBlocks({ todos: [] }), "");
  assert.equal(renderDurableBlocks({ plan: "", todos: [] }), "");
});

test("a plan renders with the instruction that makes it useful after a summary", () => {
  const rendered = renderDurableBlocks({ plan: "Ship the parser.\n\n- read the spec" });
  assert.match(rendered, /## Your current plan/);
  assert.match(rendered, /Ship the parser/);
  // The cue that turns a stored plan into a resumable one: it says what this text is and what to do
  // when it no longer matches.
  assert.match(rendered, /survives summarisation/);
  assert.match(rendered, /update it with SetPlan/);
});

test("a todo list shows progress and how to read the markers", () => {
  const todos: TodoItem[] = [
    { text: "read the spec", status: "done" },
    { text: "write the parser", status: "doing" },
    { text: "handle escapes", status: "pending" },
    { text: "get the API key", status: "blocked" },
  ];
  const rendered = renderDurableBlocks({ todos });
  assert.match(rendered, /1\/4 done/, "progress is counted so a long task has a sense of movement");
  assert.match(rendered, /- \[x\] read the spec/);
  assert.match(rendered, /- \[>\] write the parser/);
  assert.match(rendered, /- \[ \] handle escapes/);
  assert.match(rendered, /- \[!\] get the API key/);
  // The instruction is about accuracy in *both* directions, which is the failure mode of a todo
  // list an agent keeps: stale items cause redone or skipped work.
  assert.match(rendered, /make you redo the work/);
  assert.match(rendered, /make you skip it/);
});

test("plan comes before todos, because the why precedes the what", () => {
  const rendered = renderDurableBlocks({
    plan: "PLAN TEXT",
    todos: [{ text: "TODO TEXT", status: "pending" }],
  });
  assert.ok(rendered.indexOf("PLAN TEXT") < rendered.indexOf("TODO TEXT"));
});

test("a refusal says what would be accepted", () => {
  // "Too long" teaches nothing; naming the alternative is what stops the model retrying the same
  // thing.
  const long = validatePlan("x".repeat(MAX_PLAN_CHARS + 1));
  assert.ok(long);
  assert.match(long.reason, /put detail in a file under \/home\/box\/work/);
  assert.match(long.reason, /paid for repeatedly/, "it says why the limit exists");

  const empty = validatePlan("  ");
  assert.ok(empty);
  assert.match(empty.reason, /reads as 'there is nothing to do'/);

  assert.equal(validatePlan("a real plan"), undefined);
});

test("a todo list is refused when it has become a plan", () => {
  const tooMany = validateTodos(
    Array.from({ length: MAX_TODOS + 1 }, (_, index) => ({
      text: `item ${index}`,
      status: "pending" as const,
    }))
  );
  assert.ok(tooMany);
  assert.match(tooMany.reason, /is a plan; write it with SetPlan/);

  const tooLong = validateTodos([{ text: "y".repeat(MAX_TODO_CHARS + 1), status: "pending" }]);
  assert.ok(tooLong);
  assert.match(tooLong.reason, /really several items/);

  const blank = validateTodos([{ text: "  ", status: "pending" }]);
  assert.ok(blank);
  assert.match(blank.reason, /cannot be worked on or ticked off/);

  const badStatus = validateTodos([{ text: "x", status: "later" as unknown as "pending" }]);
  assert.ok(badStatus);
  assert.match(badStatus.reason, /pending, doing, done, blocked/);

  assert.equal(validateTodos([{ text: "fine", status: "doing" }]), undefined);
  assert.equal(validateTodos([]), undefined, "an empty list is allowed: it means finished");
});

test("the tool result echoes the whole list, which is what covers a mid-turn change", () => {
  // The system prompt is built once per turn, so an update at round 5 is not in the prompt at round
  // 300. The echo is in the message array, where in-turn pruning does not reach.
  const described = describeTodos([
    { text: "one", status: "done" },
    { text: "two", status: "pending" },
  ]);
  assert.match(described, /1\/2 done/);
  assert.match(described, /- \[x\] one/);
  assert.match(described, /- \[ \] two/);
  assert.equal(describeTodos([]), "The todo list is now empty.");
});

test("statuses are checked, not trusted", () => {
  for (const status of ["pending", "doing", "done", "blocked"]) {
    assert.equal(isTodoStatus(status), true);
  }
  assert.equal(isTodoStatus("later"), false);
  assert.equal(isTodoStatus(""), false);
  assert.equal(isTodoStatus("DONE"), false, "case matters: a near miss is a miss");
});


/** A registry and a tool context over it, for the dispatch tests below. */
function toolFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-durable-"));
  const registry = new AgentRegistry(root);
  const agent = registry.create({ name: "Ada" });
  const context: ToolContext = {
    agent,
    registry,
    bus: new AgentBus(registry, async () => {}),
    box: undefined,
  };
  return {
    registry,
    agent,
    context,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a malformed SetTodos changes nothing, rather than erasing the list", async () => {
  // `todos` arriving as an object or a string used to become `[]`, which then replaced the real
  // list — so a malformed call silently erased the work an agent was tracking, and the echo told it
  // the list was empty as though it had meant that. Clearing is a real thing to want, which is why
  // it has to be said rather than inferred from a shape that did not parse.
  const { registry, agent: ada, context, cleanup } = toolFixture();
  try {

    await dispatchTool("SetTodos", { todos: [{ text: "ship it", status: "doing" }] }, context);
    assert.equal((registry.readDurableState(ada.id).todos ?? []).length, 1);

    const wrongShape = await dispatchTool("SetTodos", { todos: { text: "ship it" } }, context);
    assert.equal(wrongShape.isError, true);
    assert.match(wrongShape.text, /needs `todos` to be a list/);
    assert.match(wrongShape.text, /Nothing was changed/);
    assert.match(wrongShape.text, /to clear the list, pass an empty one/i);
    assert.equal((registry.readDurableState(ada.id).todos ?? []).length, 1, "the real list is still there");

    // An unknown status is refused too, rather than quietly becoming "pending": a list that says
    // something the agent did not say is worse than a rejected call.
    const wrongStatus = await dispatchTool(
      "SetTodos",
      { todos: [{ text: "ship it", status: "in_progress" }] },
      context
    );
    assert.equal(wrongStatus.isError, true);
    assert.match(wrongStatus.text, /"in_progress" is not a todo status/);
    assert.match(wrongStatus.text, /pending, doing, done, blocked/);
    assert.deepEqual((registry.readDurableState(ada.id).todos ?? [])[0]?.status, "doing", "unchanged");

    // And clearing still works when it is asked for.
    await dispatchTool("SetTodos", { todos: [] }, context);
    assert.equal((registry.readDurableState(ada.id).todos ?? []).length, 0);
  } finally {
    cleanup();
  }
});


test("RememberFact can withdraw what it replaces, and refuses when nothing matches", async () => {
  const { registry, agent: ada, context, cleanup } = toolFixture();
  try {
    await dispatchTool("RememberFact", { fact: "deployment region is us-east-1" }, context);

    // A correction that names nothing is refused rather than silently added alongside: an agent
    // that believes it corrected something and did not will act on the correction while the prompt
    // keeps showing the old line.
    const missed = await dispatchTool(
      "RememberFact",
      { fact: "deployment region is eu-west-1", replaces: "the billing address" },
      context
    );
    assert.equal(missed.isError, true);
    assert.match(missed.text, /Nothing remembered matches/);
    assert.equal(registry.readMemoryRecords(ada.id).length, 1, "and nothing was added");

    const corrected = await dispatchTool(
      "RememberFact",
      {
        fact: "deployment region is eu-west-1",
        replaces: "deployment region is us-east-1",
      },
      context
    );
    assert.equal(corrected.isError, undefined);
    assert.match(corrected.text, /has been withdrawn/);

    // The log keeps all three lines — it is a record of what was believed when, which is what makes
    // a wrong correction recoverable — and the view the prompt is built from has one.
    assert.equal(registry.readMemoryRecords(ada.id).length, 3);
    const view = renderMemory(recall(registry.readMemoryRecords(ada.id)));
    assert.ok(!view.includes("us-east-1"), `still showing the old region: ${view}`);
    assert.ok(view.includes("eu-west-1"));
  } finally {
    cleanup();
  }
});


test("two agents writing one file: the second is refused rather than winning silently", async () => {
  // The lost update, through the real tool path. Both agents share one work directory as one uid,
  // so before this the second write simply won and the first agent went on believing its work was
  // there.
  const { registry, context, cleanup } = toolFixture();
  try {
    const rex = registry.create({ name: "Rex" });
    const files = new FileVersions();
    const disk = new Map<string, string>();

    // A box that is just a filesystem, which is all these two tools need.
    const box = {
      readFile: async (path: string) => {
        const content = disk.get(path);
        if (content === undefined) throw new Error("no such file");
        return { path, content, total_lines: 1, truncated: false };
      },
      writeFile: async (path: string, content: string) => {
        disk.set(path, content);
        return { path, bytes_written: content.length };
      },
    } as never;

    const ada = { ...context, box, files };
    const rexContext = { ...context, agent: rex, box, files };
    const path = "/home/box/work/report.md";

    // Ada creates it, then Rex reads and changes it.
    await dispatchTool("write_file", { path, content: "Ada's draft" }, ada);
    await dispatchTool("read_file", { path }, rexContext);
    await dispatchTool("write_file", { path, content: "Rex's revision" }, rexContext);

    // Ada, still holding her version, writes again.
    const refused = await dispatchTool("write_file", { path, content: "Ada's second draft" }, ada);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /changed since you last read it/);
    assert.match(refused.text, /Rex/);
    assert.equal(disk.get(path), "Rex's revision", "and Rex's work is still there");

    // Reading it is the way forward, and then the write goes through.
    await dispatchTool("read_file", { path }, ada);
    const accepted = await dispatchTool("write_file", { path, content: "merged" }, ada);
    assert.equal(accepted.isError, undefined);
    assert.equal(disk.get(path), "merged");

    // And the deliberate escape works, for when an agent has looked and decided.
    await dispatchTool("write_file", { path, content: "Rex again" }, rexContext);
    const forced = await dispatchTool(
      "write_file",
      { path, content: "Ada insists", overwrite: true },
      ada
    );
    assert.equal(forced.isError, undefined);
    assert.equal(disk.get(path), "Ada insists");
  } finally {
    cleanup();
  }
});

test("a file that cannot be checked is refused, not waved through", async () => {
  // Two things at once, and they are the same thing. Reading ten lines is not knowledge of the
  // whole file, so it establishes nothing; and a file too large to read whole cannot be compared
  // against anything, so "I could not check" must not pass as "I checked and it is fine" — that is
  // how a guarantee quietly stops applying to exactly the largest files.
  const { context, cleanup } = toolFixture();
  try {
    const files = new FileVersions();
    const box = {
      readFile: async (path: string) => ({
        path,
        content: "line 1",
        total_lines: 900,
        truncated: true,
      }),
      writeFile: async (path: string, content: string) => ({ path, bytes_written: content.length }),
    } as never;
    const ada = { ...context, box, files };
    const path = "/home/box/work/big.log";

    await dispatchTool("read_file", { path, start_line: 1, end_line: 10 }, ada);
    const refused = await dispatchTool("write_file", { path, content: "replaced" }, ada);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /too large to read in full/);
    assert.match(refused.text, /overwrite: true/, "and the deliberate way through is named");

    // Which still works, because the point is that it is a decision rather than an accident.
    const forced = await dispatchTool(
      "write_file",
      { path, content: "replaced", overwrite: true },
      ada
    );
    assert.equal(forced.isError, undefined);
  } finally {
    cleanup();
  }
});


test("two agents claiming one task: the second is refused, through the tool", async () => {
  const { registry, context, cleanup } = toolFixture();
  try {
    const rex = registry.create({ name: "Rex" });
    const claims = new Claims(null);
    // A real file would be better but the class is covered directly; here the wiring is on test.
    const shared = new Claims(join(mkdtempSync(join(tmpdir(), "agentbox-claims-tool-")), "c.jsonl"));
    void claims;

    const ada = { ...context, claims: shared };
    const rexContext = { ...context, agent: rex, claims: shared };

    const first = await dispatchTool("ClaimWork", { work: "Rewrite the deploy script" }, ada);
    assert.equal(first.isError, undefined);
    assert.match(first.text, /Claimed/);

    const second = await dispatchTool("ClaimWork", { work: "rewrite the deploy script" }, rexContext);
    assert.equal(second.isError, true);
    assert.match(second.text, /Ada claimed this/);

    // Renewing is not a conflict with yourself.
    const renewed = await dispatchTool("ClaimWork", { work: "Rewrite the deploy script" }, ada);
    assert.match(renewed.text, /Still yours/);

    // And releasing hands it over.
    await dispatchTool("ClaimWork", { work: "Rewrite the deploy script", release: true }, ada);
    const afterRelease = await dispatchTool("ClaimWork", { work: "rewrite deploy script" }, rexContext);
    assert.equal(afterRelease.isError, undefined);
  } finally {
    cleanup();
  }
});

test("an empty claim is refused rather than colliding with everything", async () => {
  const { context, cleanup } = toolFixture();
  try {
    const result = await dispatchTool("ClaimWork", { work: "  " }, { ...context, claims: new Claims(null) });
    assert.equal(result.isError, true);
    assert.match(result.text, /Say what the work is/);
  } finally {
    cleanup();
  }
});


test("a read that fails is not treated as the file being absent", async () => {
  // A transient daemon error or permission fault used to collapse to ABSENT, the one state the
  // version check always permits, so a hiccup reading an existing file let the next write overwrite
  // it silently. "Could not read" and "not there" are opposite answers.
  const { context, cleanup } = toolFixture();
  try {
    const files = new FileVersions();
    const path = "/home/box/work/report.md";
    let mode: "ok" | "fail" | "missing" = "ok";
    const box = {
      readFile: async () => {
        if (mode === "fail") throw new Error("the box was restarting");
        if (mode === "missing") throw new Error("/home/box/work/report.md does not exist");
        return { path, content: "someone's work", total_lines: 1, truncated: false };
      },
      writeFile: async (p: string, content: string) => ({ path: p, bytes_written: content.length }),
    } as never;
    const ada = { ...context, box, files };

    // A read failure that is not "absent" refuses the write, rather than overwriting blind.
    mode = "fail";
    const refused = await dispatchTool("write_file", { path, content: "mine" }, ada);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /could not be read/);
    assert.match(refused.text, /not the same as the file being absent/);

    // A genuinely missing file still writes — creating it is safe.
    mode = "missing";
    const created = await dispatchTool("write_file", { path, content: "new" }, ada);
    assert.equal(created.isError, undefined);
  } finally {
    cleanup();
  }
});
