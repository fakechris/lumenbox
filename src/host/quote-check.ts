/**
 * Is that sentence actually in the thing it was read from?
 *
 * The read contract says how much of a source came back (read-outcome.ts) and the kept
 * files say what came back (fetched.ts, results.ts). Neither connects a sentence in an
 * answer to a span of bytes in a source, and that gap is where the expensive failure
 * lives: not a made-up fact, but a true sentence attached to a source that does not say
 * it. Stanford RegLab measured products sold as verified at 17% and 33% hallucinated,
 * where hallucinated explicitly includes "cites a source that does not support the claim,
 * even when the response is factually accurate" (docs/71 §2).
 *
 * So this does the half that can be proved, and deliberately not the half that cannot.
 *
 * **What it proves.** A quote is present in the source at these offsets, or it is not
 * findable. That is a string fact, checkable now and re-checkable later against the digest
 * the pointer carries (INV-659). It is the same kind of guarantee the Citations API gives —
 * extraction fidelity — arrived at from the other end: they extract so the model cannot
 * invent, we search so an invention does not pass.
 *
 * **What it refuses to do.** Decide whether the source *supports* a claim. The public
 * leaderboard for that tops out at 77% balanced accuracy, with 0.4B and 405B models both
 * inside 71.8–77.4, and expert-domain content at 58–61, which is chance-adjacent. A
 * judgement that is wrong one time in four cannot sit behind the word "verified". If that
 * is ever added it belongs in its own field with its own name, never folded into this one.
 *
 * **And what a failure here does not mean.** `not_located` says this text was not found in
 * this source. It does not say the quote was invented, the source was faked, or the agent
 * lied. A paraphrase in quotation marks, a translated line, a quote from a different page
 * in the same answer all land here. The word is chosen to be the weakest true statement,
 * matching docs/68 §4's `quote_not_located`, which exists for the same reason.
 *
 * Nobody ships this. LlamaIndex's citation engine numbers chunks and trusts the number;
 * LangChain has no string check; ALCE uses entailment and never string matching (docs/71
 * §2). The reason it is worth building anyway is that it is about sixty lines and it is
 * the only part of the problem with a right answer.
 */

/**
 * The three things that can be true of a quote, in docs/68 §4's vocabulary.
 *
 * `unavailable` is about the *source*, not the quote: we cannot say anything either way
 * because there is nothing to search. Keeping it distinct from `not_located` is the whole
 * point — "we looked and it is not there" and "we could not look" are different findings
 * and only one of them is about the agent.
 */
export type QuoteState = "located" | "not_located" | "unavailable";

export interface QuoteVerdict {
  state: QuoteState;
  /** Offsets into the source *as given*, not into the folded form. Only when located. */
  start?: number;
  end?: number;
  /** 0 to 1, how close the match was. Reported so a reader can see the margin. */
  score?: number;
  /**
   * The source contains this text, folded, with no edits at all.
   *
   * **This is the only strong signal here, and the difference is not a matter of degree.**
   * Measured on a real sentence (`quote-check.test.ts`): a quote that *reverses* what the
   * source says — "is effective" written where the source says "is not effective" — scores
   * 0.979. Edit distance is relative to length, so the four characters that invert a
   * two-hundred-character sentence are invisible to it, and no threshold separates them: a
   * cutoff high enough to reject that rejects every genuine near-verbatim quote too.
   *
   * So a near match is a pointer, not a confirmation. It says "the closest thing in this
   * source is here, and here is what it actually says" — which is useful, and is why
   * `sourceText` comes back with it. It does not say the source says this.
   */
  exact?: boolean;
  /**
   * What the source actually says in the matched span. Present on a near match, because a
   * near match is only worth anything if the two texts can be put side by side.
   */
  sourceText?: string;
  /** Why, when the state needs one. */
  note?: string;
}

/**
 * How near a span has to be before it is worth showing to the caller.
 *
 * Calibrated on the three real pages in `fixtures/read-shapes`, against the edits models
 * actually make while quoting correctly, and against sentences from a *different* page
 * (`quote-check.test.ts` pins the numbers):
 *
 *   genuine near-verbatim quotes, recall at this cutoff   100%
 *   sentences from another page, highest score seen       0.329
 *
 * So the gap is wide and the cutoff sits in the middle of it. It was 0.82 in the first
 * draft, chosen rather than measured, and that lost one genuine quote in eight.
 *
 * What the cutoff is *not* doing is separating true quotes from false ones. It cannot: see
 * `exact`. It separates "there is something here worth comparing" from "there is nothing
 * in this source like this at all".
 */
export const QUOTE_MATCH_THRESHOLD = 0.55;

/**
 * Below this, finding it proves nothing.
 *
 * Twelve folded characters of Chinese is a clause; of English it is two words. An
 * approximate search over a long page finds something near enough to almost any short
 * string, and — the case that made this apply to exact matches too — "the data" really is
 * in the Wikipedia article, which is a true statement and not evidence about anything.
 * A match that any source would produce says nothing about this one.
 */
export const MIN_QUOTE_CHARS = 12;

/**
 * Differences that are not differences.
 *
 * Every entry here is a thing a model changes while quoting correctly, and each one is in
 * the table because leaving it out makes a genuine quote read as absent. Full-width and
 * half-width punctuation is the big one for Chinese sources — a model writing a quote back
 * will regularly swap 。for . and （ for ( without touching a word of it.
 */
const FOLDED: Record<string, string> = {
  "，": ",", "。": ".", "、": ",", "；": ";", "：": ":",
  "！": "!", "？": "?", "（": "(", "）": ")",
  "「": '"', "」": '"', "『": '"', "』": '"',
  "“": '"', "”": '"', "‘": "'", "’": "'", "＂": '"',
  "《": '"', "》": '"', "〈": '"', "〉": '"',
  "—": "-", "–": "-", "－": "-", "‐": "-", "‑": "-",
  "…": "...", "⋯": "...", "·": ".", "・": ".",
  " ": " ", "　": " ", "​": "", "﻿": "", "‎": "", "‏": "",
};

/** Han, kana, CJK punctuation and the full-width forms. */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;

function isCjk(character: string | undefined): boolean {
  return character !== undefined && CJK.test(character);
}

interface Folded {
  text: string;
  /** `map[i]` is the index in the original text that folded character `i` came from. */
  map: number[];
}

/**
 * Folds the differences out, keeping a way back.
 *
 * The offsets this module returns are into the text the caller handed over, never into the
 * folded form, because an offset into a normalisation nobody else computes is not a
 * citation anyone can check.
 */
export function fold(text: string): Folded {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const raw = text[i]!;
    const mapped = FOLDED[raw] ?? raw;
    if (mapped === "") continue;
    if (/\s/.test(mapped)) {
      // A run of any whitespace is one space, and leading space is dropped: a quote
      // re-flowed across different line breaks is the same quote.
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      // A space beside a CJK character is formatting, not a word boundary: Chinese has no
      // inter-word spaces, so `作者说：先做` and `作者说: 先做` are the same sentence typed
      // twice. Keeping the space here made every Chinese quote with half-widthed
      // punctuation read as *near* rather than exact, which is the difference between a
      // check and a pointer.
      const before = out[out.length - 1];
      if (!(isCjk(before) || isCjk(mapped[0]))) {
        out.push(" ");
        map.push(i);
      }
      pendingSpace = false;
    }
    for (const character of mapped.toLowerCase()) {
      out.push(character);
      map.push(i);
    }
  }
  return { text: out.join(""), map };
}

/**
 * Edit distance from `needle` to the nearest substring of `haystack`.
 *
 * The standard approximate-substring variant: the first row is zeroes, so a match may
 * start anywhere for free, and the answer is the smallest value in the last row, so it may
 * end anywhere for free. Returns where it ended as well as how far it was.
 */
function nearestSubstring(needle: string, haystack: string): { distance: number; end: number } {
  const m = needle.length;
  let previous = new Array<number>(haystack.length + 1).fill(0);
  let current = new Array<number>(haystack.length + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= haystack.length; j++) {
      const substitution = previous[j - 1]! + (needle[i - 1] === haystack[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j]! + 1, current[j - 1]! + 1);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  let best = Infinity;
  let end = 0;
  for (let j = 0; j <= haystack.length; j++) {
    if (previous[j]! < best) {
      best = previous[j]!;
      end = j;
    }
  }
  return { distance: best, end };
}

const TRIGRAM_CANDIDATES = 6;

/**
 * Roughly where in the haystack the needle might be, by shared three-character runs.
 *
 * Without this the fine pass would run over the whole page for every quote, which on a
 * sixty-thousand-character source is seconds. Each trigram hit votes for the start it
 * implies; the buckets with the most votes are worth the expensive look.
 */
function candidateStarts(needle: string, haystack: string): number[] {
  const positions = new Map<string, number[]>();
  for (let i = 0; i + 3 <= haystack.length; i++) {
    const gram = haystack.slice(i, i + 3);
    const at = positions.get(gram);
    if (at === undefined) positions.set(gram, [i]);
    else if (at.length < 400) at.push(i);
  }
  const bucket = Math.max(8, Math.floor(needle.length / 4));
  const votes = new Map<number, number>();
  for (let i = 0; i + 3 <= needle.length; i++) {
    for (const at of positions.get(needle.slice(i, i + 3)) ?? []) {
      const start = Math.max(0, at - i);
      const key = Math.floor(start / bucket);
      votes.set(key, (votes.get(key) ?? 0) + 1);
    }
  }
  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TRIGRAM_CANDIDATES)
    .map(([key]) => key * bucket);
}

/**
 * Finds a quote in a source, or says it did not.
 *
 * Exact first, because most quotes are exact once folded and an exact answer needs no
 * threshold. The fuzzy pass exists for the case the field reliably produces: a quote off
 * by a few tokens, which strict equality would call a fabrication.
 */
export function locateQuote(quote: string, source: string): QuoteVerdict {
  const needle = fold(quote);
  const haystack = fold(source);
  if (needle.text === "") return { state: "not_located", note: "the quote is empty" };
  if (haystack.text === "") return { state: "unavailable", note: "the source has no text" };

  if (needle.text.length < MIN_QUOTE_CHARS) {
    return {
      state: "not_located",
      note: `too short to be evidence (${needle.text.length} folded characters, ${MIN_QUOTE_CHARS} needed)`,
    };
  }

  const exact = haystack.text.indexOf(needle.text);
  if (exact !== -1) {
    return {
      state: "located",
      start: haystack.map[exact]!,
      end: (haystack.map[exact + needle.text.length - 1] ?? haystack.map[haystack.map.length - 1]!) + 1,
      score: 1,
      exact: true,
    };
  }

  // Look a little wider than the quote, because the edits that make a near-verbatim quote
  // near rather than verbatim are usually insertions.
  const width = Math.ceil(needle.text.length * 1.35) + 16;
  let best: { score: number; start: number; end: number } | undefined;
  for (const candidate of candidateStarts(needle.text, haystack.text)) {
    const from = Math.max(0, candidate - Math.floor(width / 3));
    const window = haystack.text.slice(from, Math.min(haystack.text.length, from + width));
    if (window.length === 0) continue;
    const forward = nearestSubstring(needle.text, window);
    const score = 1 - forward.distance / needle.text.length;
    if (score <= (best?.score ?? -Infinity)) continue;
    // Where it started: the same search, both sides reversed, so the free end becomes the
    // free start. Cheaper and less error-prone than backtracking the first pass.
    const reversedWindow = [...window.slice(0, forward.end)].reverse().join("");
    const backward = nearestSubstring([...needle.text].reverse().join(""), reversedWindow);
    best = {
      score,
      start: from + forward.end - backward.end,
      end: from + forward.end,
    };
  }

  if (best === undefined || best.score < QUOTE_MATCH_THRESHOLD) {
    return {
      state: "not_located",
      ...(best !== undefined ? { score: Number(best.score.toFixed(3)) } : {}),
      note: "not found in this source; that is not a finding about whether it is true",
    };
  }
  const start = haystack.map[Math.min(best.start, haystack.map.length - 1)]!;
  const end = (haystack.map[Math.min(best.end, haystack.map.length) - 1] ?? haystack.map[haystack.map.length - 1]!) + 1;
  return {
    state: "located",
    start,
    end,
    score: Number(best.score.toFixed(3)),
    exact: false,
    // The near case is only useful if the two can be compared, so the source's own words
    // come back with it rather than only the offsets.
    sourceText: source.slice(start, end),
  };
}

/** The marks that come in distinguishable pairs, where an opener cannot be a closer. */
const PAIRED = /[“「『]([^”」』\n]{1,400})[”」』]/g;
/** How long a quoted run has to be before it is worth checking at all. */
const QUOTE_RUN_RANGE = { min: 8, max: 400 };

/**
 * Pulls the quoted runs out of an answer.
 *
 * Only what is marked as a quotation. A paraphrase is not a claim about wording and is not
 * this gate's business; going looking for unmarked ones would mean guessing which sentences
 * were meant as quotation, and a gate that guesses is a gate that accuses.
 */
export function quotedRuns(answer: string): string[] {
  const found: { at: number; run: string }[] = [];
  const take = (at: number, run: string): void => {
    const inner = run.trim();
    if (inner.length < QUOTE_RUN_RANGE.min || inner.length > QUOTE_RUN_RANGE.max) return;
    found.push({ at, run: inner });
  };

  // Curly and CJK marks first, then blanked out so the straight-quote pass does not see
  // through them. Positions are kept because the two passes find things out of order and a
  // reader checking the list against the answer should not have to re-sort it.
  const rest = [...answer];
  for (const match of answer.matchAll(PAIRED)) {
    take(match.index, match[1]!);
    for (let i = match.index; i < match.index + match[0]!.length; i++) rest[i] = " ";
  }

  // A straight quote is the same character opening and closing, so a regex cannot pair them
  // without guessing: `He said "yes" and then "yes" again` hands a regex the run
  // ` and then `, which is the text *between* two quotations. Walking the marks in order is
  // the only reading that is not a guess. An odd number of them means one is unclosed, and
  // the trailing fragment is dropped rather than paired with the end of the answer.
  const straight = rest.join("");
  let open = -1;
  for (let i = 0; i < straight.length; i++) {
    if (straight[i] !== '"') continue;
    if (open === -1) open = i;
    else {
      take(open + 1, straight.slice(open + 1, i));
      open = -1;
    }
  }

  const out: string[] = [];
  for (const { run } of found.sort((a, b) => a.at - b.at)) if (!out.includes(run)) out.push(run);
  return out;
}

export interface CheckedQuote extends QuoteVerdict {
  quote: string;
  /** Which source it was found in, or looked for in. */
  source?: string;
}

export interface QuoteReport {
  checked: CheckedQuote[];
  /** Quoted runs the source's own text contains, character for character. */
  exact: number;
  /** Found, but not word for word. A pointer to compare, never a confirmation. */
  near: number;
  /** Looked for in every source at hand and found in none of them. */
  notLocated: number;
  /** There was nothing to search. Says nothing about the quote. */
  unavailable: number;
}

/**
 * Runs every quoted run in an answer against the sources that were read for it.
 *
 * A quote is checked against each source in turn and keeps its best answer, because an
 * answer that read four pages may quote any of them and the gate has no way to know which
 * — and guessing wrong would report a real quote as absent.
 *
 * The counts are kept apart on purpose. `exact` is the only one that supports the word
 * "verified"; `near` is an invitation to compare two texts; `not_located` is a fact about
 * a string and not an accusation; `unavailable` is about the source and not the quote.
 * Collapsing any two of them would produce the boolean this whole design exists to avoid.
 */
export function checkQuotes(answer: string, sources: { name: string; text: string }[]): QuoteReport {
  const checked: CheckedQuote[] = [];
  for (const quote of quotedRuns(answer)) {
    let best: CheckedQuote = { quote, state: "unavailable", note: "no source was read for this answer" };
    for (const source of sources) {
      const verdict = locateQuote(quote, source.text);
      const better =
        (verdict.state === "located" && best.state !== "located") ||
        (verdict.state === "located" && best.state === "located" && (verdict.score ?? 0) > (best.score ?? 0)) ||
        (verdict.state === "not_located" && best.state === "unavailable");
      if (better) best = { ...verdict, quote, source: source.name };
    }
    checked.push(best);
  }
  return {
    checked,
    exact: checked.filter(one => one.state === "located" && one.exact === true).length,
    near: checked.filter(one => one.state === "located" && one.exact !== true).length,
    notLocated: checked.filter(one => one.state === "not_located").length,
    unavailable: checked.filter(one => one.state === "unavailable").length,
  };
}

/**
 * What to tell the agent, when there is anything worth telling it.
 *
 * Said to the agent rather than to the person, and before the answer is delivered, because
 * the useful moment is while it can still reword the sentence. Nothing is said when every
 * quote is exact: a gate that speaks on success trains people to stop reading it.
 */
export function quoteReportLine(report: QuoteReport): string | undefined {
  const problems = report.checked.filter(one => one.state !== "located" || one.exact !== true);
  if (problems.length === 0) return undefined;
  const lines = problems.map(one => {
    const quote = one.quote.length > 60 ? `${one.quote.slice(0, 60)}…` : one.quote;
    if (one.state === "not_located") {
      return `  "${quote}" — not found in what you read. If it is your wording rather than the source's, drop the quotation marks.`;
    }
    if (one.state === "unavailable") {
      return `  "${quote}" — nothing was read that could contain it, so this was not checked either way.`;
    }
    const said = one.sourceText === undefined ? "" : ` The source says: "${one.sourceText.trim().slice(0, 120)}"`;
    return `  "${quote}" — close to the source but not its wording.${said}`;
  });
  return `[quotes: ${report.exact} exact, ${report.near} near, ${report.notLocated} not found]\n${lines.join("\n")}`;
}

/**
 * How near two short strings are, 0 to 1, with no minimum length.
 *
 * `locateQuote` refuses anything under `MIN_QUOTE_CHARS` because finding a short string in
 * a long source proves nothing — any source would contain it. That guard is right for its
 * job and wrong for comparing one short label against one other short label, where there
 * is no corpus for a coincidence to hide in. A ten-character Chinese heading is a real
 * heading, and the day it was refused for being short the enumeration detector let a list
 * through (INV-670).
 *
 * Symmetric by taking the better direction, so a label that is a prefix of the other
 * scores the same whichever way round it is asked.
 */
export function similarity(a: string, b: string): number {
  const left = fold(a).text;
  const right = fold(b).text;
  if (left === "" || right === "") return 0;
  if (left === right) return 1;
  const one = (needle: string, haystack: string): number =>
    1 - nearestSubstring(needle, haystack).distance / needle.length;
  return Math.max(one(left, right), one(right, left));
}
