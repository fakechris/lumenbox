/**
 * What an exchange teaches, as decisions about the memory that already exists (INV-733).
 *
 * The extractor used to return plain lines, each a new note. That had three costs. A fact that
 * changed was written beside the old one, both dated, both believed. A preference said for the
 * fifth time was dropped as "already known", so it kept decaying as if it had been said once.
 * And a line said nothing about where in the conversation it came from beyond the exchange.
 *
 * So each item is now one of three decisions, and each rests on the person's own words:
 *
 *   - **`create`** — something new. A change ("now", "from now on", "we moved") is a create, not a
 *     correction: the old line was true when it was said, and the reader weighs the two by date.
 *   - **`confirm`** — they said again what a remembered line holds. The line is written again,
 *     dated now, with this place added to its `from`: its decay starts over, its history stays.
 *   - **`correct`** — they said a remembered line was wrong. A retraction of it, then the new line,
 *     both citing where they said so: the withdrawal semantics every other writer uses.
 *
 * `target` must be one of the remembered lines shown in this very call, by number. A number that
 * names nothing shown is not guessed at.
 *
 * **The quote is the admission test.** Every item quotes what the person said, and the quote must
 * be found, exactly, in a stretch headed as the person's own words — `locateQuote`, exact hits
 * only; the near-match it also reports is a pointer, not evidence. What the host wrote, what a
 * teammate sent and what the agent replied are never the person's (INV-829), so an item resting
 * on them is dropped. Where the quote is found is also where the item came from: `from` is the
 * exchange(s) holding it, not a number the model chose.
 *
 * Nothing here trusts the reply's shape. A line that is not JSON, an op that is not one of the
 * three, a target not offered, a quote not found: each loses that one item, never the batch, and
 * is counted so the log can say what was lost and why.
 */

import { dedupeKey, isNothing, type MemoryRecord, NOTHING_TO_KEEP, validateRecord } from "./memory.ts";
import { fold, locateQuote } from "./quote-check.ts";

export type ExtractionOp = "create" | "confirm" | "correct";
const OPS: readonly ExtractionOp[] = ["create", "confirm", "correct"];

/** The instruction says three; the parser enforces it rather than trusting it. */
export const MAX_EXTRACTED = 3;

/**
 * How many places one record's `from` keeps. A preference confirmed every week would otherwise
 * grow a line without bound; the first place (where it was learned) and the newest are kept.
 */
export const MAX_FROM = 8;

/** One accepted decision. `target` is the remembered record it is about, for confirm and correct. */
export interface ExtractedItem {
  op: ExtractionOp;
  text: string;
  target?: MemoryRecord;
  /** The exchange(s) the quote was found in. Absent when the exchanges had no places to cite. */
  from?: string[];
}

export type DropReason = "malformed" | "unknown op" | "target not offered" | "quote not in their words" | "not storable" | "repeated";

export interface ParsedExtraction {
  items: ExtractedItem[];
  dropped: Partial<Record<DropReason, number>>;
}

export function buildExtractionPrompt(
  exchange: string,
  /** The remembered lines this call offers as targets, numbered K1… in this order. */
  candidates: readonly MemoryRecord[],
  options: {
    /**
     * The exchanges are about to be summarised away (INV-778). A summary keeps a sentence per
     * thread; what it loses first is that something *changed* — so the extractor is told to
     * put reversals ahead of new facts.
     */
    stateChangesFirst?: boolean;
  } = {}
): string {
  const existing = candidates.length === 0 ? "(nothing yet)" : candidates.map((record, i) => `K${i + 1}. ${record.text}`).join("\n");
  return [
    "Below is part of a conversation you had, and what you already remember.",
    "",
    `Reply with ${NOTHING_TO_KEEP} and nothing else unless the conversation taught you something`,
    "that will still matter in a *different* conversation. Most exchanges teach nothing durable, and",
    "a memory of something obvious is worse than no memory: it is read on every future turn and",
    "crowds out what matters.",
    "",
    "Keep: a decision and its reason, a constraint about how they work or what they use, a",
    "correction they gave you.",
    "",
    "Do not keep: what a tool can tell you again on demand, anything specific to this task, your own",
    "plans.\nOnly a line headed `They said` is a person's own word; under any other heading, nothing is their preference, decision or correction.",
    ...(options.stateChangesFirst === true
      ? [
          "",
          "This part of the conversation is about to be replaced by a summary. A change of state comes",
          "first: something reversed, completed, superseded or cancelled, a preference or constraint",
          "they changed. Only after those, a new standing fact. A summary keeps the facts; what it",
          "loses is that an earlier one stopped being true.",
        ]
      : []),
    "",
    "At most three lines, each one JSON object and nothing else:",
    '{"op":"create","text":"they use pnpm","quote":"our team uses pnpm"}',
    '- op: "create" for something new; "confirm" when they said again what a K line holds; "correct" only',
    '  when they said a K line was wrong. A change ("now", "from now on") is a create: the old line was true then.',
    '- target: the K number, for confirm and correct, like "K2".',
    '- text: makes sense with none of this conversation around it; "they", not "the user above".',
    "- quote: the sentence of theirs it rests on, copied exactly from a line headed `They said`. No quote, not kept.",
    "",
    "--- already remembered ---",
    existing,
    "",
    "--- conversation ---",
    exchange,
  ].join("\n");
}

/**
 * Strips list markers, however many are stacked: a model asked for bare lines will still write
 * `* 2. {…}`. Bounded so a line of nothing but markers terminates.
 */
function stripMarkers(raw: string): string {
  let text = raw.trim();
  for (let pass = 0; pass < 4; pass++) {
    const next = text.replace(/^(?:[-*•+]|\d+[.)])\s+/, "").trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** The objects in a reply: one a line, or one JSON list. What does not parse is counted, not guessed. */
function objectsOf(reply: string): { values: unknown[]; malformed: number } {
  const body = reply.trim().replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  if (body.startsWith("[")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) return { values: parsed, malformed: 0 };
    } catch {
      // One bad item in a list must not lose the others: read it line by line below.
    }
  }
  const values: unknown[] = [];
  let malformed = 0;
  for (const raw of body.split("\n")) {
    const line = stripMarkers(raw).replace(/,$/, "");
    if (line === "" || line === "[" || line === "]" || line.startsWith("```") || isNothing(line)) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      malformed += 1;
    }
  }
  return { values, malformed };
}

/** Where a sentence ends, in either script. A comma does not end one: a clause is a fragment. */
const SENTENCE_END = /[。！？；!?;\n]+|\.(?=\s|$)/;
const bare = (text: string): string => fold(text).text.replace(/[.!?;\s]+$/, "");

/**
 * Whether a quote is in one stretch of the person's words: an exact hit, folded the way
 * `locateQuote` folds. Below its twelve characters `locateQuote` calls nothing evidence, and a
 * Chinese sentence is often shorter ("以后报告都用公制。" is nine) — so a quote that is one *whole
 * sentence* of theirs also counts. A whole sentence is something they said; a few characters inside
 * one can be a coincidence ("周五" is in "不是周五").
 */
export function quoteInTheirWords(quote: string, theirs: string): boolean {
  const verdict = locateQuote(quote, theirs);
  if (verdict.state === "located" && verdict.exact === true) return true;
  const needle = bare(quote);
  return needle !== "" && theirs.split(SENTENCE_END).some(sentence => bare(sentence) === needle);
}

/** `"K2"`, `"2"` or `2`, as the index it names among the candidates, or undefined. */
function targetIndex(raw: unknown, count: number): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim().replace(/^K/i, "")) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= count ? n - 1 : undefined;
}

/**
 * Reads an extraction reply into decisions, dropping each item that fails on its own terms.
 *
 * `said[i]` is the person's own words in exchange `i` (undefined when none of it is theirs) and
 * `refs[i]` its place; `refs` is empty when the exchanges could not all be placed, and then nothing
 * is cited — a numbering with holes would cite a place that means nothing. `live` is the memory as
 * it stands: a create that repeats a live line word for word is a confirm of that line.
 */
export function parseExtraction(
  reply: string,
  context: { candidates: readonly MemoryRecord[]; said: readonly (string | undefined)[]; refs: readonly string[]; live: readonly MemoryRecord[] }
): ParsedExtraction {
  const out: ParsedExtraction = { items: [], dropped: {} };
  const drop = (reason: DropReason) => { out.dropped[reason] = (out.dropped[reason] ?? 0) + 1; };
  const trimmed = reply.trim();
  if (trimmed === "" || trimmed.toUpperCase().startsWith(NOTHING_TO_KEEP) || isNothing(trimmed)) return out;

  const { values, malformed } = objectsOf(trimmed);
  for (let i = 0; i < malformed; i++) drop("malformed");
  const liveByKey = new Map(context.live.map(record => [dedupeKey(record.text), record]));
  const seen = new Set<string>();
  for (const value of values) {
    if (out.items.length >= MAX_EXTRACTED) break;
    if (value === null || typeof value !== "object" || Array.isArray(value)) { drop("malformed"); continue; }
    const row = value as Record<string, unknown>;
    if (!OPS.includes(row.op as ExtractionOp)) { drop("unknown op"); continue; }
    let op = row.op as ExtractionOp;
    if (typeof row.quote !== "string") { drop("malformed"); continue; }
    const quote = row.quote;
    const hits = context.said.flatMap((theirs, index) => (theirs !== undefined && quoteInTheirWords(quote, theirs) ? [index] : []));
    if (hits.length === 0) { drop("quote not in their words"); continue; }
    const from = [...new Set(hits.map(index => context.refs[index]).filter((ref): ref is string => ref !== undefined))];

    let target: MemoryRecord | undefined;
    if (op !== "create") {
      const index = targetIndex(row.target, context.candidates.length);
      if (index === undefined) { drop("target not offered"); continue; }
      target = context.candidates[index];
    }
    let text = typeof row.text === "string" ? row.text.trim() : "";
    if (op === "confirm") text = target!.text;
    if (text === "" || isNothing(text) || validateRecord(text) !== undefined) { drop("not storable"); continue; }
    const key = dedupeKey(text);
    if (key === "") { drop("not storable"); continue; }
    // A "create" of a line already live, word for word, is that line said again; a "correction"
    // to the same words corrects nothing.
    const same = liveByKey.get(key);
    if (op === "create" && same !== undefined) { op = "confirm"; target = same; text = same.text; }
    if (op === "correct" && dedupeKey(target!.text) === key) { drop("repeated"); continue; }
    if (seen.has(key)) { drop("repeated"); continue; }
    seen.add(key);
    out.items.push({ op, text, ...(target !== undefined ? { target } : {}), ...(from.length > 0 ? { from } : {}) });
  }
  return out;
}

/** "2 not JSON, 1 quote not in their words" — counts only, never the text. */
export function describeDrops(dropped: ParsedExtraction["dropped"]): string | undefined {
  const parts = Object.entries(dropped).filter(([, n]) => (n ?? 0) > 0).map(([reason, n]) => `${n} ${reason}`);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** `from` with places added, without repeats, bounded: the first (where it was learned) and the newest. */
function mergeFrom(before: readonly string[] | undefined, added: readonly string[] | undefined): string[] {
  const all = [...new Set([...(before ?? []), ...(added ?? [])])];
  return all.length <= MAX_FROM ? all : [all[0]!, ...all.slice(-(MAX_FROM - 1))];
}

export interface ExtractionRecords {
  /** New lines, for the judge. */
  creates: MemoryRecord[];
  /** Remembered lines written again, dated now, `from` extended: their decay restarts. */
  confirms: MemoryRecord[];
  /** A withdrawal of the old line and the line that replaces it; the new line goes to the judge too. */
  corrections: { retraction: MemoryRecord; record: MemoryRecord }[];
}

/** The ledger lines each decision becomes. Append-only: a confirm is the same record again, never an edit. */
export function recordsOfExtraction(items: readonly ExtractedItem[], now = new Date()): ExtractionRecords {
  const at = now.toISOString();
  // The replacement is a millisecond after its withdrawal, so read by time as well as by file
  // order the withdrawal comes first (the same convention as an edit in Settings → Memory).
  const after = new Date(now.getTime() + 1).toISOString();
  const out: ExtractionRecords = { creates: [], confirms: [], corrections: [] };
  for (const item of items) {
    const cite = item.from !== undefined ? { from: item.from } : {};
    if (item.op === "create") out.creates.push({ at, kind: "note", text: item.text, source: "extracted", ...cite });
    else if (item.op === "confirm") {
      const from = mergeFrom(item.target!.from, item.from);
      out.confirms.push({ ...item.target!, at, ...(from.length > 0 ? { from } : {}) });
    } else {
      out.corrections.push({
        retraction: { at, kind: "retraction", text: item.target!.text, source: "extracted:correct", ...cite },
        record: { at: after, kind: "note", text: item.text, source: "extracted:correct", ...cite },
      });
    }
  }
  return out;
}
