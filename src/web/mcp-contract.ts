/**
 * The side door's written contract (INV-1358): how a task ends, what was ignored, whether a
 * retry runs twice, and which capabilities exist.
 *
 * The person's MCP door (`/mcp`, assign_task / task_status / …) had behaviour but no contract.
 * The contract has four parts:
 * terminal states `completed | failed | incomplete | cancelled`, `ignored_fields`, an
 * `Idempotency-Key` that returns the first result and waits while it is still running, and a
 * capability list where a missing capability is reported `false` rather than left out. This
 * module is the mapping from our board and our turn to that vocabulary; `mcp-server.ts` speaks it.
 *
 * `incomplete` is INV-1354's and the loop detector's outcome: the turn stopped itself and handed
 * the work back. It is not a failure and not a completion, and a caller that cannot tell the
 * three apart retries the wrong one.
 */

import type { Task } from "../host/tasks.ts";

export type TaskState = "in_progress" | "completed" | "failed" | "incomplete" | "cancelled";
export type IncompleteReason = "turn_budget" | "rounds" | "continuations" | "held_for_review";

export interface TaskOutcome {
  status: TaskState;
  reason?: IncompleteReason | "blocked" | "dropped";
}

/** The note a turn's own stop leaves on the task, so the outcome can say why (written by mcp-tools.ts). */
export const INCOMPLETE_NOTE = /^incomplete \((turn_budget|rounds|continuations)\)/;

/** Our board's status and history, read as the contract's terminal state. */
export function outcomeOf(task: Pick<Task, "status" | "history">): TaskOutcome {
  switch (task.status) {
    case "done":
      return { status: "completed" };
    case "blocked":
      return { status: "failed", reason: "blocked" };
    case "dropped":
      return { status: "cancelled", reason: "dropped" };
    case "review": {
      const note = [...task.history].reverse().find(change => change.note !== undefined && INCOMPLETE_NOTE.test(change.note))?.note;
      const reason = note === undefined ? undefined : (INCOMPLETE_NOTE.exec(note)?.[1] as IncompleteReason | undefined);
      return { status: "incomplete", reason: reason ?? "held_for_review" };
    }
    default:
      return { status: "in_progress" };
  }
}

export function describeOutcome(outcome: TaskOutcome): string {
  return `status: ${outcome.status}${outcome.reason !== undefined ? ` (${outcome.reason})` : ""}`;
}

/** Arguments the tool's schema does not name: accepted, not acted on, and said. */
export function ignoredFields(args: Record<string, unknown>, inputSchema: Record<string, unknown>): string[] {
  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
  return Object.keys(args).filter(key => !(key in properties) && key !== "idempotency_key").sort();
}

/**
 * Every capability, true or false, never omitted: a caller that has to guess from an absent key
 * guesses wrong in the direction that costs it. The false ones are the honest edge of the door.
 */
export const SIDE_DOOR_CAPABILITIES = {
  tasks: true,
  task_status: true,
  terminal_states: true,
  ignored_fields: true,
  idempotency_key: true,
  cancel: false,
  streaming: false,
  files: false,
  sessions: false,
} as const;

/** The idempotency key a call carries, from the header first, then the MCP `_meta`, then the arguments. */
export function idempotencyKeyOf(headers: Record<string, unknown>, params: Record<string, unknown> | undefined): string | undefined {
  const header = headers["idempotency-key"];
  if (typeof header === "string" && header !== "") return header;
  const meta = (params?._meta ?? {}) as Record<string, unknown>;
  if (typeof meta.idempotencyKey === "string" && meta.idempotencyKey !== "") return meta.idempotencyKey;
  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  return typeof args.idempotency_key === "string" && args.idempotency_key !== "" ? args.idempotency_key : undefined;
}
