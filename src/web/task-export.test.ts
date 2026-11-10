import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TurnLedger } from "../host/resume.ts";
import { TaskStore } from "../host/tasks.ts";
import { digestOf } from "../host/task-deliverables.ts";
import { setRedactionSource } from "../host/secret-redaction.ts";
import { readBoundedEpochs } from "../agents/transcript-bounded.ts";
import { TaskExecutions, ExecutionReset, type ExecutionAccess } from "./task-execution.ts";
import { exportRedaction } from "./task-export-policy.ts";
import { TaskExports, TASK_EXPORT_TTL } from "./task-export.ts";

function fixture(count = 1) {
  const home = mkdtempSync(join(tmpdir(), "task-export-")), tasks = new TaskStore(null);
  const task = tasks.create({ title: "Inspect retained objects", requester: "p", assigneeId: "a", contract: { acceptance: "Person reviews the evidence" } })!;
  const turns = new TurnLedger(join(home, "turns.jsonl"));
  const entries: any[] = [];
  let reads = 0, now = Date.now(), boxAllowed = true, taskAllowed = true;
  const access = (): ExecutionAccess => ({ task: id => taskAllowed && id === task.id, agent: id => id === "a", box: id => boxAllowed && id === "box" });
  const scope = { id: "turn", executionId: "execution", attempt: 2, agentId: "a", boxId: "box", conversation: "chat", contextEpoch: 1, workId: "work", taskBinding: { taskId: task.id, role: "executor" as const } };
  turns.begin({ ...scope, about: "Retained inspection" });
  function step(index: number, result = `result-${index}`, role: "executor" | "child" = "executor", ended = true, tool = "read_file") {
    const call = { type: "tool_use", id: `c${index}`, name: tool, input: { path: "other-task.md", prompt: "INTERNAL-PROMPT-SEED" } };
    entries.push({ kind: "blocks", turnId: scope.id, executionId: scope.executionId, blocks: [call, { type: "thinking", thinking: "HIDDEN-REASONING-SEED" }] });
    const taskBinding = { taskId: task.id, role, ...(role === "child" ? { parent: { conversation: "parent", turnId: "parent-turn", workId: "parent-work", forkId: "fork" } } : {}) };
    turns.observeExecution({ ...scope, taskBinding, event: "step", phase: "start", toolUseId: call.id, tool: call.name, recordId: `start-${index}`, at: new Date(1000 + index).toISOString() });
    if (ended) {
      entries.push({ kind: "results", turnId: scope.id, executionId: scope.executionId, blocks: [{ type: "tool_result", tool_use_id: call.id, content: result }] });
      turns.observeExecution({ ...scope, taskBinding, event: "step", phase: "end", toolUseId: call.id, tool: call.name, recordId: `end-${index}`, at: new Date(5000 + index).toISOString(), outcome: index === 2 ? "failed" : "ok" });
    }
  }
  for (let index = 0; index < count; index++) step(index, `result-${index}`, index % 2 ? "child" : "executor", index !== 3);
  const registry = { readContextTranscriptsByEpoch: () => { reads++; return [{ epoch: 1, entries }]; } };
  const executions = new TaskExecutions({ namespace: "fixture", turns, registry });
  const exports = new TaskExports({ home, executions, task: id => tasks.get(id), now: () => now });
  return { home, task, tasks, turns, scope, entries, step, access, executions, exports,
    get reads() { return reads; }, revokeBox: () => { boxAllowed = false; }, revokeTask: () => { taskAllowed = false; }, expire: () => { now += TASK_EXPORT_TTL; },
    cleanup: () => { setRedactionSource(undefined); rmSync(home, { recursive: true, force: true }); } };
}
function rows(bytes: Buffer) { return bytes.toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }

test("2000-step export preserves the authorized snapshot and resolves each source once per phase", async () => {
  const f = fixture(2000);
  try {
    const before = JSON.stringify(f.tasks.get(f.task.id));
    const page = f.executions.open(f.task.id, f.access());
    const descriptor = await f.exports.create(f.task.id, f.access);
    assert.equal(f.reads, 4, "one reference open, one capture, one hydration, one final validation; never 2000 catalogs");
    const files = new Map(descriptor.files.map(file => [file.name, f.exports.download(f.task.id, descriptor.id, file.name, f.access)]));
    const manifest = JSON.parse(files.get("manifest.json")!.toString()), exported = rows(files.get("steps.jsonl")!);
    assert.equal(exported.length, 2000);
    assert.deepEqual(exported.slice(0, 100).map(row => [row.id, row.sourceRefs, row.parent, row.outcome]), page.steps.map(row => [row.id, row.sourceRefs, row.parent, row.outcome]));
    assert.equal(exported[3].outcome, "running");
    assert.equal(exported[3].resultCoverage, "not-recorded-at-snapshot");
    assert.equal(exported[2].outcome, "failed");
    assert.equal(manifest.highWater, page.highWater);
    assert.equal(manifest.steps, 2000);
    assert.equal(manifest.coverage, "partial", "source-reference-only bodies are explicit, not claimed complete");
    for (const file of manifest.files) assert.equal(digestOf(files.get(file.name)!), file.sha256);
    for (const file of descriptor.files) assert.equal(digestOf(files.get(file.name)!), file.sha256);
    assert.equal(JSON.stringify(f.tasks.get(f.task.id)), before, "export does not submit artifacts, update history or trigger Goal work");
    const all = [...files.values()].map(bytes => bytes.toString()).join("\n");
    for (const seed of ["INTERNAL-PROMPT-SEED", "HIDDEN-REASONING-SEED", "other-task.md", "result-100"]) assert.ok(!all.includes(seed));
    assert.match(all, /source-references-only/);
  } finally { f.cleanup(); }
});

test("even delivered DOM and context bodies stay reference-only; task prose redacts before clipping", async () => {
  const f = fixture(0);
  try {
    const held = "SYNTHETIC-HELD-" + "x".repeat(40), seed = "UNHELD-STRUCTURED-SEED";
    setRedactionSource(() => [{ name: "fixture", value: held }]);
    const text = "v".repeat(31990) + held + " end";
    const json = JSON.stringify({ public: "approved report", token: seed, system_prompt: "SYSTEM-PROMPT-SEED", nested: { authorization: seed } });
    const dom = '- document [ref=e1]:\n - textbox "Customer password" PRIVATE-DOM-SEED';
    f.step(0, text); f.step(1, json); f.step(2, "<html><script>BOOTSTRAP-SEED</script></html>"); f.step(3, dom, "executor", true, "browser_snapshot");
    for (const [index, value] of [text, json, "<html><script>BOOTSTRAP-SEED</script></html>", dom].entries()) f.tasks.deliver(f.task.id, { name: `report-${index}.txt`, path: `report-${index}.txt`, size: Buffer.byteLength(value), sha256: digestOf(Buffer.from(value)), note: "A task delivery", at: new Date().toISOString(), by: "a" });
    f.tasks.update(f.task.id, { title: held, description: json }, "p");
    const redaction = exportRedaction(f.home);
    assert.ok(!String(redaction.clean(text)).includes("SYNTHETIC-HELD-"), "redaction precedes the field clipping boundary");
    assert.deepEqual(redaction.clean(json), { public: "approved report", nested: {} });
    const descriptor = await f.exports.create(f.task.id, f.access);
    const exported = rows(f.exports.download(f.task.id, descriptor.id, "steps.jsonl", f.access));
    assert.ok(exported.every(row => row.result === null && row.input === null && row.resultOmitted));
    assert.ok(exported.every(row => row.artifactId), "exact delivered bytes retain only an artifact reference, even for DOM");
    for (const file of descriptor.files) {
      const content = f.exports.download(f.task.id, descriptor.id, file.name, f.access).toString();
      for (const value of [held, seed, "SYSTEM-PROMPT-SEED", "BOOTSTRAP-SEED", "PRIVATE-DOM-SEED"]) assert.ok(!content.includes(value));
    }
    writeFileSync(join(f.home, "config.json"), JSON.stringify({ key: "NEW-SYNTHETIC-CONFIG-CREDENTIAL" }));
    assert.throws(() => f.exports.download(f.task.id, descriptor.id, "steps.jsonl", f.access), ExecutionReset, "new redaction inputs invalidate old downloads");
  } finally { f.cleanup(); }
});

test("download cache is task-scoped, expiring, reauthorized and invalidated by source rewriting", async () => {
  for (const reason of ["box", "task", "source", "metadata", "ttl"]) {
    const f = fixture();
    try {
      const descriptor = await f.exports.create(f.task.id, f.access);
      assert.throws(() => f.exports.download("other-task", descriptor.id, "task.md", f.access), ExecutionReset);
      for (const file of ["../../config.json", "/etc/passwd", "task.md\r\nX-evil:yes"]) assert.throws(() => f.exports.download(f.task.id, descriptor.id, file, f.access), ExecutionReset);
      if (reason === "box") f.revokeBox();
      if (reason === "task") f.revokeTask();
      if (reason === "source") f.entries.splice(0);
      if (reason === "metadata") f.tasks.scrub("Inspect", "Forgotten");
      if (reason === "ttl") f.expire();
      assert.throws(() => f.exports.download(f.task.id, descriptor.id, "task.md", f.access), ExecutionReset, reason);
    } finally { f.cleanup(); }
  }
});

test("generation rechecks authority during yields and bounds concurrent builds before source reads", async () => {
  const f = fixture(200);
  try {
    const pending = f.exports.create(f.task.id, f.access);
    f.revokeBox();
    await assert.rejects(pending, ExecutionReset);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(f.exports.create(f.task.id, f.access, {}, controller.signal), /abort/i);
  } finally { f.cleanup(); }
  const g = fixture();
  try {
    const one = g.exports.create(g.task.id, g.access), two = g.exports.create(g.task.id, g.access);
    await assert.rejects(g.exports.create(g.task.id, g.access), /capacity/);
    await Promise.all([one, two]);
  } finally { g.cleanup(); }
});

test("frozen export does not gain later results; expiry and physical recovery stay explicit", async () => {
  const f = fixture(4);
  try {
    const capture = f.executions.captureExport(f.task.id, f.access());
    f.entries.push({ kind: "results", turnId: "turn", executionId: "execution", blocks: [{ type: "tool_result", tool_use_id: "c3", content: "LATE-RESULT-SEED" }] });
    const resolved: any[] = [];
    await f.executions.visitExport(capture, f.access, row => resolved.push(row));
    assert.equal(resolved[3].result, null);
    f.entries.splice(1, 1);
    const missing: any[] = [];
    await f.executions.visitExport(capture, f.access, row => missing.push(row));
    assert.equal(missing[0].sourceExpired, true);
    f.turns.begin({ ...f.scope, executionId: "resumed", attempt: 3, about: "Recovery" });
    f.turns.observeExecution({ ...f.scope, executionId: "resumed", attempt: 3, event: "step", phase: "start", toolUseId: "c3", tool: "read_file", recordId: "resumed-call", at: new Date(9000).toISOString() });
    const descriptor = await f.exports.create(f.task.id, f.access);
    const exported = rows(f.exports.download(f.task.id, descriptor.id, "steps.jsonl", f.access));
    assert.equal(exported[3].outcome, "unknown");
    assert.equal(exported[4].executionId, "resumed");
    assert.equal(exported[4].attempt, 3);
    assert.equal(exported[4].result, null);
  } finally { f.cleanup(); }
});

test("bounded source reads retain valid evidence and report byte, entry and malformed-tail gaps", () => {
  const f = fixture(0);
  try {
    const path = join(f.home, "source.jsonl"); writeFileSync(path, JSON.stringify({ kind: "text", text: "x".repeat(10000) }) + "\n");
    const limited = readBoundedEpochs([{ epoch: 1, path }], { bytes: 100, entries: 10 });
    assert.equal(limited.partial, true); assert.ok(limited.gaps!.includes("byte-limit")); assert.equal(limited[0]!.entries.length, 0);
    writeFileSync(path, '{}\n{}\n');
    const prefix = readBoundedEpochs([{ epoch: 1, path }], { bytes: 100, entries: 1 });
    assert.deepEqual(prefix[0]!.entries, [{}]); assert.ok(prefix.gaps!.includes("entry-limit"));
    assert.deepEqual(readBoundedEpochs([{ epoch: 1, path }], { bytes: 100, entries: 2 })[0]!.entries, [{}, {}]);
    f.step(0);
    writeFileSync(path, f.entries.map(entry => JSON.stringify(entry)).join("\n") + '\n{"crash-tail":');
    const executions = new TaskExecutions({ namespace: "fixture", turns: f.turns, registry: { readContextTranscriptsByEpoch: () => readBoundedEpochs([{ epoch: 1, path }], { bytes: 100000, entries: 100 }) } });
    const page = executions.open(f.task.id, f.access());
    assert.equal(page.steps[0]!.outcome, "succeeded", "a crash tail cannot erase the 2000 prior valid observations");
    assert.equal(page.coverage, "partial");
    const detail = executions.detail(f.task.id, f.access(), { snapshot: page.snapshot, step: page.steps[0]!.id });
    assert.equal(detail.result, "result-0"); assert.deepEqual(detail.sourceGaps, ["malformed-line"]);
  } finally { f.cleanup(); }
});


test("progress-only sources participate in download authorization even with an empty work filter", async () => {
  const f = fixture(0);
  try {
    const admission = f.tasks.progress.reserve(f.task.id, "progress-work", "new")!;
    const producer = f.tasks.progress.open({ taskId: f.task.id, admission, agentId: "a", boxId: "box", conversation: "progress-only", turnId: "progress-turn", executionId: "progress-execution", workId: "progress-work", role: "executor" })!;
    f.tasks.progress.receive(producer, { ...f.tasks.progress.info(producer), reportId: "one", observedAt: new Date().toISOString(), unit: "objects", total: 70, objects: Array.from({ length: 70 }, (_, index) => ({ id: `object-${index}`, state: index < 3 ? "failed" : "succeeded", version: "v1" })) }, "progress-source");
    const descriptor = await f.exports.create(f.task.id, f.access, { workId: "no-steps" });
    const md = f.exports.download(f.task.id, descriptor.id, "task.md", f.access).toString();
    assert.match(md, /"processed": 70/); assert.match(md, /"failed": 3/);
    assert.equal(rows(f.exports.download(f.task.id, descriptor.id, "steps.jsonl", f.access)).length, 0);
    f.revokeBox();
    assert.throws(() => f.exports.download(f.task.id, descriptor.id, "task.md", f.access), ExecutionReset);
    const hidden = await f.exports.create(f.task.id, f.access);
    const hiddenText = f.exports.download(f.task.id, hidden.id, "task.md", f.access).toString();
    assert.ok(!hiddenText.includes("progress-source")); assert.ok(!hiddenText.includes('"processed": 70'));
  } finally { f.cleanup(); }
});
