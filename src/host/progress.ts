/**
 * Telling a turn that is stuck from one that is merely long.
 *
 * A turn ran up to four hundred rounds and then ended with a note saying the agent was "probably
 * looping". Two things were wrong with that. The diagnosis was a guess — a genuinely long task looks
 * identical from there — and there was no continuation, so the work was abandoned at the limit with
 * whatever it had done left half-finished.
 *
 * Both are now answerable because the agent keeps state that says what it is trying to do
 * ([durable.ts](durable.ts)). So:
 *
 *   - **A loop is detected when it starts, not at round four hundred.** An agent repeating the same
 *     call has already wasted every round since the second one; there is nothing to learn from
 *     letting it do three hundred more.
 *   - **At the limit, the two cases are distinguished and reported differently.** A loop is stopped
 *     with the repeated call quoted, which is worth more than any adjective. Real progress means the
 *     turn hit a *budget*, not a wall, and is continued rather than abandoned.
 *
 * Continuation is deliberately conservative. An agent that continues itself is the exact shape the
 * wake-rate limit exists to catch, so a continuation goes through the same policy gate as any other
 * wake, is only granted while progress is actually being made, and is bounded anyway. A turn that
 * continues forever is worse than one that stops, because it stops *visibly*.
 */

import { envNumber } from "../config.ts";
import { createHash } from "node:crypto";
import type { DurableState } from "./durable.ts";

/** What one round did, reduced to what matters for deciding whether anything is happening. */
export interface RoundRecord {
  /** One entry per tool call: the tool and a hash of its input. */
  signatures: readonly string[];
  /** A hash of the plan and todo list as they stood at the end of the round. */
  stateHash: string;
}

/**
 * The signature of a tool call.
 *
 * Name plus a hash of the input, because the input is what distinguishes `bash: ls` from
 * `bash: rm -rf`. Keys are sorted so two identical calls whose arguments arrived in a different order
 * are recognised as identical — otherwise a loop would hide behind key ordering.
 */
export function signatureOf(tool: string, input: unknown): string {
  return `${tool}:${createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
}

/** A hash of the state that says what the agent is trying to do. Changes mean something moved. */
export function stateHashOf(state: DurableState): string {
  const shape = {
    plan: state.plan?.trim() ?? "",
    todos: (state.todos ?? []).map(item => `${item.status}:${item.text}`),
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16);
}

/**
 * How many consecutive rounds of the same single call count as a loop.
 *
 * Four rather than two, because a legitimate repeat exists: taking a screenshot, checking whether a
 * page finished loading, polling a build. Three of those in a row is patience; four with nothing else
 * happening and no change to what the agent says it is doing is a loop.
 */
const LOOP_THRESHOLD = envNumber("AGENTBOX_LOOP_ROUNDS", 4);

export interface LoopFinding {
  /** The call being repeated, for the message. An adjective is worth less than the actual call. */
  signature: string;
  rounds: number;
}

/**
 * Whether the recent rounds are one call repeating with nothing else moving.
 *
 * Three conditions, all required, because any one alone has a false positive:
 *
 *   - the same single signature in every recent round — varied work is not a loop;
 *   - no other tool called alongside it — an agent alternating two calls is doing something;
 *   - the plan and todo list unchanged — an agent that ticked something off made progress, whatever
 *     its calls looked like.
 */
export function detectLoop(rounds: readonly RoundRecord[]): LoopFinding | undefined {
  if (rounds.length < LOOP_THRESHOLD) return undefined;
  const window = rounds.slice(-LOOP_THRESHOLD);

  const signatures = new Set(window.flatMap(round => round.signatures));
  if (signatures.size !== 1) return undefined;
  // A round with no calls at all is the model talking, which is not a loop.
  if (window.some(round => round.signatures.length === 0)) return undefined;

  const states = new Set(window.map(round => round.stateHash));
  if (states.size > 1) return undefined;

  return { signature: [...signatures][0]!, rounds: window.length };
}

/**
 * Whether anything moved across the whole turn.
 *
 * Used at the round limit to decide between "stuck" and "out of budget". Deliberately generous: a
 * turn that changed its todo list once in four hundred rounds was making progress, slowly, and
 * abandoning it would throw that away. The narrow judgement is `detectLoop`'s job.
 */
export function hasProgressed(rounds: readonly RoundRecord[]): boolean {
  if (rounds.length === 0) return false;
  const states = new Set(rounds.map(round => round.stateHash));
  if (states.size > 1) return true;
  // No state change: progress is then whether the work itself varied, since an agent doing many
  // different things without a todo list is still working.
  const signatures = new Set(rounds.flatMap(round => round.signatures));
  return signatures.size > 1;
}

export type LimitOutcome =
  /** Stuck. Say what the loop was and stop. */
  | { kind: "looping"; finding: LoopFinding }
  /** Working, and out of rounds. Worth continuing. */
  | { kind: "progressing" }
  /** Neither: it ran out of rounds without repeating and without changing anything. */
  | { kind: "inconclusive" };

export function classifyLimit(rounds: readonly RoundRecord[]): LimitOutcome {
  const loop = detectLoop(rounds);
  if (loop !== undefined) return { kind: "looping", finding: loop };
  return hasProgressed(rounds) ? { kind: "progressing" } : { kind: "inconclusive" };
}

/**
 * How many times one piece of work may continue past the round limit.
 *
 * Bounded even though continuation already requires progress, because "progress" is a heuristic and a
 * heuristic that gates an unbounded loop is an unbounded loop. Three continuations is 1,600 rounds,
 * which is far past any task that was going to finish.
 */
export const MAX_CONTINUATIONS = envNumber("AGENTBOX_MAX_CONTINUATIONS", 3);

/** What the agent is told when its turn is continued rather than ended. */
export function continuationPrompt(round: number, continuation: number): string {
  return [
    `You have used ${round} tool rounds, which is the limit for one turn, and you were still making`,
    `progress — so this is a fresh turn rather than a failure. This is continuation ${continuation}`,
    `of at most ${MAX_CONTINUATIONS}.`,
    "",
    "Your plan and todo list are in your instructions above and are unchanged; the earlier part of",
    "the conversation may have been summarised. Pick up from the first item that is not done.",
    "",
    "If the work will not fit in the remaining continuations, stop and say what is left instead of",
    "starting something you cannot finish.",
  ].join("\n");
}

/** What the transcript says when a loop was detected, whether early or at the limit. */
export function loopReport(finding: LoopFinding, round: number): string {
  const tool = finding.signature.split(":")[0] ?? "a tool";
  return [
    `Stopping: the last ${finding.rounds} rounds all made the same \`${tool}\` call with the same`,
    `arguments, and neither the plan nor the todo list changed. That is a loop rather than slow`,
    `progress, and ${round} rounds of it is enough to be sure.`,
    "",
    "Say what you were trying to achieve with that call and what you expected it to change. If it",
    "needs something you do not have, say so rather than repeating it.",
  ].join("\n");
}
