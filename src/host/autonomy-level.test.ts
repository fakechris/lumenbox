/** A task's autonomy level (INV-1650): the inference table, what each level lets a call do, and the parse. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inferLevel, LEVEL_MEANING, levelAllows, parseLevel } from "./autonomy-level.ts";

test("the inference table: tidy → L1, analyse → L2, ordinary → L4, verified → L5, outward words cap at L4, no changing tool caps at L2", () => {
  const rows: [Parameters<typeof inferLevel>[0], number, RegExp][] = [
    [{ title: "整理本周的会议记录，输出摘要" }, 1, /collect or summarise/],
    [{ title: "Summarise the three PRs for the standup" }, 1, /collect or summarise/],
    [{ title: "分析为什么构建变慢了，给出方案" }, 2, /analysis or a proposal/],
    [{ title: "Compare the two vendors and recommend one" }, 2, /analysis or a proposal/],
    [{ title: "Write the Q3 report" }, 4, /ordinary work/],
    [{ title: "Write the Q3 report", hasContract: true }, 5, /written acceptance/],
    [{ title: "run 3 times a week", isPursuit: true }, 5, /goal with its own gate/],
    [{ title: "Email the Q3 report to the board", hasContract: true }, 4, /reaches outside/],
    [{ title: "把发布说明发到群里" }, 4, /reaches outside/],
    [{ title: "Fix the flaky test and merge it", hasContract: true }, 4, /reaches outside/],
    [{ title: "Implement the new parser", assigneeTools: ["read_file", "WebSearch"] }, 2, /no tool that changes anything/],
    [{ title: "Implement the new parser", assigneeTools: null }, 4, /ordinary/],
  ];
  for (const [input, level, reason] of rows) {
    const got = inferLevel(input);
    assert.equal(got.level, level, `${input.title} → L${got.level} (${got.reasons.join("; ")})`);
    assert.ok(got.reasons.some(r => reason.test(r)), `${input.title}: ${got.reasons.join("; ")}`);
  }
  for (const level of [1, 2, 3, 4, 5] as const) assert.match(LEVEL_MEANING[level], new RegExp(`^L${level} — `));
});

test("what a level lets a call do: inside the box from L3, outward asks at L3–L4 and is free at L5, nothing but looking at L1–L2", () => {
  assert.equal(levelAllows(1, "observe"), "allow");
  assert.equal(levelAllows(1, "self"), "deny");
  assert.equal(levelAllows(2, "self"), "deny");
  assert.equal(levelAllows(2, "reach"), "deny");
  assert.equal(levelAllows(3, "self"), "allow");
  assert.equal(levelAllows(3, "reach"), "ask");
  assert.equal(levelAllows(4, "spend"), "ask");
  assert.equal(levelAllows(4, "irreversible"), "ask");
  assert.equal(levelAllows(5, "reach"), "allow");
  assert.equal(levelAllows(5, "irreversible"), "allow");
});

test("a level parses from a number or an L-prefixed string, and nothing else", () => {
  assert.equal(parseLevel(4), 4);
  assert.equal(parseLevel("L2"), 2);
  assert.equal(parseLevel("5"), 5);
  assert.equal(parseLevel(0), undefined);
  assert.equal(parseLevel("six"), undefined);
  assert.equal(parseLevel(undefined), undefined);
});
