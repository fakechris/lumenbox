import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResultChecks, checkGoal, type ResultCheckPolicy } from "./result-check-policy.ts";
import { runResultCheck } from "./result-check-runner.ts";
import { evidenceDigest, VerificationLedger } from "./review-dispatch.ts";
import { TaskStore } from "./tasks.ts";
import type { ProviderProfile } from "./provider.ts";
import { auditToolAllowed } from "./audit-context.ts";
import { resultCheckRoute } from "../web/result-check-routes.ts";

export const MODEL_CHECK: ResultCheckPolicy = { mode: "model", reason: "Independently confirm the installed artifact", acceptance: "The approved skill is installed", paths: ["/work/skills/import/SKILL.md"], reviewers: 1, maxRounds: 2, maxDispatches: 2, maxCalls: 3, maxMs: 60_000, maxCost: 1 };
const profile = { model: "test", contextWindow: 1000, maxTokens: 100 } as ProviderProfile;
const rates = () => ({ test: { inputPerM: 1, outputPerM: 2 } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "result-check-")), path = join(dir, "checks.jsonl"), tasks = new TaskStore(null);
  const created = tasks.create({ title: "Install the skill", requester: "person", assigneeId: "worker", reviewerId: "reviewer", contract: { acceptance: "The approved skill is installed" } })!;
  const task = tasks.deliveryCommand(created.id, "submit", "worker", { evidence: ["/work/skills/import/SKILL.md: installed"] })!.task;
  let now = Date.now(); const checks = new ResultChecks(path, () => now, rates);
  return { dir, path, tasks, task, checks, tick: (ms: number) => { now += ms; }, now: () => now, cleanup: () => rmSync(dir, { force: true, recursive: true }) };
}

test("checks require goal-specific authority and consume one plan for unchanged evidence across restart", () => {
  const f = fixture(); try {
    assert.equal(f.checks.begin(f.task, ["reviewer"]).plan, undefined);
    f.checks.grant(f.task, MODEL_CHECK, "operator");
    const first = f.checks.begin(f.task, ["reviewer"]).plan!;
    assert.ok(first);
    assert.equal(f.checks.begin(f.task, ["reviewer"]).plan, undefined);
    f.checks.stop(f.task, first.id, "No agreement; a person decides");
    const restarted = new ResultChecks(f.path, f.now, rates);
    assert.equal(restarted.begin(f.task, ["reviewer"]).plan, undefined);
    f.tasks.update(f.task.id, { status: "doing" }, "person");
    const newer = f.tasks.deliveryCommand(f.task.id, "submit", "worker", { evidence: ["New artifact hash"] })!.task;
    assert.ok(restarted.begin(newer, ["reviewer"]).plan);
    const changedGoal = { ...newer, description: "Now test the whole harness" };
    assert.equal(restarted.snapshot(changedGoal).policy.mode, "manual");
    assert.equal(restarted.begin(changedGoal, ["reviewer"]).plan, undefined);
  } finally { f.cleanup(); }
});

test("every provider attempt reserves durable cumulative calls and worst-case cost, including failed or interrupted attempts", () => {
  const f = fixture(); try {
    f.checks.grant(f.task, { ...MODEL_CHECK, maxCalls: 2 }, "operator");
    const plan = f.checks.begin(f.task, ["reviewer"]).plan!;
    assert.equal(f.checks.reserve(f.task, plan.id, "other", profile).allowed, false);
    assert.equal(f.checks.reserve(f.task, plan.id, "reviewer", profile).allowed, true);
    const restarted = new ResultChecks(f.path, f.now, rates);
    assert.equal(restarted.reserve(f.task, plan.id, "reviewer", profile).allowed, true);
    assert.equal(restarted.reserve(f.task, plan.id, "reviewer", profile).allowed, false);
    assert.equal(restarted.snapshot(f.task).calls, 2);
    assert.ok(restarted.snapshot(f.task).reservedCost > 0);
    assert.match(restarted.snapshot(f.task).plans[0]!.reason!, /allowance is exhausted/);
    restarted.grant(f.task, MODEL_CHECK, "operator");
    assert.equal(restarted.snapshot(f.task).calls, 2, "regranting cannot reset total consumption");
  } finally { f.cleanup(); }
});

test("expiry, stale evidence, cancellation, unpriced models and insufficient cost bounds stop before spending", () => {
  for (const why of ["expired", "stale", "cancelled", "unpriced", "cache-unpriced", "cost"] as const) {
    const f = fixture(); try {
      f.checks.grant(f.task, why === "cost" ? { ...MODEL_CHECK, maxCost: 0.00001 } : MODEL_CHECK, "operator");
      const plan = f.checks.begin(f.task, ["reviewer"]).plan!;
      if (why === "expired") f.tick(60_001);
      const task = why === "stale" ? { ...f.task, description: "Another goal" } : why === "cancelled" ? { ...f.task, status: "dropped" as const } : f.task;
      const result = f.checks.reserve(task, plan.id, "reviewer", why === "unpriced" ? { ...profile, model: "unknown" } : why === "cache-unpriced" ? { ...profile, promptCaching: true } : profile);
      assert.equal(result.allowed, false, why); assert.equal(f.checks.snapshot(task).calls, 0);
    } finally { f.cleanup(); }
  }
});

test("deterministic installation file checks use approved bytes, no model, and never replace business acceptance", async () => {
  const f = fixture(); let modelCalls = 0, reads = 0;
  try {
    const content = Buffer.from([0x50, 0x4b, 0xff, 0x80, 0x00]), sha256 = createHash("sha256").update(content).digest("hex");
    const ledger = new VerificationLedger();
    const deps = { checks: f.checks, verifications: ledger, tasks: f.tasks, candidates: () => ["worker", "reviewer"], nameOf: (id: string) => id, isAgent: () => true, read: async () => { reads++; return Buffer.from(content); }, ask: async () => { modelCalls++; return ""; }, log: () => {} };
    await runResultCheck(f.task, deps); assert.equal(modelCalls, 0); assert.equal(reads, 0);
    f.checks.grant(f.tasks.get(f.task.id)!, { mode: "files", reason: "Verify the approved skill was copied completely", files: [{ path: "/work/skills/import/SKILL.md", sha256, acceptance: "Approved skill file matches" }] }, "operator");
    await runResultCheck(f.tasks.get(f.task.id)!, deps);
    assert.equal(reads, 1); assert.equal(modelCalls, 0); assert.equal(f.tasks.get(f.task.id)!.status, "review");
    await runResultCheck(f.tasks.get(f.task.id)!, deps); assert.equal(reads, 1);
    assert.equal(ledger.historyFor(f.task.id)[0]!.verdict, "pass");
  } finally { f.cleanup(); }
});

test("a check can only read its approved task, original conversation and exact evidence paths", () => {
  const scope = { taskId: "t1", digest: "evidence", reviewerId: "reviewer", planId: "plan", assigneeId: "worker", sourceConversation: "main", paths: ["/work/skills/import/SKILL.md"] };
  assert.equal(auditToolAllowed(scope, "Tasks", { action: "read", id: "t1" }), true);
  assert.equal(auditToolAllowed(scope, "ReadHistory", { agent: "worker", conversation: "main" }), true);
  assert.equal(auditToolAllowed(scope, "read_file", { path: scope.paths[0] }), true);
  for (const tool of ["bash", "Fork", "Delegate", "RunOnHost", "UseMcpTool", "SendToAgent", "write_file", "RememberFact", "Recall"]) assert.equal(auditToolAllowed(scope, tool, {}), false, tool);
  assert.equal(auditToolAllowed(scope, "Tasks", { action: "create", title: "Probe" }), false);
  assert.equal(auditToolAllowed(scope, "read_file", { path: "/work/other" }), false);
  assert.equal(auditToolAllowed(scope, "ReadHistory", { agent: "another", conversation: "main" }), false);
});

test("check-policy API requires operator access and a current goal version; corrupted budget state fails closed", async () => {
  const f = fixture(); try {
    const route = "POST /api/tasks/checks", url = new URL("http://localhost/api/tasks/checks");
    const deps = { checks: f.checks, tasks: f.tasks, refused: () => true, mayRead: () => true, readJson: async () => ({ id: f.task.id, action: "grant", policy: MODEL_CHECK, expectedGoal: checkGoal(f.task), expectedEvidence: evidenceDigest(f.task) }), by: "operator" };
    assert.equal((await resultCheckRoute(route, url, deps))!.status, 0);
    assert.equal((await resultCheckRoute(route, url, { ...deps, refused: () => false, readJson: async () => ({ ...await deps.readJson(), expectedGoal: "stale" }) }))!.status, 409);
    assert.equal((await resultCheckRoute(route, url, { ...deps, refused: () => false }))!.status, 200);
    writeFileSync(f.path, "{torn budget authority");
    assert.throws(() => new ResultChecks(f.path), /JSON/);
  } finally { f.cleanup(); }
});
