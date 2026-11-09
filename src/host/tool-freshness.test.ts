import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFreshObservation } from "./tool-freshness.ts";

test("mixed-action tools and MCP gateways refresh observations without lifting action limits", () => {
  assert.equal(needsFreshObservation("Jobs", { action: "wait" }), true);
  assert.equal(needsFreshObservation("Jobs", { action: "kill" }), false);
  assert.equal(needsFreshObservation("Tasks", { action: "list" }), true);
  assert.equal(needsFreshObservation("Tasks", { action: "create" }), false);
  assert.equal(needsFreshObservation("connector_request", { method: "GET" }), true);
  assert.equal(needsFreshObservation("connector_request", { method: "POST" }), false);
  const tools = [{ name: "service__state", annotations: { readOnlyHint: true } }];
  assert.equal(needsFreshObservation("UseMcpTool", { tool: "service__state", arguments: {} }, tools), true);
  assert.equal(needsFreshObservation("UseMcpTool", { tool: "service__unknown", arguments: {} }, tools), false);
  assert.equal(needsFreshObservation("UseMcpTool", { tool: "UseMcpTool" }, tools), false);
});
