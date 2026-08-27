/**
 * The progress a batch job reports, read from the file it writes.
 *
 * The task card's action line used to show whatever tool call happened to be running —
 * `bash: python batch.py` for forty minutes, which answers "is it alive" and not "how far
 * along". For exactly the work the product is aimed at (three hundred reports), the number
 * a person wants is 37/300, and no amount of watching tool calls produces it.
 *
 * So the convention: a long-running batch script writes `progress.json` in its chat's work
 * directory — `{"current": 37, "total": 300, "failed": ["q1.pdf"]}` — and the card shows
 * it in the person's terms. The script writes what it knows; nothing here invents a
 * percentage (the third product review's rule: report progress only when it is real).
 *
 * Parsing is deliberately strict. A half-written file (the script is mid-write when the
 * poller reads) or a script that wrote prose is `undefined`, not a guess — the card simply
 * keeps its last line until a whole, sane file appears.
 */

export interface BatchProgress {
  current: number;
  total: number;
  /** Names the script chose to record as failed. Shown as a count; the list is for the report. */
  failed?: string[];
}

/** The parsed file, or undefined for anything that is not a whole, sane progress record. */
export function parseProgressFile(text: string): BatchProgress | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const current = record.current;
  const total = record.total;
  if (typeof current !== "number" || typeof total !== "number") return undefined;
  if (!Number.isFinite(current) || !Number.isFinite(total)) return undefined;
  if (current < 0 || total <= 0 || current > total) return undefined;
  const failed = Array.isArray(record.failed)
    ? record.failed.filter((name): name is string => typeof name === "string")
    : undefined;
  return { current, total, ...(failed !== undefined && failed.length > 0 ? { failed } : {}) };
}

/** The card line, in the person's words. */
export function progressLine(progress: BatchProgress): string {
  const base = `已处理 ${progress.current}/${progress.total}`;
  return progress.failed !== undefined ? `${base},${progress.failed.length} 份有问题` : base;
}
