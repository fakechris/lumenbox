/**
 * A side-door task keeps the agent's last word (INV-1676): an agent that answers in prose and writes
 * no note, delivers no file, used to leave the caller outside "completed" and nothing else.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { REPLY_MAX } from "../host/task-reply.ts";
import { TaskStore } from "../host/tasks.ts";
import { fakeModel } from "../host/testing/fake-model.ts";
import type { TaskRecord } from "./mcp-record.ts";
import { mcpServerTools } from "./mcp-tools.ts";

test("assign_task: a turn that only answers in prose leaves its reply on the task, cut at the cap and scrubbed, for task_status to read", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-task-reply-"));
  const previousHome = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = root;
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada" });
    const board = new TaskStore(null);
    // The finding, then a long tail and a held value the outbound redactor would scrub from a chat reply.
    const said = `X is 42, per the vendor's own page. token=SECRET-1 ${"detail ".repeat(600)}`;
    const orchestrator = new Orchestrator({
      registry, useBox: false, inbox: null, mcp: null, hooks: null, tasks: board, extensions: null, pendingWork: null,
      client: fakeModel(() => ({
        id: "r", type: "message", role: "assistant", model: "test",
        content: [{ type: "text", text: said }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4 },
      } as never)),
    });
    const tools = mcpServerTools({
      registry, orchestrator, principals: { resolve: id => ({ name: id }) }, workDir: "/work", log: () => {}, listen: () => () => {},
      redact: text => text.replaceAll("SECRET-1", "[redacted]"),
    });
    const tool = (name: string) => tools.find(entry => entry.name === name)!;
    const answer = String(await tool("assign_task").run({ brief: "Find out what X is.", agent: "Ada" }, "p-chris"));
    const id = /^(t\d+)/.exec(answer)?.[1];
    assert.ok(id !== undefined, answer);
    for (let i = 0; i < 200 && board.get(id)!.history.every(change => change.reply !== true); i++) await new Promise(resolve => setTimeout(resolve, 10));

    const { text, structured } = await tool("task_status").runWithRecord!({ task_id: id }, "p-chris");
    const [record] = structured.tasks as TaskRecord[];
    assert.equal(record!.outcome.status, "completed", "the turn still closes the task");
    assert.equal(board.get(id)!.assigneeId, ada.id);
    assert.equal(record!.reply?.by, "Ada", "the reply is the agent's move");
    assert.match(record!.reply!.text, /^X is 42, per the vendor's own page\. token=\[redacted\]/);
    assert.doesNotMatch(record!.reply!.text, /SECRET-1/, "scrubbed on the way onto the record, as a chat reply is on the way out");
    assert.ok(record!.reply!.text.length <= REPLY_MAX && record!.reply!.text.length > REPLY_MAX - 10, "cut at the cap: the task is not a copy of the conversation");
    assert.ok(record!.reply!.text.endsWith("…"));
    assert.equal(record!.history.filter(change => change.reply === true).length, 1);
    assert.match(text, /Ada +replied: X is 42/, "the text says it too");
    // Recorded before the turn closed it, so the record reads in the order it happened.
    const replyAt = board.get(id)!.history.findIndex(change => change.reply === true);
    const closedAt = board.get(id)!.history.findIndex(change => change.status === "done");
    assert.ok(replyAt >= 0 && closedAt > replyAt, JSON.stringify(board.get(id)!.history));
  } finally {
    if (previousHome === undefined) delete process.env.AGENTBOX_HOME;
    else process.env.AGENTBOX_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
