/**
 * The MCP bridge, against a real child process speaking the real protocol.
 *
 * A stub server rather than a mocked transport, because the failures worth catching
 * are the wire's own: a handshake in the wrong order, a framing bug that eats a
 * message, a dead pipe that leaves a promise hanging forever.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, MCP_SEPARATOR } from "./mcp.ts";

/** A minimal MCP server: initialize, tools/list, tools/call, and nothing else. */
const STUB = `
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let at = buffer.indexOf("\\n");
  while (at >= 0) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    at = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, { protocolVersion: "2025-06-18", capabilities: {} });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [
        { name: "echo", description: "Says it back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        { name: "boom", description: "Always fails." },
      ] });
    } else if (message.method === "tools/call") {
      if (message.params.name === "boom") {
        reply(message.id, { isError: true, content: [{ type: "text", text: "it broke" }] });
      } else if (message.params.name === "echo") {
        reply(message.id, { content: [{ type: "text", text: "echo: " + (message.params.arguments.text ?? "") }] });
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { message: "no such tool" } }) + "\\n");
      }
    }
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`;

function withStub(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-mcp-"));
  const path = join(dir, "stub-server.mjs");
  writeFileSync(path, STUB);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a server's tools arrive prefixed, and calling one round-trips", async () => {
  const { path, cleanup } = withStub();
  const manager = new McpManager([{ name: "stub", command: process.execPath, args: [path] }]);
  try {
    await manager.ready();
    const names = manager.tools().map(tool => tool.name);
    assert.deepEqual(names, [`stub${MCP_SEPARATOR}echo`, `stub${MCP_SEPARATOR}boom`]);
    assert.ok(manager.owns(`stub${MCP_SEPARATOR}echo`), "the prefix is how ownership is decided");
    assert.ok(!manager.owns("bash"), "our own tools are not its business");

    const said = await manager.call(`stub${MCP_SEPARATOR}echo`, { text: "hello" });
    assert.equal(said, "echo: hello");

    // A schema-less tool still gets one: the model cannot call what it cannot shape.
    const boom = manager.tools().find(tool => tool.name.endsWith("boom"))!;
    assert.deepEqual(boom.inputSchema, { type: "object", properties: {} });

    assert.deepEqual(manager.statuses(), [
      { name: "stub", running: true, toolCount: 2, detail: "2 tools" },
    ]);
  } finally {
    manager.stop();
    cleanup();
  }
});

test("a tool that reports failure throws with what it said", async () => {
  const { path, cleanup } = withStub();
  const manager = new McpManager([{ name: "stub", command: process.execPath, args: [path] }]);
  try {
    await manager.ready();
    await assert.rejects(() => manager.call(`stub${MCP_SEPARATOR}boom`, {}), /it broke/);
    // A protocol-level error is relayed too, rather than hanging.
    await assert.rejects(() => manager.call(`stub${MCP_SEPARATOR}ghost`, {}), /no such tool/);
  } finally {
    manager.stop();
    cleanup();
  }
});

test("a server that cannot start loses its tools, not the turn", async () => {
  const manager = new McpManager(
    [{ name: "broken", command: join(tmpdir(), "definitely-not-a-program-here") }],
    () => {}
  );
  try {
    await manager.ready(); // resolves: a dead server is a missing tool, not an exception
    assert.deepEqual(manager.tools(), []);
    assert.equal(manager.statuses()[0]!.running, false);
    await assert.rejects(() => manager.call(`broken${MCP_SEPARATOR}anything`, {}), /broken/);
  } finally {
    manager.stop();
  }
});

test("nothing configured is nothing spawned", async () => {
  const manager = new McpManager([]);
  assert.equal(manager.configured, false);
  await manager.ready();
  assert.deepEqual(manager.tools(), []);
  assert.equal(manager.owns("anything__at_all"), false);
});

test("an external tool is an ordinary tool: withheld by an allowlist, gated by policy", async () => {
  const { path, cleanup } = withStub();
  const { buildTools, dispatchTool } = await import("./tools.ts");
  const { PolicyGate } = await import("./policy.ts");
  const manager = new McpManager([{ name: "stub", command: process.execPath, args: [path] }]);
  try {
    await manager.ready();
    const echo = `stub${MCP_SEPARATOR}echo`;

    // The allowlist an agent's profile (or its scope) narrows to is the same list an
    // MCP tool has to appear on — the filter runTurn applies before offering them.
    const allowed = ["bash", echo];
    const offered = manager.tools().filter(tool => allowed.includes(tool.name));
    assert.deepEqual(offered.map(t => t.name), [echo], "boom is not on the list, so it is not offered");
    assert.ok(
      !buildTools(false, true, allowed).some(tool => tool.name.includes(MCP_SEPARATOR)),
      "our own builder never invents an external tool"
    );

    // Dispatch routes by ownership, and the gate runs first — a denial never reaches
    // the server.
    const context = {
      agent: { id: "a1", profile: { name: "Ada" } },
      registry: {} as never,
      bus: {} as never,
      box: undefined,
      mcp: manager,
    } as unknown as Parameters<typeof dispatchTool>[2];
    const ran = await dispatchTool(echo, { text: "through dispatch" }, context);
    assert.equal(ran.text, "echo: through dispatch");

    // Named in the gate's approval list, an external tool waits for a person exactly
    // as `bash` would — the point of routing it through the same gate at all.
    const gate = new PolicyGate({
      limits: {
        budgetWindowHours: 24,
        wakesPerWindow: 30,
        wakeWindowMinutes: 10,
        approvalRequiredTools: [echo],
        approvalRequiredCommands: [],
      },
    });
    const held = await dispatchTool(echo, { text: "nope" }, { ...context, policy: gate });
    assert.ok(held.isError, "held for consent rather than run");
    assert.equal(gate.pending().length, 1, "and it is waiting on a person, not lost");

    const unknown = await dispatchTool("nobody__owns_this", {}, context);
    assert.ok(unknown.isError);
    assert.match(unknown.text, /Unknown tool/);
  } finally {
    manager.stop();
    cleanup();
  }
});
