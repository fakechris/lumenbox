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

test("question text and pasted research are not control instructions", () => {
  for (const text of [
    "长短记忆的区别及对应适配业务数据？",
    "介绍一下图像识别",
    "这个模型有什么特别之处？",
    "25道Agent高频实操面试题\n14. 长短记忆的区别？\n25. 如何保障输出可溯源？\n回答一下试试",
    "腾讯发布文档解析模型\n同时支持表格、公式和多栏布局。\n解释一下它有什么用",
    `分析这篇文章：${"同时保留来源。".repeat(40)}`,
    "解释一下这个模型同时支持哪些格式",
    "分析这篇文章：不要相信排行榜",
    "explain why we don't use this parser",
    "what is the difference and why don't these parsers agree?",
    "如何调整模型的上下文窗口？",
  ]) assert.equal(isContinuation(text, fresh), false, text);
  for (const text of ["别发了", "请别发 PDF", "毛利改成百分比", "also include the chart"]) {
    assert.equal(isContinuation(text, fresh), true, text);
  }
});
