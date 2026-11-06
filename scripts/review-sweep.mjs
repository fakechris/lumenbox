#!/usr/bin/env node
/**
 * Lists — and with --apply, drops — the tasks that wait in review for a person although an
 * agent asked for them and an agent was named to review them (INV-1647). Those were never the
 * person's to accept: the review record settles them from now on, and the ones left over from
 * before are closed here, with a note, after the list has been read.
 *
 *   node scripts/review-sweep.mjs            # the list, nothing changes
 *   node scripts/review-sweep.mjs --apply    # drops them, one note each
 *
 * Talks to the running app on 127.0.0.1:7777 with the UI token in ~/.agentbox/ui-token.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const apply = process.argv.includes("--apply");
const home = process.env.AGENTBOX_HOME ?? join(homedir(), ".agentbox");
const token = readFileSync(join(home, "ui-token"), "utf8").trim();
const base = process.env.AGENTBOX_URL ?? "http://127.0.0.1:7777";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

const state = await (await fetch(`${base}/api/state`, { headers })).json();
const agents = new Map(state.agents.map(agent => [agent.id, agent.name]));
const tasksBody = await (await fetch(`${base}/api/tasks`, { headers })).json();
const tasks = Array.isArray(tasksBody) ? tasksBody : tasksBody.tasks;
const stale = tasks.filter(task => task.status === "review" && agents.has(task.requester) && task.reviewerId !== undefined && agents.has(task.reviewerId));

const byRequester = new Map();
for (const task of stale) byRequester.set(task.requester, (byRequester.get(task.requester) ?? 0) + 1);
console.log(`${stale.length} task(s) in review, asked for by an agent and reviewed by an agent:`);
for (const [id, count] of byRequester) console.log(`  ${count}\tasked by ${agents.get(id)}`);
for (const task of stale.slice(0, 12)) console.log(`  ${task.id}\t${task.createdAt.slice(0, 10)}\t${task.title.slice(0, 70)}`);
if (stale.length > 12) console.log(`  … and ${stale.length - 12} more`);
const kept = tasks.filter(task => task.status === "review" && !stale.includes(task));
console.log(`${kept.length} task(s) in review stay, as a person asked or reviews them: ${kept.map(task => task.id).join(", ")}`);

if (!apply) { console.log("Nothing changed (pass --apply to drop the listed ones)."); process.exit(0); }
let dropped = 0;
for (const task of stale) {
  const response = await fetch(`${base}/api/tasks/update`, { method: "POST", headers, body: JSON.stringify({ id: task.id, status: "dropped", note: "swept: an agent asked for this and an agent was to review it; no person's word was ever owed (INV-1647)" }) });
  if (response.ok) dropped += 1; else console.error(`  ${task.id}: ${response.status} ${await response.text()}`);
}
console.log(`dropped ${dropped} of ${stale.length}.`);
