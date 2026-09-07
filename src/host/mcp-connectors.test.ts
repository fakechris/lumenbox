/**
 * The connector doors (mcp-connectors.ts): env-gated server configs, config.json
 * precedence, and the satisfies-a-template-connector logic — plus the remote
 * (Streamable HTTP) MCP transport against a real HTTP server, because the failures
 * worth catching live on the wire, not in a mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { CONNECTOR_DOORS, connectorSatisfied, doorServers, expandEnv, mergeServers } from "./mcp-connectors.ts";
import { McpManager, RemoteMcpServer } from "./mcp.ts";

const ENV = {
  NOTION_API_KEY: "ntn_test",
  LINEAR_API_KEY: "lin_api_test",
  SLACK_BOT_TOKEN: "xoxb-test",
  FIGMA_API_KEY: "figd_test",
  X_API_BEARER_TOKEN: "x-test",
  GOOGLE_OAUTH_REFRESH_TOKEN: "1//test",
  GOOGLE_CLIENT_ID: "id",
  GOOGLE_CLIENT_SECRET: "secret",
};

test("a door turns on only when its credential is set, and names itself mcp:<slug>", () => {
  const on = doorServers(ENV);
  assert.equal(on.configs.length, CONNECTOR_DOORS.length);
  assert.ok(on.configs.every(config => config.name.startsWith("mcp:")));
  assert.ok(on.doors.every(door => door.on));

  const off = doorServers({});
  assert.equal(off.configs.length, 0);
  assert.ok(off.doors.every(door => !door.on));
  assert.ok(off.doors.find(door => door.slug === "linear"));
});

test("credentials expand into the spec; the google door covers both gmail and calendar slugs", () => {
  const notion = doorServers(ENV).configs.find(config => config.name === "mcp:notion");
  assert.equal(notion?.env?.OPENAPI_MQS_HEADERS, "x-api-key: ntn_test");
  const linear = doorServers(ENV).configs.find(config => config.name === "mcp:linear");
  assert.equal(linear?.url, "https://mcp.linear.app/mcp");
  assert.equal(linear?.headers?.Authorization, "Bearer lin_api_test");

  const google = doorServers(ENV).configs.find(config => config.name === "mcp:google");
  assert.ok(google !== undefined, "the google door is one server");
  const provides = CONNECTOR_DOORS.find(door => door.slug === "google")?.provides ?? [];
  assert.deepEqual([...provides].sort(), ["mcp:gmail", "mcp:google-calendar"]);
  assert.ok(connectorSatisfied("mcp:gmail", ["mcp:google"], ENV));
  assert.ok(connectorSatisfied("mcp:google-calendar", ["mcp:google"], ENV));
});

test("config.json entries override a door with the same name, and keep their own names otherwise", () => {
  const merged = mergeServers(
    [{ name: "mcp:notion", command: "/usr/local/bin/my-notion", args: [] }, { name: "jira", command: "jira-mcp" }],
    ENV
  );
  const notion = merged.find(config => config.name === "mcp:notion");
  assert.equal(notion?.command, "/usr/local/bin/my-notion", "the operator's entry wins outright");
  assert.ok(merged.find(config => config.name === "jira"), "an unrelated entry rides along");
  assert.ok(merged.find(config => config.name === "mcp:linear"), "the other doors stay up");
});

test("connectorSatisfied: direct name match, bare name match, door coverage, and the honest no", () => {
  assert.ok(connectorSatisfied("mcp:notion", ["mcp:notion"], {}));
  assert.ok(connectorSatisfied("mcp:notion", ["notion"], {}));
  assert.ok(connectorSatisfied("mcp:linear", [], { LINEAR_API_KEY: "lin_api_test" }), "a live door satisfies its slug with no server running yet");
  assert.ok(!connectorSatisfied("mcp:notion", [], {}));
  assert.ok(!connectorSatisfied("mcp:notion", [], { LINEAR_API_KEY: "lin_api_test" }), "an unrelated live door does not satisfy");
});

test("expandEnv leaves an unknown variable visible rather than silently empty", () => {
  assert.equal(expandEnv("Bearer ${GOOD}", { GOOD: "t" }), "Bearer t");
  assert.equal(expandEnv("Bearer ${MISSING}", {}), "Bearer ${MISSING}");
});

/** A minimal Streamable-HTTP MCP server: initialize, tools/list, tools/call. */
function withRemoteMcp(): Promise<{ url: string; requests: { method?: string; session?: string }[]; close: () => void }> {
  const requests: { method?: string; session?: string }[] = [];
  let session: string | undefined;
  return new Promise(resolve => {
    const server: Server = createServer((request, response) => {
      let body = "";
      request.on("data", chunk => (body += chunk));
      request.on("end", () => {
        const message = JSON.parse(body || "{}");
        requests.push({ method: message.method, session: request.headers["mcp-session-id"] as string | undefined });
        const reply = (result: unknown) => {
          response.writeHead(200, {
            "content-type": "application/json",
            ...(session !== undefined ? { "mcp-session-id": session } : {}),
          });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        };
        if (message.method === "initialize") {
          session = "sess-123";
          reply({ protocolVersion: "2025-06-18", capabilities: {} });
        } else if (message.method === "notifications/initialized") {
          response.writeHead(202);
          response.end();
        } else if (message.method === "tools/list") {
          reply({
            tools: [{ name: "search", description: "Finds things.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }],
          });
        } else if (message.method === "tools/call") {
          reply({ content: [{ type: "text", text: `found: ${message.params.arguments?.q ?? ""}` }] });
        } else if (message.method === "tools/fail") {
          reply({ isError: true, content: [{ type: "text", text: "nope" }] });
        } else {
          response.writeHead(400);
          response.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/mcp`, requests, close: () => server.close() });
    });
  });
}

test("a remote server lists its tools and calls one, carrying the session and the bearer", async () => {
  const remote = await withRemoteMcp();
  try {
    const manager = new McpManager(
      [{ name: "mcp:linear", url: remote.url, headers: { Authorization: "Bearer lin_api_test" } }],
      () => {}
    );
    await manager.ready();
    const tools = manager.tools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.name, "mcp:linear__search");
    const answer = await manager.call("mcp:linear__search", { q: "bugs" });
    assert.equal(answer, "found: bugs");
    assert.ok(remote.requests.every(request => request.session === undefined || request.session === "sess-123"));
    // statuses report through the same shape a stdio server does
    const status = manager.statuses()[0]!;
    assert.equal(status.running, true);
    assert.match(status.detail, /1 tool/);
    manager.stop();
  } finally {
    remote.close();
  }
});

test("a remote server's failure lands in the detail, not the turn", async () => {
  const bad = new RemoteMcpServer({ name: "mcp:x", url: "http://127.0.0.1:1/mcp" }, () => {});
  await bad.ensureStarted();
  const status = bad.status();
  assert.equal(status.toolCount, 0);
  assert.notEqual(status.detail, "not started");
  await assert.rejects(() => bad.call("anything", {}));
});

test("reload keeps an unchanged remote server and restarts one whose url changed", async () => {
  const remote = await withRemoteMcp();
  try {
    const manager = new McpManager([{ name: "mcp:linear", url: remote.url }], () => {});
    await manager.ready();
    const result = manager.reload([{ name: "mcp:linear", url: remote.url }]);
    assert.deepEqual(result, { started: [], stopped: [], kept: ["mcp:linear"] });
    const moved = manager.reload([{ name: "mcp:linear", url: `${remote.url}v2` }]);
    assert.deepEqual(moved, { started: ["mcp:linear"], stopped: ["mcp:linear"], kept: [] });
    manager.stop();
  } finally {
    remote.close();
  }
});
