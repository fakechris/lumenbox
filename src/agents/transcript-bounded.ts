/** Explicit history projections read bounded prefixes and retain valid records across gaps. */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
export interface TranscriptReadBudget { bytes: number; entries: number }
export type TranscriptGap = "byte-limit" | "entry-limit" | "malformed-line" | "missing-source" | "read-error";
export type TranscriptEpochs = { epoch: number; entries: unknown[] }[] & { partial?: boolean; gaps?: TranscriptGap[] };
export const executionReadBudget = (): TranscriptReadBudget => ({ bytes: 32 * 1024 * 1024, entries: 20_000 });
export function readBoundedEpochs(files: readonly { epoch: number; path: string }[], budget: TranscriptReadBudget): TranscriptEpochs {
  const result: TranscriptEpochs = [], gaps = new Set<TranscriptGap>();
  for (const { epoch, path } of files) {
    const entries: unknown[] = [];
    result.push({ epoch, entries });
    if (!existsSync(path)) { gaps.add("missing-source"); continue; }
    let fd: number | undefined;
    try {
      fd = openSync(path, "r");
      const size = fstatSync(fd).size, length = Math.min(size, Math.max(0, budget.bytes));
      if (length < size) gaps.add("byte-limit");
      budget.bytes -= length;
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) { const count = readSync(fd, buffer, offset, length - offset, offset); if (!count) break; offset += count; }
      if (offset < length) gaps.add("read-error");
      // A valid prefix remains useful after a crash, a malformed line, or an exhausted budget.
      const lines = buffer.toString("utf8", 0, offset).split("\n");
      if (offset < size && lines.at(-1)) lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        if (budget.entries <= 0) { gaps.add("entry-limit"); break; }
        budget.entries--;
        try { const value: unknown = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); entries.push(value); }
        catch { gaps.add("malformed-line"); }
      }
    } catch { gaps.add("read-error"); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  result.partial = gaps.size > 0;
  result.gaps = [...gaps];
  return result;
}
