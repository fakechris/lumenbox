import { test } from "node:test";
import assert from "node:assert/strict";
import { parseContinuation } from "./continuation.ts";

test("natural language never establishes task ownership", () => {
  for (const text of ["好", "2", "另外介绍一个模型", "同时支持哪些格式？", "毛利改成百分比", "https://example.test/new", "25道题\n长短记忆的区别？", "also include the chart", "别发了"]) {
    assert.equal(parseContinuation(text), undefined, text);
  }
});

test("explicit references support free-form and multiline answers", () => {
  assert.deepEqual(parseContinuation("/continue t1 改成百分比"), { kind: "continue", id: "t1", text: "改成百分比" });
  assert.deepEqual(parseContinuation("/answer q1 第一行\n第二行"), { kind: "answer", id: "q1", text: "第一行\n第二行" });
  for (const text of ["/answer", "/answer q1", "/continue t1 ", "/answer ../x 好"]) assert.equal(parseContinuation(text), undefined);
});
