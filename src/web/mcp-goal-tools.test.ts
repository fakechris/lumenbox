/** Goals through the side door (INV-1507): what a principal outside may say about its goals, and what stays a person's. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStore } from "../host/tasks.ts";
import { SIDE_DOOR_CAPABILITIES } from "./mcp-contract.ts";
import { goalConversation, mcpGoalTools } from "./mcp-goal-tools.ts";

function setup(options: { mayDrive?: boolean } = {}) {
  const board = new TaskStore(null);
  const prompts: { agentId: string; text: string; userId?: string; conversation?: string }[] = [];
  const agent = { id: "a1", profile: { name: "Ada" } };
  const tools = mcpGoalTools({
    registry: { resolve: () => agent, list: () => [agent], contextMode: () => "normal" } as never,
    orchestrator: {
      tasks: board,
      prompt: async (agentId: string, text: string, caller?: { userId?: string }, opts?: { conversation?: string }) => {
        prompts.push({ agentId, text, ...(caller?.userId !== undefined ? { userId: caller.userId } : {}), ...(opts?.conversation !== undefined ? { conversation: opts.conversation } : {}) });
      },
      contextBlockers: () => [],
      ensureDefaultAgent: () => agent,
    } as never,
    mayDrive: () => options.mayDrive ?? true,
    nameOf: id => id,
    log: () => {},
  });
  const start = tools.find(tool => tool.name === "goal_start")!;
  const control = tools.find(tool => tool.name === "goal_control")!;
  return { board, prompts, start, control };
}

const idOf = (text: string) => /^(t\d+)/.exec(text)?.[1] ?? "";

test("goal_start makes one goal per key, in a conversation of its own, and drafts its checklist without opening a task", async () => {
  const { board, prompts, start } = setup();
  await assert.rejects(start.run({ objective: "Ship the digest" }, "p1"), /needs an Idempotency-Key/, "no key, nothing made");
  assert.equal(board.list().length, 0);
  const first = await start.run({ objective: "Ship the weekly digest", budget: 5000 }, "p1", { idempotencyKey: "k1" });
  const id = idOf(first);
  const task = board.get(id)!;
  assert.equal(task.requester, "p1", "the goal is the principal's, on the board");
  assert.equal(task.conversation, goalConversation("p1", "k1"));
  assert.match(task.conversation!, /^mcp-[0-9a-f]{16}$/);
  assert.equal(task.pursuit?.limits.budget, 5000);
  assert.equal(prompts.length, 1, "the drafting turn ran");
  assert.deepEqual([prompts[0]!.userId, prompts[0]!.conversation], ["p1", task.conversation]);
  assert.equal(board.list().length, 1, "the drafting turn opened no task of its own");
  const again = await start.run({ objective: "Ship the weekly digest", budget: 5000 }, "p1", { idempotencyKey: "k1" });
  assert.equal(idOf(again), id, "the same key, past the replay store: the same goal");
  assert.equal(board.list().length, 1);
  assert.equal(prompts.length, 1, "and no second drafting turn");
  await assert.rejects(start.run({ objective: "pause" }, "p1", { idempotencyKey: "k2" }), /reads as a \/goal subcommand/);
  assert.equal(SIDE_DOOR_CAPABILITIES.goals, true);
});

test("a principal steers only its own goals; pause and resume its own pause; clear ends it", async () => {
  const { board, start, control } = setup();
  const id = idOf(await start.run({ objective: "Tidy the shared drive" }, "p1", { idempotencyKey: "k1" }));
  await assert.rejects(control.run({ task_id: id, action: "pause" }, "p2"), /not started by you/);
  assert.match(await control.run({ task_id: id, action: "pause" }, "p1"), /paused/);
  assert.deepEqual([board.get(id)!.pursuit?.status, board.get(id)!.pursuit?.pausedReason, board.get(id)!.pursuit?.pausedBy], ["paused", "person", "p1"]);
  await assert.rejects(control.run({ task_id: id, action: "resume" }, "p2"), /not started by you/);
  assert.match(await control.run({ task_id: id, action: "resume" }, "p1"), /continues/);
  assert.deepEqual([board.get(id)!.pursuit?.status, board.get(id)!.pursuit?.pausedBy], ["active", undefined]);
  assert.match(await control.run({ task_id: id, action: "clear" }, "p1"), /cleared/);
  await assert.rejects(control.run({ task_id: id, action: "clear" }, "p1"), /already cleared/);
  await assert.rejects(control.run({ task_id: "t999", action: "pause" }, "p1"), /No goal t999/);
});

test("a stop the system made is not resumable from the door; neither is a person's own pause", async () => {
  const { board, start, control } = setup();
  const id = idOf(await start.run({ objective: "Reconcile the invoices" }, "p1", { idempotencyKey: "k1" }));
  for (const reason of ["repeating", "budget", "anti_spin", "needs_person"] as const) {
    board.setPursuit(id, p => ({ ...p, status: "paused", pausedReason: reason }), `stopped: ${reason}`);
    await assert.rejects(control.run({ task_id: id, action: "resume" }, "p1"), /by the system .*a person's decision/);
    assert.equal(board.get(id)!.pursuit?.status, "paused", `${reason}: nothing changed`);
  }
  board.setPursuit(id, p => ({ ...p, status: "paused", pausedReason: "person", pausedBy: undefined }), "paused by the person (/goal pause)", "p1");
  await assert.rejects(control.run({ task_id: id, action: "resume" }, "p1"), /by somebody else/, "a pause made in the chat is resumed in the chat");
});

test("losing the right to drive the agent stops the door too", async () => {
  const { start } = setup({ mayDrive: false });
  await assert.rejects(start.run({ objective: "Ship the digest" }, "p1", { idempotencyKey: "k1" }), /权限/);
});
