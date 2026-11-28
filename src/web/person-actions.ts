/**
 * Two things a person does from a phone that the page does with a button (INV-2214): saying something
 * to an agent (a question's answer), and a decision on work (count it as done, keep it open against a
 * proposal to close it, put it off, stop it). Each does what the page's own path does — the board's
 * update and close objection, the work control's cancel for work that is running — so the record says
 * the same whichever screen it came from.
 *
 * A question's answer settles the question at once for the person it was put to (as a reply through a
 * chat door does), and reaches the agent as the person's message in that conversation.
 */

import type { QuestionWatch } from "../host/question-expiry.ts";
import type { Task, TaskStore } from "../host/tasks.ts";
import type { WorkControl } from "../host/work-control.ts";

export interface PersonActionDeps {
  board(): Pick<TaskStore, "get" | "update" | "opposeClose"> | undefined;
  workControl: Pick<WorkControl, "preview" | "cancel">;
  questions: Pick<QuestionWatch, "noteReply">;
  /** The person's message to an agent, as the page sends one; `onAdmitted` once it is in the agent's queue. Resolves when the turn has settled. */
  message(agentId: string, text: string, personId: string, conversation: string, onAdmitted?: () => void): Promise<void>;
  /** Whether something runs for this work now (a turn in its conversation, a command it let go of). */
  running(task: Task): boolean;
  /** The identities a person speaks from, their roster id among them. */
  identitiesOf(personId: string): readonly string[];
  log(line: string): void;
}

export function personActions(deps: PersonActionDeps) {
  return {
    async say(personId: string, agentId: string, conversation: string, text: string, questionId?: string): Promise<void> {
      // The question is settled once its answer is in the agent's queue, not before: an answer refused on the way leaves it waiting.
      const settle = () => { if (questionId !== undefined) for (const identity of deps.identitiesOf(personId)) deps.questions.noteReply(agentId, identity, questionId, conversation); };
      // The turn runs on: the answer is accepted now, and what the agent says back arrives in the conversation.
      void deps.message(agentId, text, personId, conversation, settle).catch((error: unknown) => deps.log(`answer from ${personId} to ${agentId}: ${error instanceof Error ? error.message : String(error)}`));
    },

    async work(personId: string, taskId: string, decision: "done" | "keep-open" | "put-off" | "stop", until?: string, note?: string): Promise<{ ok: true } | { ok: false; why: string }> {
      const board = deps.board();
      const task = board?.get(taskId);
      if (board === undefined || task === undefined) return { ok: false, why: "the work is not on the board" };
      if (decision === "keep-open") {
        const opposed = board.opposeClose(taskId, personId, note);
        return "refused" in opposed ? { ok: false, why: opposed.refused } : { ok: true };
      }
      if (decision === "stop") {
        // Work that runs is stopped first, as the page's Stop does; then the row is dropped.
        const target = { agentId: task.assigneeId ?? "", conversation: task.conversation ?? "main", taskId };
        const preview = deps.workControl.preview(target);
        if (preview.token !== undefined) {
          await deps.workControl.cancel(target, preview.token, personId, note ?? "Stopped by the person");
          return { ok: true };
        }
        // Something runs for it and nothing here can stop it (no trusted record of what runs): dropping the row would say
        // "stopped" while it ran on. Refused; the page's work control pauses the members explicitly.
        if (deps.running(task as Task)) return { ok: false, why: "it is running and cannot be stopped from here; stop it on the page" };
      }
      const changes = decision === "put-off" ? { snoozeUntil: until! } : { status: decision === "done" ? "done" as const : "dropped" as const, ...(note !== undefined && note.trim() !== "" ? { note } : {}) };
      const updated = board.update(taskId, changes, personId);
      if (updated === undefined) return { ok: false, why: "the work is not on the board" };
      return updated.coerced !== undefined ? { ok: false, why: updated.coerced } : { ok: true };
    },
  };
}
