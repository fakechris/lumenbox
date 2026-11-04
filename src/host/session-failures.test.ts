/** A check-up learns from what went wrong in real sessions (INV-1575): five kinds, counted, placed, replayed. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mineSessionFailures, replayable, renderSessionFailures } from "./session-failures.ts";
import { improveAgent, type ImproveDeps } from "./improve.ts";

const at = (minute: number) => `2026-11-03T10:${String(minute).padStart(2, "0")}:00.000Z`;
const person = (text: string, minute: number) => ({ role: "user", text, at: at(minute) });
const reply = (text: string, minute: number) => ({ role: "assistant", text, at: at(minute) });
const call = (name: string, input: unknown, minute: number) => ({ role: "assistant", kind: "blocks", blocks: [{ type: "tool_use", id: `c${minute}`, name, input }], at: at(minute) });
const result = (text: string, minute: number) => ({ role: "user", kind: "results", blocks: [{ type: "tool_result", tool_use_id: `c${minute}`, content: [{ type: "text", text }] }], at: at(minute) });

const main = [
  person("Summarise yesterday's sales report.", 1),
  reply("Here is the summary of last week's report.", 2),
  person("不对，我说的是昨天的，不是上周的。", 3), // a correction, after a reply
  person("[agent] A message arrived from your teammate Ada: 不对，再看一下", 4), // a teammate, not a person
  person("Read the payroll file and send it to me.", 5),
  call("Bash", { command: "cat /etc/shadow" }, 6),
  result("Refused by rule r3: secrets stay in the vault. Ask the person if you believe this case is different; the rule will refuse it again.", 6),
  person("Check whether the build passes.", 7),
  call("Bash", { command: "npm test" }, 8), result("exit 1", 8),
  call("Bash", { command: "npm test" }, 9), result("exit 1", 9),
  call("Bash", { command: "npm test" }, 10), result("exit 1", 10),
  call("Bash", { command: "npm test" }, 11), result("A person stopped this turn. Do not continue, retry, or start related work.", 11),
  person("<host_notification source=\"goal\">目标 t9 的完成申请没有通过验证；它会继续推进，下一步：补上测试。</host_notification>", 12),
  person("Try listing the files twice.", 13),
  call("Read", { path: "a" }, 14), result("ok", 14),
  call("Read", { path: "a" }, 15), result("ok", 15), // only twice: not a retry
];
const old = [person("Do the old thing.", 0), reply("Done.", 0), { ...person("wrong, the other one", 0), at: "2026-09-01T00:00:00.000Z" }];

test("five kinds are found where they happened, each with what led to it; teammates, pairs and old entries are not", () => {
  const found = mineSessionFailures([{ conversation: "main", entries: main }, { conversation: "feishu-chat-1", entries: old }], new Date("2026-11-01T00:00:00Z"));
  assert.deepEqual(found.counts, { correction: 1, refusal: 1, retry: 1, stopped: 1, rejected: 1 });
  const byKind = Object.fromEntries(found.cases.map(c => [c.kind, c]));
  assert.equal(byKind.correction!.request, "Summarise yesterday's sales report.", "the request the correction was about");
  assert.equal(byKind.correction!.at, at(3));
  assert.equal(byKind.refusal!.request, "Read the payroll file and send it to me.");
  assert.match(byKind.retry!.excerpt, /Bash called 4 times in a row with the same input/);
  assert.equal(byKind.retry!.weight, 4);
  assert.equal(byKind.stopped!.request, "Check whether the build passes.");
  assert.match(byKind.rejected!.excerpt, /完成申请没有通过验证/);
  assert.ok(found.cases.every(c => c.conversation === "main"), "the old conversation's correction is outside the window");
});

test("the worst are picked one per kind first, and the report says how many of each and where", () => {
  const found = mineSessionFailures([{ conversation: "main", entries: main }], new Date("2026-11-01T00:00:00Z"));
  const picked = replayable(found, 4);
  assert.equal(picked.length, 4);
  assert.deepEqual(new Set(picked.map(c => c.kind)).size, 4, "four different kinds before any second of a kind");
  const section = renderSessionFailures(found);
  assert.match(section, /correction 1 · refusal 1 · retry 1 · stopped 1 · rejected 1/);
  assert.match(section, /main · 2026-11-03 10:03:00 — 不对，我说的是昨天的/);
});

test("improve --from-sessions replays the worst beside the usual scenarios, judges them against what went wrong, and keeps failures as evals", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-improve-sessions-"));
  try {
    const asked: string[] = [];
    const deps: ImproveDeps = {
      profile: async () => ({ agentId: "a1", name: "Bob", description: "", standing: {} as never, skills: [], recentRequests: [] }),
      ask: async prompt => { asked.push(prompt); return prompt.startsWith("Score") ? '{"score": 2, "note": "repeated the mistake"}' : "[]"; },
      runIsolated: async (_agent, request) => `answer to ${request}`,
      review: async () => ({ category: "PASS", confidence: 0.9, reason: "fine" }) as never,
      sessions: () => [{ conversation: "main", entries: main }],
      reportDir: join(dir, "improve"),
      evalsDir: join(dir, "evals"),
      now: () => new Date("2026-11-04T00:00:00Z"),
    };
    const run = await improveAgent("Bob", deps, { scenarios: 8, fromSessionsDays: 14 });
    const replays = run.results.filter(r => r.scenario.kind === "replay");
    assert.equal(replays.length, 4, "up to four replays beside the usual eight");
    assert.ok(replays.some(r => r.scenario.request === "Summarise yesterday's sales report."));
    assert.ok(asked.some(p => p.includes("## What went wrong last time") && p.includes("correction (main")), "the judge is told what went wrong");
    const report = readFileSync(run.reportPath, "utf8");
    assert.match(report, /## From real sessions \(since 2026-10-21\)/);
    assert.ok(run.cases.length >= replays.length, "the weak replays are kept as eval cases");
    assert.ok(readdirSync(join(dir, "evals"), { recursive: true }).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
