/**
 * A task's stage: whom it waits for and what it needs, read off its record (INV-1464).
 *
 * The board has statuses; the attention page had seven kinds of item, each produced by its own
 * rule in its own place. Neither answered the one question a person arrives with — does this
 * need me now? — with a definition they could check. This is that definition: a table, read
 * from the top, first row that matches wins, and every live task lands on exactly one row.
 *
 * `person/*` means the work cannot continue without somebody; `working/*` means it is ours;
 * `idle` means it waits for something to happen. Derived every time, never stored.
 */

import type { Task } from "./tasks.ts";

export type TaskStage =
  | "person/delivery"
  | "person/answer"
  | "person/review"
  | "person/blocked"
  | "working/queued"
  | "working"
  | "idle"
  | "ended";

/** What the stage table reads beside the task's own record. */
export interface StageWorld {
  /** A message of this task's conversation the host could not deliver after its retries (INV-1460). */
  undelivered: boolean;
  /** A question put to a person on this task's conversation is still open (question watch), or the mandate waits for its person (INV-1457). */
  questionPending: boolean;
  /** A turn of the assignee runs in this task's conversation right now, or a command it let go of still runs (INV-1461). */
  active: boolean;
}

/**
 * The table. Rows, in order:
 *
 * | stage           | condition                                                             |
 * | --------------- | --------------------------------------------------------------------- |
 * | ended           | status done or dropped                                                |
 * | person/delivery | a message for this task's conversation is undeliverable               |
 * | person/answer   | a question is pending on it, the board asks with options, or its mandate is stale |
 * | person/review   | status review                                                         |
 * | person/blocked  | status blocked, no options to choose from                             |
 * | working/queued  | status open: nobody has started it                                    |
 * | working         | status doing and something of it runs now                             |
 * | idle            | status doing and nothing runs: it waits for a message, a job, a wake  |
 */
export function taskStage(task: Pick<Task, "status" | "history" | "mandate" | "proposedBy">, world: StageWorld): TaskStage {
  if (task.status === "done" || task.status === "dropped") return "ended";
  if (world.undelivered) return "person/delivery";
  const last = task.history.at(-1);
  const asksWithOptions = task.status === "blocked" && last?.options !== undefined && last.options.length > 0;
  const staleMandate = task.mandate?.stale !== undefined && task.mandate.withdrawn === undefined;
  if (world.questionPending || asksWithOptions || staleMandate) return "person/answer";
  if (task.status === "review") return "person/review";
  if (task.status === "blocked") return "person/blocked";
  if (task.status === "open") return "working/queued";
  return world.active ? "working" : "idle";
}

/** Whether a stage needs a person to move. */
export const needsPerson = (stage: TaskStage): boolean => stage.startsWith("person/");

export const STAGE_LABEL: Record<TaskStage, string> = {
  "person/delivery": "undeliverable",
  "person/answer": "awaiting answer",
  "person/review": "awaiting review",
  "person/blocked": "blocked",
  "working/queued": "queued",
  working: "working",
  idle: "waiting for a trigger",
  ended: "ended",
};
