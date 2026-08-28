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
 * **Advisory, like claims — with two exceptions**, both about who may say a task is
 * done. Statuses are not enforced against a model that decides everything else, and the
 * history makes movement visible rather than impossible. The exceptions:
 *
 *   1. **A named reviewer means the assignee cannot accept its own work.** The attempt
 *      lands in review with a note saying so. That is the entire point of naming one,
 *      and a gate the worker can wave itself through is decoration.
 *   2. **Somebody the task is not about cannot end it.** Chat acceptance is keyed by
 *      conversation, so an authorised colleague in a shared room could type 可以 and
 *      close work that was never theirs — the store allowed it because it only ever
 *      refused the assignee. Their attempt is refused and the task does not move.
 *
 * What is deliberately *not* enforced, and is a deferred product decision rather than an
 * oversight (docs/16): a task with no reviewer still closes when its turn finishes. The
 * alternative — every one-shot chat request waiting for a person to say 可以 — answers
 * "what needs somebody" wrong in the other direction.
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
  /**
   * The review gate redirected this move: the assignee tried to accept its own work.
   *
   * Recorded as a field rather than left to be recognised from the note's wording,
   * because a listener that string-matches a sentence breaks the day the sentence is
   * reworded — and this one is read by the pitfall writer, which must not fire on an
   * ordinary move to review. Additive and optional: records written before it read fine.
   */
  coerced?: true;
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

/**
 * How much of the request a task keeps, and what it says when it kept less.
 *
 * The cut is real — a snapshot is one line and an unbounded description makes the board
 * file unbounded — but it used to be silent, and that is what makes it dangerous rather
 * than merely lossy. A 4,200-character request whose last sentence is "do not deduplicate
 * the invoice rows" persisted without that sentence, and every later reader — a person
 * scanning the board, an auditor told to re-derive the constraints from the original
 * request — saw a complete-looking request that was not complete. Found by review.
 *
 * So the truncation announces itself in the text, in the reader's own line of sight. It
 * cannot make the words come back; it can stop them from being missed.
 */
export const DESCRIPTION_LIMIT = 4_000;

/**
 * Actors that are the harness rather than a person, moving work on the assignee's behalf.
 *
 * They pass the who-may-accept rule because refusing them would break the ordinary case
 * the board exists to serve: a one-shot ask from a chat, where nobody is watching the
 * board and leaving the row open forever answers "what needs somebody" wrong in the other
 * direction. Enumerated rather than inferred, so adding one is a decision somebody makes
 * on purpose.
 */
const HARNESS_ACTORS: ReadonlySet<string> = new Set([
  "channel",
  "restart",
  "host",
  "web",
  "audit-guard",
]);

export function clampDescription(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DESCRIPTION_LIMIT) return trimmed;
  const note = `\n\n[截断:原文 ${trimmed.length} 字,此处只保留前 ${DESCRIPTION_LIMIT} 字。完整内容在原始消息里。]`;
  return `${trimmed.slice(0, DESCRIPTION_LIMIT - note.length)}${note}`;
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
  /**
   * Called after every recorded change with the task as it now stands. The auto-audit
   * listens here for tasks landing in review; the channel wiring listens for blocked
   * landings. Methods rather than constructor arguments because subscribers are wired
   * after the store exists — and additive, because an assignable field would have the
   * second subscriber silently unseat the first.
   */
  private readonly listeners: ((task: Task) => void)[] = [];

  onChange(listener: (task: Task) => void): void {
    this.listeners.push(listener);
  }

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
        ? { description: clampDescription(input.description) }
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
  /**
   * What the end of a turn means for the task that turn was working.
   *
   * Not "done". A turn ending is a fact about a process; done is a judgement about work,
   * and the two were conflated: the channel marked every chat-initiated task done the
   * moment its turn returned. Found in production on t51 — the agent produced the answer,
   * moved the task to `review`, and told the person it was waiting for their next step;
   * five seconds later the card said Done. Two surfaces contradicting each other about one
   * task, and the person only looks at one of them.
   *
   * Two rules, both of which this path used to break:
   *
   * - **A status the agent chose survives.** `review`, `blocked` and `dropped` are all more
   *   specific than "the turn ended", and an agent that set one meant it.
   * - **The review gate applies.** It is the one enforced rule in this file, and moving the
   *   task as "channel" rather than as its assignee walked straight past it: an agent could
   *   not accept its own work, and the harness closing the turn behind it could.
   */
  turnFinished(id: string, now: Date = new Date()): { task: Task; coerced?: string } | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    if (task.status !== "open" && task.status !== "doing") return { task };
    // Attributed to whoever the work belongs to, so the gate sees the same thing it sees
    // when that agent marks its own task done — because that is what is happening.
    return this.update(id, { status: "done" }, task.assigneeId ?? "channel", undefined, now);
  }

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

    // The review gate. Two rules, both about who may say a thing is finished, because
    // "done is the requester's word" was prose in an audit prompt and prose is not a gate.
    //
    // 1. An assignee may not accept its own work when a reviewer was named. That is the
    //    original rule and the reason naming a reviewer means anything.
    // 2. Only the requester or the named reviewer may accept at all. Found by review:
    //    acceptance in a chat is keyed by *conversation*, so any authorised person in a
    //    shared room could type 可以 and close somebody else's task — and with no reviewer
    //    named, the assignee could close its own. The people who may end a piece of work
    //    are the person who asked for it and the person appointed to check it; anyone else
    //    saying so is a remark, not a verdict.
    const belongsToTask =
      by === task.requester ||
      by === task.assigneeId ||
      (task.reviewerId !== undefined && by === task.reviewerId) ||
      HARNESS_ACTORS.has(by);

    // Rule one, unchanged: a named reviewer means the assignee cannot accept its own work.
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
    } else if (status === "done" && !belongsToTask) {
      // Rule two, new: somebody the task is not about cannot end it. Found by review —
      // chat acceptance is keyed by *conversation*, so any authorised person in a shared
      // room could type 可以 and close a colleague's task, and the store allowed it because
      // it only ever refused the assignee. The task does not move: a status change nobody
      // authorised is the failure, and nudging it somewhere else would be a second one.
      status = undefined;
      coerced =
        `Only ${task.requester}${
          task.reviewerId !== undefined ? ` or ${task.reviewerId}` : ""
        } can accept this task, so it has not moved. Put what you found in a note instead — ` +
        `a verdict from somebody the work was not for is a remark.`;
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
      ...(coerced !== undefined ? { note: coerced, coerced: true as const } : {}),
      ...(run !== undefined ? { run } : {}),
    };

    const updated: Task = {
      ...task,
      ...(changes.title !== undefined && changes.title.trim() !== ""
        ? { title: changes.title.replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
      ...(changes.description !== undefined
        ? { description: clampDescription(changes.description) }
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
    const result = { task: this.get(id)!, ...(coerced !== undefined ? { coerced } : {}) };
    for (const listener of this.listeners) listener(result.task);
    return result;
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
