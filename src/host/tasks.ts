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
import { appendLine, type LedgerKind } from "./jsonl.ts";
import { Receipts } from "./receipts.ts";
import { agentboxHome, envNumber } from "../config.ts";

/**
 * What each task is, now, plus a grace period on closed ones so a person asking about
 * something they just finished still gets an answer. Older closed tasks are not owed.
 */
export const LEDGER_KIND: LedgerKind = "state";

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
  /**
   * The answers a blocked task can be unblocked with, when the note is a question. A
   * chat renders them as buttons under the question; a pressed one speaks as a reply.
   * Kept on the change, not the task: the next move is a different question or none.
   */
  options?: string[];
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
  /**
   * What the reviewer did this turn before accepting: one line per tool call. The record
   * of a verdict is the verdict and what it rested on; without this a "done" from a
   * reviewer is a name on the assignee's summary.
   */
  checked?: string[];
  /**
   * What the assignee points at when submitting for review: a URL, a path, a command's
   * output — each with a word on what it shows. Never a secret-bearing path. The reviewer
   * reads these before the summary.
   */
  evidence?: string[];
}

export interface TaskContract {
  outcome?: string;
  scope?: string;
  constraints?: string;
  acceptance?: string;
  verification?: string;
}

export function clampContract(input: Partial<Record<keyof TaskContract, unknown>> | undefined): TaskContract | undefined {
  if (input === undefined) return undefined;
  const out: TaskContract = {};
  for (const key of ["outcome", "scope", "constraints", "acceptance", "verification"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim().slice(0, 1_000);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  /** Who asked for it. */
  requester: string;
  /** The immutable admitted-message record containing the original request. */
  sourceMessageId?: string;
  assigneeId?: string;
  /** Named, "done" means this identity accepted it — the assignee cannot self-accept. */
  reviewerId?: string;
  /**
   * What finished looks like, in the requester's words, kept apart from the description.
   * Five fields because that is what a reviewer needs and a title cannot carry: what comes
   * out, what is in and out of bounds, what must not be done, how "done" is judged, and how
   * it was checked. (Involute's work items carry the same five; two days of bots working
   * from them stayed in lane.)
   */
  contract?: TaskContract;
  /**
   * Set while an agent's proposal waits for a person: the agent may describe work, a person
   * commits it before anyone starts. Cleared by `commit`. An agent cannot take or start a
   * proposed task, which is the whole point of the field.
   */
  proposedBy?: string;
  conversation?: string;
  /** When it is due, as an ISO date or instant (INV-527). Absent means no date was given. */
  due?: string;
  /**
   * What this is waiting for, when it is not waiting for us (INV-532): a supplier, a
   * deploy window, a person on leave. Named, the task is still nudged about — somebody
   * should know it is still open — but it is never archived for not moving, because not
   * moving is what waiting looks like.
   */
  waitingOn?: string;
  /**
   * Set when this task is a goal the person stated (INV-757): the area it belongs to and what
   * they committed to. The board is the one home — `due` is the next follow-up, the aging sweep
   * is the follow-up machinery, and one open goal per area is what stops a second intake.
   */
  goal?: { area: string; commitment?: string };
  /** Leave it alone until this instant: the answer to a nudge that is "not now" (INV-532). */
  snoozeUntil?: string;
  /** How often the requester has been nudged about an overdue or idle task, and when last. */
  aging?: { nudges: number; lastNudgedAt: string; reason: "overdue" | "idle" };
  /**
   * An assignee's proposal to close (INV-529): the requester has until `decideBy` to
   * object; silence closes it, and the closing says whose proposal it was.
   */
  closeProposal?: { by: string; at: string; reason: string; decideBy: string; saw?: string };
  createdAt: string;
  updatedAt: string;
  history: TaskChange[];
  /** Recovery attempts are part of this task, never replacement tasks. */
  recoveries?: TaskRecovery[];
}

export interface TaskRecovery {
  operationId: string;
  attempt: number;
  epoch: number;
  at: string;
  status: "prepared" | "running" | "completed" | "failed";
}

/** Idle this long with no movement, a live task is nudged. */
export const TASK_IDLE_MS = envNumber("AGENTBOX_TASKS_IDLE_DAYS", 7) * 24 * 3_600_000;
/** Between nudges, and after the second, before archiving. */
export const TASK_NUDGE_GAP_MS = envNumber("AGENTBOX_TASKS_NUDGE_HOURS", 48) * 3_600_000;
export const TASK_NUDGES_BEFORE_ARCHIVE = 2;
/** How long a requester has to object to an assignee's close proposal. */
export const CLOSE_PROPOSAL_MS = envNumber("AGENTBOX_TASKS_CLOSE_PROPOSAL_HOURS", 48) * 3_600_000;
/** What a nudge offers; the answers are ordinary board moves or a reply in the thread. */
export const NUDGE_OPTIONS = ["close", "downgrade", "continue"] as const;

export type AgingEvent =
  | { kind: "nudge"; task: Task; reason: "overdue" | "idle"; nudge: number; text: string }
  | { kind: "archived"; task: Task; text: string }
  | { kind: "closed"; task: Task; text: string };

export const AGING_ACTOR = "aging";

/** How long a task must have existed before its assignee may put a close clock on it. */
export const CLOSE_PROPOSAL_MIN_AGE_MS = 24 * 3_600_000;

/** What a close proposal was about: the fields whose change makes it a different question. */
function fingerprint(task: Task): string {
  return [task.title, task.status, task.due ?? "", task.assigneeId ?? "", task.reviewerId ?? "", task.description ?? ""].join("\u0000");
}

function describeAge(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours < 2 ? `${Math.max(1, Math.round(ms / 60_000))} minutes` : `${hours} hours`;
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

/** A due date as stored: an ISO instant, from a date or an instant; nothing for anything else. */
export function dueOf(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T23:59:59Z` : text);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

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

  /**
   * A person commits a proposed task: from then on it is ordinary work anyone may take.
   * Returns undefined for an unknown id, false when there was nothing to commit.
   */
  commit(id: string, by: string, now: Date = new Date()): boolean | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    if (task.proposedBy === undefined) return false;
    const at = now.toISOString();
    const change: TaskChange = { at, by, note: `committed by ${by}` };
    const next: Task = { ...task, updatedAt: at, history: [...task.history, change].slice(-HISTORY_LIMIT) };
    delete next.proposedBy;
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    for (const listener of this.listeners) listener(next);
    return true;
  }

  onChange(listener: (task: Task) => void): void {
    this.listeners.push(listener);
  }

  constructor(
    private readonly path: string | null = tasksPath(),
    private readonly onWarn: (message: string) => void = () => {},
    /**
     * Where a judgement about a task is written down when it is made (INV-551).
     *
     * The board's own history is capped at the last changes and shaped for reading a
     * story; "why was this closed" has to survive past that, and has to be findable by
     * subject rather than by scrolling.
     */
    private readonly receipts: Receipts = new Receipts(null)
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
    return task === undefined ? undefined : {
      ...task,
      history: [...task.history],
      ...(task.recoveries !== undefined ? { recoveries: task.recoveries.map(item => ({ ...item })) } : {}),
    };
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
    sourceMessageId?: string;
    assigneeId?: string;
    reviewerId?: string;
    conversation?: string;
    contract?: TaskContract;
    /** The agent proposing, when a person has yet to commit the work. */
    proposedBy?: string;
    due?: string;
    goal?: { area: string; commitment?: string };
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
      ...(input.sourceMessageId !== undefined ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.reviewerId !== undefined ? { reviewerId: input.reviewerId } : {}),
      ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
      ...(input.contract !== undefined ? { contract: input.contract } : {}),
      ...(input.proposedBy !== undefined ? { proposedBy: input.proposedBy } : {}),
      ...(dueOf(input.due) !== undefined ? { due: dueOf(input.due)! } : {}),
      ...(input.goal !== undefined && input.goal.area.trim() !== ""
        ? { goal: { area: input.goal.area.trim().slice(0, 80), ...(input.goal.commitment?.trim() ? { commitment: input.goal.commitment.trim().slice(0, 500) } : {}) } }
        : {}),
      createdAt: at,
      updatedAt: at,
      history: [{ at, by: input.requester, status: "open", note: input.proposedBy !== undefined ? "proposed, awaiting a person's commit" : "created" }],
    };
    this.tasks.set(task.id, task);
    this.append({ kind: "task", task });
    return this.get(task.id);
  }

  /** Prepare one idempotent recovery attempt on the existing task. */
  prepareRecovery(id: string, operationId: string, epoch: number, by: string, now = new Date()): TaskRecovery | undefined {
    const task = this.tasks.get(id);
    if (task === undefined) return undefined;
    const existing = task.recoveries?.find(item => item.operationId === operationId);
    if (existing !== undefined) return existing;
    const recovery: TaskRecovery = {
      operationId,
      attempt: (task.recoveries?.at(-1)?.attempt ?? 0) + 1,
      epoch,
      at: now.toISOString(),
      status: "prepared",
    };
    const change: TaskChange = { at: recovery.at, by, note: `recovery attempt ${recovery.attempt} prepared in context ${epoch}` };
    const next: Task = {
      ...task,
      recoveries: [...(task.recoveries ?? []), recovery].slice(-20),
      updatedAt: recovery.at,
      history: [...task.history, change].slice(-HISTORY_LIMIT),
    };
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    for (const listener of this.listeners) listener(next);
    return recovery;
  }

  setRecoveryStatus(id: string, operationId: string, status: TaskRecovery["status"], by: string, now = new Date()): TaskRecovery | undefined {
    const task = this.tasks.get(id);
    const current = task?.recoveries?.find(item => item.operationId === operationId);
    if (task === undefined || current === undefined) return undefined;
    if (current.status === status) return current;
    const allowed = current.status === "prepared"
      ? status === "running" || status === "failed"
      : current.status === "running"
        ? status === "completed" || status === "failed"
        : false;
    if (!allowed) return undefined;
    const at = now.toISOString();
    const recovery = { ...current, status };
    const next: Task = {
      ...task,
      ...(status === "running" ? { status: "doing" as const } : {}),
      recoveries: task.recoveries!.map(item => item.operationId === operationId ? recovery : item),
      updatedAt: at,
      history: [...task.history, { at, by, ...(status === "running" ? { status: "doing" as const } : {}), note: `recovery attempt ${current.attempt} ${status}` }].slice(-HISTORY_LIMIT),
    };
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    for (const listener of this.listeners) listener(next);
    return recovery;
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
      options?: string[];
      checked?: string[];
      evidence?: string[];
      /** A due date, or null to clear it. */
      due?: string | null;
      /** What it is waiting for outside this box, or null to say it no longer is. */
      waitingOn?: string | null;
      /** Leave it alone until this date or instant, or null to look again now. */
      snoozeUntil?: string | null;
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

    // A proposal is not work yet: nobody starts it until a person commits it. Redirected
    // rather than refused, like the review gate, so the caller learns the rule from the
    // board rather than from an error it might retry.
    if (
      task.proposedBy !== undefined &&
      (status === "doing" || status === "review" || status === "done") &&
      !HARNESS_ACTORS.has(by)
    ) {
      status = undefined;
      coerced =
        `${task.id} is a proposal awaiting a person's commit, so it cannot be started or finished ` +
        `yet. Ask the person to commit it (the board has a Commit button), then take it.`;
    }

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
    } else if (status === "dropped" && by !== task.requester && by !== task.reviewerId && by !== AGING_ACTOR && !HARNESS_ACTORS.has(by)) {
      // Dropping is ending the work too, and it was never gated (INV-531). docs/51 says
      // "an agent does not archive; it proposes and the proposal is answerable" — but the
      // only checked terminal status was `done`, so any agent could drop any task on the
      // board, including one it had nothing to do with, with no proposal and no window to
      // object. The assignee's way to end work it believes is moot is `propose_close`.
      status = undefined;
      coerced =
        `Only ${task.requester}${task.reviewerId !== undefined ? ` or ${task.reviewerId}` : ""} can drop this task, so it has not moved. ` +
        `If you believe it should close, propose it with a reason — ${task.requester} has ${Math.round(CLOSE_PROPOSAL_MS / 3_600_000)} hours to object and silence closes it.`;
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
      // Options ride only on a blocked move with a note to answer: anywhere else they
      // would be buttons under nothing.
      ...(status === "blocked" &&
      changes.options !== undefined &&
      changes.options.length > 0 &&
      changes.note !== undefined &&
      changes.note.trim() !== ""
        ? { options: changes.options.map(option => option.trim().slice(0, 80)).filter(o => o !== "").slice(0, 6) }
        : {}),
      ...(changes.evidence !== undefined && changes.evidence.length > 0
        ? { evidence: changes.evidence.map(line => line.trim().slice(0, 300)).filter(l => l !== "").slice(0, 6) }
        : {}),
      ...(status === "done" && changes.checked !== undefined && changes.checked.length > 0
        ? { checked: changes.checked.map(line => line.slice(0, 120)).slice(0, 12) }
        : {}),
      ...(run !== undefined ? { run } : {}),
    };
    if (change.note === undefined) {
      // A snooze or a waiting-on with nothing else said is still a decision about the
      // work, and the history is where a person looks to see who decided it (INV-532).
      if (changes.snoozeUntil !== undefined && changes.snoozeUntil !== null) change.note = `not now: look again after ${dueOf(changes.snoozeUntil) ?? changes.snoozeUntil}`;
      else if (changes.waitingOn !== undefined && changes.waitingOn !== null && changes.waitingOn.trim() !== "") change.note = `waiting on ${changes.waitingOn.trim().slice(0, 120)}`;
    }

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
      ...(changes.due !== undefined ? (changes.due === null ? { due: undefined } : dueOf(changes.due) !== undefined ? { due: dueOf(changes.due)! } : {}) : {}),
      ...(changes.waitingOn !== undefined ? (changes.waitingOn === null || changes.waitingOn.trim() === "" ? { waitingOn: undefined } : { waitingOn: changes.waitingOn.replace(/\s+/g, " ").trim().slice(0, 120) }) : {}),
      ...(changes.snoozeUntil !== undefined ? (changes.snoozeUntil === null ? { snoozeUntil: undefined } : dueOf(changes.snoozeUntil) !== undefined ? { snoozeUntil: dueOf(changes.snoozeUntil)! } : {}) : {}),
      updatedAt: at,
      history: [...task.history, change].slice(-HISTORY_LIMIT),
    };
    // Movement by anyone but the ageing sweep answers the nudge: the count starts over —
    // and so does the clock (INV-535). Deleting the whole record let a person who typed
    // "continue" on an overdue card be nudged again an hour later, because the card was
    // still overdue and nothing remembered that they had just answered.
    if (by !== AGING_ACTOR && updated.aging !== undefined) updated.aging = { nudges: 0, lastNudgedAt: at, reason: updated.aging.reason };
    // Any move by the requester while a close is proposed is their answer to it.
    if (updated.closeProposal !== undefined && by === task.requester) delete updated.closeProposal;

    this.tasks.set(id, updated);
    this.append({ kind: "task", task: updated });
    if (this.lines > COMPACT_AT) this.compact(now);
    const result = { task: this.get(id)!, ...(coerced !== undefined ? { coerced } : {}) };
    for (const listener of this.listeners) listener(result.task);
    return result;
  }

  /**
   * The ageing sweep (INV-527): a live task past its due date, or idle for a week, gets
   * its requester nudged — close, downgrade, or continue — at most once per gap; after
   * two nudges with no movement it is archived as dropped, with the history saying why.
   * Movement by anyone resets the count. Run daily by the host; idempotent within a gap.
   *
   * A nudge here is a *proposal to say something*, not a fact: the count advances only
   * when the caller confirms with `recordNudge` that the line reached a person (INV-530).
   * The first version counted before delivery, and the delivery it counted was routed by
   * string equality to an address that never matched a Feishu room — so two nudges nobody
   * received archived the work, silently, which is the exact failure the sweep exists to
   * prevent. Undeliverable means uncounted; the sweep proposes it again next hour.
   */
  age(now: Date = new Date()): AgingEvent[] {
    const events: AgingEvent[] = [];
    const t = now.getTime();
    for (const task of [...this.tasks.values()]) {
      if (!isLive(task.status) || task.proposedBy !== undefined) continue;
      // Asked to come back later, and told when. Until then there is nothing to say.
      if (task.snoozeUntil !== undefined && Date.parse(task.snoozeUntil) > t) continue;
      // A close proposal is already a clock with a person's answer at the end of it;
      // nudging in parallel asks the same question twice in two voices (INV-532).
      if (task.closeProposal !== undefined) continue;
      const overdue = task.due !== undefined && Date.parse(task.due) < t;
      const idle = t - Date.parse(task.updatedAt) >= TASK_IDLE_MS;
      if (!overdue && !idle) continue;
      const since = task.aging === undefined ? Infinity : t - Date.parse(task.aging.lastNudgedAt);
      if (since < TASK_NUDGE_GAP_MS) continue;
      const reason: "overdue" | "idle" = overdue ? "overdue" : "idle";
      const nudges = (task.aging?.nudges ?? 0) + 1;
      // What may be archived for not moving, and what may only be asked about (INV-532).
      // `blocked` and `review` are somebody else's turn; `waitingOn` names an outside
      // party; a date still ahead means nothing is late. Archiving those reads a person's
      // holiday, a supplier's month-end, or a reviewer's queue as an abandoned request —
      // which contradicts the rule the sweep is written under: silence is never consent
      // to close work. They are nudged up to the cap and then go quiet, still open.
      const archivable =
        (task.status === "open" || task.status === "doing") &&
        task.waitingOn === undefined &&
        (overdue || task.due === undefined);
      if (nudges > TASK_NUDGES_BEFORE_ARCHIVE && !archivable) continue;
      if (nudges > TASK_NUDGES_BEFORE_ARCHIVE) {
        const text = `${task.id} "${task.title}" was archived: ${reason} and no movement after ${TASK_NUDGES_BEFORE_ARCHIVE} nudges. Reopen it on the board if it still matters.`;
        const moved = this.update(task.id, { status: "dropped", note: `archived by ageing: ${reason}, no answer to ${TASK_NUDGES_BEFORE_ARCHIVE} nudges` }, AGING_ACTOR, undefined, now);
        if (moved !== undefined) {
          events.push({ kind: "archived", task: moved.task, text });
          this.receipts.write({
            at: now.toISOString(),
            by: AGING_ACTOR,
            subject: `task:${task.id}`,
            decision: `archived "${task.title}"`,
            because: `${reason} and no movement after ${TASK_NUDGES_BEFORE_ARCHIVE} delivered nudges`,
            evidence: [`requester:${task.requester}`, ...(task.due !== undefined ? [`due:${task.due}`] : [])],
          });
        }
        continue;
      }
      const waiting = task.waitingOn !== undefined ? ` (waiting on ${task.waitingOn})` : task.status === "blocked" || task.status === "review" ? ` (${task.status})` : "";
      const text =
        `${task.id} "${task.title}"${waiting} is ${reason === "overdue" ? `overdue (due ${task.due})` : `idle: nothing has moved for ${Math.round((t - Date.parse(task.updatedAt)) / 86_400_000)} days`}` +
        ` — nudge ${nudges} of ${TASK_NUDGES_BEFORE_ARCHIVE}. ${NUDGE_OPTIONS.join(" / ")}? Move it on the board or answer here; ` +
        (archivable
          ? `with no answer it is archived after the next nudge.`
          : `it stays open either way — say when to look again and it goes quiet until then.`);
      events.push({ kind: "nudge", task, reason, nudge: nudges, text });
    }
    return events;
  }

  /**
   * The nudge reached somebody: count it (INV-530). Called after the line was delivered —
   * pushed to the chat the task came from, or shown on the board for a task that came
   * from no chat. Refuses a second count within the gap, so a double delivery is one
   * nudge, and refuses anything the task has moved past.
   */
  recordNudge(id: string, reason: "overdue" | "idle", now: Date = new Date()): Task | undefined {
    const task = this.tasks.get(id);
    if (task === undefined || !isLive(task.status)) return undefined;
    const t = now.getTime();
    if (task.aging !== undefined && t - Date.parse(task.aging.lastNudgedAt) < TASK_NUDGE_GAP_MS) return undefined;
    const at = now.toISOString();
    const nudges = (task.aging?.nudges ?? 0) + 1;
    const next: Task = { ...task, aging: { nudges, lastNudgedAt: at, reason }, history: [...task.history, { at, by: AGING_ACTOR, note: `nudge ${nudges}/${TASK_NUDGES_BEFORE_ARCHIVE}: ${reason}` }].slice(-HISTORY_LIMIT) };
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    for (const listener of this.listeners) listener(next);
    return this.get(id)!;
  }

  /**
   * An assignee proposes closing (INV-529): the requester has CLOSE_PROPOSAL_MS to object;
   * their silence closes it. The one who asked for the work is not asked to do the
   * bookkeeping, and the one who can judge it is not made to wait for a verdict nobody gives.
   */
  proposeClose(id: string, by: string, reason: string, now: Date = new Date()): { task: Task } | { refused: string } {
    const task = this.tasks.get(id);
    if (task === undefined) return { refused: `No task ${id}.` };
    if (!isLive(task.status)) return { refused: `${id} is already ${task.status}.` };
    if (by === task.requester) return { refused: `${id} is your own request; drop it directly instead of proposing.` };
    // Only the one doing the work may propose that it stop (INV-531). The first version
    // refused the requester and nobody else, so any agent on the box could put a 48-hour
    // clock on somebody else's task and close it by their silence.
    if (!HARNESS_ACTORS.has(by) && by !== task.assigneeId) {
      return { refused: `${id} is ${task.assigneeId === undefined ? "nobody's" : `${task.assigneeId}'s`} work; only whoever is doing it can propose closing it.` };
    }
    // And not before the requester has plausibly seen it. A card proposed for closing
    // hours after it was asked for closes on the silence of somebody who has not looked
    // at the board yet, which is not the silence this rule was written about.
    if (now.getTime() - Date.parse(task.createdAt) < CLOSE_PROPOSAL_MIN_AGE_MS) {
      return { refused: `${id} was only asked for ${describeAge(now.getTime() - Date.parse(task.createdAt))} ago; say what you found and let ${task.requester} answer before proposing to close it.` };
    }
    const why = reason.trim().slice(0, 300);
    if (why === "") return { refused: "A close proposal needs a reason the requester can read." };
    const at = now.toISOString();
    const decideBy = new Date(now.getTime() + CLOSE_PROPOSAL_MS).toISOString();
    const next: Task = { ...task, closeProposal: { by, at, reason: why, decideBy, saw: fingerprint(task) }, updatedAt: at, history: [...task.history, { at, by, note: `proposed to close: ${why} (closes ${decideBy} unless ${task.requester} objects)` }].slice(-HISTORY_LIMIT) };
    if (next.aging !== undefined) delete next.aging;
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    this.receipts.write({
      at,
      by,
      subject: `task:${id}`,
      decision: `proposed to close "${task.title}"`,
      because: why,
      evidence: [`decideBy:${decideBy}`, `requester:${task.requester}`],
    });
    for (const listener of this.listeners) listener(next);
    return { task: this.get(id)! };
  }

  /** The requester (or a harness actor for them) says no: the proposal is gone, the task stays. */
  opposeClose(id: string, by: string, note?: string, now: Date = new Date()): { task: Task } | { refused: string } {
    const task = this.tasks.get(id);
    if (task === undefined) return { refused: `No task ${id}.` };
    if (task.closeProposal === undefined) return { refused: `${id} has no close proposal to object to.` };
    if (by !== task.requester && !HARNESS_ACTORS.has(by) && by !== task.reviewerId) return { refused: `Only ${task.requester}${task.reviewerId !== undefined ? ` or ${task.reviewerId}` : ""} can object to closing ${id}.` };
    const at = now.toISOString();
    const next: Task = { ...task, updatedAt: at, history: [...task.history, { at, by, note: `objected to closing${note !== undefined && note.trim() !== "" ? `: ${note.trim().slice(0, 300)}` : ""}` }].slice(-HISTORY_LIMIT) };
    delete next.closeProposal;
    this.tasks.set(id, next);
    this.append({ kind: "task", task: next });
    for (const listener of this.listeners) listener(next);
    return { task: this.get(id)! };
  }

  /** Close proposals whose window passed with no objection: closed as dropped, saying whose proposal it was. */
  settleCloseProposals(now: Date = new Date()): AgingEvent[] {
    const events: AgingEvent[] = [];
    for (const task of [...this.tasks.values()]) {
      const proposal = task.closeProposal;
      if (proposal === undefined || !isLive(task.status) || Date.parse(proposal.decideBy) > now.getTime()) continue;
      // The proposal was about the task as it stood. Anyone moving the due date, handing
      // it to somebody else, or rewriting what it is has answered it — by changing the
      // question (INV-531). Only the requester's edits used to clear a proposal, so a
      // reviewer pushing the date to next month still had it closed on the old clock.
      if (proposal.saw !== undefined && proposal.saw !== fingerprint(task)) {
        const at = now.toISOString();
        const stale: Task = { ...task, updatedAt: at, history: [...task.history, { at, by: AGING_ACTOR, note: `close proposal dropped: ${task.id} changed after ${proposal.by} proposed it` }].slice(-HISTORY_LIMIT) };
        delete stale.closeProposal;
        this.tasks.set(task.id, stale);
        this.append({ kind: "task", task: stale });
        continue;
      }
      const moved = this.update(task.id, { status: "dropped", note: `closed as ${proposal.by} proposed (${proposal.reason}); ${task.requester} did not object by ${proposal.decideBy}` }, AGING_ACTOR, undefined, now);
      if (moved === undefined) continue;
      const settled: Task = { ...moved.task };
      delete settled.closeProposal;
      this.tasks.set(task.id, settled);
      this.append({ kind: "task", task: settled });
      events.push({ kind: "closed", task: this.get(task.id)!, text: `${task.id} "${task.title}" closed as ${proposal.by} proposed: ${proposal.reason}. ${task.requester} did not object in time; reopen it on the board if that was wrong.` });
      this.receipts.write({
        at: now.toISOString(),
        by: AGING_ACTOR,
        subject: `task:${task.id}`,
        decision: `closed "${task.title}" on ${proposal.by}'s proposal`,
        because: `${proposal.reason}; ${task.requester} did not object by ${proposal.decideBy}`,
        evidence: [`proposedBy:${proposal.by}`, `decideBy:${proposal.decideBy}`],
      });
    }
    return events;
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

  /** The live goal in an area, if there is one: what a second "I want to…" should follow up rather than restart. */
  openGoalIn(area: string): Task | undefined {
    const wanted = area.trim().toLowerCase();
    return [...this.tasks.values()].find(task => task.goal !== undefined && isLive(task.status) && task.goal.area.toLowerCase() === wanted);
  }

  /**
   * Every task that mentions a phrase, with the phrase replaced wherever it appears — title,
   * description, contract, history (INV-757). Then the file is rewritten as one snapshot per task,
   * so the earlier snapshots that held the wording go too. Returns how many tasks changed.
   */
  scrub(phrase: string, replacement = "[forgotten]", now = new Date()): number {
    const pattern = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const scrubValue = (value: unknown): unknown => {
      if (typeof value === "string") return value.replace(pattern, replacement);
      if (Array.isArray(value)) return value.map(scrubValue);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrubValue(inner)]));
      }
      return value;
    };
    let changed = 0;
    for (const [id, task] of this.tasks) {
      const before = JSON.stringify(task);
      if (!before.toLowerCase().includes(phrase.toLowerCase())) continue;
      this.tasks.set(id, scrubValue(task) as Task);
      changed += 1;
    }
    // Compacted whenever the file still holds the phrase, not only when a current task did: an
    // earlier snapshot of a task since renamed is exactly where old wording survives.
    const fileHolds = this.path !== null && existsSync(this.path) && readFileSync(this.path, "utf8").toLowerCase().includes(phrase.toLowerCase());
    if (changed > 0 || fileHolds) this.compact(now);
    return changed;
  }

  /** Whether the board's file still holds a phrase anywhere, snapshots included: the verification's check. */
  fileMentions(phrase: string): boolean {
    return this.path !== null && existsSync(this.path) && readFileSync(this.path, "utf8").toLowerCase().includes(phrase.toLowerCase());
  }

  /** How many tasks mention a phrase, current wording only: the plan's count. */
  mentioning(phrase: string): number {
    const needle = phrase.toLowerCase();
    return [...this.tasks.values()].filter(task => JSON.stringify(task).toLowerCase().includes(needle)).length;
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
  const proposed = task.proposedBy !== undefined ? " (proposed — a person commits it before anyone starts)" : "";
  const goal = task.goal !== undefined ? ` · goal (${task.goal.area}${task.goal.commitment !== undefined ? `: ${task.goal.commitment}` : ""})` : "";
  return `${task.id} [${task.status}]${assignee} ${task.title}${goal}${reviewer}${proposed}`;
}
