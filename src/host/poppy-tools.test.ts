import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { poppyToolDefinitions, dispatchPoppyTool, type PoppyToolContext } from "./poppy-tools.ts";

/** Minimal fake PoppyManager. */
function fakeManager(opts: {
  ready?: boolean;
  discover?: Record<string, unknown>;
  status?: Record<string, unknown>;
} = {}) {
  return {
    ready: opts.ready ?? true,
    get clientId() { return "agent_test"; },
    async discover(domain: string) {
      return opts.discover?.[domain] ?? null;
    },
    async discoverWithAuth(domain: string) {
      const company = opts.discover?.[domain];
      if (!company) return null;
      return { company, authServer: null };
    },
    async conversationEndpointFor() { return null; },
    async converse() { return null; },
    status() {
      return opts.status ?? {
        ready: true,
        clientId: "agent_test",
        activeSessions: [],
        negativeCache: [],
        tokens: [],
        pendingAuthFlows: 0,
        pendingDeviceFlows: 0,
      };
    },
  } as unknown as PoppyToolContext["manager"];
}

describe("poppyToolDefinitions", () => {
  test("returns three tools", () => {
    const tools = poppyToolDefinitions();
    assert.equal(tools.length, 3);
    const names = tools.map(t => t.name);
    assert.ok(names.includes("PoppyDiscover"));
    assert.ok(names.includes("PoppyConverse"));
    assert.ok(names.includes("PoppyStatus"));
  });
});

describe("dispatchPoppyTool", () => {
  test("returns error when manager is not ready", async () => {
    const ctx: PoppyToolContext = { manager: fakeManager({ ready: false }) };
    const result = await dispatchPoppyTool("PoppyDiscover", { domain: "test.com" }, ctx);
    assert.ok(result.isError);
    assert.ok(result.text.includes("not available"));
  });

  test("PoppyDiscover returns info for a known domain", async () => {
    const ctx: PoppyToolContext = {
      manager: fakeManager({
        discover: {
          "test.example": {
            protocolVersion: "1.0",
            name: "TestCo",
            domain: "test.example",
            identifier: "https://test.example",
            agentProtocols: [{ type: "poppy", endpoint: "https://test.example/chat" }],
            raw: {},
          },
        },
      }),
    };
    const result = await dispatchPoppyTool("PoppyDiscover", { domain: "test.example" }, ctx);
    assert.ok(result.text.includes("TestCo"));
    assert.ok(result.text.includes("test.example"));
  });

  test("PoppyDiscover returns message for unknown domain", async () => {
    const ctx: PoppyToolContext = { manager: fakeManager() };
    const result = await dispatchPoppyTool("PoppyDiscover", { domain: "unknown.example" }, ctx);
    assert.ok(result.text.includes("does not publish"));
  });

  test("PoppyStatus returns status", async () => {
    const ctx: PoppyToolContext = {
      manager: fakeManager({
        status: {
          ready: true,
          clientId: "agent_xyz",
          activeSessions: ["allbirds.com"],
          negativeCache: ["example.com"],
          tokens: [],
          pendingAuthFlows: 0,
          pendingDeviceFlows: 0,
        },
      }),
    };
    const result = await dispatchPoppyTool("PoppyStatus", {}, ctx);
    assert.ok(result.text.includes("agent_xyz"));
    assert.ok(result.text.includes("allbirds.com"));
  });

  test("PoppyConverse returns error when domain has no conversation", async () => {
    const ctx: PoppyToolContext = { manager: fakeManager() };
    const result = await dispatchPoppyTool(
      "PoppyConverse",
      { domain: "test.example", message: "hello" },
      ctx,
    );
    assert.ok(result.isError);
    assert.ok(result.text.includes("does not support"));
  });

  test("unknown tool returns error", async () => {
    const ctx: PoppyToolContext = { manager: fakeManager() };
    const result = await dispatchPoppyTool("PoppyFoo", {}, ctx);
    assert.ok(result.isError);
    assert.ok(result.text.includes("Unknown"));
  });
});
