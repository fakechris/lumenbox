/**
 * The labelling sheet of Settings → Supervision → calibration (INV-1773): the latest verdicts, put
 * to a person as the judge's own yes-or-no question about what it read, without the judge's answer
 * — a person shown the verdict agrees with it (src/evals/calibration.ts says the same of the
 * evaluation's sheet).
 *
 * What the page may show. Nothing is stored for it: each verdict's line keeps the hashes and names
 * it kept before, and the page shows only text this installation already keeps readable elsewhere,
 * found again by where the verdict says it came from, and only when that text is the text the
 * judge read — its digest is the verdict's. Every text is scrubbed as the eval candidates are
 * (audit-export.ts `redactLine`, with the values the installation holds). So:
 *
 *   - answer review: the person's message and the agent's reply, from the transcript and the
 *     door's ledger, exactly as `agentbox eval candidates` finds them (eval-candidates.ts). The
 *     review still keeps only hashes; the failing replies INV-1474 keeps are not read here.
 *   - auto-review: the call, from the transcript by its tool_use id, and the person's latest
 *     words before it. The review's line holds neither.
 *   - memory judge: the candidate line, from the agent's memory ledger, where Settings → Memory
 *     already shows it. The conversation it came from is not kept, so it is not shown; whether a
 *     line duplicates or contradicts another needs the line it was compared with, which is not
 *     kept either, so those two questions are never put to a person.
 *   - the decision model's shadow answers keep no locator: they are calibrated by the labels a
 *     person gives the same output under the point's own judge.
 *
 * A verdict whose text cannot be found, or no longer matches, is left out and counted. Only agents
 * the caller may read are drawn from.
 */

import type { AgentRegistry } from "../agents/registry.ts";
import { type HumanLabel, spreadForLabelling } from "../evals/calibration.ts";
import { answerDigest } from "./answer-review.ts";
import { reviewDigest } from "./auto-review.ts";
import { heldValues, redactLine } from "./audit-export.ts";
import { judgedExchange } from "./eval-candidates.ts";
import { outputDigestOf } from "../evals/corpus.ts";
import { type ProductVerdict, QUESTIONS, readVerdicts } from "./judge-record.ts";

export interface SheetPart {
  /** What this text is, as a key the page words (`ui.next.cal.part.<key>`). */
  key: "request" | "reply" | "said" | "call" | "memory";
  text: string;
}

export interface SheetItem {
  question: string;
  digest: string;
  agent: string;
  at: string;
  parts: SheetPart[];
}

export interface Sheet {
  items: SheetItem[];
  /** Latest verdicts not yet labelled whose text could not be shown: gone, changed, or never kept. */
  unshown: number;
}

const CLIP = 4_000;
const clip = (text: string): string => (text.length <= CLIP ? text : `${text.slice(0, CLIP)} …`);

type Block = { type?: string; id?: string; name?: string; input?: unknown };
type Entry = { role?: string; kind?: string; text?: string; blocks?: Block[]; fromPerson?: true };

/** The call and the person's words before it, from the agent's transcript, if the call is there and is the one reviewed. */
function reviewedCall(registry: AgentRegistry, agentId: string, verdict: ProductVerdict): SheetPart[] | undefined {
  const { callId, conversation } = verdict.locate;
  if (callId === undefined || conversation === undefined) return undefined;
  const entries = registry.readTranscript(agentId, conversation) as Entry[];
  const at = entries.findIndex(entry => entry.kind === "blocks" && (entry.blocks ?? []).some(block => block.type === "tool_use" && block.id === callId));
  if (at < 0) return undefined;
  const block = entries[at]!.blocks!.find(one => one.type === "tool_use" && one.id === callId)!;
  const input = (block.input ?? {}) as Record<string, unknown>;
  if (reviewDigest({ callId, tool: String(block.name), input }) !== verdict.digest) return undefined;
  const said = entries.slice(0, at).filter(entry => entry.role === "user" && entry.kind === undefined && entry.fromPerson === true && typeof entry.text === "string").slice(-5);
  return [
    ...said.map(entry => ({ key: "said" as const, text: entry.text! })),
    { key: "call" as const, text: `${String(block.name)} ${JSON.stringify(input, null, 2)}` },
  ];
}

/** The text of one verdict as the page may show it, or undefined. */
function partsOf(home: string, registry: AgentRegistry, verdict: ProductVerdict, mayRead: (agentId: string) => boolean): { agent: string; parts: SheetPart[] } | undefined {
  const agent = registry.list().find(one => one.profile.name === verdict.agent || one.id === verdict.agent);
  if (agent === undefined || !mayRead(agent.id)) return undefined;
  if (verdict.locate.ledger === "answer-review") {
    if (verdict.locate.messageId === undefined) return undefined;
    const found = judgedExchange(home, registry, agent.id, verdict.locate.messageId);
    if (found === undefined || answerDigest(found.request, found.reply) !== verdict.digest) return undefined;
    return { agent: agent.profile.name, parts: [{ key: "request", text: found.request }, { key: "reply", text: found.reply }] };
  }
  if (verdict.locate.ledger === "auto-review") {
    const parts = reviewedCall(registry, agent.id, verdict);
    return parts === undefined ? undefined : { agent: agent.profile.name, parts };
  }
  if (verdict.locate.ledger === "memory-judge") {
    const line = registry.readMemoryRecords(agent.id).find(record => outputDigestOf(record.text) === verdict.digest);
    return line === undefined ? undefined : { agent: agent.profile.name, parts: [{ key: "memory", text: line.text }] };
  }
  return undefined;
}

/**
 * Up to `count` of the latest verdicts nobody has labelled, spread over the questions and over the
 * judge's two answers as the evaluation's sheet is (calibration.ts `spreadForLabelling`), each with
 * what the page may show of it.
 */
export function buildSheet(home: string, registry: AgentRegistry, options: { count: number; labels: readonly HumanLabel[]; mayRead: (agentId: string) => boolean; verdicts?: readonly ProductVerdict[] }): Sheet {
  const labelled = new Set(options.labels.map(label => `${label.question}:${label.outputDigest}`));
  const open = (options.verdicts ?? readVerdicts(home)).filter(verdict => verdict.locate.ledger !== "shadow" && QUESTIONS[verdict.question]?.labellable === true && !labelled.has(`${verdict.question}:${verdict.digest}`));
  // Newest first: the order key falls as the time rises.
  const order = (verdict: ProductVerdict) => String(9e15 - Date.parse(verdict.at)).padStart(20, "0");
  const drawn = spreadForLabelling(open, order, options.count * 4, verdict => verdict.digest);
  const held = heldValues(home);
  const scrub = (text: string) => clip(redactLine(text, held).text);
  const items: SheetItem[] = [];
  let unshown = 0;
  for (const verdict of drawn) {
    if (items.length >= options.count) break;
    const found = partsOf(home, registry, verdict, options.mayRead);
    if (found === undefined) { unshown += 1; continue; }
    items.push({ question: verdict.question, digest: verdict.digest, agent: found.agent, at: verdict.at, parts: found.parts.map(part => ({ key: part.key, text: scrub(part.text) })) });
  }
  return { items, unshown };
}

/** Whether a label names a verdict this installation holds: the page may only label what it drew from. */
export function labelsAVerdict(home: string, question: string, digest: string, verdicts: readonly ProductVerdict[] = readVerdicts(home)): boolean {
  return QUESTIONS[question]?.labellable === true && verdicts.some(verdict => verdict.question === question && verdict.digest === digest);
}
