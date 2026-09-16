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

export interface AttentionItem {
  kind: "question" | "close-proposal" | "review" | "nudged" | "waiting" | "unanswered";
  /** What to open: a task id, or the conversation a question was asked in. */
  ref: string;
  title: string;
  /** One line a person can act on without opening anything. */
  detail: string;
  /** When the clock runs out, if it does. */
  deadline?: string;
  /** Which agent or person this is with. */
  with?: string;
}

export interface Attention {
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
  /**
   * No person: the installation's own credential, which is the operator. They get
   * everything with a clock on it rather than nothing — an empty page for the one caller
   * who can act on all of it would be a strange kind of privacy.
   */
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

  for (const task of input.tasks) {
    if (!isLive(task)) continue;
    const proposal = task.closeProposal;
    if (proposal !== undefined && isMe(task.requester)) {
      mine.push({
        kind: "close-proposal",
        ref: task.id,
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
        ref: task.id,
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
        ref: task.id,
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
    if (isMe(task.requester)) {
      theirs.push({
        kind: "waiting",
        ref: task.id,
        title: task.title,
        detail:
          task.waitingOn !== undefined
            ? `waiting on ${task.waitingOn}`
            : task.status === "blocked"
              ? "blocked"
              : task.assigneeId === undefined
                ? "nobody has taken it"
                : `${input.nameOf(task.assigneeId)} has it`,
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
  return { mine: mine.sort(byDeadline), theirs: theirs.sort(byDeadline) };
}
