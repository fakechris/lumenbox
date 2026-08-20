/**
 * What an agent keeps between conversations.
 *
 * Until now this was one markdown file, appended to by hand and pasted whole into every system
 * prompt. That works for a week and then becomes a second unbounded context: it only grows, nothing
 * ages out, the same fact gets written three times in different words, and eventually the memory
 * costs more per request than the conversation does.
 *
 * The design here is deliberately not a retrieval engine, and that is the interesting decision.
 * Facts are short, keyword-dense lines — the easy case. So: append-only records, a score, a budget,
 * and lexical matching where matching is needed. No embeddings, no index, no second database. The
 * seam for changing that later is one function (`selectRelevant`), so a vector store is a
 * substitution rather than a rewrite if the evidence ever calls for one.
 *
 * Three kinds, and the distinction is real because each has a different source:
 *
 *   - **`fact`** — the agent chose to keep this, with `RememberFact`. A deliberate act, so it is
 *     trusted and barely decays. "The user prefers tabs" belongs here.
 *   - **`note`** — extracted automatically from an exchange. Nobody vouched for it, so it decays
 *     fastest and is the first thing dropped when the budget is tight.
 *   - **`episode`** — a summary of several turns. It stands in for facts that have already aged out,
 *     so it outlives them.
 *
 * A separate "profile" tier next to a "recent" one was considered and rejected: that
 * classification has to come from somewhere, and a tier nobody can populate correctly is
 * worse than one list scored honestly. The three kinds above each have an unambiguous source, which
 * is what makes them usable.
 */

import { envNumber } from "../config.ts";

/** A single thing remembered. One JSON object per line, appended, never edited in place. */
export interface MemoryRecord {
  at: string;
  kind: MemoryKind;
  text: string;
  /** How it got here: the tool that wrote it, or the turn it was extracted from. For a person. */
  source?: string;
  /**
   * The agent that learned it, on a shared record.
   *
   * Carried because it says how much weight to give the line: a fact from the agent whose job is
   * checking things is not the same as one from the agent that was installing software at the time.
   * Absent on an agent's own memories, where it would only repeat what the file already says.
   */
  via?: string;
  /** The person it is about, when the box was told who was driving. Absent means "the team". */
  about?: string;
}

/**
 * `retraction` is not a memory; it is a record that an earlier one is no longer true.
 *
 * It exists because memory could only accrete. An agent that recorded "the deployment region is
 * us-east-1" and later learned otherwise could write the new fact, but not withdraw the old one —
 * so both sat in the prompt, both dated, both presented as things it knows. Nothing here tries to
 * *detect* the contradiction, which would mean guessing at meaning; the agent that knows says so.
 */
export type MemoryKind = "fact" | "note" | "episode" | "retraction";

/**
 * One item's ceiling.
 *
 * Short on purpose. A memory is a line, not a document: if it needs a paragraph it is really several
 * facts, or it is a document that belongs in the work directory with a fact pointing at it.
 */
export const MAX_RECORD_CHARS = 500;

/**
 * How much of the prompt memory may occupy.
 *
 * A budget rather than a count, because a count of fifty three-word facts and a count of fifty
 * three-line ones cost very differently — and this is paid on every request.
 */
export const MEMORY_CHAR_BUDGET = envNumber("AGENTBOX_MEMORY_BUDGET", 4_000);

/**
 * How fast an unvouched-for memory loses its claim on the prompt, in days.
 *
 * Thirty days: long enough that a fact from last month still surfaces, short enough that a
 * conversation-specific detail stops competing with something current. A deliberate `fact` uses a
 * much longer half-life — the agent said it would still matter, and second-guessing that would make
 * `RememberFact` pointless.
 */
const HALF_LIFE_DAYS: Record<MemoryKind, number> = {
  fact: 365,
  note: 30,
  episode: 90,
  retraction: 365,
};

/** Relative claim on the prompt at equal age. An episode summarises many facts, so it outranks one. */
const WEIGHT: Record<MemoryKind, number> = {
  fact: 1,
  note: 0.5,
  episode: 1.5,
  // Never scored: a retraction is removed during dedupe and never reaches recall.
  retraction: 0,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How strong a memory's claim is right now.
 *
 * Exponential decay by kind, times its weight. Exposed because the ordering it produces is the whole
 * behaviour of this module, and a test that cannot see the score can only assert on output that
 * happens to be ordered.
 */
export function scoreOf(record: MemoryRecord, now = Date.now()): number {
  const ageDays = Math.max(0, (now - Date.parse(record.at)) / DAY_MS);
  const halfLife = HALF_LIFE_DAYS[record.kind];
  return WEIGHT[record.kind] * 2 ** (-ageDays / halfLife);
}

/**
 * The key two memories are the same by.
 *
 * Aggressive on purpose: lowercased, punctuation and filler words dropped. The failure this prevents
 * is the same fact accumulating in five phrasings until it crowds out everything else, and being
 * slightly too eager to merge is cheaper than that.
 */
export function dedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(word => word !== "" && !FILLER.has(word))
    .join(" ");
}

const FILLER = new Set([
  "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "for", "and", "or",
  "that", "this", "it", "its", "their", "they", "user", "users", "prefers", "prefer",
]);

/** Trims and refuses what cannot be stored, saying what would be accepted. */
export function validateRecord(text: string): { reason: string } | undefined {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { reason: "There is nothing to remember. Say what should be kept, in one line." };
  }
  if (trimmed.length > MAX_RECORD_CHARS) {
    return {
      reason:
        `A memory may be ${MAX_RECORD_CHARS} characters and this is ${trimmed.length}. It is read on ` +
        `every future turn, so length here is paid for repeatedly. If it needs a paragraph it is ` +
        `several facts, or it is a document — put that under /home/box/work and remember where it is.`,
    };
  }
  return undefined;
}

/**
 * Drops records superseded by a later one saying the same thing.
 *
 * Later wins, because a memory written again is usually a correction. Applied on read rather than on
 * write: the file stays a faithful append-only log of what was believed when, and the *view* is
 * deduplicated. That distinction is why a wrong merge here is recoverable.
 */
export function dedupe(records: readonly MemoryRecord[]): MemoryRecord[] {
  const byKey = new Map<string, MemoryRecord>();
  for (const record of records) {
    const key = dedupeKey(record.text);
    if (key === "") continue;
    if (record.kind === "retraction") {
      // Withdraws whatever it names, and is not itself remembered. Order matters and is the file's:
      // something recorded again *after* a retraction is a fresh statement, not a withdrawn one.
      byKey.delete(key);
      continue;
    }
    const existing = byKey.get(key);
    // A deliberate fact is never replaced by an automatic note repeating it: the note adds nothing
    // and would restart the decay clock on something already vouched for.
    if (existing !== undefined && existing.kind === "fact" && record.kind === "note") continue;
    byKey.set(key, record);
  }
  return [...byKey.values()];
}

export interface MemoryRecall {
  records: MemoryRecord[];
  /** How many were left out by the budget, so the prompt can say so rather than imply completeness. */
  omitted: number;
}

/**
 * What goes in the prompt: the strongest claims that fit the budget.
 *
 * Scored, then filled to the character budget. The count that fits is not fixed, because it should
 * not be: fifty short facts and five long ones cost the same and one of those is worth more.
 */
export function recall(
  records: readonly MemoryRecord[],
  budget = MEMORY_CHAR_BUDGET,
  now = Date.now()
): MemoryRecall {
  const ranked = dedupe(records)
    .map(record => ({ record, score: scoreOf(record, now) }))
    .sort((a, b) => b.score - a.score || b.record.at.localeCompare(a.record.at));

  const kept: MemoryRecord[] = [];
  let used = 0;
  for (const { record } of ranked) {
    const cost = record.text.length + 4; // the bullet and newline it is rendered with
    if (used + cost > budget && kept.length > 0) continue;
    kept.push(record);
    used += cost;
  }
  // Chronological for the prompt even though selection was by score: a model reading a list of
  // facts benefits from knowing which came after which, and the scoring has already decided *which*
  // facts it sees.
  kept.sort((a, b) => a.at.localeCompare(b.at));
  return { records: kept, omitted: ranked.length - kept.length };
}

/**
 * The records most related to some text, by word overlap.
 *
 * Used when a set of candidates has to be narrowed — the extraction pass reasoning about what it
 * already knows. Plain lexical overlap, because these are short keyword-dense lines and that is the
 * easy case; an embedding here would be infrastructure bought to solve a problem nobody has
 * measured. **This function is the seam**: if the evidence ever calls for semantic retrieval, it is
 * the only thing that changes.
 */
export function selectRelevant(
  query: string,
  records: readonly MemoryRecord[],
  max: number
): MemoryRecord[] {
  if (max <= 0) return [];
  const wanted = new Set(dedupeKey(query).split(" ").filter(word => word.length > 2));
  if (wanted.size === 0) return [];
  return records
    .map(record => {
      const words = new Set(dedupeKey(record.text).split(" "));
      let overlap = 0;
      for (const word of wanted) if (words.has(word)) overlap += 1;
      return { record, overlap };
    })
    .filter(entry => entry.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || b.record.at.localeCompare(a.record.at))
    .slice(0, max)
    .map(entry => entry.record);
}

/**
 * How much of the prompt the *team's* memory may occupy.
 *
 * Smaller than an agent's own, on purpose. A shared fact is worth more per line — it is the kind of
 * thing everyone needs — but the shared tier is written by every agent, so it grows N times as fast
 * and a generous budget here would push out an agent's own working knowledge.
 */
export const SHARED_CHAR_BUDGET = envNumber("AGENTBOX_SHARED_MEMORY_BUDGET", 1_500);

/**
 * The team's memory as it appears in the prompt.
 *
 * A separate section rather than one merged list, because the two have different standing. An agent
 * should be able to tell "I learned this" from "a colleague learned this and thought everyone needed
 * it" — the second is more likely to be about the person and less likely to be about the work in
 * front of it.
 */
export function renderSharedMemory(
  recalled: MemoryRecall,
  nameOf: (agentId: string) => string = id => id
): string {
  if (recalled.records.length === 0) return "";
  const lines = recalled.records.map(record => {
    const day = record.at.slice(0, 10);
    const who = record.via === undefined ? "" : ` — ${nameOf(record.via)}`;
    const about = record.about === undefined ? "" : ` (about ${record.about})`;
    return `- (${day})${about} ${record.text}${who}`;
  });
  const tail =
    recalled.omitted > 0 ? [``, `${recalled.omitted} more are not shown.`] : [];
  return [
    "## What your team has learned",
    "",
    "Kept by your teammates because everyone needs it. Treat it as you would your own memory, but",
    "notice who learned it: a colleague's account of something is not the same as having checked it.",
    "",
    ...lines,
    ...tail,
  ].join("\n");
}

/** How memory appears in the system prompt. */
export function renderMemory(recalled: MemoryRecall): string {
  if (recalled.records.length === 0) {
    return [
      "# Your memory",
      "",
      "You have not kept anything yet. As you learn things worth keeping across conversations — a",
      "decision the user made and why, a constraint about their setup, a correction they gave you —",
      "keep them with `RememberFact`. Do not record what a tool can tell you again on demand.",
    ].join("\n");
  }

  const lines = recalled.records.map(record => {
    const day = record.at.slice(0, 10);
    // The kind is shown because it says how much to trust the line: something the agent chose to
    // keep is not the same as something extracted from a conversation without review.
    const mark = record.kind === "fact" ? "" : ` [${record.kind}]`;
    return `- (${day})${mark} ${record.text}`;
  });

  const tail =
    recalled.omitted > 0
      ? [
          "",
          `${recalled.omitted} older or weaker memories are not shown. This is a selection, not`,
          "everything you know — so do not conclude something never happened from its absence here.",
        ]
      : [];

  return ["# Your memory", "", "What you have kept from earlier conversations:", "", ...lines, ...tail].join(
    "\n"
  );
}

// ── extraction ────────────────────────────────────────────────────────────────────────

/**
 * The prompt that turns an exchange into memories, or into nothing.
 *
 * "Or into nothing" is the part that matters. An extractor that must produce output will invent
 * something on a turn that taught it nothing, and a memory file filling with restatements of the
 * obvious is worse than an empty one — it costs budget and crowds out real facts. So the sentinel is
 * explicit and the instruction leads with it.
 */
export const NOTHING_TO_KEEP = "NOTHING";

export function buildExtractionPrompt(exchange: string, known: readonly MemoryRecord[]): string {
  const existing =
    known.length === 0
      ? "(nothing yet)"
      : known.map(record => `- ${record.text}`).join("\n");

  return [
    "Below is part of a conversation you had, and what you already remember.",
    "",
    `Reply with ${NOTHING_TO_KEEP} and nothing else unless the conversation taught you something`,
    "that will still matter in a *different* conversation. Most exchanges teach nothing durable, and",
    "a memory of something obvious is worse than no memory: it is read on every future turn and",
    "crowds out what matters.",
    "",
    "Keep: a decision and its reason, a constraint about how they work or what they use, a",
    "correction they gave you, a fact that was expensive to establish.",
    "",
    "Do not keep: what a tool can tell you again on demand, anything specific to this task, your own",
    "plans, or a restatement of something already listed below.",
    "",
    "One line each, at most three lines, no numbering, no preamble. Each line must make sense with",
    "none of this conversation around it — write \"they\" rather than \"the user above\".",
    "",
    "--- already remembered ---",
    existing,
    "",
    "--- conversation ---",
    exchange,
  ].join("\n");
}

/**
 * Reads an extraction reply into records, dropping anything that fails on its own terms.
 *
 * Lenient about the shape it accepts — models add bullets and numbering whatever the instruction
 * says — and strict about what it stores. A line that is too long, empty, or a restatement of
 * something known is dropped silently: this runs after a turn with nobody watching, so a refusal has
 * nobody to explain itself to.
 */
/**
 * Strips list markers, however many are stacked.
 *
 * A loop rather than one pass because a model asked for plain lines will sometimes emit `* 2. text` —
 * a bullet and a number — and one pass leaves the `2.` inside the memory, where it corrupts the
 * dedupe key and reads as part of the fact. Bounded so a line of nothing but markers terminates.
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

export function parseExtraction(
  reply: string,
  known: readonly MemoryRecord[],
  now = new Date()
): MemoryRecord[] {
  const trimmed = reply.trim();
  if (trimmed === "" || trimmed.toUpperCase().startsWith(NOTHING_TO_KEEP)) return [];

  const knownKeys = new Set(known.map(record => dedupeKey(record.text)));
  const out: MemoryRecord[] = [];
  const seen = new Set<string>();

  for (const raw of trimmed.split("\n")) {
    const text = stripMarkers(raw);
    if (text === "" || validateRecord(text) !== undefined) continue;
    if (text.toUpperCase() === NOTHING_TO_KEEP) continue;
    const key = dedupeKey(text);
    if (key === "" || knownKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ at: now.toISOString(), kind: "note", text, source: "extracted" });
    if (out.length >= 3) break; // the instruction says three; enforce it rather than trust it
  }
  return out;
}

/** The prompt that condenses several exchanges into one durable episode. */
export function buildEpisodePrompt(exchanges: readonly string[]): string {
  return [
    `Below are ${exchanges.length} exchanges from your recent work. Write one paragraph that a future`,
    "you would want in place of all of them: what was being done, what was decided, and where it got",
    "to. This replaces the individual facts as they age, so it has to carry the outcome rather than",
    "the narrative.",
    "",
    "No preamble, no bullet list, at most six sentences. If nothing durable happened, reply",
    `${NOTHING_TO_KEEP} and nothing else.`,
    "",
    "--- exchanges ---",
    exchanges.join("\n\n---\n\n"),
  ].join("\n");
}

export function parseEpisode(reply: string, now = new Date()): MemoryRecord | undefined {
  const text = reply.trim().replace(/\s+/g, " ");
  if (text === "" || text.toUpperCase().startsWith(NOTHING_TO_KEEP)) return undefined;
  return {
    at: now.toISOString(),
    kind: "episode",
    text: text.slice(0, MAX_RECORD_CHARS),
    source: "episode",
  };
}

/**
 * Turns an existing markdown memory file into records, once.
 *
 * Existing agents have a `memory.md` written by the old `RememberFact`, and losing it would be
 * losing the thing this module exists to keep. Each bullet becomes a `fact` — deliberate, because
 * that is what it was — and the date in `- (YYYY-MM-DD) …` is honoured where present so decay does
 * not treat a year-old note as written today. The markdown file is left on disk untouched.
 */
export function importMarkdown(markdown: string, fallback = new Date()): MemoryRecord[] {
  const out: MemoryRecord[] = [];
  const seen = new Set<string>();
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const bullet = line.replace(/^\s*[-*•]\s*/, "");
    const dated = /^\((\d{4}-\d{2}-\d{2})\)\s*(.*)$/.exec(bullet);
    const text = (dated?.[2] ?? bullet).trim();
    if (text === "" || validateRecord(text) !== undefined) continue;
    const key = dedupeKey(text);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({
      // Midday, because the original line carried only a date and midnight in one timezone is
      // the previous day in another.
      at: dated?.[1] !== undefined ? `${dated[1]}T12:00:00.000Z` : fallback.toISOString(),
      kind: "fact",
      text,
      source: "imported from memory.md",
    });
  }
  return out;
}
