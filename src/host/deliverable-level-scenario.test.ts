/**
 * A task that asks for a file without naming one gets the file (INV-2321).
 *
 * "请分析日志，并导出一个 CSV 文件" and "Analyze the logs and produce a CSV file" ask for a file as plainly as a
 * task that names `summary.csv`, but the level rule only saw the named one, so both ran at L2 and the gate refused
 * the write: the person got a plan back instead of the file. The rows in autonomy-level.test.ts pin the rule; this
 * walks the whole way: the task is made from the person's own words with no level given, the rule infers it, the
 * gate judges every call by it, and the CSV that lands in the box is read back header and rows. The control is
 * the same walk for a task that asks only for advice: the write is refused and no CSV exists, so the gate is
 * really in the path.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyGate } from "./policy.ts";
import { runEpisode } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

const LOG = "/home/box/work/app.log";
const CSV = "/home/box/work/severity.csv";
/** Three severities in a known proportion, so the rows are checkable. */
const LINES = [
  "2026-11-28T09:00:01Z INFO server started",
  "2026-11-28T09:00:02Z WARN cache cold",
  "2026-11-28T09:00:03Z INFO request /health 200",
  "2026-11-28T09:00:04Z ERROR upstream timed out",
  "2026-11-28T09:00:05Z INFO request /api 200",
  "2026-11-28T09:00:06Z WARN retrying upstream",
  "2026-11-28T09:00:07Z ERROR upstream timed out",
  "2026-11-28T09:00:08Z INFO request /api 200",
  "2026-11-28T09:00:09Z ERROR disk almost full",
];

/** Read the log, count what was read, write the CSV, report: what a model that does the asked work would do. */
async function walk(title: string) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-deliverable-level-"));
  const policy = new PolicyGate({ path: join(dir, "policy.jsonl"), limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [], tierGate: "off" } });
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  let taskId = "";
  const result = await runEpisode({
    team: [{ name: "Ada" }],
    says: [],
    policy, tasks,
    files: { [LOG]: `${LINES.join("\n")}\n` },
    script: ({ messages }) => {
      const last = JSON.stringify(messages.at(-1));
      if (!last.includes("tool_result")) return { call: "read_file", input: { path: LOG } };
      if (last.includes("server started")) {
        // The counts come from what the read returned, not from LINES: the CSV is the box's answer.
        const counts = new Map<string, number>();
        for (const [, severity] of last.matchAll(/Z (INFO|WARN|ERROR) /g)) counts.set(severity!, (counts.get(severity!) ?? 0) + 1);
        const rows = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([severity, count]) => `${severity},${count}`);
        return { call: "write_file", input: { path: CSV, content: `severity,count\n${rows.join("\n")}\n` } };
      }
      return { say: "Done." };
    },
    drive: async ({ bus, frontId }) => {
      const task = tasks.create({ title, requester: "chris", assigneeId: frontId })!;
      taskId = task.id;
      tasks.update(task.id, { status: "doing" }, frontId);
      bus.sendFromUser(frontId, title, { taskBinding: { taskId: task.id, role: "executor" } });
      await bus.wake(frontId);
      await bus.idle();
    },
  });
  const level = tasks.get(taskId)?.level;
  return { result, level, cleanup: () => { result.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const title of ["请分析日志，并导出一个 CSV 文件", "Analyze the logs and produce a CSV file"]) {
  test(`"${title}": the rule gives the work, and the CSV in the box has the header and one row per severity`, async () => {
    const { result, level, cleanup } = await walk(title);
    try {
      assert.equal(level, 4, "a task that asks for a file is the work, named or not");
      assert.deepEqual(result.score.refusals.filter(line => /This task is at L/.test(line)), [], "the gate refused nothing for the level");
      assert.equal(result.files.get(CSV), "severity,count\nERROR,3\nINFO,4\nWARN,2\n", "the header, then each severity counted from the log");
    } finally {
      cleanup();
    }
  });
}

test("the control: a task that asks only for advice stays at L2, the same write is refused, and no CSV exists", async () => {
  const { result, level, cleanup } = await walk("分析一下这份日志，给出改进建议");
  try {
    assert.equal(level, 2);
    assert.equal(result.score.refusals.filter(line => /This task is at L2/.test(line)).length, 1, "the write is refused with where the task stops");
    assert.equal(result.files.has(CSV), false);
  } finally {
    cleanup();
  }
});
