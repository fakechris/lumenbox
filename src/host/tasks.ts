/**
 * The task board: work as an object, not a message.
 *
 * Until now the unit of work was a conversation turn — fine for "do this now", useless
 * for "who is doing what, what is blocked, what is waiting for review". A Task is the
 * smallest object that answers those: a title, an assignee, a status with a history of
 * who moved it and when, and an optional reviewer whose acceptance is what "done"
 * means. This is the work control plane's minimal form; Runs are linked by recording
 * the turn id on every change an agent makes, and the transcript is the evidence.
 *
 * **Advisory, like claims — with one exception.** Statuses are not enforced against a
 * model that decides everything else, and the history makes movement visible rather
 * than impossible. The exception is the review gate: when a task has a reviewer, its
 * assignee cannot move it to done — the attempt lands in review with a note saying so.
 * That one rule is enforced because it is the entire point of naming a reviewer, and a
 * gate the worker can wave itself through is decoration.
 *
 * Storage is a jsonl of task snapshots, one line per change, latest line per id wins —
 * the same replay-and-compact shape as every other durable log here. History rides
 * inside the task, bounded, so a snapshot is self-contained. Ids are small numbers
 * ("t12") because people say them in chat; a counter marker survives compaction so an
 * id is never reused after its task is gone.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendLine } from "./jsonl.ts";
import { agentboxHome, envNumber } from "../config.ts";

export function tasksPath(): string {
  return process.env.AGENTBOX_TASKS_LOG ?? join(agentboxHome(), "tasks.jsonl");
}

export const TASK_STATUSES = ["open", "doing", "blocked", "review", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

/** A status under which a task still needs somebody. */
export function isLive(status: TaskStatus): boolean {
  return status !== "done" && status !== "dropped";
}

export interface TaskChange {
  at: string;
  /** Who moved it: an agent id, a principal id, or "web". */
  by: string;
  status?: TaskStatus;
  assigneeId?: string;
  note?: string;
  /** The turn (run) an agent made this change in, when it was an agent. */
  run?: string;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Who asked for it. */
  requester: string;
  assigneeId?: string;
  /** Named, "done" means this identity accepted it — the assignee cannot self-accept. */
  reviewerId?: string;
  conversation?: string;
  createdAt: string;
  updatedAt: string;
  history: TaskChange[];
}

/** Kept on each task so a snapshot stays one line, not a graph. */
const HISTORY_LIMIT = 30;
const COMPACT_AT = envNumber("AGENTBOX_TASKS_COMPACT_AT", 5_000);
/** Done and dropped tasks older than this are let go on compaction. */
const RETAIN_CLOSED_MS = envNumber("AGENTBOX_TASKS_RETAIN_DAYS", 30) * 24 * 3_600_000;

type TaskLine = { kind: "task"; task: Task } | { kind: "counter"; value: number };

export class TaskStore {
  private readonly tasks = new Map<string, Task>();
  private counter = 0;
  private lines = 0;

  constructor(
    private readonly path: string | null = tasksPath(),
    private readonly onWarn: (message: string) => void = () => {}
  ) {
    this.replay();
  }

  list(filter: { status?: TaskStatus; assigneeId?: string } = {}): Task[] {
    return [...this.tasks.values()]
      .filter(task => filter.status === undefined || task.status === filter.status)
      .filter(task => filter.assigneeId === undefined || task.assigneeId === filter.assigneeId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task === undefined ? undefined : { ...task, history: [...task.history] };
  }

  /** The live tasks on an agent's plate, for its prompt. Oldest first: finish before starting. */
  forAgent(agentId: string): Task[] {
    return [...this.tasks.values()]
      .filter(task => task.assigneeId === agentId && isLive(task.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  create(input: {
    title: string;
    description?: string;
    requester: string;
    assigneeId?: string;
    reviewerId?: string;
    conversation?: string;
    now?: Date;
  }): Task | undefined {
    const title = input.title.replace(/\s+/g, " ").trim().slice(0, 200);
    if (title === "") return undefined;
    const at = (input.now ?? new Date()).toISOString();
    this.counter += 1;
    const task: Task = {
      id: `t${this.counter}`,
      title,
      ...(input.description !== undefined && input.description.trim() !== ""
        ? { description: input.description.trim().slice(0, 4000) }
        : {}),
      status: "open",
      requester: input.requester,
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.reviewerId !== undefined ? { reviewerId: input.reviewerId } : {}),
      ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
      createdAt: at,
      updatedAt: at,
      history: [{ at, by: input.requester, status: "open", note: "created" }],
    };
    this.tasks.set(task.id, task);
    this.append({ kind: "task", task });
    return this.get(task.id);
  }

  /**
   * Moves, reassigns or annotates a task, recording who did it and in which run.
   *
   * Returns the updated task plus `coerced` when the review gate redirected a
   * self-acceptance — so the caller can say so instead of silently disagreeing with
   * what the model believes it did.
   */
  update(
    id: string,
    changes: {
      status?: TaskStatus;
      assigneeId?: string | null;
      reviewerId?: string | null;
      note?: string;
      title?: string;
      description?: string;
    },
    by: string,
    run?: string,
    now: Date = new Date()
  ): { task: Task; coerced?: string } | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;

    const at = now.toISOString();
    let coerced: string | undefined;
    let status = changes.status;

    // The review gate: the one enforced rule. A reviewer was named precisely so the
    // assignee cannot accept its own work; the attempt becomes "ready for review".
    if (
      status === "done" &&
      task.reviewerId !== undefined &&
      task.reviewerId !== by &&
      by === task.assigneeId
    ) {
      status = "review";
      coerced =
        `This task names ${task.reviewerId} as its reviewer, so its assignee cannot mark it ` +
        `done. It is now in review instead; ${task.reviewerId} accepting it is what done means.`;
    }

    const change: TaskChange = {
      at,
      by,
      ...(status !== undefined ? { status } : {}),
      ...(changes.assigneeId !== undefined && changes.assigneeId !== null
        ? { assigneeId: changes.assigneeId }
        : {}),
      ...(changes.note !== undefined && changes.note.trim() !== ""
        ? { note: changes.note.trim().slice(0, 500) }
        : {}),
      ...(coerced !== undefined ? { note: coerced } : {}),
      ...(run !== undefined ? { run } : {}),
    };

    const updated: Task = {
      ...task,
      ...(changes.title !== undefined && changes.title.trim() !== ""
        ? { title: changes.title.replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
      ...(changes.description !== undefined
        ? { description: changes.description.trim().slice(0, 4000) }
        : {}),
      ...(status !== undefined ? { status } : {}),
      ...(changes.assigneeId !== undefined
        ? changes.assigneeId === null
          ? { assigneeId: undefined }
          : { assigneeId: changes.assigneeId }
        : {}),
      ...(changes.reviewerId !== undefined
        ? changes.reviewerId === null
          ? { reviewerId: undefined }
          : { reviewerId: changes.reviewerId }
        : {}),
      updatedAt: at,
      history: [...task.history, change].slice(-HISTORY_LIMIT),
    };

    this.tasks.set(id, updated);
    this.append({ kind: "task", task: updated });
    if (this.lines > COMPACT_AT) this.compact(now);
    return { task: this.get(id)!, ...(coerced !== undefined ? { coerced } : {}) };
  }

  private append(line: TaskLine): void {
    if (this.path === null) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, JSON.stringify(line));
      this.lines += 1;
    } catch (error) {
      // Never fail a turn over bookkeeping; what is lost is one snapshot, and the
      // in-memory state still serves this process.
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`tasks: cannot write ${this.path} (${detail})`);
    }
  }

  private replay(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      let lines = 0;
      for (const raw of readFileSync(this.path, "utf8").split("\n")) {
        if (raw.trim() === "") continue;
        lines += 1;
        try {
          const line = JSON.parse(raw) as TaskLine;
          if (line.kind === "counter" && typeof line.value === "number") {
            this.counter = Math.max(this.counter, line.value);
          } else if (line.kind === "task" && typeof line.task?.id === "string") {
            this.tasks.set(line.task.id, line.task);
            const numeric = Number(line.task.id.slice(1));
            if (Number.isFinite(numeric)) this.counter = Math.max(this.counter, numeric);
          }
        } catch {
          // A torn last line costs one snapshot, not the board.
        }
      }
      this.lines = lines;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`tasks: cannot read ${this.path} (${detail})`);
    }
  }

  /**
   * Rewrites the file as one snapshot per task, letting go of closed tasks past the
   * retention window. The counter marker goes first, so an id from a dropped task is
   * never reused — "t12" must mean one thing forever.
   */
  private compact(now: Date): void {
    if (this.path === null) return;
    try {
      const cutoff = now.getTime() - RETAIN_CLOSED_MS;
      for (const [id, task] of this.tasks) {
        if (!isLive(task.status) && Date.parse(task.updatedAt) < cutoff) this.tasks.delete(id);
      }
      const kept = [
        JSON.stringify({ kind: "counter", value: this.counter } satisfies TaskLine),
        ...[...this.tasks.values()].map(task =>
          JSON.stringify({ kind: "task", task } satisfies TaskLine)
        ),
      ];
      const temp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temp, `${kept.join("\n")}\n`, "utf8");
      renameSync(temp, this.path);
      this.lines = kept.length;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.onWarn(`tasks: cannot compact ${this.path} (${detail})`);
    }
  }
}

/** One task as a line a model or a person reads. */
export function describeTask(task: Task, nameOf: (id: string) => string): string {
  const assignee = task.assigneeId !== undefined ? ` @${nameOf(task.assigneeId)}` : " (unassigned)";
  const reviewer = task.reviewerId !== undefined ? ` · review by ${nameOf(task.reviewerId)}` : "";
  return `${task.id} [${task.status}]${assignee} ${task.title}${reviewer}`;
}
