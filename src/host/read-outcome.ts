/**
 * One line, first, saying what a read actually got.
 *
 * Six tools read something into a turn — WebFetch, WebSearch, ReadFeishuDoc, read_file,
 * ReadHistory, browser_read — and each of them used to describe an incomplete read in its
 * own prose, at the end: "[... rest of page not shown]", "[文档过长,已截断…]", "showing part
 * of 412 lines", "the 25 most recent are above". Six wordings, no common field, and every
 * one of them at the bottom.
 *
 * The bottom is the wrong end. A tool result is cut to `DURABLE_RESULT_CHARS` when the
 * transcript stores it (turn.ts), so what survives is the *head* — and the head of a web
 * page is its navigation. Measured on a real case (docs/69): a page whose text was 6,390
 * characters, 82% of the article it was asked for, was recorded as two thousand characters
 * of "Log in / Sign up". Nothing in the record said the read had gone well or badly.
 *
 * So the shape of the read goes first, in one machine-readable line:
 *
 *   [read: clipped — 40,000 of 61,606 chars, 57 prose blocks, 576 links; the rest is not
 *   shown; fetch a narrower URL or open it with browser_open]
 *
 * It is deliberately a *measurement*, not a verdict on whether the content is any good.
 * An earlier draft of this module tried to classify pages as "shell" (a JavaScript app
 * that had served navigation instead of content) from structure alone. Measured against
 * real pages that idea failed outright: the x.com page scored 0.78 prose-to-text where
 * Wikipedia scored 0.26, so the rule would have called the encyclopedia a shell and the
 * app a document. Reporting the numbers is honest; guessing the verdict was not.
 */

/** What a read got, as far as the reader can honestly tell. */
export type ReadCompleteness =
  /** Everything the source offered, within the tool's limits. */
  | "full"
  /** The source had more; a limit cut it. The line says how much of how much. */
  | "clipped"
  /** The other end served an interstitial instead of the content. */
  | "blocked"
  /** There was nothing to read: a status code, a tombstone, a deleted thing. */
  | "unavailable"
  /** Not a document read at all — search results, which are the engine's words. */
  | "summary";

/**
 * What was counted. Every field is optional because the six readers count different
 * things; a file has lines, a search has results, a page has prose blocks.
 */
export interface ReadShape {
  /** Characters handed to the model. */
  chars?: number;
  /** Characters the source had, when that is known and larger. */
  totalChars?: number;
  lines?: number;
  totalLines?: number;
  entries?: number;
  totalEntries?: number;
  results?: number;
  /**
   * Blocks of at least `PROSE_BLOCK_CHARS` characters once markdown links are removed.
   * A count, not a judgement: it says how much of the text is not link labels.
   */
  prose?: number;
  links?: number;
}

/** A block this long, outside links, is prose rather than a label. */
export const PROSE_BLOCK_CHARS = 40;

/** Matches the line this module writes, so tests and later readers can parse it back. */
export const READ_OUTCOME_PATTERN = /^\[read: (full|clipped|blocked|unavailable|summary)\b[^\]]*\]/;

const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/g;

/**
 * Counts the shape of a block of extracted text.
 *
 * Links are removed before the prose is measured because a navigation-heavy page is
 * mostly link labels, and counting those as prose is what made the naive version of this
 * useless.
 */
export function textShape(text: string): { chars: number; prose: number; links: number } {
  const links = (text.match(MARKDOWN_LINK) ?? []).length;
  const prose = text
    .replace(MARKDOWN_LINK, " ")
    .split(/\n\s*\n/)
    .filter(block => block.trim().length >= PROSE_BLOCK_CHARS).length;
  return { chars: text.length, prose, links };
}

function number(value: number): string {
  return value.toLocaleString("en-US");
}

/** The counted part, in the order a person reads it: how much, of how much, of what kind. */
function countsOf(shape: ReadShape): string[] {
  const counts: string[] = [];
  if (shape.chars !== undefined) {
    counts.push(
      shape.totalChars !== undefined && shape.totalChars > shape.chars
        ? `${number(shape.chars)} of ${number(shape.totalChars)} chars`
        : `${number(shape.chars)} chars`
    );
  }
  if (shape.lines !== undefined) {
    counts.push(
      shape.totalLines !== undefined && shape.totalLines > shape.lines
        ? `${number(shape.lines)} of ${number(shape.totalLines)} lines`
        : `${number(shape.lines)} lines`
    );
  }
  if (shape.entries !== undefined) {
    counts.push(
      shape.totalEntries !== undefined && shape.totalEntries > shape.entries
        ? `${number(shape.entries)} of ${number(shape.totalEntries)} entries`
        : `${number(shape.entries)} entries`
    );
  }
  if (shape.results !== undefined) counts.push(`${number(shape.results)} results`);
  if (shape.prose !== undefined) counts.push(`${number(shape.prose)} prose blocks`);
  if (shape.links !== undefined) counts.push(`${number(shape.links)} links`);
  return counts;
}

export interface ReadOutcomeInput {
  completeness: ReadCompleteness;
  shape?: ReadShape;
  /** What happened, in a clause. No trailing stop. */
  note?: string;
  /** What to do about it, when there is something to do. No trailing stop. */
  hint?: string;
}

/**
 * The line. Put it first in the tool result, always — it is what survives the
 * transcript's cut, and it is the only part a later reader can rely on being there.
 */
export function readOutcome(input: ReadOutcomeInput): string {
  const parts: string[] = [input.completeness];
  const counts = countsOf(input.shape ?? {});
  if (counts.length > 0) parts.push(`— ${counts.join(", ")}`);
  const tail = [input.note, input.hint].filter((piece): piece is string => piece !== undefined && piece !== "");
  return `[read: ${parts.join(" ")}${tail.length > 0 ? `; ${tail.join("; ")}` : ""}]`;
}

/** Puts the line where it belongs, with the body under it. */
export function withReadOutcome(input: ReadOutcomeInput, body: string): string {
  return `${readOutcome(input)}\n\n${body}`;
}

export interface ParsedReadOutcome {
  completeness: ReadCompleteness;
  /** Everything after the verdict, as written. */
  detail: string;
}

/** Reads the line back — for tests, for the guard, and for anything auditing a transcript. */
export function parseReadOutcome(text: string): ParsedReadOutcome | undefined {
  const match = READ_OUTCOME_PATTERN.exec(text.trimStart());
  if (match === null) return undefined;
  const whole = match[0];
  return {
    completeness: match[1] as ReadCompleteness,
    detail: whole.slice(`[read: ${match[1]}`.length, -1).replace(/^[\s—;]+/, "").trim(),
  };
}
