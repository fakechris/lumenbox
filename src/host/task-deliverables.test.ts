import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BoxClient } from "../box/client.ts";
import { deliverableRoute } from "../web/deliverable-routes.ts";
import { attentionFor } from "./attention.ts";
import { deliverFileTool } from "./deliver-file-tool.ts";
import { deliverablesDir } from "./task-deliverables.ts";
import { TaskStore } from "./tasks.ts";
import type { ToolContext } from "./tools.ts";

const AGENT = "a-ada";

/** A box of files in a Map, enough for DeliverFile: read a file, take an upload, make a directory. */
function box(files: Map<string, Buffer>): BoxClient {
  return {
    downloadFile: async (path: string) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`${path} does not exist`);
      return { path, size: bytes.length, media_type: "application/octet-stream", base64: bytes.toString("base64") };
    },
    uploadFile: async (path: string, base64: string) => { files.set(path, Buffer.from(base64, "base64")); return { path, bytes: 0 }; },
    exec: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
  } as unknown as BoxClient;
}

function setup(conversation = "main") {
  const tasks = new TaskStore(join(mkdtempSync(join(tmpdir(), "agentbox-deliver-")), "tasks.jsonl"));
  const task = tasks.create({ title: "Quarterly report", requester: "p-chris", assigneeId: AGENT, conversation })!;
  tasks.update(task.id, { status: "doing" }, AGENT);
  const files = new Map<string, Buffer>();
  const context = { agent: { id: AGENT }, tasks, taskBinding:{taskId:task.id,role:"executor"}, box: box(files), conversation, turnId: "turn-1" } as unknown as ToolContext;
  return { tasks, task, files, context };
}

/** The download route, served for real, so the test reads what a browser would get. */
async function download(tasks: TaskStore, taskId: string, id: string): Promise<{ status: number; bytes: Buffer; disposition: string | null }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!deliverableRoute(`${req.method} ${url.pathname}`, url, res, { tasks, mayReadTask: () => true, send: (r, status, body) => { r.writeHead(status); r.end(JSON.stringify(body)); } })) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/tasks/deliverable?task=${taskId}&id=${id}`);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()), disposition: response.headers.get("content-disposition") };
  } finally { server.close(); }
}

test("DeliverFile keeps a snapshot and a record; the box changing afterwards does not change what downloads", async () => {
  const { tasks, task, files, context } = setup();
  const original = Buffer.from("# Q3\n\nRevenue grew 12%.\n");
  files.set("/home/box/work/report.md", original);
  const result = await deliverFileTool(context, { path: "/home/box/work/report.md", note: "The Q3 report" });
  assert.equal(result.isError, undefined, result.text);
  assert.match(result.text, /report\.md .* is d1 on t1/);

  const recorded = tasks.get(task.id)!.deliverables!;
  assert.equal(recorded.length, 1);
  assert.deepEqual({ ...recorded[0], at: "" }, { id: "d1", name: "report.md", path: "/home/box/work/report.md", size: original.length, sha256: recorded[0]!.sha256, note: "The Q3 report", at: "", by: AGENT, run: "turn-1" });
  assert.match(tasks.get(task.id)!.history.at(-1)!.note!, /delivered report\.md — The Q3 report/);
  // It survives a restart: the record is on the board's file, the copy beside it, read-only.
  assert.equal(new TaskStore(tasks.path).get(task.id)!.deliverables![0]!.sha256, recorded[0]!.sha256);
  const kept = join(deliverablesDir(tasks.path!), task.id, recorded[0]!.sha256);
  assert.deepEqual(readFileSync(kept), original);
  assert.equal(statSync(kept).mode & 0o222, 0, "the snapshot is not writable");

  files.set("/home/box/work/report.md", Buffer.from("rewritten the next morning"));
  const got = await download(tasks, task.id, "d1");
  assert.equal(got.status, 200);
  assert.deepEqual(got.bytes, original, "the download is the bytes delivered, not the box's current file");
  assert.match(got.disposition!, /attachment; filename="report\.md"/);

  // A retried call is the same delivery; a revision is a second one.
  assert.match((await deliverFileTool(context, { path: "/home/box/work/report.md", note: "again" })).text, /d2 on t1/);
  files.set("/home/box/work/report.md", original);
  assert.match((await deliverFileTool(context, { path: "/home/box/work/report.md", note: "again" })).text, /Already delivered: report\.md is d1/);
  assert.equal(tasks.get(task.id)!.deliverables!.length, 2);
  assert.equal(readdirSync(join(deliverablesDir(tasks.path!), task.id)).length, 2);
  assert.equal((await download(tasks, task.id, "d9")).status, 404);
});

test("DeliverFile refuses a broken file, a path outside the work tree, and somebody else's task", async () => {
  const { tasks, task, files, context } = setup();
  files.set("/home/box/work/deck.pptx", Buffer.from("# not really a deck"));
  const broken = await deliverFileTool(context, { path: "/home/box/work/deck.pptx", note: "The deck" });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /cannot be opened as its name says/);
  assert.match((await deliverFileTool(context, { path: "/etc/passwd", note: "x" })).text, /under \/home\/box\/work/);
  assert.match((await deliverFileTool(context, { path: "/home/box/work/../x.md", note: "x" })).text, /under \/home\/box\/work/);
  tasks.update(task.id, { assigneeId: "a-bob" }, "p-chris");
  files.set("/home/box/work/a.md", Buffer.from("a"));
  assert.match((await deliverFileTool(context, { path: "/home/box/work/a.md", note: "x", task_id: task.id })).text, /assigned to someone else/);
  assert.equal(tasks.get(task.id)!.deliverables, undefined);
});

test("in an outside chat the delivered file goes into the chat's outbox, where the channel push picks it up", async () => {
  const { files, context } = setup("feishu-oc_room");
  files.set("/home/box/work/out/summary.md", Buffer.from("summary"));
  const result = await deliverFileTool(context, { path: "/home/box/work/out/summary.md", note: "Summary" });
  assert.match(result.text, /in this chat's outbox/);
  assert.deepEqual(files.get("/home/box/work/chats/feishu-oc_room/outbox/summary.md"), Buffer.from("summary"));
});

test("a task in review that names a file and marked no deliverable says so on the reviewer's card", async () => {
  const { tasks, task, files, context } = setup();
  tasks.update(task.id, { reviewerId: "p-chris" }, "p-chris");
  tasks.update(task.id, { status: "review", note: "Done", evidence: ["/home/box/work/report.docx — the report"] }, AGENT);
  const card = () => attentionFor({ principalId: "p-chris", identities: [], tasks: tasks.list(), questions: [], nameOf: id => id }).mine.find(item => item.kind === "review")!;
  assert.match(card().detail, /No deliverable was marked: the submission names report\.docx/);
  files.set("/home/box/work/report.md", Buffer.from("r"));
  await deliverFileTool(context, { path: "/home/box/work/report.md", note: "r", task_id: task.id });
  assert.doesNotMatch(card().detail, /No deliverable/);
});

test("on a host box a deliverable is a file under its own work directory, and the review card reads the submission there (INV-1737)", async () => {
  const work = "/Users/ada/lumenbox";
  const { tasks, task, files, context } = setup();
  const host = { ...context, boxKind: "host", boxWorkDir: work } as ToolContext;
  files.set("/home/box/work/report.md", Buffer.from("r"));
  assert.match((await deliverFileTool(host, { path: "/home/box/work/report.md", note: "r" })).text, new RegExp(`must be a file under ${work}/`));
  tasks.update(task.id, { reviewerId: "p-chris", status: "review", note: "Done", evidence: [`${work}/out/q3.md — the report`] }, AGENT);
  const card = () => attentionFor({ principalId: "p-chris", identities: [], tasks: tasks.list(), questions: [], nameOf: id => id, workOf: () => work }).mine.find(item => item.kind === "review")!;
  assert.match(card().detail, /the submission names q3\.md/);
  files.set(`${work}/out/q3.md`, Buffer.from("# Q3\n"));
  const delivered = await deliverFileTool(host, { path: `${work}/out/q3.md`, note: "r", task_id: task.id });
  assert.equal(tasks.get(task.id)!.deliverables?.[0]?.path, `${work}/out/q3.md`, delivered.text);
});
