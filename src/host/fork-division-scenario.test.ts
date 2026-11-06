/**
 * The division of work, on the real stack (INV-1667, docs/43): the scripted agent takes a task and
 * forks it in two. One child finds the pricing and hands off done; the other tries to message the
 * team, is refused by the fence (docs/32 §2), and hands off blocked. The task's "Division of work"
 * lists both with the right state, each with its whole chain — sent, started, reported, merged —
 * and the fenced one with the step where the fence stopped it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { DIVISION_JS as DIVISION_JS_TEMPLATE } from "../web/division-ui.ts";
import { localizeScript } from "../web/page-locale.ts";
const DIVISION_JS = localizeScript(DIVISION_JS_TEMPLATE, "en");
import { taskRecord } from "../web/mcp-record.ts";
import { ForkEvents } from "./fork-events.ts";
import { PendingWork } from "./pending-work.ts";
import { runEpisode, type Script } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

const script: Script = ({ system, messages }) => {
  const results = JSON.stringify(messages).split('"tool_result"').length - 1;
  if (/You are a fork/.test(system)) {
    const brief = typeof messages[0]?.content === "string" ? messages[0].content : "";
    if (/pricing/.test(brief)) return { say: 'Acme pricing: 3 tiers, from $9.\nHANDOFF: {"status":"done","reason":"all tiers found"}' };
    return results === 0
      ? { call: "SendToAgent", input: { target_id: "Ada", message: "the price list is ready" } }
      : { say: 'I could not message the team from here.\nHANDOFF: {"status":"blocked","reason":"telling the team needs the parent turn"}' };
  }
  if (results === 0) return { call: "Tasks", input: { action: "take", id: "t1" } };
  if (results === 1) return { call: "Fork", input: { briefs: ["find Acme pricing", "tell the team the price list is ready"] } };
  return { say: "Acme's pricing is three tiers from $9. I have not told the team yet; that needs a message from me, and I will send it next." };
};

test("two forks of one task, one done and one fenced: the task's division of work shows both, each with its whole chain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-division-ep-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  tasks.create({ title: "Price check on Acme, then tell the team", requester: "p-chris", conversation: "main" });
  const pendingWork = new PendingWork(join(dir, "pending-work.jsonl"));
  pendingWork.forks = new ForkEvents(join(dir, "fork-events.jsonl"));
  const episode = await runEpisode({ team: [{ name: "Ada" }], says: ["Please do t1."], tasks, pendingWork, script });
  try {
    // The fence held: the refusal is the one a fork gets, and nothing reached anyone.
    assert.ok(episode.score.trail.includes("Ada:SendToAgent"), "the fork tried");
    assert.equal(episode.score.peerMessages, 0, "and the fence refused it: nothing reached anyone");

    // Read back as a fresh host would, from the file.
    const forks = new ForkEvents(join(dir, "fork-events.jsonl")).ofTask("t1");
    assert.deepEqual(forks.map(fork => [fork.brief, fork.status]), [
      ["find Acme pricing", "done"],
      ["tell the team the price list is ready", "fenced"],
    ]);
    assert.ok(forks.every(fork => fork.parent === "main" && fork.child.startsWith("fork/main-")), "each child names the conversation it was forked from");
    assert.deepEqual(forks[0]!.steps.map(step => step.event), ["fork.spawned", "fork.started", "fork.reported", "fork.merged"]);
    assert.deepEqual(forks[1]!.steps.map(step => [step.event, step.status ?? step.detail]), [
      ["fork.spawned", undefined],
      ["fork.started", undefined],
      ["fork.fenced", "SendToAgent"],
      ["fork.reported", "blocked"],
      ["fork.merged", "done"],
    ], "the chain is whole: sent, started, stopped by the fence, reported, merged into the parent");
    // The parent got the findings before the chain said merged: the results entry is on disk.
    assert.equal(pendingWork.open().length, 0, "the ledger settled both");

    // The record the side door reads carries the same rows.
    const record = taskRecord(tasks.get("t1")!, { nameOf: id => id, forksOf: id => pendingWork.forks!.ofTask(id) });
    assert.deepEqual(record.forks?.map(fork => fork.status), ["done", "fenced"]);

    // And the task card's section, as the page renders it.
    const window: Record<string, unknown> = {};
    runInNewContext(DIVISION_JS, { window, document: { addEventListener: () => {} }, esc: (text: unknown) => String(text), fmtAgo: () => "now" });
    const html = (window.divisionHtml as (task: unknown) => string)({ ...tasks.get("t1")!, forks });
    assert.match(html, /Division of work/);
    assert.equal(html.match(/data-fork="/g)?.length, 2, "two rows");
    assert.deepEqual([...html.matchAll(/data-fork-status="(\w+)"/g)].map(match => match[1]), ["done", "fenced"]);
    assert.match(html, /data-openconv="fork\/main-[^"]+" data-agent=/, "each row opens the child's thread");
    assert.match(html, /fenced \(SendToAgent\)/);
  } finally {
    episode.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
