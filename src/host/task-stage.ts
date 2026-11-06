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
  /** In review with an agent named as reviewer (INV-1647): the K-reviewer record settles it, no person is asked. */
  | "review"
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
  /** The named reviewer is an agent (INV-1647): the review is the team's, and only the person's own asks wait for the person. */
  reviewerIsAgent?: boolean;
}

/** The world for one task from what the host holds; the attention page and the side door read it the same way (INV-1506). */
export function stageWorldOf<T extends Pick<Task, "conversation" | "assigneeId" | "reviewerId">>(
  task: T,
  reads: { undeliverableChats: ReadonlySet<string>; chatKeyOf?: (conversation: string) => string | undefined; questions: readonly { conversation?: string; agentId?: string }[]; agentIds?: ReadonlySet<string>; active?: (task: T) => boolean },
): StageWorld {
  const chatKey = task.conversation !== undefined ? reads.chatKeyOf?.(task.conversation) : undefined;
  return {
    undelivered: chatKey !== undefined && reads.undeliverableChats.has(chatKey),
    questionPending: reads.questions.some(question => question.conversation === task.conversation && (task.assigneeId === undefined || question.agentId === task.assigneeId)),
    active: reads.active?.(task) ?? false,
    reviewerIsAgent: task.reviewerId !== undefined && (reads.agentIds?.has(task.reviewerId) ?? false),
  };
}

/**
 * The table. Rows, in order:
 *
 * | stage           | condition                                                             |
 * | --------------- | --------------------------------------------------------------------- |
 * | ended           | status done or dropped                                                |
 * | person/delivery | a message for this task's conversation is undeliverable               |
 * | person/answer   | a question is pending on it, the board asks with options, or its mandate is stale |
 * | review          | status review, an agent named as reviewer: the team's record settles it  |
 * | person/review   | status review, otherwise                                               |
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
  if (task.status === "review") return world.reviewerIsAgent === true ? "review" : "person/review";
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
  review: "under the team's review",
  "person/blocked": "blocked",
  "working/queued": "queued",
  working: "working",
  idle: "waiting for a trigger",
  ended: "ended",
};
