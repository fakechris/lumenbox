/**
 * A task that ends in a file, on the real stack (INV-1663): the scripted agent takes the task,
 * writes the report, marks it with DeliverFile and submits for review. The task's card lists the
 * file, and the download route serves the bytes it was delivered with — after the box has moved on.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { deliverableRoute } from "../web/deliverable-routes.ts";
import { DELIVERABLES_JS as DELIVERABLES_JS_TEMPLATE } from "../web/deliverables-ui.ts";
import { localizeScript } from "../web/page-locale.ts";
const DELIVERABLES_JS = localizeScript(DELIVERABLES_JS_TEMPLATE, "en");
import { runEpisode, type Script } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

const REPORT = "# Q3 summary\n\nRevenue grew 12%; churn fell to 3%.\n";
const PATH = "/home/box/work/reports/q3-summary.md";

/** One step per tool result seen: take the task, write, deliver, submit, say. */
const script: Script = ({ messages }) => {
  const done = JSON.stringify(messages).split('"tool_result"').length - 1;
  const steps = [
    { call: "Tasks", input: { action: "take", id: "t1" } },
    { call: "write_file", input: { path: PATH, content: REPORT } },
    { call: "DeliverFile", input: { path: PATH, note: "The Q3 summary the task asked for" } },
    { call: "Tasks", input: { action: "submit", id: "t1", note: "Written and delivered.", evidence: [`${PATH} — the summary`] } },
  ];
  return steps[done] ?? { say: "The Q3 summary is written and delivered on t1." };
};

test("an agent delivers the file its task was for; the card lists it and the download is the delivered bytes", async () => {
  const tasks = new TaskStore(join(mkdtempSync(join(tmpdir(), "agentbox-deliver-ep-")), "tasks.jsonl"));
  tasks.create({ title: "Write the Q3 summary", requester: "p-chris", conversation: "main" });
  const episode = await runEpisode({ team: [{ name: "Ada" }], says: ["Please do t1, the Q3 summary."], tasks, script });
  try {
    assert.deepEqual(episode.score.refusals, []);
    assert.ok(episode.score.trail.includes("Ada:DeliverFile"), episode.score.trail.join(" "));
    const task = tasks.get("t1")!;
    assert.equal(task.status, "review");
    assert.equal(task.deliverables?.length, 1);
    assert.equal(task.deliverables![0]!.name, "q3-summary.md");

    // The box moves on; the delivery does not.
    episode.files.set(PATH, "overwritten by a later turn");

    // The card, as the page renders it.
    const window: { deliverablesHtml?: (task: unknown) => string } = {};
    runInNewContext(DELIVERABLES_JS, { window, esc: (text: string) => String(text).replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`), encodeURIComponent, Date });
    const card = window.deliverablesHtml!(JSON.parse(JSON.stringify(task)));
    assert.match(card, /Deliverables/);
    assert.match(card, /q3-summary\.md/);
    assert.match(card, /The Q3 summary the task asked for/);
    const href = /href="([^"]+)"/.exec(card)![1]!.replace(/&#38;/g, "&");

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (!deliverableRoute(`${req.method} ${url.pathname}`, url, res, { tasks, mayReadTask: () => true, send: (r, status) => { r.writeHead(status); r.end(); } })) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${href}`);
      assert.equal(response.status, 200);
      assert.equal(Buffer.from(await response.arrayBuffer()).toString("utf8"), REPORT, "byte for byte what was delivered");
    } finally { server.close(); }
  } finally { episode.cleanup(); }
});
