/**
 * The task board as a chat reads it: one message, in the person's language.
 *
 * The complaint this answers, verbatim: "现在有各种task,我都对应不上" — the board
 * exists, the ids exist, and from inside a chat there was no way to see them together.
 * "早报" answers "what happened today"; this answers "what is on the plate right now",
 * grouped by what a person does about each state: accept it, unblock it, wait, or
 * nothing.
 *
 * Deliberately not a model call, same as the digest: a board that could hallucinate a
 * task id would poison the one place ids are read aloud. Every line is a lookup.
 */

import { isLive, type Task } from "../host/tasks.ts";

/** How each live status reads as a group heading, in the order a person triages. */
const GROUPS: { status: Task["status"]; heading: string }[] = [
  { status: "review", heading: "待验收" },
  { status: "blocked", heading: "卡住了" },
  { status: "doing", heading: "进行中" },
  { status: "open", heading: "排队中" },
];

export const BOARD_EMPTY = "这个群现在没有挂着的任务。";

/**
 * The board message for one chat's tasks.
 *
 * `nameOf` turns an assignee id into the name people use; `urlFor` is the workshop
 * link when this installation is reachable, absent otherwise — a link that opens
 * nothing is worse than no link.
 */
export function boardMessage(
  tasks: readonly Task[],
  nameOf: (id: string) => string,
  urlFor: (taskId: string) => string | undefined,
  now: Date = new Date()
): string {
  const live = tasks.filter(task => isLive(task.status));
  const since = now.getTime() - 24 * 3_600_000;
  const done = tasks.filter(
    task => task.status === "done" && Date.parse(task.updatedAt) >= since
  );
  if (live.length === 0 && done.length === 0) return BOARD_EMPTY;

  const lines: string[] = [`看板 · ${live.length} 件在办`];
  for (const group of GROUPS) {
    const inGroup = live.filter(task => task.status === group.status);
    if (inGroup.length === 0) continue;
    lines.push(`${group.heading}:`);
    for (const task of inGroup) {
      const who = task.assigneeId !== undefined ? `@${nameOf(task.assigneeId)} ` : "";
      const url = urlFor(task.id);
      lines.push(`  ${task.id} ${who}${task.title}${url !== undefined ? ` ${url}` : ""}`);
    }
  }
  if (done.length > 0) {
    lines.push(
      `近 24 小时完成:${done.map(task => `${task.id} ${task.title}`).join("、")}`
    );
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
