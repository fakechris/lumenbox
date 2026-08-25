/**
 * Work that was in progress when the process stopped, found and told about.
 *
 * A channel request is answered by an awaited promise: the adapter calls `ask`, and when
 * it returns it finishes the card, closes the task and delivers the reply. All of that is
 * a continuation living in memory. Kill the process and it is gone — while the *turn* is
 * recovered from the ledger on disk and runs to completion, because those two recovery
 * stories were built separately and never met.
 *
 * The result is the worst shape available: the agent does the work, spends the money, and
 * the person watches a card that says "Working" forever. Observed, not imagined — a task
 * sat in `doing` with its turn long finished and its answer delivered nowhere.
 *
 * This closes it from the durable side. Nothing in memory is trusted: a task is stuck if
 * the board says somebody is working on it and no turn is running for it. What to do about
 * one is deliberately not "run it again" — the work may well have completed, and repeating
 * a turn that already sent an email is a worse failure than the one being fixed. The person
 * is told instead, and the task goes back to where somebody can pick it up.
 */

import type { Task, TaskStore } from "./tasks.ts";

export interface Stuck {
  task: Task;
  /** Where to say something, when the request came from a chat. */
  conversation?: string;
  requester?: string;
}

/**
 * Tasks the board believes are being worked on, with nobody working on them.
 *
 * `live` is the set of conversations that have a turn running right now. A restart makes
 * that set empty, which is exactly the case this exists for; passing it in rather than
 * assuming empty means the same function is correct when called on a running system.
 */
export function stuckTasks(tasks: readonly Task[], live: ReadonlySet<string>): Stuck[] {
  const found: Stuck[] = [];
  for (const task of tasks) {
    // `review` is somebody else's turn to act and is not stuck; `blocked` already says
    // it is going nowhere and why. Only `doing` claims that work is happening now.
    if (task.status !== "doing") continue;
    if (task.conversation !== undefined && live.has(task.conversation)) continue;
    found.push({
      task,
      ...(task.conversation !== undefined ? { conversation: task.conversation } : {}),
      ...(task.requester !== undefined ? { requester: task.requester } : {}),
    });
  }
  return found;
}

/**
 * What to tell somebody whose request was interrupted.
 *
 * It does not claim the work failed, because it very often did not — the turn is resumed
 * from the ledger and usually finishes. What was lost is the delivery. Saying "it failed"
 * would be a lie that costs the person the work; saying nothing is what produced the
 * frozen card. So it says what is actually known, which is that the answer may exist and
 * cannot be produced here.
 */
export function rescueMessage(stuck: Stuck): string {
  return (
    `"${stuck.task.title}" was interrupted when I restarted, and I lost track of it.\n\n` +
    `The work may well have finished — I cannot tell from here, and I would rather say so ` +
    `than either repeat it or leave you watching a card that never moves. It is back on the ` +
    `board as ${stuck.task.id}. Ask again if you still need it.`
  );
}

/**
 * Moves stuck tasks somewhere honest and returns what was moved, so a caller can tell
 * the people waiting.
 *
 * Back to `open` rather than `dropped`: the request was never withdrawn, and a task
 * nobody can see is the frozen card with extra steps.
 */
export function rescueStuck(
  tasks: TaskStore,
  live: ReadonlySet<string>,
  by = "restart"
): Stuck[] {
  const stuck = stuckTasks(tasks.list(), live);
  for (const entry of stuck) {
    tasks.update(
      entry.task.id,
      {
        status: "open",
        note: "interrupted by a restart; the turn's result was not delivered",
      },
      by
    );
  }
  return stuck;
}
