/** Goals through the side door (INV-1507): what a principal outside may say about its goals, and what stays a person's. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskStore } from "../host/tasks.ts";
import { SIDE_DOOR_CAPABILITIES } from "./mcp-contract.ts";
import { goalConversation, mcpGoalTools } from "./mcp-goal-tools.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_ID } from "../host/installation.ts";
import { Principals } from "../host/principals.ts";
import { applyPendingMerge, confirmMerge, mergePreview } from "../host/self-merge.ts";
import { SIX, sixPaths, writeSixIdentities } from "../host/testing/six-identities.ts";

function setup(options: { mayDrive?: boolean; board?: TaskStore; aliasesOf?: (id: string) => readonly string[] } = {}) {
  const board = options.board ?? new TaskStore(null);
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
    ...(options.aliasesOf !== undefined ? { aliasesOf: options.aliasesOf } : {}),
    log: () => {},
  });
  const start = tools.find(tool => tool.name === "goal_start")!;
  const control = tools.find(tool => tool.name === "goal_control")!;
  return { board, prompts, start, control };
}

const idOf = (text: string) => /^(t\d+)/.exec(text)?.[1] ?? "";

test("goal_start makes one goal per key, in a conversation of its own, and drafts its checklist without opening a task", async () => {
  const { board, prompts, start } = setup();
  await assert.rejects(start.run({ objective: "Ship the digest" }, "p1"), /needs an idempotency_key argument/, "no key, nothing made");
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

test("a blank agent is not named, and an unknown one is refused with the team (INV-1518)", async () => {
  const { agentNamed } = await import("./mcp-goal-tools.ts");
  const ada = { id: "a1", profile: { name: "Ada" } }, ops = { id: "a2", profile: { name: "Ops" } };
  const registry = { resolve: (name: string) => { const found = [ada, ops].find(agent => agent.profile.name === name); if (found === undefined) throw new Error("no"); return found; }, list: () => [ada, ops] };
  assert.equal(agentNamed(registry, "", () => ada), ada);
  assert.equal(agentNamed(registry, undefined, () => ada), ada);
  assert.equal(agentNamed(registry, " Ops ", () => ada), ops);
  assert.throws(() => agentNamed(registry, "coordinator", () => ada), /No agent named coordinator on this team\. The team: Ada, Ops\. Omit agent for the coordinator\./);
});

test("a goal started before the merge continues in its own conversation when the Owner sends its key again (INV-1705)", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-goal-merge-"));
  try {
    writeSixIdentities(home, { ledgers: false });
    const paths = sixPaths(home);
    const before = setup({ board: new TaskStore(paths.tasks) });
    const id = idOf(await before.start.run({ objective: "Ship the weekly digest" }, SIX.work2, { idempotencyKey: "k1" }));
    const conversation = before.board.get(id)!.conversation;
    assert.equal(conversation, goalConversation(SIX.work2, "k1"));

    confirmMerge(paths, { digest: mergePreview(paths, { desktop: true }).digest, by: "the operator", desktop: true });
    applyPendingMerge(paths, () => {});
    const principals = new Principals(paths.roster, { warn: () => {} });
    assert.equal(principals.resolve(SIX.work2).id, OWNER_ID, "the token's person is the Owner now");
    const after = setup({ board: new TaskStore(paths.tasks), aliasesOf: who => principals.byId(who)?.aliases ?? [] });
    assert.equal(after.board.get(id)!.requester, OWNER_ID, "the merge moved the goal to the Owner");
    const again = await after.start.run({ objective: "Ship the weekly digest" }, OWNER_ID, { idempotencyKey: "k1" });
    assert.equal(idOf(again), id, "the same key is the same goal");
    assert.equal(after.board.list().filter(task => task.pursuit !== undefined).length, 1, "not a second one");
    assert.equal(after.prompts.length, 0, "and no second drafting turn in a new conversation");
    const fresh = await after.start.run({ objective: "Tidy the shared drive" }, OWNER_ID, { idempotencyKey: "k2" });
    assert.equal(after.board.get(idOf(fresh))!.conversation, goalConversation(OWNER_ID, "k2"), "a new key is named from the Owner");

    const none = setup({ board: new TaskStore(paths.tasks) });
    const unaliased = await none.start.run({ objective: "Ship the weekly digest" }, OWNER_ID, { idempotencyKey: "k1" });
    assert.notEqual(idOf(unaliased), id, "without the aliases the old goal is not found: this is what the lookup fixes");
    assert.notEqual(none.board.get(idOf(unaliased))!.conversation, conversation);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
