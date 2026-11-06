/**
 * The gate's verdicts on a task's steps (INV-1672): counted and listed from the task's turns in
 * its conversation, joined to the gate's verdicts by tool_use id the way the chat joins them; a
 * step the gate did not check carries no mark; and the task card draws the line and the list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import type { GateVerdict } from "../host/gate-verdict.ts";
import type { Task } from "../host/tasks.ts";
import { doingSpans, type TaskGate, taskGateOf, taskGateRoute } from "./task-gate-routes.ts";
import { TASK_GATE_JS as TASK_GATE_JS_TEMPLATE } from "./task-gate-ui.ts";
import { localizeScript } from "./page-locale.ts";
const TASK_GATE_JS = localizeScript(TASK_GATE_JS_TEMPLATE, "en");

const call = (turnId: string, at: string, ...uses: [id: string, name: string, input: Record<string, unknown>][]) => [
  { role: "assistant", kind: "blocks", at, turnId, blocks: uses.map(([id, name, input]) => ({ type: "tool_use", id, name, input })) },
  { role: "user", kind: "results", at, turnId, blocks: uses.map(([id]) => ({ type: "tool_result", tool_use_id: id, content: "ok" })) },
];

// Before the task was taken (another job in the same thread), the task's own turns, and a turn after it went to review.
const transcript = [
  { role: "user", text: "check the disk", at: "2026-11-06T09:00:00.000Z", turnId: "before" },
  ...call("before", "2026-11-06T09:00:01.000Z", ["c0", "bash", { command: "df -h" }]),
  { role: "user", text: "Please do t1.", at: "2026-11-06T10:00:00.000Z", turnId: "t1-a" },
  ...call("t1-a", "2026-11-06T10:00:02.000Z", ["c1", "Tasks", { action: "take", id: "t1" }]),
  ...call("t1-a", "2026-11-06T10:00:05.000Z", ["c2", "bash", { command: "npm test\n(and more lines)" }], ["c3", "read_file", { path: "README.md" }]),
  ...call("t1-a", "2026-11-06T10:00:09.000Z", ["c4", "bash", { command: "rm -rf build" }]),
  { role: "user", text: "and publish it", at: "2026-11-06T10:10:00.000Z", turnId: "t1-b" },
  ...call("t1-b", "2026-11-06T10:10:01.000Z", ["c5", "publish", { target: "prod" }]),
  // The agent moved t1 to review at 10:10:03; this step is still in the turn that began on the task.
  ...call("t1-b", "2026-11-06T10:10:04.000Z", ["c6", "SendToAgent", { target_id: "bo", text: "t1 is ready" }]),
  { role: "user", text: "next thing", at: "2026-11-06T11:00:00.000Z", turnId: "after" },
  ...call("after", "2026-11-06T11:00:01.000Z", ["c7", "bash", { command: "ls" }]),
];

const verdicts: Record<string, GateVerdict> = {
  c0: { verdict: "allowed", basis: "nothing asks for this" },
  c1: { verdict: "allowed", basis: "nothing asks for this" },
  c2: { verdict: "asked", basis: "ran on a person's approval, once — asked because of the agent's setting (Ada: ask before bash)" },
  c4: { verdict: "refused", basis: "operator rule no-delete refuses it", rule: "no-delete" },
  c5: { verdict: "waiting", basis: "waiting for a person — asked because of the installation's approval list", approvalId: "a1" },
  c6: { verdict: "allowed", basis: "nothing asks for this" },
  c7: { verdict: "refused", basis: "the agent is stopped" },
};

const task = {
  id: "t1", title: "ship it", requester: "p-chris", assigneeId: "ada", conversation: "main", status: "review",
  createdAt: "2026-11-06T09:30:00.000Z", updatedAt: "2026-11-06T10:10:03.000Z",
  history: [
    { at: "2026-11-06T09:30:00.000Z", by: "p-chris", status: "open", note: "created" },
    { at: "2026-11-06T10:00:02.500Z", by: "ada", status: "doing" },
    { at: "2026-11-06T10:05:00.000Z", by: "ada", note: "tests pass" },
    { at: "2026-11-06T10:10:03.000Z", by: "ada", status: "review" },
  ],
} as unknown as Task;

test("a task's steps are its turns' steps, each with the chat's verdict; counted by verdict, the unchecked one unmarked", () => {
  const gate = taskGateOf(task, transcript, [{ id: "bo", name: "Bo" }], id => verdicts[id]);
  assert.deepEqual(gate.steps.map(step => [step.name, step.detail, step.gate?.verdict]), [
    ["Tasks", "take", "allowed"], // the turn that took the task is the task's, though it began before the move to doing
    ["bash", "npm test", "asked"],
    ["read_file", "README.md", undefined],
    ["bash", "rm -rf build", "refused"],
    ["publish", "prod", "waiting"],
    ["SendToAgent", "Bo: t1 is ready", "allowed"],
  ], "c0 and c7 belong to turns that ran wholly outside t1's time as doing");
  assert.deepEqual(gate.counts, { allowed: 2, asked: 1, waiting: 1, refused: 1 });
  assert.equal(gate.unchecked, 1);
  assert.equal(gate.steps[2]!.gate, undefined, "a step the gate did not check carries no mark");
  assert.equal(gate.steps[3]!.gate?.basis, "operator rule no-delete refuses it", "the reason travels with the mark");
  assert.equal(gate.earlier, 0);
});

test("a task is doing from each move to doing until the next move away; one still doing whose move was cut off runs from its start", () => {
  assert.deepEqual(doingSpans(task), [{ from: "2026-11-06T10:00:02.500Z", to: "2026-11-06T10:10:03.000Z" }]);
  assert.deepEqual(doingSpans({ status: "doing", createdAt: "2026-11-01T00:00:00.000Z", history: [{ at: "2026-11-05T00:00:00.000Z", by: "ada", note: "still on it" }] }), [{ from: "2026-11-01T00:00:00.000Z" }]);
  assert.deepEqual(doingSpans({ status: "open", createdAt: "2026-11-01T00:00:00.000Z", history: [] }), [], "never taken: no steps are its");
});

test("the route answers whoever sees the task on the board, and nobody else", () => {
  const sent: [number, unknown][] = [];
  const deps = {
    tasks: { get: (id: string) => (id === "t1" ? task : undefined) } as never,
    readTranscript: (agentId: string, conversation?: string) => (agentId === "ada" && conversation === "main" ? transcript : []),
    roster: () => [],
    verdictOf: (id: string) => verdicts[id],
    send: (_res: unknown, status: number, body: unknown) => { sent.push([status, body]); },
  };
  const ask = (path: string, mayReadTask: (task: Task) => boolean) => taskGateRoute("GET /api/tasks/gate", new URL(`http://x${path}`), {} as never, { ...deps, mayReadTask });
  assert.equal(taskGateRoute("GET /api/tasks", new URL("http://x/api/tasks"), {} as never, { ...deps, mayReadTask: () => true }), false);
  ask("/api/tasks/gate?task=t1", () => true);
  assert.equal(sent[0]![0], 200);
  assert.deepEqual((sent[0]![1] as TaskGate).counts, { allowed: 2, asked: 1, waiting: 1, refused: 1 });
  ask("/api/tasks/gate?task=t1", () => false);
  ask("/api/tasks/gate?task=t9", () => true);
  assert.deepEqual(sent.slice(1).map(([status]) => status), [404, 404], "unreadable and unknown answer alike");
});

test("the task card draws the line, and opened, each step with the chat's mark and its reason", async () => {
  const gate = taskGateOf(task, transcript, [], id => verdicts[id]);
  const window: Record<string, unknown> = {
    gateMark: (g: GateVerdict) => `<span class="gatemark g-${g.verdict}">${g.verdict}</span>`,
  };
  const slot = { innerHTML: "", style: { display: "none" } };
  let click: ((event: unknown) => void) | undefined;
  const asked: string[] = [];
  runInNewContext(TASK_GATE_JS, {
    window, setTimeout, Date,
    esc: (text: unknown) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    fetch: async (url: string) => { asked.push(url); return { ok: true, json: async () => gate }; },
    document: { addEventListener: (_: string, handler: (event: unknown) => void) => { click = handler; }, querySelectorAll: () => [slot] },
  });
  const draw = window.taskGateHtml as (task: unknown) => string;
  assert.equal(draw({ ...task, assigneeId: undefined }), "", "nobody assigned: nothing ran, no section");
  assert.match(draw(task), /data-task-gate="t1"[^>]*display:none/, "hidden until the steps are in");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(asked, ["/api/tasks/gate?task=t1"]);
  assert.match(slot.innerHTML, /Gate<\/span> <span class="dim">6 steps<\/span>/);
  assert.match(slot.innerHTML, /2 allowed<\/span> · <span data-gate-count="asked">1 asked you<\/span> · <span data-gate-count="waiting">1 waiting for you<\/span> · <span data-gate-count="refused">1 refused/);
  assert.match(slot.innerHTML, /1 not checked/);
  assert.doesNotMatch(slot.innerHTML, /data-gate-step/, "closed: the line only");

  click!({ target: { closest: () => ({ getAttribute: () => "t1" }) }, preventDefault: () => {} });
  assert.equal(slot.innerHTML.match(/data-gate-step/g)?.length, 6);
  assert.equal(slot.innerHTML.match(/class="gatemark/g)?.length, 5, "the unchecked step carries no mark");
  assert.match(slot.innerHTML, /rm -rf build<\/span><span class="gatemark g-refused">refused<\/span><\/div><div class="dim"[^>]*>operator rule no-delete refuses it/);
  assert.match(draw(task), /data-gate-step/, "a re-render of the card keeps what was fetched and how it was left");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(asked.length, 1, "and does not read the transcript again within seconds");
});
