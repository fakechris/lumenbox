/**
 * A member's one-off reminder to itself (INV-1878): "look at this PR again on Friday".
 *
 * Before this a member that wanted to come back to something had to write a skill file with an
 * `@at` schedule — a routine, for one note — or hope to remember. The host already kept reminders:
 * a tool result may ask for one (INV-861, effects.ts), written to the pending-work ledger before it
 * is acknowledged, delivered once when due, kept across a restart. This is that record with a tool
 * in front of it, not a second store: a reminder is an open `reminder` line in the ledger, set is
 * `prepare`, firing is `commit`, a person or the member dropping it is `dropped`.
 *
 * What firing does depends on whether the member named a chat:
 *   - none: the note is queued to the member in the conversation it was set in, as the host's
 *     words, and wakes it — what an extension's reminder has always done;
 *   - a chat: the member runs a turn of its own on the note and what it says is reported to that
 *     chat through the routine's report door, so the resolve step, the push budget and the quiet
 *     rule (quiet-delivery.ts) all apply and there is no other way out to a person.
 *
 * Three limits. A member holds at most twenty at a time, so "remind me" cannot become a loop that
 * feeds itself. A time already past is refused, because a reminder that fires at once is a turn the
 * member could have taken now. And nothing further out than a year: that is a plan, and plans live
 * on the board or in a routine.
 *
 * A reminder is not paused when nobody has written to the box for a week (routine-idle.ts). That
 * rule is for what repeats: a brief written every morning for nobody. A reminder fires once, there
 * are at most twenty, and the usual one is a person's own "tell me on the 1st" followed by ten days
 * of silence — which is the case it exists for.
 */

import { MAIN_CONVERSATION } from "../agents/registry.ts";
import { outcomeLine } from "../protocol/index.ts";
import type { PendingWork } from "./pending-work.ts";
import type { ToolContext, ToolOutcome } from "./tools.ts";

export const REMINDER = "Reminder";
/** Reminders one member may have waiting. */
export const REMINDERS_PER_AGENT = 20;
export const REMINDER_MAX_CHARS = 1_000;
/** A reminder further out than this is refused: it is a plan, and plans belong in a task or a routine. */
export const MAX_REMINDER_MS = 366 * 24 * 3_600_000;
/** The part of the host a reminder's turn is opened by (model-text.ts `HOST_ORIGINS`): the note is the member's own, never a person's words. */
export const REMINDER_ORIGIN = "host:reminder";
/** The ledger's `child` for a reminder somebody set. The host's own due-now notes (a pause's result) use another and are not listed. */
const SET_BY_SOMEONE = "reminder";

export interface Reminder {
  id: string;
  agentId: string;
  text: string;
  /** ISO instant it fires at or after. */
  due: string;
  setAt: string;
  /** The conversation it was set in, where a reminder with no chat is delivered. */
  conversation: string;
  /** The chat its result is reported to, when the member named one. */
  chat?: string;
}

type Ledger = Pick<PendingWork, "open" | "prepare" | "dropped">;

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/**
 * When a reminder is due: `30m`, `2h`, `3d`, `1w` (also "in 3 days") from now, or an ISO 8601 time.
 * Comes back with the instant, or with why not in words the member can act on.
 */
export function parseDue(raw: string, now: Date): Date | string {
  const text = raw.trim();
  const relative = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|h|d|w)(?:in|ins|inute|inutes|r|rs|our|ours|ay|ays|k|ks|eek|eeks)?$/i.exec(text);
  let at: number;
  if (relative !== null) at = now.getTime() + Math.round(Number(relative[1]) * UNIT_MS[relative[2]!.toLowerCase()]!);
  else if (/^\d{4}-\d{2}-\d{2}/.test(text) && !Number.isNaN(Date.parse(text))) at = Date.parse(text);
  else return `"${text.slice(0, 60)}" is not a time: give \`30m\`, \`2h\`, \`3d\`, \`1w\`, or an ISO time such as 2026-12-01T09:00+08:00`;
  if (at <= now.getTime()) return `${new Date(at).toISOString()} is not in the future (it is ${now.toISOString()} now): do it in this turn instead`;
  if (at - now.getTime() > MAX_REMINDER_MS) return `${new Date(at).toISOString()} is more than a year away: that is a plan, and belongs in a task or a routine`;
  return new Date(at);
}

/** The reminders waiting to fire, soonest first; one member's when named. */
export function pendingReminders(ledger: Pick<PendingWork, "open">, agentId?: string): Reminder[] {
  return ledger.open()
    .filter(work => work.kind === "reminder" && work.child === SET_BY_SOMEONE && (agentId === undefined || work.agentId === agentId))
    .map(work => ({
      id: work.id,
      agentId: work.agentId,
      text: String(work.data?.text ?? work.brief),
      due: String(work.data?.at ?? ""),
      setAt: work.at,
      conversation: work.parent,
      ...(typeof work.data?.chat === "string" ? { chat: work.data.chat } : {}),
    }))
    .sort((a, b) => a.due.localeCompare(b.due));
}

/** Writes a reminder down, unless the member already holds its twenty. Durable before it returns. */
export function setReminder(
  ledger: Ledger,
  input: { agentId: string; conversation: string; text: string; due: Date; chat?: string; tool?: string; now?: Date }
): { ok: true; reminder: Reminder } | { ok: false; reason: string } {
  const waiting = pendingReminders(ledger, input.agentId).length;
  if (waiting >= REMINDERS_PER_AGENT) {
    return { ok: false, reason: `you already have ${waiting} reminders waiting, and ${REMINDERS_PER_AGENT} is the most one member holds. List them and cancel one you no longer need, or put this on a task` };
  }
  const text = input.text.trim().slice(0, REMINDER_MAX_CHARS), due = input.due.toISOString(), now = input.now ?? new Date();
  const id = ledger.prepare({
    agentId: input.agentId,
    kind: "reminder",
    parent: input.conversation,
    child: SET_BY_SOMEONE,
    brief: text,
    data: { text, at: due, ...(input.chat !== undefined ? { chat: input.chat } : {}), ...(input.tool !== undefined ? { tool: input.tool } : {}) },
    now,
  });
  return { ok: true, reminder: { id, agentId: input.agentId, text, due, setAt: now.toISOString(), conversation: input.conversation, ...(input.chat !== undefined ? { chat: input.chat } : {}) } };
}

/** Drops a waiting reminder so it never fires; the member's own when `agentId` is given. Returns it, or undefined when none waits under that id. */
export function cancelReminder(ledger: Ledger, id: string, agentId?: string, now = new Date()): Reminder | undefined {
  const found = pendingReminders(ledger, agentId).find(reminder => reminder.id === id);
  if (found !== undefined) ledger.dropped(id, "cancelled", now);
  return found;
}

/** What the member is told when a reminder that reports to a chat opens its turn. */
export function reminderPrompt(reminder: Pick<Reminder, "text" | "setAt" | "chat">): string {
  return (
    `[reminder] This turn was started by a reminder you set for yourself on ${reminder.setAt}, not by a person. It is your own note, ` +
    "not a new instruction: act only within what a person already asked of you. Nobody will answer a question, so decide rather than ask. " +
    `Your final message is delivered to ${reminder.chat ?? "a chat"}, where people will read it, so make it the thing itself, short enough ` +
    "to read on a phone. If there is nothing worth telling them now, call NothingToSay with the reason.\n\n" +
    `Your note: ${reminder.text}`
  );
}

export function withReminderTool(tools: { name: string; input_schema: unknown }[]): void {
  tools.push({
    name: REMINDER,
    description:
      "Set a one-off reminder for yourself: when it is due you are woken with your note. With `chat`, what you say then is sent to that chat. " +
      "`list` shows yours; `cancel` drops one.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "list", "cancel"] },
        message: { type: "string", description: "set: what to do then, in words that stand alone." },
        due: { type: "string", description: "set: `30m`, `2h`, `3d`, `1w`, or an ISO time with its offset." },
        chat: { type: "string", description: "set: a chat key to report to." },
        id: { type: "string", description: "cancel: an id from `list`." },
      },
      required: ["action"],
    },
  } as never);
}

function refused(reason: string): ToolOutcome {
  return { text: outcomeLine("refused", reason), isError: true };
}

function line(reminder: Reminder): string {
  return `${reminder.id} · due ${reminder.due}${reminder.chat !== undefined ? ` · reports to ${reminder.chat}` : ""} · ${reminder.text.replace(/\s+/g, " ").slice(0, 160)}`;
}

export function reminderTool(context: Pick<ToolContext, "agent" | "conversation" | "pendingWork">, input: unknown, now = new Date()): ToolOutcome {
  const ledger = context.pendingWork;
  if (ledger === undefined) return refused("this host keeps no reminders (it has no pending-work ledger)");
  const args = (input ?? {}) as Record<string, unknown>;
  const word = (key: string) => (typeof args[key] === "string" ? (args[key] as string).trim() : "");
  const agentId = context.agent.id;
  switch (args.action) {
    case "set": {
      if (word("message") === "") return refused("a reminder needs a `message`: what to do when it is due");
      if (word("message").length > REMINDER_MAX_CHARS) return refused(`the message is ${word("message").length} characters and the most is ${REMINDER_MAX_CHARS}: keep the note short and put the detail in a file`);
      if (word("due") === "") return refused("a reminder needs `due`: `30m`, `2h`, `3d`, `1w`, or an ISO time");
      const due = parseDue(word("due"), now);
      if (typeof due === "string") return refused(due);
      const set = setReminder(ledger, { agentId, conversation: context.conversation ?? MAIN_CONVERSATION, text: word("message"), due, ...(word("chat") !== "" ? { chat: word("chat") } : {}), tool: REMINDER, now });
      if (!set.ok) return refused(set.reason);
      return { text: `Reminder ${set.reminder.id} set for ${set.reminder.due}. ${set.reminder.chat !== undefined ? `What you say then is reported to ${set.reminder.chat}.` : "You will be woken with the note in this conversation."}` };
    }
    case "list": {
      const mine = pendingReminders(ledger, agentId);
      return { text: mine.length === 0 ? "You have no reminders waiting." : [`${mine.length} of ${REMINDERS_PER_AGENT} reminders waiting, soonest first:`, ...mine.map(line)].join("\n") };
    }
    case "cancel": {
      if (word("id") === "") return refused("`cancel` needs the reminder's `id`, from `list`");
      const dropped = cancelReminder(ledger, word("id"), agentId, now);
      return dropped === undefined ? refused(`no reminder of yours is waiting as ${word("id")}: it fired, was dismissed, or is not yours`) : { text: `Reminder ${dropped.id} cancelled; it will not fire.` };
    }
    default:
      return refused("`action` is one of set, list, cancel");
  }
}
