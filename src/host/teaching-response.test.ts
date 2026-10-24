import test from "node:test";
import assert from "node:assert/strict";
import { teachingResponseText } from "./teaching-response.ts";

test("teaching extracts completed text without leaking private reasoning", () => {
  assert.equal(teachingResponseText({ stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "private", signature: "sig" },
    { type: "text", text: '{"skill":null,"question":"Which report?"}', citations: null },
  ] }), '{"skill":null,"question":"Which report?"}');
});

test("teaching rejects truncation, empty reasoning-only output and tool actions", () => {
  assert.throws(() => teachingResponseText({ stop_reason: "max_tokens", content: [
    { type: "text", text: "partial", citations: null },
  ] }), /incomplete/);
  assert.throws(() => teachingResponseText({ stop_reason: "end_turn", content: [
    { type: "thinking", thinking: "private", signature: "sig" },
  ] }), /no proposal/);
  assert.throws(() => teachingResponseText({ stop_reason: "end_turn", content: [
    { type: "tool_use", id: "x", name: "write", input: {}, caller: { type: "direct" } },
  ] }), /action block/);
});
