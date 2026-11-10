/** Retained source inventory: removing an archive must not turn missing history into an empty complete view. */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { archivePaths } from "./jsonl.ts";

export class ExecutionArchives {
  private captured = false;
  constructor(private readonly ledger?: string) {}
  capture(archive?: string): void {
    if (!this.ledger || (this.captured && !archive)) return;
    const catalog = this.ledger + ".sources.json";
    const existing = existsSync(catalog) ? JSON.parse(readFileSync(catalog, "utf8")) as { schema: number; files: string[] } : { schema: 1, files: [] };
    if (existing.schema !== 1 || !Array.isArray(existing.files)) throw new Error("Unsupported execution source inventory");
    const files = [...new Set([...existing.files, ...archivePaths(this.ledger).map(path => basename(path)), ...(archive ? [basename(archive)] : [])])].sort();
    const temp = catalog + ".tmp";
    writeFileSync(temp, JSON.stringify({ schema: 1, files }), "utf8"); renameSync(temp, catalog);
    this.captured = true;
  }
  missing(): boolean {
    if (!this.ledger) return true;
    try {
      const data = JSON.parse(readFileSync(this.ledger + ".sources.json", "utf8")) as { schema: number; files: unknown[] };
      if (data.schema !== 1 || !Array.isArray(data.files)) return true;
      const actual = new Set(archivePaths(this.ledger).map(path => basename(path)));
      return data.files.some(name => typeof name !== "string" || !actual.has(name));
    } catch { return true; }
  }
}
