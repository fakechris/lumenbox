/**
 * The mechanical half of "a synthesis, not a list".
 *
 * The ask of 2026-09-19 had a parenthesis in it doing most of the work: summarise the day
 * **across** it, not by listing what happened. That is a judgement, and judgements are not
 * testable — but the failure has a shape that is. A digest that has given up and gone
 * back to enumerating walks the day's messages in order, one section each, and that is a
 * string fact about the document.
 *
 * So this checks four things, all of them mechanical, none of them semantic:
 *
 * 1. Every citation resolves to something in the package.
 * 2. A sentence citing the agent's own turn carries a second citation, because otherwise
 *    the agent is offering its own words as the evidence for its own words.
 * 3. The short reply is short.
 * 4. **The digest is not a list**, detected as a run of consecutive headings that map,
 *    in order, onto the day's messages.
 *
 * It does not judge whether a source supports a claim. That ceiling is 77% balanced
 * accuracy on the public leaderboard, with 0.4B and 405B models both inside 71.8–77.4, and
 * a judgement wrong one time in four cannot gate delivery (docs/71 §2). Semantics are for
 * the gold days and a person's eye.
 */

import { similarity } from "../quote-check.ts";
import type { DayManifest } from "./assemble.ts";

/** The three things a sentence may point at, all of which must be in the package. */
export type CitationKind = "msg" | "source" | "turn";

export interface Citation {
  kind: CitationKind;
  /** The first eight characters of the id, which is what a reader can hold in their head. */
  key: string;
  /** Where in the document, so a report can point at it. */
  at: number;
}

export interface ValidationProblem {
  /** Short enough to group by, specific enough to act on. */
  kind:
    | "citation-unresolved"
    | "turn-without-backing"
    | "sentence-without-citation"
    | "short-version-too-long"
    | "enumeration"
    | "theme-single-source"
    | "delta-without-baseline";
  detail: string;
}

export interface ValidationReport {
  ok: boolean;
  problems: ValidationProblem[];
  citations: { total: number; byKind: Record<CitationKind, number>; unresolved: number };
  /**
   * How far the digest got through the day's messages in order, one heading each.
   *
   * Reported even when it is under the limit, because the number creeping up over a week
   * is the interesting signal and a boolean hides it.
   */
  enumerationRun: number;
  headings: number;
}

const CITATION = /\[(msg|source|turn):([0-9a-zA-Z_-]{4,64})\]/g;
/** Long enough that three in a row is a pattern; short enough to catch a real slide. */
export const MAX_ENUMERATION_RUN = 2;
/** The reply a person reads in the chat. Past this it is no longer the short version. */
export const SHORT_VERSION_MAX_CHARS = 600;

export function citationsIn(text: string): Citation[] {
  const out: Citation[] = [];
  for (const match of text.matchAll(CITATION)) {
    out.push({ kind: match[1] as CitationKind, key: match[2]!, at: match.index });
  }
  return out;
}

/**
 * Sentences, for the rule about what a sentence must carry.
 *
 * Split on the sentence-enders of both writing systems plus hard breaks. Crude on purpose:
 * a real segmenter would disagree with this one at the edges and the rule it feeds is about
 * whether a citation is *near* a claim, not about where a linguist would put the boundary.
 */
export function sentences(text: string): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!;
    const ender = "。！？!?\n".includes(character) || (character === "." && !/\d/.test(text[i + 1] ?? " "));
    if (!ender) continue;
    const piece = text.slice(start, i + 1);
    if (piece.trim() !== "") out.push({ text: piece, at: start });
    start = i + 1;
  }
  const tail = text.slice(start);
  if (tail.trim() !== "") out.push({ text: tail, at: start });
  return out;
}

/** Markdown headings, in order, with their level. */
export function headings(text: string): { title: string; level: number; at: number }[] {
  const out: { title: string; level: number; at: number }[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match !== null && match[2]!.trim() !== "") {
      out.push({ title: match[2]!.trim(), level: match[1]!.length, at });
    }
    at += line.length + 1;
  }
  return out;
}

/** The opening of a message, which is what a section named after it would be named. */
function messageTitle(text: string): string {
  const firstLine = text.split("\n").find(line => line.trim() !== "") ?? "";
  return firstLine.trim().slice(0, 60);
}

/** The longest ascending run in a sequence where `undefined` breaks it. */
function longestAscendingRun(indices: readonly (number | undefined)[]): number {
  let longest = 0;
  let run = 0;
  let previous = -1;
  for (const index of indices) {
    if (index !== undefined && index > previous) {
      run += 1;
      previous = index;
    } else {
      run = 0;
      previous = index ?? -1;
    }
    longest = Math.max(longest, run);
  }
  return longest;
}

/** The text of each section, split at headings. */
function sections(document: string): { title: string; body: string }[] {
  const marks = headings(document);
  return marks.map((mark, at) => ({
    title: mark.title,
    body: document.slice(mark.at, marks[at + 1]?.at ?? document.length),
  }));
}

/**
 * How far the document walks the day's messages in order, one section at a time.
 *
 * This is the whole "not a list" test, and it asks the question two ways because the
 * obvious way is easy to slip past.
 *
 * **By citation, which needs no threshold.** A list has one section per message: section
 * *k* cites message *k* and nothing else. That is exact, and it survives any amount of
 * rewording — a reworded list still cites the same messages in the same order. This is the
 * primary signal for that reason.
 *
 * **By heading, approximately.** A section named after a message is named after a message
 * even if the naming was paraphrased. Measured: reworded headings score 0.61 to 0.71
 * against the messages they were named after, so the bar sits below that and the citation
 * test carries the cases it misses.
 *
 * A *run* and not a count, because a day with one big thing in it legitimately gets one
 * section about one message. What a synthesis may not do is march.
 */
export function enumerationRun(document: string, messages: readonly { id: string; text: string }[]): number {
  if (messages.length === 0) return 0;
  const keys = messages.map(message => message.id.slice(0, 8));
  const titles = messages.map(message => messageTitle(message.text));
  const parts = sections(document);

  // One message cited and no other: the shape of an entry in a list.
  const byCitation = parts.map(part => {
    const cited = [...new Set(citationsIn(part.body).filter(one => one.kind === "msg").map(one => one.key))];
    if (cited.length !== 1) return undefined;
    const at = keys.indexOf(cited[0]!);
    return at === -1 ? undefined : at;
  });

  const byHeading = parts.map(part => {
    let best: { index: number; score: number } | undefined;
    for (const [index, title] of titles.entries()) {
      if (title.length < 6) continue;
      // `similarity` and not `locateQuote`: the latter refuses anything under twelve folded
      // characters, which is right when searching a long source and wrong here. A ten
      // character Chinese heading is a real heading, and refusing it let a list through.
      const score = similarity(part.title, title);
      if (score >= 0.6 && score > (best?.score ?? 0)) best = { index, score };
    }
    return best?.index;
  });

  return Math.max(longestAscendingRun(byCitation), longestAscendingRun(byHeading));
}

export interface ValidateInput {
  /** The digest as written. */
  draft: string;
  /** The short version that goes to the chat. */
  shortVersion?: string;
  manifest: DayManifest;
  /** Yesterday's theme names, if there was a yesterday. Delta verbs need a baseline. */
  previousThemes?: readonly string[];
}

const DELTA_VERBS = /\b(NEW|STRENGTHENED|CONTRADICTED)\b/;

/**
 * Checks a digest against the package it came from.
 *
 * Everything here is a string fact. A report with no problems does not mean the digest is
 * good; it means it is not one of the four ways of being mechanically wrong.
 */
export function validateDigest(input: ValidateInput): ValidationReport {
  const { draft, manifest } = input;
  const problems: ValidationProblem[] = [];

  const known = {
    msg: new Set(manifest.messages.map(one => one.id.slice(0, 8))),
    source: new Set(manifest.sources.map(one => one.key)),
    turn: new Set(manifest.turns.map(one => one.id.slice(0, 8))),
  };

  const all = citationsIn(draft);
  const byKind: Record<CitationKind, number> = { msg: 0, source: 0, turn: 0 };
  let unresolved = 0;
  for (const citation of all) {
    byKind[citation.kind] += 1;
    if (!known[citation.kind].has(citation.key)) {
      unresolved += 1;
      problems.push({
        kind: "citation-unresolved",
        detail: `[${citation.kind}:${citation.key}] is not in this package`,
      });
    }
  }

  // A sentence that cites only the agent's own turn is offering its own words as the
  // evidence for its own words. Prose with no citation at all is fine in a heading or a
  // connective; the rule is about sentences that carry a claim, and a `[turn:]` is the
  // clearest signal that one does.
  for (const sentence of sentences(draft)) {
    const here = citationsIn(sentence.text);
    if (here.length === 0) continue;
    if (here.every(one => one.kind === "turn")) {
      problems.push({
        kind: "turn-without-backing",
        detail: `a sentence cites only the agent's own turn: "${sentence.text.trim().slice(0, 70)}"`,
      });
    }
  }

  if (input.shortVersion !== undefined && input.shortVersion.length > SHORT_VERSION_MAX_CHARS) {
    problems.push({
      kind: "short-version-too-long",
      detail: `the short version is ${input.shortVersion.length} characters; ${SHORT_VERSION_MAX_CHARS} is the limit`,
    });
  }

  const run = enumerationRun(draft, manifest.messages);
  if (run > MAX_ENUMERATION_RUN) {
    problems.push({
      kind: "enumeration",
      detail:
        `${run} consecutive sections walk the day's messages in order. That is the list this ` +
        "was asked not to be. Organise by what the day was about, not by what arrived.",
    });
  }

  // A delta verb says something changed since yesterday. Without yesterday it is a guess
  // wearing the clothes of a measurement.
  if (DELTA_VERBS.test(draft) && (input.previousThemes === undefined || input.previousThemes.length === 0)) {
    problems.push({
      kind: "delta-without-baseline",
      detail: "NEW / STRENGTHENED / CONTRADICTED appear, but there is no previous day to compare against",
    });
  }

  return {
    ok: problems.length === 0,
    problems,
    citations: { total: all.length, byKind, unresolved },
    enumerationRun: run,
    headings: headings(draft).length,
  };
}

/** The report, for a person or for a skill to read back and fix. */
export function describeValidation(report: ValidationReport): string[] {
  const lines = [
    report.ok ? "Digest passes the mechanical checks." : `Digest has ${report.problems.length} problem(s).`,
    `  citations: ${report.citations.total} (${report.citations.byKind.msg} msg, ` +
      `${report.citations.byKind.source} source, ${report.citations.byKind.turn} turn), ` +
      `${report.citations.unresolved} unresolved`,
    `  headings: ${report.headings}; longest run walking the day's messages in order: ${report.enumerationRun}`,
  ];
  // Grouped, because twelve unresolved citations is one problem to fix and not twelve.
  const byKind = new Map<string, string[]>();
  for (const problem of report.problems) {
    const at = byKind.get(problem.kind) ?? [];
    at.push(problem.detail);
    byKind.set(problem.kind, at);
  }
  for (const [kind, details] of byKind) {
    lines.push(`  ${kind} (${details.length}):`);
    for (const detail of details.slice(0, 5)) lines.push(`    ${detail}`);
    if (details.length > 5) lines.push(`    … and ${details.length - 5} more`);
  }
  return lines;
}
