/**
 * Remembering how something went wrong, so the next attempt does not learn it again.
 *
 * Memory held what is *true* — facts, notes, episodes. Nothing held what *goes wrong*, and
 * that is where the expensive knowledge is: the walls this system has hit cost hours each
 * to find and were written down nowhere an agent reads. See docs/19.
 *
 * **The admission test.** `memory.ts` rejected a "profile" tier on the grounds that a tier
 * nobody can populate correctly is worse than one list scored honestly — each kind must
 * have an unambiguous source. So a pitfall may not be written whenever something feels
 * like a lesson. It is written from exactly four events the harness *observes*:
 *
 *   - a turn that repeated itself until the loop detector stopped it;
 *   - a task an agent parked on `blocked`, in its own words;
 *   - an audit that sent work back with findings;
 *   - a self-acceptance the review gate refused.
 *
 * Not from a tool error: tools fail constantly and recoverably, and a registry of `ENOENT`
 * teaches nothing while crowding out what matters.
 *
 * **Answer-agnostic or not written at all.** "抓取竞品价格要先登录后台" is a fact about one
 * task; "a page that returns 200 with an empty table may be a logged-out view — check for
 * the login wall before parsing" is a pitfall. The distiller is allowed — instructed — to
 * find nothing, the same discipline as the extractor: an extractor that must produce
 * output invents, and an invented hazard is read on every future turn.
 *
 * Borrowed and named: Antigravity's Teamwork distils verifier findings into an
 * "answer-agnostic pitfall registry" that outlives the attempt that produced it.
 */

import type { MemoryRecord } from "./memory.ts";
import { MAX_RECORD_CHARS, NOTHING_TO_KEEP } from "./memory.ts";

/** What went wrong, as the harness saw it. Each maps to one observed event, never a judgement. */
export type PitfallSource = "loop" | "blocked" | "audit-returned" | "self-accept-refused";

/** How each source is described to the distiller, and recorded for a person reading the file. */
const SOURCE_LABEL: Record<PitfallSource, string> = {
  loop: "the agent repeated the same call until it was stopped",
  blocked: "the agent parked the work as blocked and said why",
  "audit-returned": "an independent reviewer sent the work back",
  "self-accept-refused": "the agent believed it was done and the review gate disagreed",
};

/**
 * The prompt that turns one observed failure into a line worth keeping, or into nothing.
 *
 * `attempt` is what was being tried, `detail` is what the system recorded about the
 * failure — a loop report, a blocked note, an audit's findings. Both are the harness's
 * own record, not the agent's account of itself.
 */
export function buildPitfallPrompt(input: {
  source: PitfallSource;
  attempt: string;
  detail: string;
}): string {
  return [
    `Something went wrong: ${SOURCE_LABEL[input.source]}.`,
    "",
    "Write the one sentence a stranger attempting something *similar* would need in order not to",
    "walk into the same wall. Name the symptom they would see and what it actually means, or the",
    "check that would have caught it early.",
    "",
    `Reply with ${NOTHING_TO_KEEP} and nothing else if the lesson does not survive removing this`,
    "task's specifics — if it is about this file, this site, this account, this number, it is not a",
    "pitfall and writing it down makes future prompts worse, not better. Most failures are ordinary",
    "and teach nothing.",
    "",
    "One line, no preamble, no numbering. It must make sense with none of this context around it.",
    "",
    "--- what was being attempted ---",
    input.attempt.slice(0, 2_000),
    "",
    "--- what the system recorded ---",
    input.detail.slice(0, 4_000),
  ].join("\n");
}

/**
 * Reads a distiller reply into a record, or nothing.
 *
 * Strict in the same places as the extractor, and one more: a pitfall is one line. A model
 * that answered with a paragraph did not follow the brief, and the brief is what makes the
 * line worth its place in every future prompt.
 */
export function parsePitfall(
  reply: string,
  source: PitfallSource,
  now = new Date()
): MemoryRecord | undefined {
  const trimmed = reply.trim();
  if (trimmed === "") return undefined;
  if (trimmed.replace(/[^a-z]/gi, "").toUpperCase() === NOTHING_TO_KEEP) return undefined;

  const first = trimmed
    .split("\n")
    .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .find(line => line !== "");
  if (first === undefined) return undefined;
  // A sentinel that arrived with punctuation or inside a sentence of its own.
  if (first.replace(/[^a-z]/gi, "").toUpperCase() === NOTHING_TO_KEEP) return undefined;
  if (first.length > MAX_RECORD_CHARS) return undefined;
  // Below this it is an interjection, not a lesson — "It failed.", "Timed out."
  if (first.length < 20) return undefined;

  return { at: now.toISOString(), kind: "pitfall", text: first, source: `pitfall:${source}` };
}
