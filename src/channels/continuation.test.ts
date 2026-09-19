import { test } from "node:test";
import assert from "node:assert/strict";
import { isContinuation } from "./continuation.ts";

const fresh = { awaitingAnswer: false };

test("a correction or an addition continues the running work", () => {
  for (const text of [
    "毛利改成百分比",
    "改成只做 Q3",
    "不要 PDF，给我 markdown",
    "另外把标题加粗",
    "顺便看下这个 https://x.com/a/status/1",
    "等等，先别发",
    "还有一个：附上来源",
    "actually, use the Q3 numbers",
    "wait — don't send it yet",
    "also include the chart",
  ]) {
    assert.equal(isContinuation(text, fresh), true, text);
  }
});

test("a one-word acknowledgement or an option number is an answer, not new work", () => {
  for (const text of ["好", "可以", "ok", "OK.", "对", "不对", "2", "第二个", "b", "go ahead"]) {
    assert.equal(isContinuation(text, fresh), true, text);
  }
});

test("whatever is said answers a question the agent is waiting on", () => {
  assert.equal(isContinuation("https://x.com/blanplan/status/2100868243489530158", { awaitingAnswer: true }), true);
});

test("a link or a fresh request while work runs is new work, and queues", () => {
  // The three that were swallowed on 2026-09-19 (inbox seq 17/18/19), and the shapes
  // people fire at a busy agent.
  for (const text of [
    "https://x.com/blanplan/status/2100868243489530158",
    "https://x.com/0xCodila/status/2100984487802708306",
    "1/ Introducing CUA-S1: a family of System One Models, small, specialized, and built for computer use.",
    "帮我看看邮件",
    "写一份周报",
    "分析这条推文",
    "what's the weather in Tokyo",
  ]) {
    assert.equal(isContinuation(text, fresh), false, text);
  }
});
