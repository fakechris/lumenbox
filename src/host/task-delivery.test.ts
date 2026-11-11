import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import { evidenceDigest } from "./review-dispatch.ts";
import { requestsResultCheck } from "./task-delivery.ts";
import { taskDeliveryRoute } from "../web/task-delivery-routes.ts";
import { deliveryTool } from "./task-delivery-tools.ts";

function fixture() { const dir = mkdtempSync(join(tmpdir(), "task-delivery-")), path = join(dir, "tasks.jsonl"), board = new TaskStore(path); const task = board.create({ title: "Install the package", requester: "person", assigneeId: "worker", reviewerId: "reviewer" })!; return { board, path, task, cleanup: () => rmSync(dir, { recursive: true, force: true }) }; }

test("delivery intentions survive restart and repeated submission cannot dispatch another check", () => {
  const f = fixture(); try {
    let checks = 0; f.board.onChange(t => { if (requestsResultCheck(t.history.at(-1))) checks++; });
    assert.equal(f.board.deliveryCommand(f.task.id, "submit", "worker", { evidence: ["installed files and loader result"] })!.outcome, "applied");
    assert.equal(checks, 1);
    const reopened = new TaskStore(f.path); let writes = 0; reopened.onChange(() => writes++);
    assert.equal(reopened.deliveryCommand(f.task.id, "submit", "worker", { evidence: ["installed files and loader result"] })!.outcome, "unchanged");
    assert.equal(reopened.deliveryCommand(f.task.id, "request_check", "reviewer")!.outcome, "unchanged");
    assert.equal(writes, 0);
    reopened.update(f.task.id, { status: "doing", note: "The result was rejected" }, "reviewer");
    assert.equal(reopened.deliveryCommand(f.task.id, "submit", "worker")!.outcome, "refused");
    assert.equal(reopened.get(f.task.id)!.status, "doing");
    reopened.deliveryCommand(f.task.id, "submit", "worker", { evidence: ["fixed files and new loader evidence"] });
    assert.equal(reopened.deliveryCommand(f.task.id, "accept", "stranger")!.outcome, "refused");
    assert.equal(reopened.deliveryCommand(f.task.id, "accept", "reviewer")!.task.status, "done");
    assert.equal(reopened.get(f.task.id)!.delivery!.action, "accept");
  } finally { f.cleanup(); }
});

test("legacy review changes and unrelated notes cannot masquerade as a submitted result", () => {
  const f = fixture(); try {
    let checks = 0; f.board.onChange(t => { if (requestsResultCheck(t.history.at(-1))) checks++; });
    assert.match(f.board.update(f.task.id, { status: "review" }, "worker")!.coerced!, /Use submit/);
    assert.equal(f.board.get(f.task.id)!.status, "open");
    assert.equal(f.board.deliveryCommand(f.task.id, "request_check", "worker")!.outcome, "refused");
    f.board.update(f.task.id, { note: "The model says it finished" }, "worker");
    assert.equal(checks, 0);
  } finally { f.cleanup(); }
});

test("stale evidence does not publish a result or overwrite concurrent work", () => {
  const f = fixture(); try {
    const version = evidenceDigest(f.task); f.board.update(f.task.id, { description: "Updated requirements" }, "person");
    const before = JSON.stringify(f.board.get(f.task.id));
    assert.equal(f.board.deliveryCommand(f.task.id, "submit", "worker", { expectedVersion: version, evidence: ["stale report"] })!.outcome, "refused");
    assert.equal(JSON.stringify(f.board.get(f.task.id)), before);
  } finally { f.cleanup(); }
});

test("Web and model adapters enforce the same refusal and explicit submission while reviewer inspection is preserved", async () => {
  const f = fixture(); try {
    const common = { board: f.board, refused: () => false, mayRead: () => true, by: "worker", view: (t: unknown) => t };
    const refused = await taskDeliveryRoute("POST /api/tasks/delivery", { ...common, readJson: async () => ({ id: f.task.id, action: "accept" }) });
    assert.equal(refused!.status, 409); assert.equal(f.board.get(f.task.id)!.status, "open");
    const submitted = deliveryTool(f.board, { id: f.task.id, action: "submit", evidence: ["files verified"] }, { agent: { id: "worker" } });
    assert.notEqual(submitted.isError, true); assert.equal(f.board.get(f.task.id)!.status, "review");
    const bareAcceptance = deliveryTool(f.board, { id: f.task.id, action: "accept" }, { agent: { id: "reviewer" }, toolsUsedThisTurn: new Set(["Tasks"]) });
    assert.equal(bareAcceptance.isError, true); assert.equal(f.board.get(f.task.id)!.status, "review");
    const accepted = await taskDeliveryRoute("POST /api/tasks/delivery", { ...common, by: "person", readJson: async () => ({ id: f.task.id, action: "accept" }) });
    assert.equal(accepted!.status, 200); assert.equal(f.board.get(f.task.id)!.status, "done");
    const hidden = await taskDeliveryRoute("POST /api/tasks/delivery", { ...common, mayRead: () => false, readJson: async () => ({ id: f.task.id, action: "accept" }) });
    assert.equal(hidden!.status, 404);
  } finally { f.cleanup(); }
});


test("cancelled roots refuse explicit and legacy completion without disturbing another task", () => {
  const board = new TaskStore(null);
  const task = board.create({ title: "Stopped installation", requester: "person", assigneeId: "worker", workRoot: { state: { id: "stopped", owner: "worker", conversation: "main", generation: 2, epoch: 0, status: "cancelled", messages: [], peers: [], awaiting: [] } } })!;
  const other = board.create({ title: "Other installation", requester: "person", assigneeId: "worker" })!;
  const before = JSON.stringify(board.get(task.id));
  assert.equal(board.deliveryCommand(task.id, "submit", "worker")!.outcome, "refused");
  assert.match(board.update(task.id, { status: "done" }, "person")!.coerced!, /cancelled/);
  assert.equal(JSON.stringify(board.get(task.id)), before);
  assert.equal(board.deliveryCommand(other.id, "submit", "worker")!.outcome, "applied");
});
