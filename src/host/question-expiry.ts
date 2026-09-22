/**
 * Questions that expire (INV-526): an unanswered question stops being a stall.
 *
 * The failure it answers: a bot put five open questions to a person and waited four
 * weeks. Nothing in the system knew the questions were still open, so nothing could
 * act. Now every AskUser is watched: when its window passes without a reply in the
 * conversation that asked, the agent is woken with one of two cues — proceed on the
 * default it named, and say so; or, with no default, the person has moved on and the
 * question is skipped: decide, say which way, go on. Grok Bot expires its question
 * widgets the same way ("moved on without responding — treat it as skipped").
 *
 * A reply is the person who was asked speaking again (INV-533): tapping a card, typing
 * an answer, or giving a new instruction all count, and the watch clears itself without
 * being told. Somebody *else* in the room does not count — a group where a colleague
 * asks about lunch is not an answer about which account to bill, and the first version
 * read any message in the conversation as one. Where nobody was named — a question asked
 * from the page — any voice in that conversation is the voice that was asked.
 *
 * Pending questions outlive the process: a restart used to lose the question, its
 * default and its clock, which is the same silence the watch exists to end. The ledger
 * is the record, replayed on start.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { appendLine } from "./jsonl.ts";

export interface WatchedQuestion {
  /** Short and unique: what the ledger, the card and a late answer all name. */
  id: string;
  agentId: string;
  agentName: string;
  conversation: string;
  question: string;
  /** What the agent said it would do without an answer. */
  fallback?: string;
  /** Who was asked, when a person was: only their reply answers it. */
  asker?: string;
  askedAt: number;
  expiresAt: number;
}

export type Expiry =
  | { question: WatchedQuestion; verdict: "answered" }
  | { question: WatchedQuestion; verdict: "superseded" }
  | { question: WatchedQuestion; verdict: "default"; cue: string; toChat: string }
  | { question: WatchedQuestion; verdict: "skipped"; cue: string; toChat: string };

/** The default window, when the agent names none. Long enough for a working day, short enough that a week does not pass. */
export const QUESTION_TTL_MS = 4 * 3_600_000;
export const QUESTION_TTL_MAX_MS = 7 * 86_400_000;
export const QUESTION_TTL_MIN_MS = 5 * 60_000;

export const QUESTION_EXPIRED_CUE = "[question expired]";

export class QuestionWatch {
  private readonly pending = new Map<string, WatchedQuestion>();
  /** Questions the person answered, by id, until the next sweep settles them. */
  private readonly answered = new Set<string>();
  private counter = 0;

  /**
   * `path` is the ledger: every ask and every settlement, appended, replayed on start.
   * Without it the watch is memory only — which is what the tests want and what a
   * restart must not be.
   */
  constructor(private readonly path?: string, private readonly onLine?: (line: string) => void) {
    if (path !== undefined) this.restore(path);
  }

  private keyOf(agentId: string, conversation: string): string {
    return `${agentId}/${conversation}`;
  }

  private nextId(now: number): string {
    this.counter += 1;
    return `q${now.toString(36)}${this.counter.toString(36)}`;
  }

  /**
   * Watches a question. A second question in the same conversation supersedes the first
   * rather than deleting it: the earlier one is settled as `superseded` and said so in
   * the ledger, because a question that vanished without a verdict is exactly the hole
   * this file exists to close.
   */
  ask(input: { agentId: string; agentName: string; conversation: string; question: string; fallback?: string; asker?: string; ttlMs?: number; now?: number }): { question: WatchedQuestion; superseded?: WatchedQuestion } {
    const now = input.now ?? Date.now();
    const ttl = Math.min(QUESTION_TTL_MAX_MS, Math.max(QUESTION_TTL_MIN_MS, input.ttlMs ?? QUESTION_TTL_MS));
    const key = this.keyOf(input.agentId, input.conversation);
    const superseded = this.pending.get(key);
    if (superseded !== undefined) {
      this.pending.delete(key);
      this.append({ kind: "settled", id: superseded.id, at: new Date(now).toISOString(), verdict: "superseded" });
    }
    const watched: WatchedQuestion = {
      id: this.nextId(now),
      agentId: input.agentId,
      agentName: input.agentName,
      conversation: input.conversation,
      question: input.question,
      ...(input.fallback !== undefined ? { fallback: input.fallback } : {}),
      ...(input.asker !== undefined ? { asker: input.asker } : {}),
      askedAt: now,
      expiresAt: now + ttl,
    };
    this.pending.set(key, watched);
    this.append({ kind: "asked", at: new Date(now).toISOString(), ...watched });
    return { question: watched, ...(superseded !== undefined ? { superseded } : {}) };
  }

  /**
   * Who the door actually reached, learned after the ask (the card is addressed by the
   * same call that returns the identity). Until it is set, the question is nobody's in
   * particular and the transcript rule applies.
   */
  setAsker(id: string, asker: string): void {
    for (const [key, question] of this.pending) {
      if (question.id !== id) continue;
      this.pending.set(key, { ...question, asker });
      this.append({ kind: "asked", at: new Date(question.askedAt).toISOString(), ...question, asker });
      return;
    }
  }

  list(): WatchedQuestion[] {
    return [...this.pending.values()].map(question => ({ ...question }));
  }

  /**
   * The person who was asked has spoken (INV-533). Called from the door a reply comes
   * through, with the identity it came from; questions put to somebody else in the same
   * room are untouched.
   */
  noteReply(agentId: string, identity: string, questionId: string, conversation: string, now = Date.now()): WatchedQuestion[] {
    const hit: WatchedQuestion[] = [];
    for (const question of this.pending.values()) {
      if (question.agentId !== agentId || question.asker !== identity || question.id !== questionId || question.conversation !== conversation || question.expiresAt <= now) continue;
      if (this.answered.has(question.id)) continue;
      // Persist acceptance now: a restart before the periodic sweep must not apply the
      // fallback after the person's answer was already admitted.
      this.append({ kind: "settled", id: question.id, at: new Date(now).toISOString(), verdict: "answered" });
      this.answered.add(question.id);
      hit.push({ ...question });
    }
    return hit;
  }

  /**
   * Settles what is due. `answeredSince(question)` says whether the conversation moved on
   * without a named person — the caller reads it off the transcript, and it is consulted
   * only for questions nobody was named in. Everything settled is removed from the watch.
   */
  sweep(answeredSince: (question: WatchedQuestion) => boolean, now = Date.now()): Expiry[] {
    const out: Expiry[] = [];
    for (const [key, question] of this.pending) {
      const replied = question.asker !== undefined ? this.answered.has(question.id) : answeredSince(question);
      if (replied) {
        this.pending.delete(key);
        this.answered.delete(question.id);
        this.append({ kind: "settled", id: question.id, at: new Date(now).toISOString(), verdict: "answered" });
        out.push({ question, verdict: "answered" });
        continue;
      }
      if (question.expiresAt > now) continue;
      this.pending.delete(key);
      const waited = describeWait(question.expiresAt - question.askedAt);
      const verdict = question.fallback !== undefined ? "default" : "skipped";
      this.append({ kind: "settled", id: question.id, at: new Date(now).toISOString(), verdict, agentId: question.agentId, conversation: question.conversation, question: question.question, ...(question.fallback !== undefined ? { fallback: question.fallback } : {}) });
      if (question.fallback !== undefined) {
        out.push({
          question,
          verdict: "default",
          cue:
            `${QUESTION_EXPIRED_CUE} No answer in ${waited} to your question "${question.question}". ` +
            `Proceed on the default you named — ${question.fallback} — and say in one line that you went with it. Do not ask again.`,
          toChat: `${question.agentName}: no answer to "${question.question}" in ${waited} — going with the default: ${question.fallback}`,
        });
      } else {
        out.push({
          question,
          verdict: "skipped",
          cue:
            `${QUESTION_EXPIRED_CUE} No answer in ${waited} to your question "${question.question}". ` +
            "The person has moved on; treat it as skipped: decide it yourself, say plainly which way you went and why, and go on. Do not ask again.",
          toChat: `${question.agentName}: no answer to "${question.question}" in ${waited} — deciding without one and saying which way.`,
        });
      }
    }
    return out;
  }

  private append(line: Record<string, unknown>): void {
    const text = JSON.stringify(line);
    this.onLine?.(text);
    if (this.path === undefined) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendLine(this.path, text);
    } catch {
      // A question the ledger could not record is still a question being watched; the
      // one thing that must not happen is losing it because the disk was busy.
    }
  }

  /** Replays the ledger: every ask without a settlement is still pending (INV-533). */
  private restore(path: string): void {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return;
    }
    const asked = new Map<string, WatchedQuestion>();
    const settled = new Set<string>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Lines from before the ledger recorded asks are settlements, and say nothing
      // about anything still open.
      if (entry.kind === "asked" && typeof entry.id === "string") asked.set(entry.id, entry as unknown as WatchedQuestion);
      else if (typeof entry.id === "string") settled.add(entry.id);
    }
    for (const [id, question] of asked) {
      if (settled.has(id)) continue;
      this.pending.set(this.keyOf(question.agentId, question.conversation), question);
    }
  }
}

function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}
