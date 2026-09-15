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
 * A reply is anything the person said in that conversation after the question was
 * asked, read off the transcript — so answering in words, tapping a card, or simply
 * giving new instructions all count, and the watch clears itself without being told.
 */

export interface WatchedQuestion {
  agentId: string;
  agentName: string;
  conversation: string;
  question: string;
  /** What the agent said it would do without an answer. */
  fallback?: string;
  askedAt: number;
  expiresAt: number;
}

export type Expiry =
  | { question: WatchedQuestion; verdict: "answered" }
  | { question: WatchedQuestion; verdict: "default"; cue: string; toChat: string }
  | { question: WatchedQuestion; verdict: "skipped"; cue: string; toChat: string };

/** The default window, when the agent names none. Long enough for a working day, short enough that a week does not pass. */
export const QUESTION_TTL_MS = 4 * 3_600_000;
export const QUESTION_TTL_MAX_MS = 7 * 86_400_000;
export const QUESTION_TTL_MIN_MS = 5 * 60_000;

export const QUESTION_EXPIRED_CUE = "[question expired]";

export class QuestionWatch {
  private readonly pending = new Map<string, WatchedQuestion>();

  private keyOf(agentId: string, conversation: string): string {
    return `${agentId}/${conversation}`;
  }

  /** Watches a question; a second question in the same conversation replaces the first. */
  ask(input: { agentId: string; agentName: string; conversation: string; question: string; fallback?: string; ttlMs?: number; now?: number }): WatchedQuestion {
    const now = input.now ?? Date.now();
    const ttl = Math.min(QUESTION_TTL_MAX_MS, Math.max(QUESTION_TTL_MIN_MS, input.ttlMs ?? QUESTION_TTL_MS));
    const watched: WatchedQuestion = {
      agentId: input.agentId,
      agentName: input.agentName,
      conversation: input.conversation,
      question: input.question,
      ...(input.fallback !== undefined ? { fallback: input.fallback } : {}),
      askedAt: now,
      expiresAt: now + ttl,
    };
    this.pending.set(this.keyOf(input.agentId, input.conversation), watched);
    return watched;
  }

  list(): WatchedQuestion[] {
    return [...this.pending.values()].map(question => ({ ...question }));
  }

  /**
   * Settles what is due. `answeredSince(question)` says whether the person spoke in that
   * conversation after the ask; the caller reads it off the transcript. Everything
   * settled is removed from the watch, answered or not.
   */
  sweep(answeredSince: (question: WatchedQuestion) => boolean, now = Date.now()): Expiry[] {
    const out: Expiry[] = [];
    for (const [key, question] of this.pending) {
      if (answeredSince(question)) {
        this.pending.delete(key);
        out.push({ question, verdict: "answered" });
        continue;
      }
      if (question.expiresAt > now) continue;
      this.pending.delete(key);
      const waited = describeWait(question.expiresAt - question.askedAt);
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
}

function describeWait(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}
