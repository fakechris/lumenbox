/** Explicit history projections have a read budget before allocating or parsing source files. */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
export interface TranscriptReadBudget { bytes: number; entries: number }
export const executionReadBudget = (): TranscriptReadBudget => ({ bytes: 32 * 1024 * 1024, entries: 20_000 });
export function readBoundedEpochs(files: readonly { epoch: number; path: string }[], budget: TranscriptReadBudget) {
  return files.map(({ epoch, path }) => {
    if (!existsSync(path)) return { epoch, entries: [] };
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size > budget.bytes) throw new Error("Transcript read budget exceeded");
      budget.bytes -= size;
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) { const count = readSync(fd, buffer, offset, size - offset, offset); if (!count) break; offset += count; }
      // An append beyond the captured byte watermark belongs to the next projection.
      const entries: unknown[] = [];
      for (const line of buffer.toString("utf8", 0, offset).split("\n")) {
        if (!line.trim()) continue;
        if (--budget.entries < 0) throw new Error("Transcript entry budget exceeded");
        try { entries.push(JSON.parse(line)); } catch { throw new Error("Transcript source incomplete"); }
      }
      return { epoch, entries };
    } finally { closeSync(fd); }
  });
}
