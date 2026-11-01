/**
 * A person's follow-up in a task's own thread (INV-1462): the task's agent decides it first.
 *
 * Every channel message used to open its own task; a person had `/continue tN` to say which
 * work a line belonged to, and without it "再把标题改短点" became a new request. A topic thread
 * is the subscription dsh's ticket model makes explicit: the task that was asked for there owns
 * what a person says there next. So a message in a thread goes to that task's agent as a
 * follow-up turn — never folded into a running turn (the Nova rule), always its own turn on the
 * same task — and the agent either does it, which its reply acknowledges, or hands it back with
 * one reason, after which the message is routed as new work. A hand-back is recorded once per
 * follow-up; a second is refused. A task a person stopped owns nothing.
 *
 * Rooms without threads keep the old behaviour: a room is not a subscription.
 */

import type { Task } from "./tasks.ts";

export interface FollowUp {
  /** The channel message, so a second hand-back of the same one is refused. */
  messageId: string;
  at: string;
  handedBack?: { at: string; by: string; reason: string };
}

/** Which live-or-resumable task owns a thread's follow-ups: the newest in that conversation whose mandate was not withdrawn. */
export function ownerOf(tasks: readonly Task[], conversation: string): Task | undefined {
  return tasks
    .filter(task => task.conversation === conversation && task.mandate?.withdrawn === undefined && task.proposedBy === undefined)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** The record of a follow-up handed to the task's agent; a new message replaces the last. */
export function deliveredFollowUp(messageId: string, now: Date): FollowUp {
  return { messageId, at: now.toISOString() };
}

export type HandBackResult = "handed" | "already" | "none";

/** The follow-up handed back, once. */
export function handBack(current: FollowUp | undefined, by: string, reason: string, now: Date): { result: HandBackResult; followUp?: FollowUp } {
  if (current === undefined) return { result: "none" };
  if (current.handedBack !== undefined) return { result: "already" };
  return { result: "handed", followUp: { ...current, handedBack: { at: now.toISOString(), by, reason: reason.trim().slice(0, 300) } } };
}

/** What the task's agent is told when a person's thread message is theirs to decide. */
export function followUpPrompt(task: Pick<Task, "id" | "title">, text: string): string {
  return (
    `[Follow-up in the thread of task ${task.id} (${task.title}). You own this task, so this message is yours to decide: ` +
    `if it is within what the person asked for, do it and say so; if it asks for something beyond this task or belongs to other work, ` +
    `call HandBack with task_id "${task.id}" and one sentence of why, and do nothing else about it — it will be routed as new work.]\n\n${text}`
  );
}
