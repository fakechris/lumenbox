/**
 * A note written under names: "Result: …", "下一步：…", "Please do: …".
 *
 * What a member writes to a person is free text on a task's history, and two things are read back
 * out of it by the name a line opens with: a delivery (delivery-report.ts, INV-1922) and a request
 * for the person to act (person-ask.ts, INV-1923). This is the one reading of "a line that opens
 * with a name": what may stand before the name, how it ends, and that the longest name wins.
 */

/** The names each part is written under. The first of each language is the one we write; the rest are what members write instead. */
export type NoteNames<K extends string> = Record<K, { en: string[]; zh: string[] }>;

/** A line that opened a part: which, in which language, and the rest of the line. */
export interface Opened<K extends string> { key: K; lang: "en" | "zh"; rest: string }

/** What may stand before a name on its line: a heading mark, a bullet, a number, bold. */
const LEAD = /^[\s#>*_\-–—•·]*(?:[（(]?\d+[.)、）]|[①-⑥])?[\s*_]*/;

/** Whether a line opens or closes a code fence: what is inside one is never a name. */
export const isFence = (line: string): boolean => /^\s*(```|~~~)/.test(line);

/**
 * The reader for one table of names: a line opens a part when it starts with one of its names
 * followed by a colon or the end of the line. Longest name first, so "Not done or limits" is not
 * read as "Not done".
 */
export function opener<K extends string>(names: NoteNames<K>): (line: string) => Opened<K> | undefined {
  const sorted = (Object.keys(names) as K[])
    .flatMap(key => (["en", "zh"] as const).flatMap(lang => names[key][lang].map(name => ({ key, lang, name: name.toLowerCase() }))))
    .sort((a, b) => b.name.length - a.name.length);
  return line => {
    const body = line.replace(LEAD, ""), lower = body.toLowerCase();
    for (const { key, lang, name } of sorted) {
      if (!lower.startsWith(name)) continue;
      const after = body.slice(name.length).replace(/^[\s*_]*/, "");
      if (after === "") return { key, lang, rest: "" };
      if (after[0] === ":" || after[0] === "：") return { key, lang, rest: after.slice(1).replace(/^[\s*_]*/, "") };
    }
    return undefined;
  };
}
