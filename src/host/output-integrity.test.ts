import { test } from "node:test";
import assert from "node:assert/strict";
import { leakedToolCall, malformedNudge, malformedOutput, sanitizeHistoryText } from "./output-integrity.ts";

// The opening of the stored reply from turn 0c87cb81, byte for byte up to the second call.
const INCIDENT =
  "我先动手的是 (1)：拉一份能挂上标准答案的 goal/task harness 评审清单。]<]minimax[>[<tool_call>\n" +
  '{"name": "web_search", "arguments": {"query": "goal-driven agent harness architecture", "top_n": 10, "source": "news"}}\n' +
  '{"name": "web_search", "arguments": {"query": "agent harness loop judge retry budget", "top_n": 10, "source": "news"}}';

test("the incident's reply is a leaked call, found at its marker", () => {
  const found = malformedOutput(INCIDENT, "max_tokens");
  assert.equal(found?.kind, "leaked-tool-call");
  assert.equal(leakedToolCall(INCIDENT)?.at, INCIDENT.indexOf("]<]minimax"));
});

test("each native call format is seen outside code", () => {
  for (const text of [
    '<tool_call>\n{"name": "read_file", "arguments": {}}\n</tool_call>',
    "<minimax:tool_call>\n<invoke name=\"search\">",
    '<function_calls>\n<invoke name="search">',
    "Checking.\n<function=web_search>\n<parameter=query>x</parameter>",
    "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function",
    '[TOOL_CALLS] [{"name": "search"}]',
    '{"name": "web_search", "arguments": {"q": 1}}\n{"name": "web_search", "arguments": {"q": 2}}',
  ]) {
    assert.equal(malformedOutput(text, "end_turn")?.kind, "leaked-tool-call", text);
  }
});

test("talking about the markup is not leaking it", () => {
  for (const text of [
    "Hermes wraps each call in a `<tool_call>` tag with JSON inside.",
    'The format looks like this:\n```\n<tool_call>\n{"name": "search", "arguments": {}}\n</tool_call>\n```\nand the parser reads it.',
    "Models emit <tool_call> tags when the template asks them to.",
    'One call object is fine: {"name": "x", "arguments": {}} is the shape.',
  ]) {
    assert.equal(malformedOutput(text, "end_turn"), undefined, text);
  }
});

test("a loop at the cap is degenerate; the same length of real prose is not", () => {
  const loop = ["Here is the list:", ...Array.from({ length: 60 }, (_, i) => `- agent harness long horizon variant ${i}`)].join("\n");
  assert.equal(malformedOutput(loop, "max_tokens")?.kind, "degenerate");
  assert.equal(malformedOutput(loop, "end_turn"), undefined, "a list that ended on its own is the model's choice");
  const prose = Array.from({ length: 60 }, (_, i) => `${i + 1}. ${["Completion", "Budget", "State", "Recovery", "Caching"][i % 5]} needs ${"a check that ".repeat((i % 3) + 1)}holds under load (${i}).`).join("\n");
  assert.equal(malformedOutput(prose, "max_tokens"), undefined, "a long honest answer that reached the cap is kept");
  const unbroken = `我先查一下。${"再查一下这个问题的相关资料，".repeat(40)}`;
  assert.equal(malformedOutput(unbroken, "max_tokens")?.kind, "degenerate", "a loop with no newlines");
});

test("the retry names the way back only where there are no tools", () => {
  assert.match(malformedNudge("leaked-tool-call", false, true), /没有任何工具[\s\S]*\/new/);
  assert.doesNotMatch(malformedNudge("leaked-tool-call", true, true), /\/new/);
  assert.match(malformedNudge("leaked-tool-call", true, false), /tool interface/);
  assert.match(malformedNudge("degenerate", true, false), /Do not repeat it or continue it/);
});

test("a stored leak goes back to the model cut at the marker, and clean text untouched", () => {
  const cut = sanitizeHistoryText(INCIDENT);
  assert.ok(cut.startsWith("我先动手的是 (1)"));
  assert.equal(cut.includes("web_search"), false);
  assert.match(cut, /never ran and was not an answer/);
  assert.equal(sanitizeHistoryText("plain answer"), "plain answer");
});
