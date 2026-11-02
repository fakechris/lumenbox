/**
 * Goals through the side door (INV-1507, docs/90 §3.2): a principal outside starts and steers its
 * own goals, and the decisions that belong to a person stay with the person.
 *
 * `goal_start` is `/goal <objective>` by another road: the same `goalCommand`, so the same driver
 * gate, the same context check, the same blockers, the same refusal of a repeat. The call's
 * Idempotency-Key is the operation id a chat message's id is, and without one nothing is made —
 * a retried create must not be a second goal. Each goal gets a conversation of its own.
 *
 * `goal_control` touches only goals this principal started. Pause and clear are its own to say.
 * Resume is narrower: only a pause this principal made. A goal the gate stopped — budget,
 * repeating, idling, a failed verification — waits for a person, because going on past a stop is
 * the decision the stop exists to hand over. Budget, replace and checklist confirmation are not here.
 */

import { createHash } from "node:crypto";
import type { AgentRegistry } from "../agents/registry.ts";
import { goalCommand, parseGoalCommand } from "../host/goal-mode.ts";
import type { Orchestrator } from "../host/orchestrator.ts";
import type { McpServerTool } from "./mcp-server.ts";

export interface McpGoalDeps {
  registry: Pick<AgentRegistry, "resolve" | "list" | "contextMode">;
  orchestrator: Pick<Orchestrator, "tasks" | "prompt" | "contextBlockers" | "ensureDefaultAgent">;
  /** Whether this principal may drive this agent's box (the gate `/goal` asks). */
  mayDrive: (agentId: string, principalId: string) => boolean;
  nameOf: (principalId: string) => string;
  log: (line: string) => void;
}

/** One conversation per goal, named from who asked and the call's key, in the alphabet a goal conversation allows. */
/**
 * The agent a door call names: blank is "not named" (a model fills optional fields with ""), and a
 * name that is not on the team is refused with the team, so the caller does not have to guess (INV-1518).
 */
export function agentNamed<A extends { profile: { name: string } }>(registry: { resolve(name: string): A; list(): A[] }, name: unknown, fallback: () => A): A {
  if (typeof name !== "string" || name.trim() === "") return fallback();
  try {
    return registry.resolve(name.trim());
  } catch {
    throw new Error(`No agent named ${name.trim()} on this team. The team: ${registry.list().map(agent => agent.profile.name).join(", ") || "nobody yet"}. Omit agent for the coordinator.`);
  }
}

export function goalConversation(principalId: string, key: string): string {
  return `mcp-${createHash("sha256").update(`${principalId}\n${key}`).digest("hex").slice(0, 16)}`;
}

export function mcpGoalTools(deps: McpGoalDeps): McpServerTool[] {
  const { registry, orchestrator, log } = deps;
  return [
    {
      name: "goal_start",
      description:
        "Give the team a goal to pursue until it is verified done: it drafts a checklist, works in rounds, and stops " +
        "itself on budget, idling, repetition or a failed check. Requires an idempotency_key argument (or the Idempotency-Key header). Returns the task id; follow " +
        "it with task_status, whose structuredContent carries the checklist and the spend.",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string", description: "What done looks like, self-contained." },
          agent: { type: "string", description: "Which agent, by name. Omit for the coordinator." },
          budget: { type: "number", description: "Input-token equivalents; the goal pauses at the line." },
        },
        required: ["objective"],
      },
      readOnly: false,
      run: async (input, principalId, meta) => {
        const board = orchestrator.tasks;
        if (board === undefined) throw new Error("This installation has no task board.");
        const key = meta?.idempotencyKey;
        if (key === undefined || key === "") throw new Error("goal_start needs an idempotency_key argument (any unique string; the same one on a retry), so a retry cannot make a second goal. Nothing was created.");
        const objective = String(input.objective ?? "").replace(/\s+/g, " ").trim();
        const budget = typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0 ? Math.round(input.budget) : undefined;
        const text = `/goal ${objective}${budget !== undefined ? ` --budget ${budget}` : ""}`;
        if (parseGoalCommand(text).kind !== "create") throw new Error("That objective reads as a /goal subcommand, not a goal. Say what done looks like.");
        const agent = agentNamed(registry, input.agent, () => registry.list()[0] ?? orchestrator.ensureDefaultAgent());
        const conversation = goalConversation(principalId, key);
        const operationId = JSON.stringify(["mcp", principalId, key, "goal"]);
        // The replay store answers a retry for a day; after that the board still knows the goal this key made.
        const already = board.pursuitFromMessage(operationId);
        if (already !== undefined) return `${already.id} — this key already started that goal. Ask task_status about ${already.id}.\nstatus: ${already.pursuit?.status ?? "in_progress"}`;
        const result = goalCommand({
          tasks: board,
          mayUse: () => deps.mayDrive(agent.id, principalId),
          contextMode: () => registry.contextMode(agent.id, conversation),
          blockers: () => orchestrator.contextBlockers(agent.id, conversation),
        }, { agentId: agent.id, conversation, requester: principalId, operationId, privateChat: true, text });
        const created = board.pursuitIn(conversation);
        if (result.draft === undefined || created === undefined) throw new Error(result.text);
        // The first turn drafts the checklist; the pursuit task is the work, so this turn opens no task of its own.
        void orchestrator.prompt(agent.id, result.draft.prompt, { userId: principalId }, { conversation, lane: "agent" })
          .catch(error => log(`mcp goal ${created.id}: drafting turn failed (${error instanceof Error ? error.message : String(error)})`));
        return `${created.id} — ${agent.profile.name} is drafting a checklist for this goal, then works on it. Ask task_status about ${created.id}.\nstatus: in_progress`;
      },
    },
    {
      name: "goal_control",
      description:
        "Pause, clear or resume a goal you started. Resume only works on a pause you made: a goal the system stopped " +
        "(budget, repetition, idling, a failed check) waits for the person whose token this is.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          action: { type: "string", enum: ["pause", "clear", "resume"] },
        },
        required: ["task_id", "action"],
      },
      readOnly: false,
      run: async (input, principalId) => {
        const board = orchestrator.tasks;
        if (board === undefined) throw new Error("This installation has no task board.");
        const id = String(input.task_id ?? "");
        const task = board.get(id);
        const pursuit = task?.pursuit;
        if (task === undefined || pursuit === undefined) throw new Error(`No goal ${id}.`);
        if (task.requester !== principalId) throw new Error(`Goal ${id} was not started by you; only its requester steers it here.`);
        if (task.assigneeId !== undefined && !deps.mayDrive(task.assigneeId, principalId)) throw new Error(`You may no longer drive the agent on goal ${id}; nothing changed.`);
        const who = deps.nameOf(principalId);
        switch (input.action) {
          case "pause":
            if (pursuit.status === "verifying") throw new Error(`Goal ${id} is being verified; pause it when the verdict is in.`);
            if (pursuit.status !== "active") throw new Error(`Goal ${id} is ${pursuit.status}${pursuit.pausedReason !== undefined ? ` (${pursuit.pausedReason})` : ""}; there is nothing to pause.`);
            board.setPursuit(id, p => ({ ...p, status: "paused", pausedReason: "person", pausedBy: principalId }), `paused by ${who} through the side door`, principalId);
            return `Goal ${id} paused. Progress and checklist stay on the board; goal_control resume continues it.`;
          case "clear":
            if (pursuit.status === "complete" || pursuit.status === "cleared") throw new Error(`Goal ${id} is already ${pursuit.status}.`);
            board.setPursuit(id, p => ({ ...p, status: "cleared", pausedReason: "person" }), `cleared by ${who} through the side door`, principalId);
            return `Goal ${id} cleared. The record stays on the board; it will not be pursued again.`;
          case "resume":
            if (pursuit.status !== "paused") throw new Error(`Goal ${id} is ${pursuit.status}, not paused.`);
            if (pursuit.pausedReason !== "person" || pursuit.pausedBy !== principalId) {
              throw new Error(`Goal ${id} was stopped ${pursuit.pausedReason === "person" ? "by somebody else" : `by the system (${pursuit.pausedReason ?? "paused"})`}. Going on past that stop is a person's decision: the person whose token this is can resume it with /goal resume. Nothing changed.`);
            }
            board.setPursuit(id, p => ({ ...p, status: "active", pausedReason: undefined, pausedBy: undefined }), `resumed by ${who} through the side door`, principalId);
            return `Goal ${id} continues.`;
          default:
            throw new Error("action is one of pause, clear, resume.");
        }
      },
    },
  ];
}
