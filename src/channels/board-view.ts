/**
 * The task board as a chat reads it, in the person's language.
 *
 * The complaint this answers, verbatim: "现在有各种task,我都对应不上" — the board
 * exists, the ids exist, and from inside a chat there was no way to see them together.
 * "早报" answers "what happened today"; this answers "what is on the plate right now",
 * grouped by what a person does about each state: accept it, unblock it, wait, or
 * nothing.
 *
 * Structured view first, renderings second: Feishu draws it as a card, a plain wire
 * gets the text form, and both read the same facts. Deliberately not a model call,
 * same as the digest: a board that could hallucinate a task id would poison the one
 * place ids are read aloud. Every line is a lookup.
 */

import { isLive, type Task } from "../host/tasks.ts";

/** One task as a board line shows it. `title` is already clamped for display. */
export interface BoardTaskLine {
  id: string;
  /** The assignee's name, when there is one. */
  who?: string;
  title: string;
  url?: string;
}

export interface BoardView {
  liveCount: number;
  /** Only the non-empty groups, in triage order. */
  groups: { heading: string; tasks: BoardTaskLine[] }[];
  /** Finishes in the last 24 hours, compact. */
  done: BoardTaskLine[];
}

/** How each live status reads as a group heading, in the order a person triages. */
const GROUPS: { status: Task["status"]; heading: string }[] = [
  { status: "review", heading: "待验收" },
  { status: "blocked", heading: "卡住了" },
  { status: "doing", heading: "进行中" },
  { status: "open", heading: "排队中" },
];

export const BOARD_EMPTY = "这个群现在没有挂着的任务。";

export function boardHeadline(liveCount: number): string {
  return `看板 · ${liveCount} 件在办`;
}

/**
 * A title as a board line can afford it. Tasks from before the title rewrite carry
 * whole paragraphs as their titles, and six of those joined by "、" was a wall — the
 * board is for telling tasks apart, and the full words are one click away.
 */
function clampTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length > 24 ? `${oneLine.slice(0, 23)}…` : oneLine;
}

/**
 * The board for one chat's tasks, as facts.
 *
 * `nameOf` turns an assignee id into the name people use; `urlFor` is the workshop
 * link when this installation is reachable, absent otherwise — a link that opens
 * nothing is worse than no link.
 */
export function boardView(
  tasks: readonly Task[],
  nameOf: (id: string) => string,
  urlFor: (taskId: string) => string | undefined,
  now: Date = new Date()
): BoardView {
  const live = tasks.filter(task => isLive(task.status));
  const since = now.getTime() - 24 * 3_600_000;
  const line = (task: Task): BoardTaskLine => {
    const url = urlFor(task.id);
    return {
      id: task.id,
      ...(task.assigneeId !== undefined ? { who: nameOf(task.assigneeId) } : {}),
      title: clampTitle(task.title),
      ...(url !== undefined ? { url } : {}),
    };
  };
  return {
    liveCount: live.length,
    groups: GROUPS.map(group => ({
      heading: group.heading,
      tasks: live.filter(task => task.status === group.status).map(line),
    })).filter(group => group.tasks.length > 0),
    done: tasks
      .filter(task => task.status === "done" && Date.parse(task.updatedAt) >= since)
      .map(line),
  };
}

/** The board as one plain-text message, for wires without cards. */
export function boardText(view: BoardView): string {
  if (view.groups.length === 0 && view.done.length === 0) return BOARD_EMPTY;
  const lines: string[] = [boardHeadline(view.liveCount)];
  for (const group of view.groups) {
    lines.push(`${group.heading}:`);
    for (const task of group.tasks) {
      const who = task.who !== undefined ? `@${task.who} ` : "";
      lines.push(`  ${task.id} ${who}${task.title}${task.url !== undefined ? ` ${task.url}` : ""}`);
    }
  }
  if (view.done.length > 0) {
    lines.push(`近 24 小时完成:${view.done.map(task => `${task.id} ${task.title}`).join("、")}`);
  }
  return lines.join("\n");
}

/**
 * What the chat hears when a task lands on blocked, or nothing.
 *
 * A blocked row buried on the board is how work quietly stops — the digest already
 * knew this and named it "needs a person"; but a digest arrives tomorrow morning and
 * the person who can unblock it is in the chat now.
 *
 * Nothing when the channel itself parked the task: its failure path lands tasks on
 * blocked in the same breath as delivering the error to the chat, and announcing
 * again is an echo.
 */
export function blockedAnnouncement(task: Task): string | undefined {
  if (task.status !== "blocked") return undefined;
  const last = task.history.at(-1);
  if (last?.by === "channel") return undefined;
  const note = last?.note;
  return `${task.id}「${task.title}」卡住了,要人来搭把手${
    note !== undefined ? `:${note}` : "。"
  }`;
}
