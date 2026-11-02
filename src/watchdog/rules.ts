/**
 * What the watchdog judges, from the record alone (INV-1509, docs/91). Deterministic, and each rule
 * says something a person can check by opening the task: no move on the record for an hour while
 * it is in hand; a goal the gate stopped that nobody has looked at; a goal whose verification keeps
 * failing. Notes are stable — no running minute counts — so the door's cooldown can recognise the
 * same flag raised twice.
 */

import type { TaskRecord } from "../web/mcp-record.ts";

export interface WatchdogLimits {
  /** In hand (status doing) with no change on the record for this long: flagged. */
  stallMinutes: number;
  /** A goal the gate stopped, untouched for this long: flagged. */
  pausedMinutes: number;
  /** A goal whose verification failed this many times: flagged. */
  rejections: number;
  /** One of the watchdog's own goals stalled this long is paused as well as flagged. */
  pauseOwnMinutes: number;
}

export const DEFAULT_LIMITS: WatchdogLimits = { stallMinutes: 60, pausedMinutes: 30, rejections: 2, pauseOwnMinutes: 120 };

export type Rule = "stalled" | "stopped-unattended" | "verification-failing";

export interface Finding {
  taskId: string;
  rule: Rule;
  note: string;
  /** Pause the goal too: only ever one the watchdog's own principal started. */
  pause?: true;
}

const minutesSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / 60_000;
const minutes = (n: number) => `${n} minute${n === 1 ? "" : "s"}`;

/** The findings for one task; `mine` says whether the watchdog's principal asked for it. */
export function findingsFor(record: TaskRecord, mine: boolean, now: Date, limits: WatchdogLimits = DEFAULT_LIMITS): Finding[] {
  if (record.outcome.status !== "in_progress" && record.outcome.status !== "failed" && record.outcome.status !== "incomplete") return [];
  const found: Finding[] = [];
  const quiet = minutesSince(record.updatedAt, now);
  const pursuit = record.pursuit;
  if (record.status === "doing" && (pursuit === undefined || pursuit.status === "active") && quiet >= limits.stallMinutes) {
    const pause = mine && pursuit?.status === "active" && quiet >= limits.pauseOwnMinutes;
    found.push({
      taskId: record.id,
      rule: "stalled",
      note: `no change on its record for over ${minutes(limits.stallMinutes)} while in hand${pause ? "; the watchdog paused its own goal" : ""}`,
      ...(pause ? { pause: true as const } : {}),
    });
  }
  if (pursuit?.status === "paused" && pursuit.pausedReason !== undefined && pursuit.pausedReason !== "person" && quiet >= limits.pausedMinutes) {
    found.push({ taskId: record.id, rule: "stopped-unattended", note: `the goal was stopped by the gate (${pursuit.pausedReason}) over ${minutes(limits.pausedMinutes)} ago and nobody has looked` });
  }
  if (pursuit !== undefined && (pursuit.status === "active" || pursuit.status === "verifying") && pursuit.spent.rejections >= limits.rejections) {
    found.push({ taskId: record.id, rule: "verification-failing", note: `its verification has failed ${limits.rejections} or more times` });
  }
  return found;
}
