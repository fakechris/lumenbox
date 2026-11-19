/**
 * Golden runs, kept (INV-821, folded into INV-1772): `agentbox golden` used to print its rows and
 * forget them, so the "red row on a board" its own header promises had no board — a nightly run
 * per model left nothing to compare tonight with.
 *
 * Each run is written beside the release scorecards as `golden-<model>-<time>.json`: every task's
 * outcome, the tokens, the model, the build and a version of the task set. `agentbox golden
 * --trend` reads them back: per task, the last runs side by side and how often it passed; per
 * model, whether the latest run is worse than the one before by more than noise. One golden run
 * is one attempt at each task, so a single red row is INCOMPLETE, not a regression — the same
 * rule the evaluation report holds itself to (stats.ts).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digest } from "./corpus.ts";
import { failureUpperBound, pairedComparison } from "./stats.ts";

export interface GoldenRow {
  id: string;
  /** `error` is the harness or the judge failing, not the agent; `skipped` a task that needs a box there was none for. */
  status: "pass" | "fail" | "skipped" | "error";
  detail: string;
  ms: number;
}

export interface GoldenRecord {
  format: "lumenbox-golden/1";
  at: string;
  provider: string;
  model: string;
  build: string;
  /** A hash of the tasks' ids and code: two records are compared only when they asked the same things. */
  fixtureVersion: string;
  tokens: number;
  results: GoldenRow[];
}

/** The version of a task set: its ids and the source of each prompt and check. */
export const goldenFixtureVersion = (tasks: readonly { id: string; prompt: unknown; check: unknown }[]): string =>
  digest(tasks.map(task => `${task.id}\n${String(task.prompt)}\n${String(task.check)}`).join("\n\n")).slice(0, 12);

const fileSafe = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "model";

/** Writes one run's record and returns its path. A run in which nothing was attempted leaves no record. */
export function writeGoldenRecord(dir: string, record: Omit<GoldenRecord, "format">): string | undefined {
  if (record.results.every(row => row.status === "skipped")) return undefined;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `golden-${fileSafe(record.model)}-${record.at.replace(/[:.]/g, "-")}.json`);
  writeFileSync(path, `${JSON.stringify({ format: "lumenbox-golden/1", ...record }, null, 2)}\n`);
  return path;
}

/** Every golden record in a directory, oldest first; a file that is not one is passed over. */
export function readGoldenRecords(dir: string): GoldenRecord[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.startsWith("golden-") && name.endsWith(".json")).flatMap(name => {
    try {
      const record = JSON.parse(readFileSync(join(dir, name), "utf8")) as GoldenRecord;
      return record.format === "lumenbox-golden/1" && Array.isArray(record.results) ? [record] : [];
    } catch {
      return [];
    }
  }).sort((a, b) => (a.at < b.at ? -1 : 1));
}

const MARK: Record<GoldenRow["status"], string> = { pass: "·", fail: "x", error: "!", skipped: "-" };

/**
 * The trend, per model: the last `last` runs of each task side by side, then the latest run
 * against the one before it. Runs of a different task set are shown but not compared.
 */
export function renderGoldenTrend(records: readonly GoldenRecord[], last = 10): string[] {
  if (records.length === 0) return ["No golden runs recorded yet. `agentbox golden <provider>` writes one each time it runs."];
  const lines: string[] = [];
  for (const model of [...new Set(records.map(record => `${record.provider} ${record.model}`))]) {
    const runs = records.filter(record => `${record.provider} ${record.model}` === model).slice(-last);
    lines.push(`${model} — ${runs.length} run(s), ${runs[0]!.at.slice(0, 10)} to ${runs.at(-1)!.at.slice(0, 10)}`);
    const ids = [...new Set(runs.flatMap(run => run.results.map(row => row.id)))];
    let attempts = 0;
    let failures = 0;
    for (const id of ids) {
      const rows = runs.map(run => run.results.find(row => row.id === id));
      const counted = rows.filter(row => row !== undefined && row.status !== "skipped");
      const passed = counted.filter(row => row!.status === "pass").length;
      attempts += counted.length;
      failures += counted.length - passed;
      lines.push(`  ${id.padEnd(22)} ${rows.map(row => (row === undefined ? " " : MARK[row.status])).join("")}  ${passed}/${counted.length}`);
    }
    const bound = failureUpperBound(failures, attempts);
    lines.push(`  ${attempts - failures}/${attempts} attempts passed${bound !== undefined ? `; the failure rate could be as high as ${(bound * 100).toFixed(1)}% (95%)` : ""}`);
    const latest = runs.at(-1)!;
    const before = runs.at(-2);
    if (before === undefined) lines.push("  INCOMPLETE — one run: nothing to compare it with yet");
    else if (before.fixtureVersion !== latest.fixtureVersion) lines.push("  INCOMPLETE — the tasks changed since the run before: not comparable");
    else {
      const outcome = (record: GoldenRecord) => new Map(record.results.filter(row => row.status !== "skipped").map(row => [row.id, row.status === "pass"]));
      const comparison = pairedComparison(outcome(latest), outcome(before));
      lines.push(`  ${comparison.verdict.replaceAll("_", " ")} against ${before.at.slice(0, 16)} — ${comparison.why}`);
    }
    lines.push("  · pass   x fail   ! harness or judge failed   - skipped (needs a box)");
  }
  return lines;
}
