import { test } from "node:test";
import assert from "node:assert/strict";
import { SurfaceLedger } from "./show-ui.ts";
import { WorkAttention, type CurrentWork } from "../agents/work-attention.ts";
import { TaskStore } from "./tasks.ts";
import { surfaceActionWork } from "./surface-action.ts";

function fixture() {
  const tasks = new TaskStore(null);
  const state: CurrentWork = { id: "original-work", taskId: "t1", owner: "worker", conversation: "main", generation: 1, epoch: 0, status: "waiting", messages: ["original-request"], peers: [], awaiting: [] };
  const task = tasks.create({ title: "Install the approved skill", requester: "web", assigneeId: "worker", conversation: "main", origin: { kind: "user" }, workRoot: { state } })!;
  const focus = new WorkAttention(undefined, () => 0, tasks.workRoots), surfaces = new SurfaceLedger(null);
  surfaces.record({ agentId: "worker", agentName: "Worker", conversation: "main", surfaceId: "installation", messages: [], at: new Date().toISOString(), work: state });
  const input = { action: { surface: "installation", name: "confirm" }, text: '[Action "confirm" on card installation]', agentId: "worker", conversation: "main", surfaces, focus, tasks };
  return { tasks, task, focus, surfaces, state, input };
}

test("a card press remains an interaction of its original work, including after the physical answer ended", () => {
  const f = fixture();
  assert.ok("taskBinding" in surfaceActionWork(f.input));
  f.focus.settle(f.state, "answered");
  const continued = surfaceActionWork(f.input);
  assert.ok("taskBinding" in continued);
  if (!("taskBinding" in continued)) return;
  assert.equal(continued.work, undefined, "an answered execution is not falsely claimed to be active");
  f.tasks.workRoots.prepare("worker", { id: "press", fromId: "user", fromName: "user", text: f.input.text, priority: false, receivedAt: new Date().toISOString(), conversation: "main", taskBinding: continued.taskBinding, steerable: false }, f.focus);
  assert.equal(f.tasks.list().length, 1); assert.equal(f.tasks.get(f.task.id)!.title, "Install the approved skill");
  assert.equal(f.tasks.get(f.task.id)!.workRoot!.state.id, f.state.id);
});

test("missing, ended, cancelled, superseded and forged card interactions cannot create a user goal", () => {
  for (const why of ["missing", "ended", "cancelled", "superseded", "forged"] as const) {
    const f = fixture();
    if (why === "missing") f.surfaces.close("worker", "main", "installation");
    if (why === "ended") f.tasks.update(f.task.id, { status: "dropped" }, "web");
    if (why === "cancelled") f.focus.cancel(f.state, "web", "Stop this work");
    if (why === "superseded") f.focus.project({ ...f.state, id: "another-work", generation: 2 });
    const result = surfaceActionWork({ ...f.input, ...(why === "forged" ? { text: '[Action "other" on card installation]' } : {}) });
    assert.ok("error" in result, why); assert.equal(f.tasks.list().length, 1);
  }
});
