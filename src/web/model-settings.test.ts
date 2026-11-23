import assert from "node:assert/strict";
import { test } from "node:test";
import { OpenAIWireError } from "../host/openai-wire.ts";
import { modelTestError } from "./model-settings.ts";

test("a regional 401 points to the other MiniMax preset without assuming the key's region", () => {
  const denied = Object.assign(new Error("invalid api key"), { status: 401 });
  assert.match(modelTestError("minimax-global", denied).error, /if it came from the other region, select MiniMax \(China\)/);
  assert.match(modelTestError("minimax", denied).error, /select MiniMax \(global\)/);
  assert.equal(modelTestError("anthropic", denied).error, "invalid api key");
});

test("a parameter rejection tells the model tester how to recover instead of showing vendor JSON", () => {
  const detail = '{"error":{"code":"unsupported_parameter","param":"max_tokens"}}';
  assert.match(modelTestError("openai", new OpenAIWireError(400, detail)).error, /Update LumenBox or choose another model/);
  assert.equal(modelTestError("openai", new OpenAIWireError(400, "Not a parameter error")).error, "400 Not a parameter error");
});
