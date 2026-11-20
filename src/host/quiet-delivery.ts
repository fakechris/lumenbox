/**
 * A message nobody asked for waits until the conversation is quiet (INV-1928, docs/101 §4).
 *
 * What a member sends on its own initiative — a routine's result, a reminder, a notice from the
 * host, a Tell from a turn nobody is watching — was limited by how many go out in a day
 * (push-budget.ts, follow-up-budget.ts) and by nothing about the moment: it could land between a
 * person's question and the answer they were waiting for. So before one goes, the conversation is
 * looked at. If a person wrote there in the last few minutes, or a member is in the middle of
 * answering them there, the message is kept here and goes when the conversation has been quiet for
 * the window, in the order it was queued.
 *
 * Three things keep waiting from becoming losing:
 *   - the wait is capped: at the cap a message goes whatever the conversation is doing;
 *   - the queue is a file, so a restart keeps what was waiting, and a message leaves it only once
 *     the door it goes by has taken it;
 *   - what cannot wait does not: a reply owed to a person, a question for them, something a person
 *     approved, and the notices named urgent — by policy here, or by the person in the config.
 *
 * "A person wrote" is not decided here. It is the heard record's answer (heard-record.ts), which
 * is why a member's own messages, a routine's prompt and a host notice do not restart the wait.
 *
 * The rule is one function, `quietVerdict`. Every door that carries such a message asks this queue
 * and no door decides for itself: the chat doors through `quietChatDoor`, which stands where every
 * push into a chat leaves, and Tell through `admitTell` (tell.ts), because a Tell also goes to the page.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./jsonl.ts";
import type { OutboundPurpose } from "./outbound.ts";

/** Minutes a conversation has been without a person's message before it counts as quiet. */
export const QUIET_MINUTES = 3;
/** Minutes a message waits at most; then it goes anyway. */
export const QUIET_CAP_MINUTES = 30;
const MINUTE = 60_000;

/**
 * The settings a person wrote under `quiet` in the config, bounded: the window in minutes (0 turns the waiting off), the cap,
 * and the kinds of notice that never wait. Anything that is not a whole number in range keeps its default.
 */
export function quietSettings(raw: { minutes?: unknown; capMinutes?: unknown; urgent?: unknown } | undefined): { windowMinutes: number; capMinutes: number; urgent: string[] } {
  const whole = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  return {
    windowMinutes: whole(raw?.minutes, QUIET_MINUTES, 0, 720),
    capMinutes: whole(raw?.capMinutes, QUIET_CAP_MINUTES, 1, 1_440),
    urgent: Array.isArray(raw?.urgent) ? raw.urgent.filter((kind): kind is string => typeof kind === "string" && kind.trim() !== "") : [],
  };
}

export interface QuietSituation {
  now: number;
  /** When a person last wrote in this conversation; undefined when the record has none. */
  lastPersonAt?: number;
  /** A member is in the middle of a turn that answers a person here. */
  answering: boolean;
  /** When this message was queued; `now` for one that has just arrived. */
  queuedAt: number;
  /** 0 turns the rule off. */
  windowMs: number;
  capMs: number;
  urgent?: boolean;
}

export type QuietVerdict = { go: true; why: "urgent" | "off" | "cap" | "quiet" } | { go: false; until: number };

/** Whether a message nobody asked for goes now or waits — the one place that decides. `until` is the earliest it could go. */
export function quietVerdict(situation: QuietSituation): QuietVerdict {
  if (situation.urgent === true) return { go: true, why: "urgent" };
  if (situation.windowMs <= 0) return { go: true, why: "off" };
  const cap = situation.queuedAt + situation.capMs;
  if (situation.now >= cap) return { go: true, why: "cap" };
  const quietAt = situation.lastPersonAt === undefined ? 0 : situation.lastPersonAt + situation.windowMs;
  if (!situation.answering && situation.now >= quietAt) return { go: true, why: "quiet" };
  return { go: false, until: situation.answering ? cap : Math.min(cap, quietAt) };
}

/** Notices that never wait, by what they are about: they put a question to a person, are an operator's own line, or say work is stuck on them. */
const NEVER_WAITS: readonly RegExp[] = [/^question\b/, /^console\b/, /^board: \S+ blocked$/];

/**
 * Whether a push into a chat is one the quiet rule applies to. Only a notice is: an answer and an
 * acknowledgement are owed to a person who is there, a question needs them, a result reports what
 * they asked for and a draft is one they approved. A notice goes at once when its sender marked it
 * urgent, when policy names its kind above, or when the person listed its kind (`approved`: the
 * leading words of what the notice is about, as the log prints them — "rescued", "report from").
 */
export function waitsForQuiet(purpose: OutboundPurpose, approved: readonly string[] = []): boolean {
  if (purpose.kind !== "notice" || purpose.urgent === true) return false;
  const about = purpose.about ?? "";
  return !NEVER_WAITS.some(kind => kind.test(about)) && !approved.some(kind => kind.trim() !== "" && about.startsWith(kind.trim()));
}

/**
 * Whether a turn open in this conversation is answering a person: one of the messages it started on
 * was a person's, as the heard record wrote it down. A routine's turn there, or a teammate's, is not.
 */
export function answeringPerson(
  open: readonly { agentId: string; conversation?: string; causedBy?: readonly string[] }[],
  heard: { get(agentId: string, id: string): { speaker?: { by: string } } | undefined } | undefined,
  conversation: string
): boolean {
  return open.some(turn => (turn.conversation ?? "main") === conversation && (turn.causedBy ?? []).some(id => heard?.get(turn.agentId, id)?.speaker?.by === "person"));
}

/** A message waiting for its conversation to be quiet. */
export interface QueuedMessage {
  /** Short, so a member can name it: q1, q2, … */
  id: string;
  at: string;
  conversation: string;
  /** Whose message it is — the one member that may take it back or reword it. */
  agentId?: string;
  text: string;
  /** The door that took it and will carry it. */
  via: string;
  /** What that door needs to carry it later, as it wrote it. */
  detail?: Record<string, unknown>;
}

type LedgerLine =
  | ({ kind: "queued" } & QueuedMessage)
  | { kind: "released"; id: string; at: string; why: string }
  | { kind: "withdrawn"; id: string; at: string }
  | { kind: "reworded"; id: string; at: string; text: string };

export type Release = (message: QueuedMessage, why: "quiet" | "cap") => Promise<void>;

export interface QuietDeps {
  /** Where the queue is kept across a restart. Absent: this process only. */
  path?: string;
  now?: () => number;
  /** Defaults to QUIET_MINUTES; 0 turns the rule off. */
  windowMinutes?: number;
  /** Defaults to QUIET_CAP_MINUTES. */
  capMinutes?: number;
  /** When a person last wrote in a conversation, in ms, by the heard record. */
  lastPersonAt: (conversation: string) => number | undefined;
  /** Whether a member is mid-turn answering a person there (`answeringPerson`). */
  answering: (conversation: string) => boolean;
  /** Whether the door a message leaves by is up. A message whose door is not — a chat door still starting — stays queued rather than be handed to nothing. */
  ready?: (message: QueuedMessage) => boolean;
  log?: (line: string) => void;
}

export class QuietQueue {
  private waitingNow: QueuedMessage[] = [];
  private queuedEver = 0;
  private readonly doors = new Map<string, Release>();
  private running: Promise<number> = Promise.resolve(0);

  constructor(private readonly deps: QuietDeps) {
    if (deps.path !== undefined) this.restore(deps.path);
  }

  get capMinutes(): number {
    return this.deps.capMinutes ?? QUIET_CAP_MINUTES;
  }

  /** How a door delivers what it queued, once the wait is over. A message whose door is not connected stays queued. */
  door(via: string, release: Release): void {
    this.doors.set(via, release);
  }

  /** Whether a message for this conversation would wait now: a person is in it, or others are already waiting and it goes after them. */
  holds(conversation: string): boolean {
    const now = this.now();
    if (this.verdict(conversation, now, now).go) return this.windowMs() > 0 && this.waitingNow.some(message => message.conversation === conversation);
    return true;
  }

  /** Takes a message into the queue. From here it is delivered, withdrawn by its member, or still waiting — never dropped. */
  hold(message: Omit<QueuedMessage, "id" | "at">): QueuedMessage {
    const held: QueuedMessage = { ...message, id: `q${this.queuedEver + 1}`, at: new Date(this.now()).toISOString() };
    this.write({ kind: "queued", ...held });
    return held;
  }

  /** What is waiting, oldest first. */
  waiting(where: { conversation?: string; agentId?: string } = {}): readonly QueuedMessage[] {
    return this.waitingNow.filter(message => (where.conversation === undefined || message.conversation === where.conversation) && (where.agentId === undefined || message.agentId === where.agentId));
  }

  /**
   * A member takes back one of its own waiting messages (no `text`), or puts new words in its place,
   * where it stood in the order. Undefined when nothing of that member's waits under the id — it has gone, or never was.
   */
  amend(id: string, agentId: string, text?: string): QueuedMessage | undefined {
    const message = this.waitingNow.find(entry => entry.id === id && entry.agentId === agentId);
    if (message === undefined) return undefined;
    const at = new Date(this.now()).toISOString();
    this.write(text === undefined ? { kind: "withdrawn", id, at } : { kind: "reworded", id, at, text });
    return message;
  }

  /** Delivers what no longer has to wait, each conversation's in order. One pass at a time; returns how many went. */
  sweep(): Promise<number> {
    const next = this.running.then(() => this.pass(), () => this.pass());
    this.running = next.catch(() => 0);
    return next;
  }

  /** Looks every few seconds. Returns the stop. */
  start(everyMs = 15_000): () => void {
    const timer = setInterval(() => { if (this.waitingNow.length > 0) void this.sweep(); }, everyMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async pass(): Promise<number> {
    let released = 0;
    for (const conversation of new Set(this.waitingNow.map(message => message.conversation))) {
      for (;;) {
        const head = this.waitingNow.find(message => message.conversation === conversation);
        if (head === undefined) break;
        const verdict = this.verdict(conversation, Date.parse(head.at), this.now());
        if (!verdict.go) break;
        const release = this.doors.get(head.via);
        if (release === undefined || this.deps.ready?.(head) === false) break;
        try {
          await release(head, verdict.why === "cap" ? "cap" : "quiet");
        } catch (error) {
          // Still queued, and tried again at the next look: a message is never dropped for a door that threw.
          this.deps.log?.(`quiet queue: ${head.id} for ${conversation} was not delivered (${error instanceof Error ? error.message : String(error)}); it stays queued`);
          break;
        }
        // Withdrawn while it was on its way: it went, and the member is told so when it asks.
        if (this.waitingNow.some(message => message.id === head.id)) this.write({ kind: "released", id: head.id, at: new Date(this.now()).toISOString(), why: verdict.why });
        released += 1;
      }
    }
    return released;
  }

  private verdict(conversation: string, queuedAt: number, now: number): QuietVerdict {
    const lastPersonAt = this.deps.lastPersonAt(conversation);
    return quietVerdict({
      now, queuedAt, windowMs: this.windowMs(), capMs: this.capMinutes * MINUTE, answering: this.deps.answering(conversation),
      ...(lastPersonAt !== undefined ? { lastPersonAt } : {}),
    });
  }

  private windowMs(): number {
    return (this.deps.windowMinutes ?? QUIET_MINUTES) * MINUTE;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private write(line: LedgerLine): void {
    this.apply(line);
    if (this.deps.path === undefined) return;
    try {
      appendLine(this.deps.path, JSON.stringify(line));
    } catch (error) {
      // Held in this process all the same; what is lost is only its surviving a restart, and that is said.
      this.deps.log?.(`quiet queue: ${line.kind} ${line.id} was not written (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private apply(line: LedgerLine): void {
    if (line.kind === "queued") {
      const { kind: _kind, ...message } = line;
      this.queuedEver += 1;
      this.waitingNow.push(message);
    } else if (line.kind === "reworded") {
      this.waitingNow = this.waitingNow.map(message => (message.id === line.id ? { ...message, text: line.text } : message));
    } else {
      this.waitingNow = this.waitingNow.filter(message => message.id !== line.id);
    }
  }

  private restore(path: string): void {
    if (!existsSync(path)) return;
    for (const text of readFileSync(path, "utf8").split("\n")) {
      if (text.trim() === "") continue;
      try {
        this.apply(JSON.parse(text) as LedgerLine);
      } catch {
        // A torn last line is the crash it records; the lines before it still stand.
      }
    }
  }
}

/** What a chat door's sender takes and answers — the outbox sender's shape (outbox-sender.ts). */
interface ChatSend { chatKey: string; text: string; purpose: OutboundPurpose }
interface ChatSent { delivered: boolean; why?: string }

/**
 * Stands where every push into a chat leaves (the channel manager's sender), so no caller chooses
 * whether the rule applies to it. A notice that has to wait is queued and answered as taken:
 * from then on the queue owes its delivery. When its time comes it goes back through the same
 * push, marked as having waited, so the files it names and the outbound gate are read then.
 */
export function quietChatDoor<Input extends ChatSend, Sent extends ChatSent>(
  inner: { send(input: Input, after?: () => Promise<void>): Promise<Sent> },
  queue: QuietQueue,
  deps: {
    conversationOf: (chatKey: string) => string;
    push: (chatKey: string, text: string, purpose: OutboundPurpose) => Promise<ChatSent>;
    /** Kinds of notice the person said never wait (config `quiet.urgent`). */
    approved?: () => readonly string[];
    log?: (line: string) => void;
  }
): { send(input: Input, after?: () => Promise<void>): Promise<Sent | (ChatSent & { queued: string })> } {
  queue.door("chat", async message => {
    const { chatKey, purpose } = message.detail as { chatKey: string; purpose: Extract<OutboundPurpose, { kind: "notice" }> };
    const sent = await deps.push(chatKey, message.text, { ...purpose, urgent: true });
    // Not confirmed is not lost: the push left it with the outbox under a receipt, where it is retried and shown to a person.
    if (!sent.delivered) deps.log?.(`quiet queue: ${message.id} left for ${chatKey} and was not confirmed (${sent.why ?? "no reason given"})`);
  });
  return {
    send(input, after) {
      const conversation = deps.conversationOf(input.chatKey);
      if (!waitsForQuiet(input.purpose, deps.approved?.()) || !queue.holds(conversation)) return inner.send(input, after);
      const from = input.purpose.kind === "notice" ? input.purpose.from : undefined;
      const held = queue.hold({ conversation, text: input.text, via: "chat", detail: { chatKey: input.chatKey, purpose: input.purpose }, ...(from !== undefined ? { agentId: from } : {}) });
      deps.log?.(`quiet queue: ${held.id} for ${input.chatKey} waits until the conversation is quiet, ${queue.capMinutes} min at most`);
      return Promise.resolve({ delivered: true, why: `waiting for the conversation to be quiet (${held.id})`, queued: held.id });
    },
  };
}
