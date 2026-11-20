/**
 * A verification with a recording, on the real stack (INV-1925): the scripted member plans two
 * scenarios, records, checks three assertions (one fails) and finishes. The report counts what
 * was checked, keeps the failure in the member's words, and orders the checks by when they came.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runEpisode, type Script } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";
import { reportCounts, reportsDir, VerificationReports } from "./verification-report.ts";

const script: Script = ({ messages }) => {
  const done = JSON.stringify(messages).split('"tool_result"').length - 1;
  const steps = [
    { call: "Verify", input: { action: "plan", title: "Export to CSV", version: "abc1234", scenarios: [
      { name: "Export", assertions: ["the button downloads a file", "the file has a header row"] },
      { name: "Empty table", assertions: ["an empty table exports only the header"] },
    ] } },
    { call: "Verify", input: { action: "start" } },
    { call: "Verify", input: { action: "check", assertion: "s1.a1", result: "pass", observed: "export.csv landed in Downloads" } },
    { call: "Verify", input: { action: "check", assertion: "s1.a2", result: "fail", observed: "the first row is data; there is no header" } },
    { call: "Verify", input: { action: "check", assertion: "s2.a1", result: "pass", observed: "one line: the header" } },
    { call: "Verify", input: { action: "finish", conclusion: "The export downloads and an empty table is right; the header row is missing on a full table." } },
  ];
  return steps[done] ?? { say: "Verified: 2 passed, 1 failed (the header row is missing)." };
};

test("a member verifies two scenarios with one failure; the report's counts, failure and timestamps hold", async () => {
  const tasks = new TaskStore(join(mkdtempSync(join(tmpdir(), "agentbox-verify-ep-")), "tasks.jsonl"));
  const recordings: string[] = [];
  const episode = await runEpisode({
    team: [{ name: "Ada" }], says: ["Please verify the CSV export."], tasks, script,
    box: {
      startRecording: async ({ display, name }: { display: number; name?: string }) => { recordings.push(`start ${name}`); return { id: "r1", display, file: `${name}.mp4`, path: "", started_at: "" }; },
      stopRecording: async (display?: number) => { recordings.push("stop"); return { id: "r1", display: display ?? 0, file: "", path: "", started_at: "" }; },
    },
  });
  try {
    assert.deepEqual(episode.score.refusals, []);
    const [report] = new VerificationReports(reportsDir(tasks.path!)).list(episode.registry.list()[0]!.id);
    assert.ok(report, "a report was kept");
    assert.equal(report.state, "finished");
    assert.deepEqual(reportCounts(report), { passed: 2, failed: 1, unchecked: 0 });
    const failed = report.scenarios.flatMap(scenario => scenario.assertions).filter(item => item.result === "fail");
    assert.deepEqual(failed.map(item => [item.id, item.fact, item.observed]), [["s1.a2", "the file has a header row", "the first row is data; there is no header"]]);
    const stamps = report.scenarios.flatMap(scenario => scenario.assertions).map(item => item.offsetMs!);
    assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, "checks are placed in the order they came");
    assert.ok(stamps.every(stamp => stamp >= 0));
    assert.deepEqual(recordings, [`start verify-${report.id}`, "stop"]);
    assert.equal(report.recording?.file, `verify-${report.id}.mp4`);
    assert.ok(episode.observations.some(item => item.name === "ShowUI:delivered" && (item.input as { surface?: string }).surface === `verify-${report.id}`), "the card was shown");
  } finally { episode.cleanup(); }
});
