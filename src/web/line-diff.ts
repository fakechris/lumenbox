/**
 * A line diff for the chat: what an `edit_file` call changed, as `-`/`+` lines (INV-112).
 *
 * The call is stored as `{path, old, new}` — two blocks of text. Shown as text, a reader has
 * to find the changed line by eye in two near-identical paragraphs; shown as a diff, the
 * change is the two lines that are marked and the rest is context. Longest common
 * subsequence on lines, which is what `diff` itself does; no word-level refinement,
 * because a chat row is read once and folded, not reviewed.
 *
 * Computed on the server, once, so the page renders a list it was given and the algorithm
 * is a tested function rather than a paragraph of page script.
 */

export type DiffOp = " " | "-" | "+";

export interface DiffLine {
  op: DiffOp;
  text: string;
}

export interface EditDiff {
  path: string;
  lines: DiffLine[];
}

/** Past this many lines a side, the diff is shown as its two blocks — a chat row is not a review tool. */
const MAX_LINES = 400;

const splitLines = (text: string): string[] => (text === "" ? [] : text.replace(/\r\n/g, "\n").split("\n"));

/** The `-`/`+`/` ` lines between two texts; equal texts give only context lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map(text => ({ op: "-" as const, text })), ...b.map(text => ({ op: "+" as const, text }))];
  }
  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: "-", text: a[i]! });
      i++;
    } else {
      out.push({ op: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) out.push({ op: "-", text: a[i++]! });
  while (j < b.length) out.push({ op: "+", text: b[j++]! });
  return out;
}

/** The diff an `edit_file` call implies, or undefined when the input is not one. */
export function editDiffOf(name: string, input: unknown): EditDiff | undefined {
  if (name !== "edit_file") return undefined;
  const args = (input ?? {}) as Record<string, unknown>;
  const before = typeof args.old === "string" ? args.old : undefined;
  const after = typeof args.new === "string" ? args.new : undefined;
  if (before === undefined || after === undefined) return undefined;
  return { path: typeof args.path === "string" ? args.path : "", lines: lineDiff(before, after) };
}

/** How many lines changed, for the one-line summary: "+2 −1". */
export function diffSummary(lines: readonly DiffLine[]): string {
  const added = lines.filter(line => line.op === "+").length;
  const removed = lines.filter(line => line.op === "-").length;
  return `+${added} −${removed}`;
}
