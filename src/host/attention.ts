/**
 * What is waiting on me, and what I am waiting on (INV-543).
 *
 * Every surface we have answers "what does the system have": a board of everyone's tasks,
 * a list of every box, a transcript per agent. None of them answers the question a person
 * actually arrives with — *what needs me?* — and the four follow-through rails (INV-526…
 * 535) have been quietly assembling the answer: a question put to somebody with a clock
 * on it, a close proposal with a window, a task whose requester has been nudged twice, a
 * review nobody has accepted.
 *
 * This is the projection of those, per person, with the deadline each one carries. Two
 * lists, because they are two different feelings: **owed by me** is work that stops if I
 * do nothing, and **owed to me** is work I am waiting on somebody else for. Nothing here
 * decides anything or hides anything: it reads the same records the board and the watch
 * already keep, filtered to one principal.
 *
 * docs/51 §3.3 cut the "unified attention ledger" down to a routine's state projection,
 * because a per-turn injection of everything open is a prompt nobody reads. This is the
 * other half of that cut — the half for people, on demand.
 */

import type { Task } from "./tasks.ts";
import type { WatchedQuestion } from "./question-expiry.ts";
import { describeStale } from "./mandate.ts";
import { currentFlag } from "./task-flag.ts";
import { STAGE_LABEL, stageWorldOf, type TaskStage, taskStage } from "./task-stage.ts";

export interface AttentionItem {
  kind: "question" | "close-proposal" | "review" | "nudged" | "waiting" | "unanswered" | "paused" | "reauthorize" | "undeliverable" | "flagged" | "box-update" | "boundary-probe" | "provider-resting" | "team-memory" | "spend-limit";
  /** What to open: a task id, or the conversation a question was asked in. */
  ref: string;
  title: string;
  /** One line a person can act on without opening anything. */
  detail: string;
  /** When the clock runs out, if it does. */
  deadline?: string;
  /** Which agent or person this is with. */
  with?: string;
  /** The task's stage by the table in task-stage.ts (INV-1464), on items that are about a task. */
  stage?: TaskStage;
}

export interface Attention {
  /** Every live task's stage by the table (INV-1464), whoever it is with. */
  stages: Record<string, TaskStage>;
  /** Waiting on me: nothing moves until I answer. */
  mine: AttentionItem[];
  /** Waiting on somebody else, for me. */
  theirs: AttentionItem[];
}

export interface AttentionInput {
  principalId: string;
  /** Every identity this person speaks from, so a question asked in Feishu is theirs on the web. */
  identities: readonly string[];
  tasks: readonly Task[];
  questions: readonly WatchedQuestion[];
  nameOf: (id: string) => string;
  /**
   * Questions put to one of our agents on a work item that got no answer (INV-556). Shown
   * to the operator only: the person who asked is an actor over there, and mapping them
   * onto a principal here is INV-575. Until then, "somebody asked and nobody answered" is
   * the installation's problem, and hiding it from the one caller who can act on it would
   * be a strange kind of privacy.
   */
  unanswered?: readonly { work: string; agent: string; detail: string; deadline?: string }[];
  /** Teammate chains the bus stopped (INV-1277): shown to everyone, since no person is in them by definition. */
  paused?: readonly { fromName: string; toName: string; hops: number; at: string; fromId: string }[];
  /**
   * No person: the installation's own credential, which is the operator. They get
   * everything with a clock on it rather than nothing — an empty page for the one caller
   * who can act on all of it would be a strange kind of privacy.
   */
  /** Messages the host could not get into a chat after its retries (INV-1460): everyone's, since no person is in them yet. */
  undeliverable?: readonly { id: string; chatKey: string; purpose: string; attempts: number; lastError?: string }[];
  /** The chat a task's conversation delivers to, so an undeliverable message is matched to its task (INV-1464). */
  chatKeyOf?: (conversation: string) => string | undefined;
  /** Whether something of this task runs right now: the assignee's turn in its conversation, or a command it let go of. */
  active?: (task: Task) => boolean;
  all?: boolean;
  now?: Date;
}

const isLive = (task: Task): boolean => task.status !== "done" && task.status !== "dropped";

export function attentionFor(input: AttentionInput): Attention {
  const now = (input.now ?? new Date()).getTime();
  const mine: AttentionItem[] = [];
  const theirs: AttentionItem[] = [];
  const isMe = (id: string | undefined): boolean =>
    input.all === true || (id !== undefined && (id === input.principalId || input.identities.includes(id)));

  // A question with my name on it. The default and the deadline travel with it, because
  // "answer this or it decides for you" is the whole point of the clock (INV-526/533).
  for (const question of input.questions) {
    if (question.asker !== undefined && !isMe(question.asker)) continue;
    mine.push({
      kind: "question",
      ref: question.conversation,
      title: question.question,
      detail:
        question.fallback !== undefined
          ? `${question.agentName} is waiting; with no answer it goes with: ${question.fallback}`
          : `${question.agentName} is waiting; with no answer it decides and says which way`,
      deadline: new Date(question.expiresAt).toISOString(),
      with: question.agentName,
    });
  }

  // A chain the budget stopped: two agents were talking past the limit with nobody in the
  // loop. Anyone can bring a person back in by speaking to either of them.
  for (const chain of input.paused ?? []) {
    mine.push({
      kind: "paused",
      ref: chain.fromId,
      title: `${chain.fromName} ↔ ${chain.toName}: paused after ${chain.hops} turns with no person`,
      detail: `${chain.fromName} wanted to message ${chain.toName} again; message either of them to decide`,
      with: chain.fromName,
    });
  }

  for (const receipt of input.undeliverable ?? []) {
    mine.push({
      kind: "undeliverable",
      ref: receipt.chatKey,
      title: `${receipt.chatKey}: ${receipt.purpose} not delivered`,
      detail: `${receipt.attempts} attempts${receipt.lastError !== undefined ? `; last: ${receipt.lastError}` : ""}; check the door, or the message stays pending`,
    });
  }

  for (const entry of input.all === true ? (input.unanswered ?? []) : []) {
    mine.push({
      kind: "unanswered",
      ref: entry.work,
      title: `${entry.work}: nobody answered`,
      detail: entry.detail,
      ...(entry.deadline !== undefined ? { deadline: entry.deadline } : {}),
      with: entry.agent,
    });
  }

  // The stage of every live task, by the one table (INV-1464): what each item below says is
  // worded from it, and the first screen counts the person/* rows.
  const stages: Record<string, TaskStage> = {};
  const undeliverableChats = new Set((input.undeliverable ?? []).map(receipt => receipt.chatKey));
  for (const task of input.tasks) {
    if (!isLive(task)) continue;
    stages[task.id] = taskStage(task, stageWorldOf(task, { undeliverableChats, questions: input.questions, ...(input.chatKeyOf !== undefined ? { chatKeyOf: input.chatKeyOf } : {}), ...(input.active !== undefined ? { active: input.active } : {}) }));
  }
  for (const task of input.tasks) {
    if (!isLive(task)) continue;
    // A wake the mandate refused (INV-1457): the work waits for the person whose word it was.
    const stale = task.mandate?.stale;
    if (stale !== undefined && task.mandate?.withdrawn === undefined && isMe(task.mandate?.by ?? task.requester)) {
      mine.push({
        kind: "reauthorize",
        ref: task.id, stage: stages[task.id],
        title: `${task.id}: needs re-authorising`,
        detail: `${describeStale(stale.reasons)}; reply on it to continue, or stop it`,
        ...(task.assigneeId !== undefined ? { with: input.nameOf(task.assigneeId) } : {}),
      });
    }
    // A supervisor said a person should look (INV-1509): the requester's, and the one who raised it sees it too.
    const flag = currentFlag(task);
    if (flag !== undefined && (isMe(task.requester) || isMe(flag.by))) {
      mine.push({
        kind: "flagged",
        ref: task.id, stage: stages[task.id],
        title: `${task.id}: ${task.title}`,
        detail: `${input.nameOf(flag.by)} flagged it: ${flag.note}`,
        ...(task.assigneeId !== undefined ? { with: input.nameOf(task.assigneeId) } : {}),
      });
    }
    const proposal = task.closeProposal;
    if (proposal !== undefined && isMe(task.requester)) {
      mine.push({
        kind: "close-proposal",
        ref: task.id, stage: stages[task.id],
        title: task.title,
        detail: `${input.nameOf(proposal.by)} proposes closing it: ${proposal.reason}. Say nothing and it closes.`,
        deadline: proposal.decideBy,
        with: input.nameOf(proposal.by),
      });
      continue;
    }
    if (task.status === "review" && isMe(task.reviewerId)) {
      mine.push({
        kind: "review",
        ref: task.id, stage: stages[task.id],
        title: task.title,
        detail: `${input.nameOf(task.assigneeId ?? "somebody")} says it is done and is waiting for your word.`,
        ...(task.due !== undefined ? { deadline: task.due } : {}),
        with: input.nameOf(task.assigneeId ?? ""),
      });
      continue;
    }
    if (task.aging !== undefined && isMe(task.requester)) {
      mine.push({
        kind: "nudged",
        ref: task.id, stage: stages[task.id],
        title: task.title,
        detail:
          task.aging.reason === "overdue"
            ? `Overdue, and asked about ${task.aging.nudges} time(s): close it, move the date, or say carry on.`
            : `Nothing has moved for a week, asked about ${task.aging.nudges} time(s): close it or say carry on.`,
        ...(task.due !== undefined ? { deadline: task.due } : {}),
        ...(task.assigneeId !== undefined ? { with: input.nameOf(task.assigneeId) } : {}),
      });
      continue;
    }
    if (stages[task.id] === "person/answer" && task.mandate?.stale === undefined && isMe(task.requester)) {
      const last = task.history.at(-1);
      mine.push({ kind: "question", ref: task.id, stage: stages[task.id], title: task.title, detail: `${last?.note ?? "a question is pending"}${last?.options !== undefined && last.options.length > 0 ? ` — ${last.options.join(" / ")}` : ""}`, ...(task.assigneeId !== undefined ? { with: input.nameOf(task.assigneeId) } : {}) });
      continue;
    }
    if (isMe(task.requester)) {
      theirs.push({
        kind: "waiting",
        ref: task.id, stage: stages[task.id],
        title: task.title,
        detail:
          task.waitingOn !== undefined
            ? `waiting on ${task.waitingOn}`
            : task.status === "blocked"
              ? "blocked"
              : task.assigneeId === undefined
                ? "nobody has taken it"
                : `${input.nameOf(task.assigneeId)} has it (${STAGE_LABEL[stages[task.id]!]})`,
        ...(task.due !== undefined ? { deadline: task.due } : {}),
        ...(task.assigneeId !== undefined ? { with: input.nameOf(task.assigneeId) } : {}),
      });
    }
  }

  // Soonest deadline first, because that is the order a person would choose; anything
  // without one goes last, in the order the board has it.
  const byDeadline = (a: AttentionItem, b: AttentionItem): number => {
    if (a.deadline === undefined && b.deadline === undefined) return 0;
    if (a.deadline === undefined) return 1;
    if (b.deadline === undefined) return -1;
    return Date.parse(a.deadline) - Date.parse(b.deadline);
  };
  void now;
  return { stages, mine: mine.sort(byDeadline), theirs: theirs.sort(byDeadline) };
}
