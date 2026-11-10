import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLedger } from "../host/resume.ts";
import { archivePathFor } from "../host/jsonl.ts";
import type { ExecutionStepRecord } from "../host/execution-records.ts";
import { TaskExecutions, ExecutionReset, type ExecutionAccess } from "./task-execution.ts";

const access: ExecutionAccess = { task: id => id === "task-A", agent: id => id === "agent", box: id => id === "original-box" };
function fixture(count = 1) {
  const dir = mkdtempSync(join(tmpdir(), "task-execution-"));
  const path = join(dir, "turns.jsonl"), turns = new TurnLedger(path);
  const entries: unknown[] = [];
  const scope = { id: "turn", executionId: "invocation", attempt: 1, workId: "work",
    agentId: "agent", boxId: "original-box", conversation: "chat", contextEpoch: 1,
    taskBinding: { taskId: "task-A", role: "executor" as const } };
  turns.begin({ ...scope, about: "synthetic work" });
  function start(index: number, overrides: Partial<ExecutionStepRecord> = {}) {
    const call = { type: "tool_use", id: `c${index}`, name: "read_file", input: { path: `object-${index}.md` } };
    entries.push({ role: "assistant", kind: "blocks", turnId: scope.id, executionId: scope.executionId, blocks: [call] });
    turns.observeExecution({ ...scope, event: "step", recordId: `start-${index}`, phase: "start", toolUseId: call.id, tool: call.name, at: new Date(1_000 + index).toISOString(), ...overrides });
  }
  function end(index: number, text = `result-${index}`) {
    entries.push({ role: "user", kind: "results", turnId: scope.id, executionId: scope.executionId,
      blocks: [{ type: "tool_result", tool_use_id: `c${index}`, content: text }] });
    turns.observeExecution({ ...scope, event: "step", recordId: `end-${index}`, phase: "end", toolUseId: `c${index}`, tool: "read_file", isError: false, at: new Date(5_000 + index).toISOString() });
  }
  for (let i = 0; i < count; i++) { start(i); end(i); }
  const registry = { readContextTranscriptsByEpoch: () => [{ epoch: 1, entries }] };
  const service = () => new TaskExecutions({ namespace: "installation", turns: new TurnLedger(path), registry });
  return { dir, path, turns, entries, scope, start, end, registry, service, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("2000 retained steps paginate exactly once after archive/live duplication and service restart", () => {
  const f = fixture(2000);
  try {
    // Simulate archive copy preceding live-file replacement: readers must not duplicate any row.
    writeFileSync(archivePathFor(f.path, new Date()), readFileSync(f.path));
    const service = f.service();
    let page = service.open("task-A", access);
    assert.equal(page.steps.length, 100);
    assert.equal(page.total, 2000);
    const ids = page.steps.map(s => s.id);
    while (page.nextCursor) {
      page = service.page("task-A", access, { snapshot: page.snapshot, cursor: page.nextCursor, limit: 137 });
      ids.push(...page.steps.map(s => s.id));
    }
    assert.equal(ids.length, 2000);
    assert.equal(new Set(ids).size, 2000);
    const reopened = f.service();
    assert.equal(reopened.open("task-A", access).total, 2000);
    assert.throws(() => reopened.page("task-A", access, { snapshot: page.snapshot }), ExecutionReset);
    rmSync(f.path);
    const retained = f.service().open("task-A", access);
    assert.equal(retained.total, 2000, "archives remain readable after loss of the live tail");
    assert.equal(retained.coverage, "partial", "an archive cannot prove that the missing live tail was empty");
  } finally { f.cleanup(); }
});

test("a frozen running step cannot acquire a later result through its detail endpoint", () => {
  const f = fixture(0);
  try {
    f.start(0);
    const service = f.service(), before = service.open("task-A", access);
    assert.equal(before.steps[0]!.outcome, "running");
    f.end(0, "new result");
    assert.equal(service.page("task-A", access, { snapshot: before.snapshot }).steps[0]!.outcome, "running");
    assert.equal(service.detail("task-A", access, { snapshot: before.snapshot, step: before.steps[0]!.id }).result, null);
    const after = service.open("task-A", access);
    assert.equal(after.steps[0]!.outcome, "succeeded");
    assert.equal(service.detail("task-A", access, { snapshot: after.snapshot, step: after.steps[0]!.id }).result, "new result");
    f.entries.push({ role: "user", kind: "results", turnId: "turn", executionId: "invocation", blocks: [{ type: "tool_result", tool_use_id: "c0", content: "later revised result" }] });
    assert.equal(service.detail("task-A", access, { snapshot: after.snapshot, step: after.steps[0]!.id }).result, "new result", "immutable source hash still resolves the older record");
  } finally { f.cleanup(); }
});

test("task, agent and historical box authorization intersect on every page and detail", () => {
  const f = fixture();
  try {
    let allowed = true;
    const dynamic: ExecutionAccess = { ...access, box: box => allowed && box === "original-box" };
    const service = f.service(), snapshot = service.open("task-A", dynamic);
    assert.equal(snapshot.total, 1);
    allowed = false;
    assert.equal(service.page("task-A", dynamic, { snapshot: snapshot.snapshot }).total, 0);
    assert.throws(() => service.detail("task-A", dynamic, { snapshot: snapshot.snapshot, step: snapshot.steps[0]!.id }), ExecutionReset);
    assert.throws(() => service.page("another-task", access, { snapshot: snapshot.snapshot }), ExecutionReset);
    assert.equal(service.open("task-A", { ...access, agent: () => false }).total, 0);
    assert.equal(service.open("task-A", { ...access, box: box => box === "new-box" }).total, 0, "current box ownership cannot expose old-box data");
  } finally { f.cleanup(); }
});

test("same turn/call in another invocation remains a distinct attempt and never steals a result", () => {
  const f = fixture();
  try {
    f.start(1); // The process dies here: no end record for the original invocation.
    f.turns.begin({ ...f.scope, executionId: "resumed", attempt: 2, about: "resume" });
    f.turns.observeExecution({ ...f.scope, executionId: "resumed", attempt: 2, event: "step", recordId: "resumed-start", phase: "start", toolUseId: "c1", tool: "read_file", at: new Date(10_000).toISOString() });
    const page = f.service().open("task-A", access);
    assert.equal(page.total, 3);
    assert.deepEqual(page.steps.map(s => s.outcome), ["succeeded", "unknown", "running"]);
    assert.notEqual(page.steps[1]!.id, page.steps[2]!.id);
  } finally { f.cleanup(); }
});

test("an early end notification is followed by invalidation after durable transcript results", () => {
  const f = fixture(0);
  try {
    const executions = f.service();
    const snapshots: ReturnType<TaskExecutions["open"]>[] = [];
    const stop = f.turns.onExecution(record => {
      if (record.event === "step" && record.phase === "end") snapshots.push(executions.open("task-A", access));
    });
    f.start(0);
    f.turns.observeExecution({ ...f.scope, event: "step", recordId: "end", phase: "end", toolUseId: "c0", tool: "read_file", at: new Date().toISOString() });
    assert.equal(snapshots.at(-1)!.steps[0]!.outcome, "unknown");
    f.entries.push({ role: "user", kind: "results", turnId: "turn", executionId: "invocation",
      blocks: [{ type: "tool_result", tool_use_id: "c0", content: "durable result" }] });
    f.turns.executionCommitted("turn");
    assert.equal(snapshots.at(-1)!.steps[0]!.outcome, "succeeded");
    assert.equal(executions.detail("task-A", access, { snapshot: snapshots.at(-1)!.snapshot, step: snapshots.at(-1)!.steps[0]!.id }).result, "durable result");
    assert.equal(snapshots[0]!.steps[0]!.outcome, "unknown", "the old high-water remains frozen");
    stop();
  } finally { f.cleanup(); }
});

test("missing or corrupt sources are partial and an ended call without a durable result stays unknown", () => {
  const f = fixture();
  try {
    f.entries.length = 0;
    appendFileSync(f.path, '{"torn":');
    const service = f.service(), page = service.open("task-A", access);
    assert.equal(page.coverage, "partial");
    assert.equal(page.steps[0]!.outcome, "unknown");
    assert.equal(service.detail("task-A", access, { snapshot: page.snapshot, step: page.steps[0]!.id }).resultCoverage, "not-recorded-at-snapshot");
  } finally { f.cleanup(); }
});

test("a durable result without the optional typed end observation cannot imply success", () => {
  const f = fixture(0);
  try {
    f.start(0);
    f.entries.push({ role: "user", kind: "results", turnId: "turn", executionId: "invocation",
      blocks: [{ type: "tool_result", tool_use_id: "c0", content: "Exit code: 1", is_error: false }] });
    const page = f.service().open("task-A", access);
    assert.equal(page.steps[0]!.outcome, "unknown");
    assert.equal(page.steps[0]!.coverage, "partial");
    assert.equal(page.coverage, "partial");
  } finally { f.cleanup(); }
});

test("removed archive inventory, missing details and changed page filters cannot imply complete coverage", () => {
  const f = fixture();
  try {
    const archive = archivePathFor(f.path, new Date());
    writeFileSync(archive, readFileSync(f.path));
    // A later begin captures the retained source inventory before more effects run.
    new TurnLedger(f.path).begin({ id: "other", executionId: "other-invocation", agentId: "other-agent", about: "unrelated" });
    rmSync(archive);
    const service = f.service(), page = service.open("task-A", access);
    assert.equal(page.coverage, "partial");
    assert.throws(() => service.page("task-A", access, { snapshot: page.snapshot, filters: { role: "child" } }), ExecutionReset);
    f.entries.length = 0;
    const detail = service.detail("task-A", access, { snapshot: page.snapshot, step: page.steps[0]!.id });
    assert.equal(detail.sourceExpired, true);
    assert.equal(detail.resultCoverage, "expired");
  } finally { f.cleanup(); }
});

test("maintenance observations remain visible without pretending to be tool calls or business completions", () => {
  const f = fixture(0);
  try {
    f.turns.observeMaintenance({ ...f.scope, event: "maintenance", recordId: "compression", kind: "compacted", covers: 400, summarised: true, at: new Date(1000).toISOString() });
    const service = f.service(), page = service.open("task-A", access);
    assert.equal(page.steps[0]!.kind, "maintenance");
    assert.equal(page.steps[0]!.toolUseId, undefined);
    assert.equal(service.detail("task-A", access, { snapshot: page.snapshot, step: "compression" }).maintenance?.covers, 400);
  } finally { f.cleanup(); }
});

test("typed unknown and approval outcomes override a generic error bit without parsing prose", () => {
  const f = fixture(2);
  try {
    for (const [index, outcome] of ["unknown", "waiting"].entries()) {
      f.turns.observeExecution({ ...f.scope, event: "step", recordId: `typed-${index}`, phase: "end", toolUseId: `c${index}`, tool: "read_file", at: new Date(9000 + index).toISOString(), isError: true, outcome: outcome as "unknown" | "waiting" });
    }
    const page = f.service().open("task-A", access);
    assert.deepEqual(page.steps.map(step => step.outcome), ["unknown", "waiting"]);
  } finally { f.cleanup(); }
});

test("HTTP execution endpoints freeze paging and recheck access before returning detail", async () => {
  const { createServer } = await import("node:http");
  const { taskExecutionRoute } = await import("./task-execution-routes.ts");
  const f = fixture(101);
  let visible = true;
  const dynamic: ExecutionAccess = { ...access, task: id => visible && access.task(id) };
  const executions = f.service();
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    taskExecutionRoute(`${req.method} ${url.pathname}`, url, res, {
      executions, access: dynamic, record: taskId => ({ id: taskId, status: "doing" }),
      send: (out, status, body) => { out.writeHead(status, { "content-type": "application/json" }); out.end(JSON.stringify(body)); },
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const get = async (path: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  try {
    const first = await get("/api/tasks/execution?task=task-A");
    assert.equal(first.status, 200);
    assert.equal(first.body.steps.length, 100);
    assert.equal(first.body.task.id, "task-A");
    const query = new URLSearchParams({ task: "task-A", snapshot: first.body.snapshot, cursor: first.body.nextCursor });
    const next = await get(`/api/tasks/execution?${query}`);
    assert.equal(next.body.steps.length, 1);
    assert.equal(next.body.highWater, first.body.highWater);
    query.set("role", "child");
    assert.equal((await get(`/api/tasks/execution?${query}`)).status, 409, "a cursor cannot silently change filters");
    const detail = new URLSearchParams({ task: "task-A", snapshot: first.body.snapshot, step: first.body.steps[0].id });
    assert.equal((await get(`/api/tasks/execution/step?${detail}`)).body.result, "result-0");
    visible = false;
    const denied = await get(`/api/tasks/execution/step?${detail}`);
    assert.equal(denied.status, 404);
    assert.equal("result" in denied.body, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    f.cleanup();
  }
});
