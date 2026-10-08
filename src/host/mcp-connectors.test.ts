/**
 * The connector doors (mcp-connectors.ts): env-gated server configs, config.json
 * precedence, and the satisfies-a-template-connector logic — plus the remote
 * (Streamable HTTP) MCP transport against a real HTTP server, because the failures
 * worth catching live on the wire, not in a mock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityLedger, capabilityHash } from "./mcp-capabilities.ts";
import { CONNECTOR_DOORS, connectorSatisfied, doorServers, expandEnv, mergeServers, pinnedPackage } from "./mcp-connectors.ts";
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

test("every npx door is pinned to an exact version, and the pin reaches the spawned arguments (INV-813)", () => {
  // The guard: an unpinned `npx -y <pkg>` is whatever upstream published this morning.
  for (const door of CONNECTOR_DOORS) {
    if (door.spec.command !== "npx") continue;
    assert.ok(door.package !== undefined && door.version !== undefined, `${door.slug}: an npx door names its package and version`);
    assert.match(door.version, /^\d+\.\d+\.\d+/, `${door.slug}: an exact version, not a range`);
    assert.ok(door.spec.args?.includes(door.package), `${door.slug}: the bare package is in args, so the pin is applied in one place`);
  }
  for (const config of doorServers(ENV).configs) {
    if (config.command !== "npx") continue;
    const pinned = pinnedPackage(config.args);
    assert.ok(pinned !== undefined, `${config.name}: the spawned args carry package@version (${config.args?.join(" ")})`);
    assert.ok(!config.args!.some(arg => /^@?[^@\s]+$/.test(arg) && CONNECTOR_DOORS.some(door => door.package === arg)), `${config.name}: no bare package left`);
  }
  assert.deepEqual(pinnedPackage(["-y", "@notionhq/notion-mcp-server@2.5.2"]), { package: "@notionhq/notion-mcp-server", version: "2.5.2" });
  assert.deepEqual(pinnedPackage(["-y", "slack-mcp-server@1.3.0", "--stdio"]), { package: "slack-mcp-server", version: "1.3.0" });
  assert.equal(pinnedPackage(["-y", "slack-mcp-server"]), undefined);
});

test("an operator pins a door to another version in config without replacing its spec (INV-813)", () => {
  const notion = mergeServers([], ENV, { notion: "9.9.9" }).find(config => config.name === "mcp:notion");
  assert.deepEqual(pinnedPackage(notion?.args), { package: "@notionhq/notion-mcp-server", version: "9.9.9" });
  assert.equal(notion?.env?.NOTION_API_KEY, "ntn_test", "the rest of the spec is untouched");
  const slack = mergeServers([], ENV, { notion: "9.9.9" }).find(config => config.name === "mcp:slack");
  assert.equal(pinnedPackage(slack?.args)?.version, CONNECTOR_DOORS.find(door => door.slug === "slack")?.version, "other doors keep the catalog's pin");
});

test("the capability hash sees the tool set, not its order or its key order", () => {
  const search = { name: "s__search", description: "Finds things.", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
  const create = { name: "s__create", description: "Makes things.", inputSchema: { properties: { title: { type: "string" } }, type: "object" } };
  assert.equal(capabilityHash([search, create]), capabilityHash([create, search]));
  assert.equal(
    capabilityHash([{ ...create, inputSchema: { type: "object", properties: { title: { type: "string" } } } }]),
    capabilityHash([create])
  );
  assert.notEqual(capabilityHash([search]), capabilityHash([search, create]), "a new tool is a change");
  assert.notEqual(capabilityHash([search]), capabilityHash([{ ...search, description: "Finds and deletes things." }]), "a description is a change");
});

test("the ledger writes a line when a server's tools change and nothing when they do not (INV-813)", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-mcp-ledger-"));
  const path = join(home, "mcp-capabilities.jsonl");
  const lines: string[] = [];
  try {
    const ledger = new CapabilityLedger(path, line => lines.push(line));
    const search = { name: "mcp:x__search", description: "Finds.", inputSchema: {} };
    const first = ledger.record("mcp:x", [search], { package: "x-mcp", version: "1.0.0" }, new Date("2026-10-08T08:00:00Z"));
    assert.equal(first.changed, true);
    assert.equal(ledger.record("mcp:x", [search], { package: "x-mcp", version: "1.0.0" }).changed, false, "same tools, no line");
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
    const second = ledger.record("mcp:x", [search, { name: "mcp:x__delete_all", description: "Deletes.", inputSchema: {} }], { package: "x-mcp", version: "1.1.0" });
    assert.equal(second.changed, true);
    assert.equal(second.previous, first.hash);
    const records = ledger.list();
    assert.equal(records.length, 2);
    assert.deepEqual(records[1]!.tools, ["mcp:x__delete_all", "mcp:x__search"]);
    assert.equal(records[1]!.version, "1.1.0");
    assert.equal(records[1]!.previous, first.hash);
    assert.match(lines[1]!, /CHANGED .* added mcp:x__delete_all/, "the reason is in the log, with the version");
    // Another server's record does not count as this one's history.
    assert.equal(ledger.record("mcp:y", [search], undefined).changed, true);
    assert.equal(ledger.latest("mcp:x")?.hash, second.hash);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("expandEnv leaves an unknown variable visible rather than silently empty", () => {
  assert.equal(expandEnv("Bearer ${GOOD}", { GOOD: "t" }), "Bearer t");
  assert.equal(expandEnv("Bearer ${MISSING}", {}), "Bearer ${MISSING}");
});

/** A minimal Streamable-HTTP MCP server: initialize, tools/list, tools/call. */
function withRemoteMcp(): Promise<{ url: string; requests: { method?: string; session?: string }[]; close: () => void; offer: (tools: unknown[]) => void }> {
  const requests: { method?: string; session?: string }[] = [];
  let session: string | undefined;
  let offered: unknown[] = [{ name: "search", description: "Finds things.", inputSchema: { type: "object", properties: { q: { type: "string" } } } }];
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
          reply({ tools: offered });
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
      resolve({ url: `http://127.0.0.1:${port}/mcp`, requests, close: () => server.close(), offer: tools => (offered = tools) });
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

test("a started server lands in the ledger, and a changed tools/list after a restart adds a line (INV-813)", async () => {
  const remote = await withRemoteMcp();
  const home = mkdtempSync(join(tmpdir(), "agentbox-mcp-ledger-live-"));
  const path = join(home, "mcp-capabilities.jsonl");
  try {
    const ledger = new CapabilityLedger(path);
    const config = { name: "mcp:linear", url: remote.url };
    const first = new McpManager([config], () => {}, { ledger });
    await first.ready();
    assert.equal(ledger.list().length, 1, "first sighting is recorded");
    assert.deepEqual(ledger.latest("mcp:linear")?.tools, ["mcp:linear__search"]);
    first.stop();

    // The same server again, unchanged: no new line.
    const same = new McpManager([config], () => {}, { ledger });
    await same.ready();
    assert.equal(ledger.list().length, 1, "nothing changed, nothing written");
    same.stop();

    // Upstream grew a tool: the next start records it, naming what was added.
    remote.offer([
      { name: "search", description: "Finds things.", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "delete_issue", description: "Deletes an issue.", inputSchema: { type: "object" } },
    ]);
    const changed = new McpManager([config], () => {}, { ledger });
    await changed.ready();
    const records = ledger.list();
    assert.equal(records.length, 2);
    assert.deepEqual(records[1]!.tools, ["mcp:linear__delete_issue", "mcp:linear__search"]);
    assert.equal(records[1]!.previous, records[0]!.hash);
    assert.notEqual(records[1]!.hash, records[0]!.hash);
    changed.stop();
  } finally {
    remote.close();
    rmSync(home, { recursive: true, force: true });
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
