/** Golden runs are kept and read back as a trend; one red row is not a regression (INV-821). */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type GoldenRecord, type GoldenRow, goldenFixtureVersion, readGoldenRecords, renderGoldenTrend, writeGoldenRecord } from "./golden-trend.ts";

const row = (id: string, status: GoldenRow["status"]): GoldenRow => ({ id, status, detail: status, ms: 1200 });
const run = (at: string, statuses: Record<string, GoldenRow["status"]>, more: Partial<GoldenRecord> = {}): Omit<GoldenRecord, "format"> => ({
  at, provider: "wire", model: "model/a", build: "0.4.5", fixtureVersion: "f1", tokens: 42_000, results: Object.entries(statuses).map(([id, status]) => row(id, status)), ...more,
});
const many = (passes: number, total: number): Record<string, GoldenRow["status"]> => Object.fromEntries(Array.from({ length: total }, (_, i) => [`t${String(i).padStart(2, "0")}`, i < passes ? "pass" : "fail"]));

test("a run is written whole beside the scorecards and read back oldest first; a run that attempted nothing leaves no record", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv1772-golden-"));
  try {
    const second = writeGoldenRecord(join(dir, "scorecards"), run("2026-11-19T02:00:00.000Z", { todo: "pass", shell: "fail", browse: "skipped" }))!;
    writeGoldenRecord(join(dir, "scorecards"), run("2026-11-18T02:00:00.000Z", { todo: "pass", shell: "error" }));
    assert.match(second, /scorecards\/golden-model-a-2026-11-19T02-00-00-000Z\.json$/, "the model's name is made safe for a file");
    assert.equal(writeGoldenRecord(join(dir, "scorecards"), run("2026-11-20T02:00:00.000Z", { browse: "skipped" })), undefined);
    writeFileSync(join(dir, "scorecards", "golden-torn.json"), "{");
    writeFileSync(join(dir, "scorecards", "2026-11-19-abc.json"), JSON.stringify({ format: "lumenbox-scorecard/1" }));
    const records = readGoldenRecords(join(dir, "scorecards"));
    assert.deepEqual(records.map(record => record.at.slice(0, 10)), ["2026-11-18", "2026-11-19"]);
    assert.deepEqual(records[1], { format: "lumenbox-golden/1", ...run("2026-11-19T02:00:00.000Z", { todo: "pass", shell: "fail", browse: "skipped" }) });
    assert.deepEqual(readGoldenRecords(join(dir, "nowhere")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the trend shows each task's runs side by side; one red row is INCOMPLETE, ten of thirty is REVIEW, and a changed task set is not compared", () => {
  const record = (at: string, statuses: Record<string, GoldenRow["status"]>, more: Partial<GoldenRecord> = {}): GoldenRecord => ({ format: "lumenbox-golden/1", ...run(at, statuses, more) });
  const small = renderGoldenTrend([
    record("2026-11-17T02:00:00.000Z", { todo: "pass", shell: "pass", browse: "skipped" }),
    record("2026-11-18T02:00:00.000Z", { todo: "pass", shell: "error", browse: "skipped" }),
    record("2026-11-19T02:00:00.000Z", { todo: "pass", shell: "fail" }),
  ]);
  assert.equal(small[0], "wire model/a — 3 run(s), 2026-11-17 to 2026-11-19");
  assert.ok(small.includes("  todo                   ···  3/3"));
  assert.ok(small.includes("  shell                  ·!x  1/3"), small.join("\n"));
  assert.ok(small.includes("  browse                 --   0/0"), "a skipped task is shown and not counted");
  assert.ok(small.some(line => /^ {2}4\/6 attempts passed; the failure rate could be as high as \d+\.\d% \(95%\)$/.test(line)));
  assert.ok(small.some(line => line.startsWith("  NO CHANGE DETECTED against 2026-11-18T02:00")), "error then fail is not a drop");

  const verdict = (records: GoldenRecord[]) => renderGoldenTrend(records).find(line => /^ {2}(REVIEW|INCOMPLETE|IMPROVED|NO CHANGE)/.test(line))!;
  assert.match(verdict([record("2026-11-18T02:00:00.000Z", many(3, 3)), record("2026-11-19T02:00:00.000Z", many(2, 3))]), /^ {2}INCOMPLETE against .* cannot be told from noise/);
  assert.match(verdict([record("2026-11-18T02:00:00.000Z", many(30, 30)), record("2026-11-19T02:00:00.000Z", many(20, 30))]), /^ {2}REVIEW against .*10 worse, 0 better of 30/);
  assert.match(verdict([record("2026-11-19T02:00:00.000Z", many(3, 3))]), /INCOMPLETE — one run/);
  assert.match(verdict([record("2026-11-18T02:00:00.000Z", many(3, 3)), record("2026-11-19T02:00:00.000Z", many(0, 3), { fixtureVersion: "f2" })]), /the tasks changed since the run before: not comparable/);

  const two = renderGoldenTrend([record("2026-11-19T02:00:00.000Z", many(1, 1)), record("2026-11-19T03:00:00.000Z", many(1, 1), { model: "model/b" })]);
  assert.equal(two.filter(line => line.startsWith("wire model/")).length, 2, "each model has its own trend");
  assert.match(renderGoldenTrend([])[0]!, /No golden runs recorded yet/);
});

test("the task set's version follows its ids and its code", () => {
  const tasks = [{ id: "a", prompt: () => "say a", check: () => true }];
  assert.equal(goldenFixtureVersion(tasks), goldenFixtureVersion([{ ...tasks[0]! }]));
  assert.notEqual(goldenFixtureVersion(tasks), goldenFixtureVersion([{ ...tasks[0]!, prompt: () => "say b" }]));
});
