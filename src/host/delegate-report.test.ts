/**
 * The delegated engine's report (INV-1261): what the gate accepts, every reason it refuses,
 * and how the verdict meets the engine's own completion event.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { deliveryInstructions, judgeWithReport, reportPath, summariseReport, validateDelegateReport } from "./delegate-report.ts";

const good = {
  done: [{ what: "tests pass", evidence: { kind: "command", command: "npm test", output: "12 passing" } }, { what: "wrote the migration", evidence: { kind: "path", path: "db/0007.sql" } }],
  not_done: [],
  problems: [],
  verdict: "done",
};

test("a report in shape is accepted, with its text redacted and bounded", () => {
  const checked = validateDelegateReport(good);
  assert.ok("report" in checked);
  assert.equal(checked.report.verdict, "done");
  assert.equal(checked.report.done.length, 2);
  assert.equal(reportPath("job-1"), "/home/box/work/.lumenbox/reports/job-1.json");
});

test("every reason a report is refused is named, so the engine fixes them in one go", () => {
  const errorsOf = (input: unknown) => {
    const checked = validateDelegateReport(input);
    assert.ok("errors" in checked, "expected a refusal");
    return checked.errors.join("\n");
  };
  assert.match(errorsOf("nope"), /must be a JSON object/);
  assert.match(errorsOf({ ...good, verdict: "unknown" }), /verdict must be done, partial or failed \(unknown is the host's to say/);
  assert.match(errorsOf({ ...good, done: [{ what: "it works" }] }), /done\[0\]\.evidence is missing: a claim is not evidence/);
  assert.match(errorsOf({ ...good, done: [{ what: "it works", evidence: { kind: "feeling" } }] }), /evidence\.kind must be command, path or diff/);
  assert.match(errorsOf({ ...good, done: [{ what: "", evidence: { kind: "path", path: "x" } }] }), /done\[0\]\.what must be a non-empty string/);
  assert.match(errorsOf({ ...good, not_done: [{ what: "docs" }] }), /verdict done with items not done: say partial/);
  assert.match(errorsOf({ ...good, done: [] }), /verdict done with nothing in done/);
  assert.match(errorsOf({ ...good, extra: 1 }), /unknown field\(s\): extra/);
  assert.match(errorsOf({ ...good, problems: "none" }), /problems must be an array/);
  assert.match(errorsOf({ ...good, done: [{ what: "x", evidence: { kind: "command", command: "c", output: "y".repeat(3000) } }] }), /over 2000 characters/);
  const many = { ...good, problems: Array.from({ length: 40 }, (_, i) => `p${i}`) };
  assert.match(errorsOf(many), /problems has 40 items; at most 32/);
});

test("the report meets the event: agreement or silence from the event takes the report; a contradiction is unknown; a done claim with no report is unknown", () => {
  const report = (validateDelegateReport(good) as { report: never }).report;
  const partial = (validateDelegateReport({ ...good, not_done: [{ what: "docs", why: "no time" }], verdict: "partial" }) as { report: never }).report;
  assert.deepEqual(judgeWithReport({ outcome: "done", why: "claude reported it completed" }, report).outcome, "done");
  assert.match(judgeWithReport({ outcome: "unknown", why: "no completion report" }, report).why, /report says done, with 2 done item\(s\) carrying evidence/);
  assert.equal(judgeWithReport({ outcome: "done", why: "ok" }, partial).outcome, "done");
  assert.match(judgeWithReport({ outcome: "done", why: "ok" }, partial).why, /partial: 1 not done/);
  const clash = judgeWithReport({ outcome: "failed", why: "pi reported a failure: 400" }, report);
  assert.equal(clash.outcome, "unknown");
  assert.match(clash.why, /report says done but its completion event says failed \(pi reported a failure: 400\); both are recorded/);
  assert.equal(judgeWithReport({ outcome: "aborted", why: "killed" }, report).outcome, "aborted");
  const noReport = judgeWithReport({ outcome: "done", why: "claude reported it completed" }, undefined);
  assert.equal(noReport.outcome, "unknown");
  assert.match(noReport.why, /delivered no report — a completion claim with no evidence is not a result/);
  assert.equal(judgeWithReport({ outcome: "failed", why: "400" }, undefined).outcome, "failed", "a failure needs no report to be a failure");
});

test("the summary and the brief's instructions name the channel and the rule", () => {
  const report = (validateDelegateReport(good) as { report: never }).report;
  assert.match(summariseReport(report), /^verdict done\. done: tests pass \(`npm test` → 12 passing\); wrote the migration \(db\/0007\.sql\)$/);
  assert.match(deliveryInstructions("mcp", "job-1"), /calling the MCP tool `delegate_submit`.*call it again; the run is not complete until it accepts/);
  assert.match(deliveryInstructions("file", "job-1"), /write your report to \/home\/box\/work\/\.lumenbox\/reports\/job-1\.json/);
  assert.match(deliveryInstructions("file", "job-1"), /your own statement is not evidence/);
});
