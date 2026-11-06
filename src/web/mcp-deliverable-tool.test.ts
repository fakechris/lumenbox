/** fetch_deliverable (INV-1668): a task's handed-over file through the side door, under the board's own read rule. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { digestOf, writeSnapshot } from "../host/task-deliverables.ts";
import { TaskStore } from "../host/tasks.ts";
import { DELIVERABLE_BASE64_MAX } from "./mcp-deliverable-tool.ts";
import { mcpServerTools } from "./mcp-tools.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-mcp-deliverable-"));
  const board = new TaskStore(join(dir, "tasks.jsonl"));
  const task = board.create({ title: "Look into X", requester: "p-chris", assigneeId: "a-ada" })!;
  const deliver = (name: string, bytes: Buffer, note = "") => {
    const sha256 = writeSnapshot(board.path!, task.id, bytes);
    return board.deliver(task.id, { name, path: `/home/box/work/${name}`, size: bytes.length, sha256, note, at: new Date().toISOString(), by: "a-ada" })!;
  };
  const tools = mcpServerTools({
    registry: { tryGet: () => ({ profile: { name: "Ada" } }) } as never,
    orchestrator: { tasks: board } as never,
    principals: { resolve: (id: string) => ({ name: id }) },
    workDir: "/work",
    log: () => {},
    listen: () => () => {},
    mayReadTask: (_task, principalId) => principalId !== "p-outsider",
  });
  const tool = (name: string) => tools.find(entry => entry.name === name)!;
  return { dir, board, task, deliver, fetch: tool("fetch_deliverable"), status: tool("task_status") };
}

test("text comes back as text, binary as base64 that decodes to the same bytes, and task_status lists both", async t => {
  const { dir, task, deliver, fetch, status } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const none = await fetch.runWithRecord!({ task_id: task.id }, "p-chris");
  assert.match(none.text, /no deliverables yet/);
  const report = deliver("report.md", Buffer.from("# Findings\n\nX is 42.\n"), "the write-up");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const chart = deliver("chart.png", png);

  const newest = await fetch.runWithRecord!({ task_id: task.id }, "p-chris");
  assert.equal(newest.structured.encoding, "base64", "without an id, the newest");
  assert.ok(Buffer.from(String(newest.structured.content), "base64").equals(png));
  assert.equal(digestOf(Buffer.from(String(newest.structured.content), "base64")), chart.sha256);

  const text = await fetch.runWithRecord!({ task_id: task.id, deliverable_id: report.id }, "p-chris");
  assert.equal(text.structured.encoding, "utf8");
  assert.equal(text.structured.content, "# Findings\n\nX is 42.\n");
  assert.match(text.text, /report\.md .*the write-up[\s\S]*X is 42\./);

  const record = (await status.runWithRecord!({ task_id: task.id }, "p-chris")).structured.tasks as { deliverables?: { id: string; name: string }[] }[];
  assert.deepEqual(record[0]!.deliverables!.map(item => `${item.id} ${item.name}`), [`${report.id} report.md`, `${chart.id} chart.png`]);
});

test("a caller who may not see the task is told it does not exist; a missing id lists what there is; a large binary is not sent", async t => {
  const { dir, task, deliver, fetch } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  deliver("big.bin", Buffer.alloc(DELIVERABLE_BASE64_MAX + 1, 0));
  await assert.rejects(fetch.run({ task_id: task.id }, "p-outsider"), new RegExp(`^Error: No task ${task.id}\\.$`));
  await assert.rejects(fetch.run({ task_id: "t999" }, "p-chris"), /No task t999/);
  await assert.rejects(fetch.run({ task_id: task.id, deliverable_id: "d9" }, "p-chris"), /no deliverable d9[\s\S]*big\.bin/);
  const big = await fetch.runWithRecord!({ task_id: task.id }, "p-chris");
  assert.equal(big.structured.encoding, "none");
  assert.equal(big.structured.content, undefined);
  assert.match(big.text, /download it from task/);
});
