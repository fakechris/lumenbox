/**
 * How often the host may start a conversation, and how much it may say (INV-535).
 *
 * Four rails now speak on their own: a question goes to its default, a task is nudged
 * and then archived, a close proposal settles, a commitment turns out to be held by
 * nothing. Each was written alone and each is quiet alone. Together, five agents with
 * one open question and five stale cards produce twenty messages in a day — and a person
 * who is nudged twenty times reads none of them, which is the failure the rails exist to
 * fix, arriving by the other door.
 *
 * Two kinds of line, and only one of them is budgeted:
 *
 *   - an **ask** — "this is overdue, close / downgrade / continue?" — is a demand on
 *     somebody's attention, and may be held back: the board still shows it, and the sweep
 *     will propose it again.
 *   - an **act** — "no answer in four hours, so I went with the default", "archived after
 *     two nudges", "closed as proposed" — is the host saying what it already did. Holding
 *     that back would make the system quieter *and* less honest: doing, saying and
 *     recording are one thing (docs/51 §3.1), so an act is never suppressed. It is only
 *     coalesced: everything for one room in one sweep is one message.
 *
 * The budget is per room, over a rolling day, and counts only what was delivered — a
 * push that failed is not attention anybody spent (INV-530).
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";

/** Proactive messages per room per rolling day. Two: a morning and an afternoon. */
export const FOLLOW_UP_MESSAGES_PER_DAY = 2;
/** Items in one message; the rest are counted, not listed. */
export const FOLLOW_UP_ITEMS_PER_MESSAGE = 5;
export const FOLLOW_UP_WINDOW_MS = 86_400_000;

export interface FollowUpItem {
  /** An act is said whatever the budget says; an ask can wait for tomorrow. */
  kind: "ask" | "act";
  text: string;
  /** What to mark as said once it is delivered — a task id, a question id. */
  ref?: string;
}

export interface FollowUpMessage {
  text: string;
  /** The refs that went out: the caller records them only after delivery lands. */
  sent: string[];
  /** Asks the budget held back, so the caller does not count them as said. */
  held: FollowUpItem[];
}

export class FollowUpBudget {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly path?: string) {
    if (path !== undefined) this.restore(path);
  }

  /**
   * What to say to one room now, given everything that came due for it in this sweep.
   * Acts always travel. Asks travel only if the room has messages left today and there
   * is room in the message; the rest come back as `held`, said another day.
   */
  compose(room: string, items: readonly FollowUpItem[], now = Date.now()): FollowUpMessage | undefined {
    const acts = items.filter(item => item.kind === "act");
    const asks = items.filter(item => item.kind === "ask");
    const spent = (this.sent.get(room) ?? []).filter(at => now - at < FOLLOW_UP_WINDOW_MS).length;
    // An act is going out regardless, and a message that is already being sent carries
    // whatever asks fit: the ask costs nothing extra once somebody is being spoken to.
    const mayAsk = acts.length > 0 || spent < FOLLOW_UP_MESSAGES_PER_DAY;
    const room_ = FOLLOW_UP_ITEMS_PER_MESSAGE - acts.length;
    const taking = mayAsk ? asks.slice(0, Math.max(0, room_)) : [];
    const held = asks.filter(ask => !taking.includes(ask));
    if (acts.length === 0 && taking.length === 0) return { text: "", sent: [], held };
    const lines = [...acts, ...taking].map(item => item.text);
    const more = held.length > 0 ? `\n(and ${held.length} more on the board; I will not list them again today)` : "";
    return {
      text: lines.length === 1 && more === "" ? lines[0]! : `${lines.join("\n")}${more}`,
      sent: [...acts, ...taking].map(item => item.ref).filter((ref): ref is string => ref !== undefined),
      held,
    };
  }

  /** One message reached one room: it counts, and is remembered across a restart. */
  record(room: string, now = Date.now()): void {
    const times = (this.sent.get(room) ?? []).filter(at => now - at < FOLLOW_UP_WINDOW_MS);
    times.push(now);
    this.sent.set(room, times);
    if (this.path === undefined) return;
    try {
      appendLine(this.path, JSON.stringify({ at: new Date(now).toISOString(), room }));
    } catch {
      // A budget that cannot write is still a budget for this process; the alternative
      // is refusing to say something the person is waiting for because a disk was busy.
    }
  }

  /** What is left today, for the page and for tests. */
  remaining(room: string, now = Date.now()): number {
    return Math.max(0, FOLLOW_UP_MESSAGES_PER_DAY - (this.sent.get(room) ?? []).filter(at => now - at < FOLLOW_UP_WINDOW_MS).length);
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const now = Date.now();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const entry = JSON.parse(line) as { at?: string; room?: string };
        if (typeof entry.at !== "string" || typeof entry.room !== "string") continue;
        const at = Date.parse(entry.at);
        if (Number.isNaN(at) || now - at >= FOLLOW_UP_WINDOW_MS) continue;
        this.sent.set(entry.room, [...(this.sent.get(entry.room) ?? []), at]);
      } catch {
        // One torn line.
      }
    }
  }
}
