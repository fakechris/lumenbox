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
import type { WatchedQuestion } from "./question-expiry.ts"; import { agentCaseText, questionLeanText } from "./consent-case.ts";
import { describeStale } from "./mandate.ts";
import { currentFlag } from "./task-flag.ts";
import { claimedButNotDelivered } from "./task-deliverables.ts";
import { DOCKER_WORK } from "./box-paths.ts"; import { openBlockers } from "./task-deps.ts";
import { STAGE_LABEL, stageWorldOf, type TaskStage, taskStage } from "./task-stage.ts";

export interface AttentionItem {
  kind: "approval" | "question" | "close-proposal" | "review" | "nudged" | "waiting" | "unanswered" | "paused" | "reauthorize" | "undeliverable" | "flagged" | "box-update" | "boundary-probe" | "provider-resting" | "team-memory" | "spend-limit" | "routine-paused" | "org-knowledge" | "exception";
  /** What to open: a task id, or the conversation a question was asked in. */
  ref: string;
  title: string;
  /** One line a person can act on without opening anything. */
  detail: string;
  /** Whether the person's answer changes what happens next (INV-1647); set where the list is assembled. */
  decision?: boolean;
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
  /** The work directory of an agent's box (`workDir`, box-paths.ts): where the files its submission names are (INV-1737). The image's when not given. */
  workOf?: (agentId: string) => string;
  /** The agents (INV-1647): a task an agent reviews is the team's to settle, not the person's. */
  agentIds?: ReadonlySet<string>;
  /** Pending approvals, the most common block (INV-1622/1627): one item each, answered from the strip. */
  approvals?: readonly { id: string; agentId: string; agentName: string; description: string; action?: string; requestedAt: string; why?: string; taskLevel?: number }[];
  /** Teammate chains the bus stopped (INV-1277): shown to everyone, since no person is in them by definition. */
  paused?: readonly { fromName: string; toName: string; hops: number; at: string; fromId: string }[];
  /** Failures a person took on with Hand to me (INV-1741): theirs to settle — retry, fix or dismiss — from the Issues view. */
  exceptionsHanded?: readonly { id: string; kind: string; subject: string; reason: string; attempt: number; task?: string; handedBy?: string }[];
  /** Routines the host stopped (INV-1665): failing K times in a row is one reason. Everyone's, since a person must turn it back on. */
  routinesHeld?: readonly { slug: string; name: string; at: string; by: string; code: string; reason: string }[];
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

/** What goes first on the strip: a parked command and a question with a clock, then the rest (INV-1627). */
/**
 * A decision is an item where the person's answer changes what happens next; a notice is
 * something they may want to know (INV-1647). Only decisions reach the strip and the OS: a
 * channel that carries everything carries nothing.
 */
export const DECISION_KINDS: ReadonlySet<AttentionItem["kind"]> = new Set(["approval", "question", "close-proposal", "reauthorize", "spend-limit", "paused", "routine-paused", "org-knowledge", "exception"]); // org-knowledge: an item its owner must re-verify, supersede or retract (INV-1731); a review is the board's, folded to one line in the strip: five of them once hid the agents
export const isDecision = (kind: AttentionItem["kind"]): boolean => DECISION_KINDS.has(kind);

export function urgencyOf(kind: AttentionItem["kind"]): number {
  return kind === "approval" ? 0 : kind === "question" ? 1 : kind === "spend-limit" || kind === "paused" || kind === "routine-paused" ? 2 : 3;
}

export function attentionFor(input: AttentionInput): Attention {
  const now = (input.now ?? new Date()).getTime();
  const mine: AttentionItem[] = [];
  const theirs: AttentionItem[] = [];
  const isMe = (id: string | undefined): boolean =>
    input.all === true || (id !== undefined && (id === input.principalId || input.identities.includes(id)));

  // A command waiting for consent: the agent is parked until a person answers, so it goes first.
  for (const approval of input.approvals ?? []) {
    mine.push({
      kind: "approval",
      ref: approval.id,
      title: `${approval.agentName || input.nameOf(approval.agentId)} ${approval.action !== undefined ? `wants to ${approval.action}` : "needs your consent"}`, // the ledger replays an approval without its agent's name
      detail: `${approval.description.replace(/\s+/g, " ").slice(0, 160)} · asked ${approval.requestedAt.slice(0, 16).replace("T", " ")}Z${approval.taskLevel !== undefined ? ` · task L${approval.taskLevel}` : ""}${agentCaseText(approval.agentName || input.nameOf(approval.agentId), approval.why) !== undefined ? ` · ${agentCaseText(approval.agentName || input.nameOf(approval.agentId), approval.why)}` : ""}`, // the background and the agent's claim (INV-1651)
      with: approval.agentName || input.nameOf(approval.agentId),
    });
  }

  // A question with my name on it. The default and the deadline travel with it, because
  // "answer this or it decides for you" is the whole point of the clock (INV-526/533).
  for (const question of input.questions) {
    if (question.asker !== undefined && !isMe(question.asker)) continue;
    mine.push({
      kind: "question",
      ref: question.conversation,
      title: question.question,
      detail:
        (question.fallback !== undefined
          ? `${question.agentName} is waiting; with no answer it goes with: ${question.fallback}`
          : `${question.agentName} is waiting; with no answer it decides and says which way`) + (questionLeanText(question.agentName, question.recommended) !== undefined ? ` · ${questionLeanText(question.agentName, question.recommended)}` : ""), // INV-1651
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

  // A routine the host stopped: nothing runs again until a person resumes it, which is one click.
  for (const held of input.routinesHeld ?? []) {
    mine.push({ kind: "routine-paused", ref: held.slug, title: `Routine ${held.name} is paused: ${held.reason}`, detail: `Paused ${held.at.slice(0, 16).replace("T", " ")}Z; fix the cause, then resume it — its failure count starts again.` });
  }

  // A failure handed to a person (INV-1741): one decision each, retried or dismissed from where it is listed.
  for (const entry of input.exceptionsHanded ?? []) {
    mine.push({ kind: "exception", ref: entry.id, title: `${entry.task !== undefined ? `${entry.task}: ` : ""}${entry.kind} failed ${entry.attempt} time${entry.attempt === 1 ? "" : "s"}: ${entry.subject.slice(0, 80)}`, detail: `${entry.reason}${entry.handedBy !== undefined ? ` · handed to ${entry.handedBy}` : ""}; retry it or dismiss it in Issues` });
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
  const undeliverableChats = new Set((input.undeliverable ?? []).map(receipt => receipt.chatKey)); const byId = new Map(input.tasks.map(task => [task.id, task])); // byId: the blockers a waiting row names (INV-1740)
  for (const task of input.tasks) {
    if (!isLive(task)) continue;
    stages[task.id] = taskStage(task, stageWorldOf(task, { undeliverableChats, questions: input.questions, ...(input.agentIds !== undefined ? { agentIds: input.agentIds } : {}), ...(input.chatKeyOf !== undefined ? { chatKeyOf: input.chatKeyOf } : {}), ...(input.active !== undefined ? { active: input.active } : {}) }));
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
    if (task.status === "review" && isMe(task.reviewerId) && !(task.reviewerId !== undefined && input.agentIds?.has(task.reviewerId))) { // an agent reviewer settles it by the record (INV-1614/1647)
      mine.push({
        kind: "review",
        ref: task.id, stage: stages[task.id],
        title: task.title,
        detail: `${input.nameOf(task.assigneeId ?? "somebody")} says it is done and is waiting for your word.${undelivered(task, input.workOf?.(task.assigneeId ?? "") ?? DOCKER_WORK)}`,
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
            : openBlockers(task, byId).length > 0 ? `blocked by ${openBlockers(task, byId).join(", ")}` : task.status === "blocked"
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

/** The review item's warning when the submission names files and none was marked as a deliverable (INV-1663). */
function undelivered(task: Task, work: string): string {
  const named = claimedButNotDelivered(task, work);
  if (named.length === 0) return "";
  const names = named.slice(0, 3).map(path => path.split("/").pop()).join(", ");
  return ` No deliverable was marked: the submission names ${names}, but the task has no file to open.`;
}
