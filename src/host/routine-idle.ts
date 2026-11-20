/**
 * When nobody is looking any more, routines stop (INV-741).
 *
 * A person stops using a box and its routines go on: every morning's brief is written, billed and
 * delivered to a chat nobody opens. The failure streak (routine-runs.ts) catches a routine that
 * keeps failing; this catches the one that keeps working for no one.
 *
 * The rule: when a routine comes due and no person has written to its box for N days, it does not
 * run. It is held with the code `idle_owner`, through the same door as every other host pause, and
 * the chat it reports to is told once. When a person writes again the hold is lifted by the host;
 * a routine a person paused is not this hold and is left alone.
 *
 * "A person has written" is not decided here. It is read from the heard record (heard-record.ts),
 * where the host wrote down who each message was from when a turn took it. A routine's own prompt,
 * a teammate, a webhook and a host notice are other speakers there, so a box cannot keep itself
 * awake by talking to itself.
 *
 * A box with no person's message on record is not called idle: no evidence that somebody left is
 * not evidence that they did, and pausing every routine of a box the record has not caught up with
 * would be the surprise this exists to prevent, in the other direction.
 */

import { envNumber } from "../config.ts";
import { resolveLocale } from "../i18n/locale.ts";
import { tr } from "../i18n/messages.ts";
import type { FollowUpBudget } from "./follow-up-budget.ts";
import type { RoutineReason } from "./routine-runs.ts";

/** The hold's code: the one the host lifts by itself. */
export const IDLE_OWNER = "idle_owner";
export const DEFAULT_IDLE_DAYS = 7;
const DAY_MS = 86_400_000;

/** Days without a person's message before a due routine is paused. `AGENTBOX_ROUTINE_IDLE_DAYS`; 0 never pauses. */
export function idleDays(): number {
  const days = envNumber("AGENTBOX_ROUTINE_IDLE_DAYS", DEFAULT_IDLE_DAYS);
  return days > 0 ? days : 0;
}

/** What the scheduler is given to apply the rule. Absent, the rule is off. */
export interface IdleOwner {
  /** When a person last wrote to this box, through any door; undefined when the record has none. */
  lastPersonAt: (boxId?: string) => Date | undefined;
  /** Defaults to `idleDays()`. */
  days?: () => number;
}

/** A routine paused for this reason that reports to a chat: what the explanation names. */
export interface IdledRoutine {
  slug: string;
  name: string;
  deliver: string;
}

/** The newest message from a person among these agents, by the heard record; with a conversation, the newest one there. */
export function lastPersonMessage(
  heard: { lastPerson(agentId: string, conversation?: string): string | undefined } | undefined, agentIds: readonly string[], conversation?: string
): Date | undefined {
  let last: string | undefined;
  for (const id of agentIds) {
    const at = heard?.lastPerson(id, conversation);
    if (at !== undefined && (last === undefined || at > last)) last = at;
  }
  return last === undefined ? undefined : new Date(last);
}

/** Why a routine due now does not run, or undefined when somebody is still around (or nobody can say). */
export function idleReason(lastPerson: Date | undefined, now: Date, days: number): RoutineReason | undefined {
  if (days <= 0 || lastPerson === undefined) return undefined;
  const quiet = now.getTime() - lastPerson.getTime();
  if (quiet < days * DAY_MS) return undefined;
  return { code: IDLE_OWNER, text: `no message from a person for ${Math.floor(quiet / DAY_MS)} days; it resumes when someone writes again` };
}

/**
 * Tells each chat, once, which of its routines stopped and why. One message per chat however many
 * routines stopped in the tick, and through the proactive budget (INV-535) as an act: the host
 * saying what it already did, which is counted against the room's day but never held back.
 * Not retried when it does not land — the hold and its reason are on the Automations page.
 */
export async function explainIdlePause(
  deps: { followUps: FollowUpBudget; push: (chatKey: string, text: string) => Promise<{ delivered: boolean; why?: string }>; log: (line: string) => void },
  routines: readonly IdledRoutine[],
  days: number
): Promise<void> {
  const byChat = new Map<string, string[]>();
  for (const routine of routines) byChat.set(routine.deliver, [...(byChat.get(routine.deliver) ?? []), routine.name]);
  for (const [chatKey, names] of byChat) {
    const locale = resolveLocale({ channelType: chatKey.split(":")[0] });
    const text = tr("routine.idle-paused", locale, { routines: names.join(locale === "zh" ? "、" : ", "), days });
    const message = deps.followUps.compose(chatKey, [{ kind: "act", text }]);
    if (message === undefined || message.text === "") continue;
    deps.followUps.reserve(chatKey);
    try {
      const result = await deps.push(chatKey, message.text).catch((error: unknown) => ({ delivered: false, why: error instanceof Error ? error.message : String(error) }));
      if (result.delivered) deps.followUps.record(chatKey);
      else deps.log(`${names.join(", ")}: paused for nobody writing, and ${chatKey} was not told (${result.why ?? "no reason given"})`);
    } finally {
      deps.followUps.release(chatKey);
    }
  }
}
