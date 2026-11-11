/**
 * A sensing round on the real stack (INV-1652): a scripted agent looks around and proposes
 * three findings; a person commits one; the next round proposes nothing again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEpisode } from "./scenario.ts";
import { TaskStore } from "./tasks.ts";

const findings = [
  { title: "Reply to the vendor's quote", discovery_kind: "todo", source: "feishu:oc_vendor", evidence: "\"can you confirm by Friday?\" — unanswered for 2 days", why_now: "the Friday deadline is tomorrow" },
  { title: "CI has failed on main since Monday", discovery_kind: "problem", source: "https://github.com/x/y/actions", evidence: "last 6 runs on main: failure", why_now: "every PR inherits the red" },
  { title: "A customer asked for CSV export twice this week", discovery_kind: "opportunity", source: "feishu:oc_support", evidence: "two requests for 'export to CSV' in support", why_now: "small to build, asked for twice" },
];

function script({ messages }: { messages: unknown[] }): { call: string; input: Record<string, unknown> } | { say: string } {
  const all = JSON.stringify(messages);
  for (const finding of findings) {
    if (!all.includes(`"title":"${finding.title}"`)) return { call: "Tasks", input: { action: "create", level: 2, ...finding } };
  }
  return { say: "Proposed what I found." };
}

test("three findings become three proposals once; a person commits one; the next round repeats none", async () => {
  const tasks = new TaskStore(join(mkdtempSync(join(tmpdir(), "agentbox-sense-")), "tasks.jsonl"));
  const first = await runEpisode({ team: [{ name: "Scout" }], says: ["Look around and propose what needs attention."], tasks, script });
  assert.ok(first.observations.some(o => o.kind === "turn"));
  const proposed = tasks.list().filter(task => task.proposedBy !== undefined).sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(proposed.length, 3, tasks.list().map(t => `${t.id} ${t.title} ${t.status}`).join("; "));
  assert.deepEqual(proposed.map(task => task.discovery?.kind), ["todo", "problem", "opportunity"]);
  assert.ok(proposed.every(task => task.status === "open" && task.discovery?.fingerprint !== undefined && task.level === 2));
  assert.equal(proposed[1]!.discovery?.source, "https://github.com/x/y/actions");

  // The person commits the CI problem and dismisses the vendor todo; the opportunity stays proposed.
  assert.equal(tasks.commit(proposed[1]!.id, "p-chris"), true);
  tasks.update(proposed[0]!.id, { status: "dropped", note: "dismissed" }, "p-chris");
  assert.equal(tasks.get(proposed[1]!.id)!.proposedBy, undefined, "committed: it is work now");

  const second = await runEpisode({ team: [{ name: "Scout" }], says: ["Look around again."], tasks, script });
  assert.ok(second.observations.some(o => o.kind === "turn"));
  assert.equal(tasks.list().filter(task=>!task.workRoot?.automatic).length, 3, "nothing was proposed twice — the dismissed one included");
  // The scripted agent tried to propose again (the scenario does not keep tool results, so the attempts are the evidence) and the board let none through.
  const attempts = second.observations.filter(o => o.kind === "call" && (o as { name?: string }).name === "Tasks");
  assert.ok(attempts.length >= 1, "the second round did try");
  assert.equal(tasks.get(proposed[0]!.id)!.status, "dropped", "dismissed stays dismissed");
  assert.equal(tasks.list().filter(task => task.proposedBy !== undefined && task.status !== "dropped").length, 1, "only the untouched opportunity is still a proposal");
});
