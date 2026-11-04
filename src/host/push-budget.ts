/**
 * How much an agent may say to people on its own initiative in a day (INV-1576).
 *
 * The host's own unprompted lines — nudges, defaults taken, archive notices — already have a
 * budget per room (follow-up-budget.ts, INV-535). What an agent itself pushes did not: a routine's
 * result, a report it decided to send. Agents are increasingly woken by events and work in the
 * background, so one agent with a dozen routines can speak to a person twenty times in a day, and
 * a person spoken to twenty times stops reading — the decisions that need them are lost in it.
 *
 * So every agent has a daily allowance (PUSHES_PER_DAY unless set for it). Within it a push goes
 * out as before; past it, it is held for the chat and goes out once, in the chat's daily briefing
 * when it has one, otherwise at DIGEST_HOUR as one message of held updates. What needs a person —
 * a goal's verdict awaiting acceptance, a question, an approval — is never held; the goal notices
 * that pass here are counted as exempt so the page can say how much was said. The day is the local
 * calendar day, as the briefings are. Everything is written to one ledger, so a restart keeps both
 * the counts and what is held.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";

export const PUSHES_PER_DAY = 8;
/** When held updates go out for a chat without a daily briefing: early evening, local time. */
export const DIGEST_HOUR = 18;
const MAX_HELD_TEXT = 2_000;

export interface HeldPush {
  at: string;
  agentId: string;
  chatKey: string;
  text: string;
}

export interface PushCounts {
  sent: number;
  held: number;
  exempt: number;
  perDay: number;
}

type LedgerLine =
  | { kind: "sent" | "exempt"; at: string; agentId: string; chatKey: string }
  | { kind: "held"; at: string; agentId: string; chatKey: string; text: string }
  | { kind: "released"; at: string; chatKey: string; count: number }
  | { kind: "limit"; at: string; agentId: string; perDay: number | null };

export class PushBudget {
  private readonly lines: LedgerLine[] = [];
  private readonly limits = new Map<string, number>();

  constructor(private readonly path?: string, private readonly now: () => Date = () => new Date()) {
    if (path !== undefined) this.restore(path);
  }

  perDayOf(agentId: string): number {
    return this.limits.get(agentId) ?? PUSHES_PER_DAY;
  }

  /** A person sets an agent's allowance; null goes back to the default. */
  setPerDay(agentId: string, perDay: number | null): void {
    if (perDay !== null && (!Number.isInteger(perDay) || perDay < 0 || perDay > 1_000)) throw new Error("perDay must be a whole number from 0 to 1000");
    this.write({ kind: "limit", at: this.now().toISOString(), agentId, perDay });
  }

  /**
   * Whether this push goes now or is held for the chat's digest. `exempt` is what needs a person
   * and is never held; a push nobody is accountable for (no agent) is not counted at all.
   */
  admit(input: { agentId?: string; chatKey: string; text: string; exempt?: boolean }): "send" | "hold" {
    if (input.agentId === undefined) return "send";
    const at = this.now().toISOString();
    if (input.exempt === true) {
      this.write({ kind: "exempt", at, agentId: input.agentId, chatKey: input.chatKey });
      return "send";
    }
    if (this.counts(input.agentId).sent < this.perDayOf(input.agentId)) {
      this.write({ kind: "sent", at, agentId: input.agentId, chatKey: input.chatKey });
      return "send";
    }
    this.write({ kind: "held", at, agentId: input.agentId, chatKey: input.chatKey, text: input.text.slice(0, MAX_HELD_TEXT) });
    return "hold";
  }

  /** Today's numbers for one agent, for the settings page. */
  counts(agentId: string): PushCounts {
    const today = this.dayOf(this.now().toISOString());
    const mine = this.lines.filter(line => line.kind !== "released" && line.kind !== "limit" && line.agentId === agentId && this.dayOf(line.at) === today);
    return {
      sent: mine.filter(line => line.kind === "sent").length,
      held: mine.filter(line => line.kind === "held").length,
      exempt: mine.filter(line => line.kind === "exempt").length,
      perDay: this.perDayOf(agentId),
    };
  }

  /** The chats that have held pushes waiting. */
  heldChats(): string[] {
    return [...new Set(this.outstanding().map(push => push.chatKey))];
  }

  /** What is held for one chat, oldest first. */
  heldFor(chatKey: string): HeldPush[] {
    return this.outstanding().filter(push => push.chatKey === chatKey);
  }

  /** Marks the chat's held pushes as delivered in a digest; call only once the digest landed. */
  release(chatKey: string, count: number): void {
    if (count > 0) this.write({ kind: "released", at: this.now().toISOString(), chatKey, count });
  }

  private outstanding(): HeldPush[] {
    const released = new Map<string, number>();
    for (const line of this.lines) if (line.kind === "released") released.set(line.chatKey, (released.get(line.chatKey) ?? 0) + line.count);
    const held: HeldPush[] = [];
    const skip = new Map(released);
    for (const line of this.lines) {
      if (line.kind !== "held") continue;
      const left = skip.get(line.chatKey) ?? 0;
      if (left > 0) { skip.set(line.chatKey, left - 1); continue; }
      held.push({ at: line.at, agentId: line.agentId, chatKey: line.chatKey, text: line.text });
    }
    return held;
  }

  private dayOf(iso: string): string {
    const day = new Date(iso);
    return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
  }

  private write(line: LedgerLine): void {
    this.apply(line);
    if (this.path === undefined) return;
    try {
      appendLine(this.path, JSON.stringify(line));
    } catch {
      // A budget that cannot write is still a budget for this process.
    }
  }

  private apply(line: LedgerLine): void {
    if (line.kind === "limit") {
      if (line.perDay === null) this.limits.delete(line.agentId);
      else this.limits.set(line.agentId, line.perDay);
      return;
    }
    this.lines.push(line);
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    for (const text of raw.split("\n")) {
      if (text.trim() === "") continue;
      try {
        this.apply(JSON.parse(text) as LedgerLine);
      } catch {
        // A torn line is skipped; the rest of the day still counts.
      }
    }
  }
}

/** The held updates as one message section: who said what, each in a line, the full text kept short. */
export function heldSection(held: readonly HeldPush[], nameOf: (agentId: string) => string): string {
  if (held.length === 0) return "";
  const lines = held.map(push => `- ${nameOf(push.agentId)}: ${push.text.replace(/\s+/g, " ").trim().slice(0, 200)}${push.text.length > 200 ? "…" : ""}`);
  return [`Held updates (${held.length}), past the agents' daily allowance:`, ...lines].join("\n");
}
