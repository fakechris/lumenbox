/**
 * The execution state of a piece of work, read from the three places it is still written (docs/99 §4).
 *
 * `Task.status`, the pursuit's `status` and the root's `status` each say how far the work has got,
 * each written by its own module. Until one field replaces them, this is where their meanings are
 * put side by side: what each value allows the execution state to be, and whether the three agree.
 * Disagreement is the defect the document is about: a card still "open" for a request that is
 * running, a card on the board for work a person stopped.
 */
import { workRootSummary } from "./work-root-store.ts";
import type { Task, TaskStatus } from "./tasks.ts";
import type { PursuitStatus } from "./goal-mode.ts";

export type Execution = "queued" | "running" | "waiting" | "finished" | "stopped";

const BY_STATUS: Record<TaskStatus, readonly Execution[]> = {
  open: ["queued"],
  doing: ["running", "waiting"],
  blocked: ["waiting"],
  review: ["finished"],
  done: ["finished"],
  dropped: ["stopped"],
};

const BY_PURSUIT: Record<PursuitStatus, readonly Execution[]> = {
  active: ["running", "waiting"],
  verifying: ["running", "waiting"],
  paused: ["waiting"],
  complete: ["finished"],
  cleared: ["stopped"],
};

/**
 * The root is the conversation's focus, so it knows less than it seems to: `answered` says the agent
 * was released, which a finished request and a parked one both are; `queued` is behind another
 * request, whether or not it had started before.
 */
const BY_ROOT: Record<string, readonly Execution[]> = {
  queued: ["queued", "waiting"],
  running: ["running"],
  waiting: ["waiting"],
  interrupted: ["waiting"],
  answered: ["finished", "waiting"],
  cancelled: ["stopped"],
};

/** What each record allows the execution state to be. A record the task does not have says nothing. */
export function executionReadings(task: Pick<Task, "status" | "pursuit" | "workRoot">): { status: readonly Execution[]; pursuit?: readonly Execution[]; root?: readonly Execution[] } {
  const phase = workRootSummary(task)?.phase;
  return {
    status: BY_STATUS[task.status],
    ...(task.pursuit !== undefined ? { pursuit: BY_PURSUIT[task.pursuit.status] } : {}),
    // An unresolved root is a record whose source could not be verified: it says nothing.
    ...(phase !== undefined && phase !== "unresolved" ? { root: BY_ROOT[phase] ?? [] } : {}),
  };
}

/** The one state all the records allow, or undefined when they contradict each other. */
export function executionOf(task: Pick<Task, "status" | "pursuit" | "workRoot">): Execution | undefined {
  const { status, pursuit, root } = executionReadings(task);
  const allowed = status.filter(state => (pursuit === undefined || pursuit.includes(state)) && (root === undefined || root.includes(state)));
  // Running outranks waiting where both are allowed: nothing here says a wait was opened.
  return allowed[0];
}

/** How the records contradict each other, in words; undefined when they do not. */
export function executionDisagreement(task: Pick<Task, "status" | "pursuit" | "workRoot">): string | undefined {
  if (executionOf(task) !== undefined) return undefined;
  const phase = workRootSummary(task)?.phase;
  return `status ${task.status}${task.pursuit !== undefined ? `, pursuit ${task.pursuit.status}${task.pursuit.completion !== undefined ? `/${task.pursuit.completion}` : ""}` : ""}${phase !== undefined ? `, root ${phase}` : ""}`;
}
