import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { conversationEndpoint } from "./conversations.ts";
import type { PoppyCompany } from "./discovery.ts";

function company(protocols?: PoppyCompany["agentProtocols"]): PoppyCompany {
  return {
    protocolVersion: "1.0",
    name: "Test",
    domain: "test.example",
    identifier: "https://test.example",
    agentProtocols: protocols,
    raw: {},
  };
}

describe("conversationEndpoint", () => {
  test("finds a poppy protocol", () => {
    const ep = conversationEndpoint(company([
      { type: "poppy", endpoint: "https://test.example/chat" },
    ]));
    assert.ok(ep);
    assert.equal(ep.endpoint, "https://test.example/chat");
  });

  test("finds a poppy-conversation protocol", () => {
    const ep = conversationEndpoint(company([
      { type: "poppy-conversation", endpoint: "https://test.example/converse", description: "Talk to us" },
    ]));
    assert.ok(ep);
    assert.equal(ep.endpoint, "https://test.example/converse");
    assert.equal(ep.description, "Talk to us");
  });

  test("returns null when no poppy protocol", () => {
    const ep = conversationEndpoint(company([
      { type: "openapi", endpoint: "https://test.example/api" },
    ]));
    assert.equal(ep, null);
  });

  test("returns null when no protocols at all", () => {
    assert.equal(conversationEndpoint(company()), null);
    assert.equal(conversationEndpoint(company([])), null);
  });
});
