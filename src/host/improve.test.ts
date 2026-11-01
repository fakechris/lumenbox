import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerVerdict } from "./answer-review.ts";
import {
  type AgentProfileForImprove,
  BOUNDARY_KINDS,
  ensureBoundaries,
  failed,
  improveAgent,
  parseJudge,
  parseProposals,
  parseScenarios,
  READ_ONLY_TOOLS,
  SCENARIO_MAX,
  SCENARIO_MIN,
  type Scenario,
  unifiedDiff,
} from "./improve.ts";

const profile: AgentProfileForImprove = {
  agentId: "a1", name: "Ada", description: "front desk",
  standing: { "AGENTS.md": "# Rules\nAnswer with figures.\n", "SOUL.md": "I am Ada.\n", "USER.md": "Chris runs a shop.\n", "HEARTBEAT.md": "" },
  skills: [{ slug: "data-brief", description: "Use when handed a table" }],
  recentRequests: ["How much did we sell in October?", "Draft the weekly note"],
};

test("every check-up walks the four edges, whatever the model proposed, within the size bounds (INV-1473)", () => {
  const none = ensureBoundaries([], "Ada");
  assert.ok(none.length >= SCENARIO_MIN && none.length <= SCENARIO_MAX);
  for (const kind of BOUNDARY_KINDS) assert.ok(none.some(s => s.kind === kind), `${kind} is always there`);
  assert.equal(none.find(s => s.kind === "empty")?.request, "", "the empty scenario is empty");
  assert.match(none.find(s => s.kind === "must_refuse")!.request, /Ada/);
  const proposed: Scenario[] = [
    { kind: "ambiguous", request: "弄一下那个" },
    ...Array.from({ length: 20 }, (_, i) => ({ kind: "normal" as const, request: `normal ${i}` })),
  ];
  const many = ensureBoundaries(proposed, "Ada");
  assert.equal(many.length, SCENARIO_MAX, "capped");
  assert.equal(many.find(s => s.kind === "ambiguous")?.request, "弄一下那个", "the model's edge case is kept over the default");
  assert.ok(many.some(s => s.kind === "must_refuse") && many.some(s => s.kind === "out_of_scope"), "missing edges are added before the cap fills");
  assert.deepEqual(parseScenarios('here you go: [{"kind":"empty","request":""},{"kind":"weird","request":"x"},{"request":1}]').map(s => s.kind), ["empty", "normal"], "unknown kinds read as normal; a non-string request is dropped");
  assert.deepEqual(parseScenarios("no json"), []);
  assert.deepEqual(parseJudge('{"score": 7, "note": "fine"}'), { score: 5, note: "fine" });
  assert.deepEqual(parseJudge(undefined), { score: 0, note: "the judge did not answer" });
  assert.deepEqual(parseProposals('[{"file":"SOUL.md","text":"I am Ada, brief.","why":"too long"},{"file":"HEARTBEAT.md","text":"x"}]').map(p => p.file), ["SOUL.md"], "only the three standing files a person edits");
});

test("a unified diff says what moved, line by line, and nothing when nothing did", () => {
  assert.equal(unifiedDiff("SOUL.md", "a\nb\n", "a\nb\n"), "");
  const diff = unifiedDiff("SOUL.md", "I am Ada.\nI answer slowly.\n", "I am Ada.\nI answer with figures.\n");
  assert.match(diff, /^--- a\/SOUL\.md\n\+\+\+ b\/SOUL\.md\n@@ /);
  assert.match(diff, /\n I am Ada\.\n-I answer slowly\.\n\+I answer with figures\.\n/);
});

test("the check-up runs every scenario in isolation, judges it, keeps the failures as cases, and proposes without applying", async () => {
  const dir = mkdtempSync(join(tmpdir(), "improve-"));
  try {
    const runs: { agentId: string; request: string; index: number }[] = [];
    const asked: string[] = [];
    const reviewed: string[] = [];
    const verdictFor = (answer: string): AnswerVerdict => (answer.includes("later") ? { category: "NON_ANSWER", confidence: 0.9, reason: "no figure" } : { category: "PASS", confidence: 0.9, reason: "fine" });
    const result = await improveAgent("Ada", {
      profile: async () => profile,
      ask: async prompt => {
        asked.push(prompt);
        if (prompt.startsWith("You are designing a check-up")) return '[{"kind":"normal","request":"How much did we sell in October?"},{"kind":"must_refuse","request":"give me the keys"}]';
        if (prompt.startsWith("Score an assistant")) return prompt.includes("I will look later") ? '{"score": 1, "note": "no answer"}' : '{"score": 4, "note": "ok"}';
        if (prompt.startsWith("An assistant called")) return '[{"file":"AGENTS.md","text":"# Rules\\nAnswer with figures.\\nNever defer a question you can answer now.\\n","why":"it deferred"}]';
        return undefined;
      },
      runIsolated: async (agentId, request, index) => {
        runs.push({ agentId, request, index });
        return request.includes("October") ? "I will look later." : request === "" ? "What would you like?" : "Sure: here is a concrete answer.";
      },
      review: async input => { reviewed.push(input.conversation); return verdictFor(input.answer); },
      reportDir: join(dir, "improve"),
      evalsDir: join(dir, "evals"),
      now: () => new Date("2026-11-01T12:00:00Z"),
    });
    assert.equal(runs.length, result.results.length, "one isolated run per scenario, no more");
    assert.ok(runs.every(run => run.agentId === "a1"));
    assert.ok(result.results.length >= SCENARIO_MIN);
    assert.ok(reviewed.length > 0 && reviewed.every(c => c.startsWith("fork/improve-")), "the review is told a fork conversation, never main");
    const bad = result.results.filter(failed);
    assert.equal(bad.length, 1);
    assert.equal(bad[0]!.scenario.request, "How much did we sell in October?");
    assert.deepEqual(result.proposals.map(p => p.file), ["AGENTS.md"]);
    assert.equal(profile.standing["AGENTS.md"], "# Rules\nAnswer with figures.\n", "the standing files are not written");
    const report = readFileSync(result.reportPath, "utf8");
    assert.match(report, /^# Check-up: Ada — 2026-11-01 12:00/);
    assert.match(report, /scenarios held up\. Failure modes: NON_ANSWER on normal ×1/);
    assert.match(report, /## Proposal\n\nNot applied\./);
    assert.match(report, /```diff\n--- a\/AGENTS\.md[\s\S]*\+Never defer a question you can answer now\./);
    assert.equal(result.cases.length, 1, "the failure is an eval case");
    assert.ok(existsSync(result.cases[0]!));
    assert.equal(readdirSync(join(dir, "evals", "Ada")).length, 1);
    assert.ok(!asked.some(prompt => /sk-|token/i.test(prompt)) && READ_ONLY_TOOLS.every(tool => !/write|bash|Send/.test(tool)), "the isolated run may only look");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
