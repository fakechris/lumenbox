import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpFace, expandRequested, faceBaseUrl, IN_FLIGHT_LIMIT, LEASE_MS, ROUTE_PATH } from "./mcp-face.ts";
import { PolicyGate } from "./policy.ts";
import { handleMcpRequest } from "../web/mcp-server.ts";
import { PRESETS, presetNamed } from "./presets.ts";

function fakeManager(names: string[], call = async (name: string, input: unknown) => `${name}(${JSON.stringify(input)})`) {
  return {
    tools: () => names.map(name => ({ name, description: `does ${name}`, inputSchema: { type: "object", properties: {} } })),
    call,
  };
}

test("a request expands to exact names against what the turn itself may call; wildcards must match; nothing is lent that was withheld", () => {
  const mine = ["github__read_issue", "github__list_prs", "jira__search"];
  assert.deepEqual(expandRequested(["github__*"], mine), { allowed: ["github__list_prs", "github__read_issue"] });
  assert.deepEqual(expandRequested(["jira__search", "jira__search"], mine), { allowed: ["jira__search"] });
  assert.match((expandRequested(["jira__create"], mine) as { error: string }).error, /not an MCP tool you may call/);
  assert.match((expandRequested(["slack__*"], mine) as { error: string }).error, /matches no MCP tool/);
  assert.match((expandRequested([], mine) as { error: string }).error, /No MCP tools were named/);
});

test("minting: exact names snapshotted, a fork cannot mint, no address means no route", () => {
  const face = new McpFace({ mcp: () => fakeManager(["a__x"]), jobsOf: () => undefined, auditPath: null });
  assert.match((face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", requested: ["a__x"], allowedMcp: ["a__x"] }) as { error: string }).error, /no address/);
  face.baseUrl = "http://host.docker.internal:7777";
  assert.match((face.mint({ agentId: "a1", agentName: "Ada", conversation: "fork/main-1", requested: ["a__x"], allowedMcp: ["a__x"] }) as { error: string }).error, /fork cannot delegate/);
  const minted = face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", workId: "w1", requested: ["a__*"], allowedMcp: ["a__x", "b__y"] });
  assert.ok("route" in minted);
  assert.match(minted.url, /^http:\/\/host\.docker\.internal:7777\/mcp\/r\/[0-9a-f]{32}$/);
  assert.ok(ROUTE_PATH.test(new URL(minted.url).pathname));
  assert.deepEqual(minted.route.allowed, ["a__x"]);
  // The snapshot holds when the server list changes underneath; the reload revokes it anyway.
  assert.equal(face.revokeAll("reloaded"), 1);
  assert.equal(face.active().length, 0);
});

test("authentication is one answer for every way to be wrong, and the lease follows the job", async () => {
  let now = 1_000_000;
  let jobs: { job_id: string; running: boolean }[] = [{ job_id: "job-1", running: true }];
  const face = new McpFace({ mcp: () => fakeManager(["a__x"]), jobsOf: () => Promise.resolve(jobs), auditPath: null, now: () => now });
  face.baseUrl = "http://127.0.0.1:1";
  const minted = face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", requested: ["a__x"], allowedMcp: ["a__x"] });
  assert.ok("route" in minted);
  const { route } = minted;
  assert.equal(face.authenticate("0".repeat(32), route.token), undefined, "unknown key");
  assert.equal(face.authenticate(route.key, "nope"), undefined, "wrong bearer");
  assert.equal(face.authenticate(route.key, undefined), undefined, "no bearer");
  assert.equal(face.authenticate(route.key, route.token)?.key, route.key);

  // Renewed while the job runs; ended when the box no longer lists it running.
  face.bindJob(route.key, "job-1");
  now += LEASE_MS - 1000;
  await face.renew();
  assert.ok(face.authenticate(route.key, route.token) !== undefined, "renewed");
  jobs = [{ job_id: "job-1", running: false }];
  await face.renew();
  assert.equal(face.authenticate(route.key, route.token), undefined, "job ended: route gone");
  assert.equal(face.active().length, 0);

  // Unrenewed, a lease simply lapses.
  const again = face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", requested: ["a__x"], allowedMcp: ["a__x"] });
  assert.ok("route" in again);
  now += LEASE_MS + 1;
  assert.equal(face.authenticate(again.route.key, again.route.token), undefined, "lapsed");
});

test("a route's call runs the gate as delegated (no approval reuse, no input in the log), the call, the clamp and the audit line", async () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-face-"));
  try {
    const policy = new PolicyGate({ path: join(root, "policy.jsonl"), limits: { approvalRequiredTools: ["a__danger"], approvalRequiredCommands: [], maxRoundsPerTurn: 400, maxTurnsPerHour: 1000 } as never });
    const calls: string[] = [];
    const face = new McpFace({
      mcp: () => fakeManager(["a__x", "a__danger"], async (name, _input) => { calls.push(name); return name === "a__x" ? "x".repeat(250_000) : "danger done"; }),
      policy,
      jobsOf: () => undefined,
      auditPath: join(root, "delegate-calls.jsonl"),
    });
    face.baseUrl = "http://127.0.0.1:1";
    const minted = face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", workId: "w1", requested: ["a__x", "a__danger"], allowedMcp: ["a__x", "a__danger"] });
    assert.ok("route" in minted);
    face.bindJob(minted.route.key, "job-9");
    const tools = face.toolsFor(minted.route);
    assert.deepEqual(tools.map(tool => [tool.name, tool.readOnly]), [["a__danger", false], ["a__x", false]]);

    const ok = await tools.find(tool => tool.name === "a__x")!.run({ q: "secret query" }, "a1");
    assert.ok(ok.length < 250_000 && ok.endsWith("[clamped to 200000 characters]"));
    await assert.rejects(tools.find(tool => tool.name === "a__danger")!.run({ q: "boom" }, "a1"), /would need a person's approval, and a delegated engine cannot ask/);
    assert.deepEqual(calls, ["a__x"], "the refused call never reached the server");

    const policyLog = readFileSync(join(root, "policy.jsonl"), "utf8");
    assert.match(policyLog, /a__x via delegated job job-9 \(\d+ bytes of input, not recorded\)/);
    assert.doesNotMatch(policyLog, /secret query|boom/);
    const audit = readFileSync(join(root, "delegate-calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(audit.length, 2);
    assert.equal(audit[0]?.tool, "a__x");
    assert.equal(audit[0]?.ok, true);
    assert.equal(audit[0]?.jobId, "job-9");
    assert.equal(audit[0]?.workId, "w1");
    assert.equal(typeof audit[0]?.resultSha256, "string");
    assert.ok(!JSON.stringify(audit).includes("secret query"), "arguments never in the ledger");
    assert.equal(audit[1]?.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("over the wire: the route path, one 401, tools/list is exactly the allow-list, four in flight", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const face = new McpFace({
    mcp: () => fakeManager(["a__x"], async () => { await gate; return "done"; }),
    jobsOf: () => undefined,
    auditPath: null,
  });
  face.baseUrl = "http://127.0.0.1:1";
  const minted = face.mint({ agentId: "a1", agentName: "Ada", conversation: "main", requested: ["a__x"], allowedMcp: ["a__x", "b__y"] });
  assert.ok("route" in minted);
  const { route } = minted;
  const server: Server = createServer((req, res) => {
    const pathname = req.url?.split("?")[0] ?? "";
    const match = ROUTE_PATH.exec(pathname);
    if (match === null) { res.writeHead(404); res.end(); return; }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim();
    const found = face.authenticate(match[1]!, bearer);
    void handleMcpRequest(req, res, {
      path: pathname,
      serverName: "lumenbox-face",
      tools: found === undefined ? [] : face.toolsFor(found),
      principalFor: () => found?.agentId,
      log: () => {},
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as { result?: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean }; error?: unknown } };
  };
  try {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    assert.equal((await call(`/mcp/r/${route.key}`, list, "wrong")).status, 401);
    assert.equal((await call(`/mcp/r/${"0".repeat(32)}`, list, route.token)).status, 401);
    assert.equal((await call(`/mcp/r/${route.key}/extra`, list, route.token)).status, 404);
    const listed = await call(`/mcp/r/${route.key}`, list, route.token);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.result?.tools?.map(tool => tool.name), ["a__x"]);

    const invoke = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "a__x", arguments: {} } };
    const inFlight = Array.from({ length: IN_FLIGHT_LIMIT }, () => call(`/mcp/r/${route.key}`, invoke, route.token));
    await new Promise(resolve => setTimeout(resolve, 50));
    const fifth = await call(`/mcp/r/${route.key}`, invoke, route.token);
    assert.equal(fifth.body.result?.isError, true);
    assert.match(fifth.body.result?.content?.[0]?.text ?? "", /already in flight/);
    release();
    const done = await Promise.all(inFlight);
    assert.ok(done.every(entry => entry.body.result?.content?.[0]?.text === "done"));
    const outside = await call(`/mcp/r/${route.key}`, { ...invoke, id: 3, params: { name: "b__y", arguments: {} } }, route.token);
    assert.equal(typeof outside.body.error, "object", "a tool outside the allow-list is not there to call");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("each preset's face names one remote server, keeps the token in the environment, and claude passes the file explicitly", () => {
  const url = "http://host.docker.internal:7777/mcp/r/abc";
  for (const preset of PRESETS) {
    const face = preset.mcpFace(url, "LUMENBOX_MCP_TOKEN", "/home/box/work/.lumenbox/mcp/abc.json");
    assert.ok(face.content.includes(url), preset.name);
    assert.ok(face.content.includes("LUMENBOX_MCP_TOKEN"), `${preset.name} references the variable`);
    assert.ok(!face.content.includes("Bearer lm"), "no literal token");
    const command = preset.run("'brief'", undefined, face.args || undefined);
    assert.ok(!command.includes("LUMENBOX_MCP_TOKEN") || command.includes("${"), `${preset.name}: no token on the command line`);
  }
  const claude = presetNamed("claude")!.mcpFace(url, "LUMENBOX_MCP_TOKEN", "/home/box/work/.lumenbox/mcp/abc.json");
  assert.match(claude.args, /--mcp-config '\/home\/box\/work\/\.lumenbox\/mcp\/abc\.json' --strict-mcp-config/);
  assert.match(claude.content, /"Bearer \$\{LUMENBOX_MCP_TOKEN\}"/);
  const opencode = presetNamed("opencode")!.mcpFace(url, "LUMENBOX_MCP_TOKEN", "/home/box/work/.lumenbox/mcp/abc.json");
  assert.equal(opencode.env.OPENCODE_CONFIG, "/home/box/work/.lumenbox/mcp/abc.json");
  assert.match(opencode.content, /"Bearer \{env:LUMENBOX_MCP_TOKEN\}"/);
  assert.match(opencode.content, /"oauth": false/);
});

test("the face's address follows the topology", () => {
  assert.equal(faceBaseUrl(7777, {}), "http://host.docker.internal:7777");
  assert.equal(faceBaseUrl(7777, { AGENTBOX_BOXD_URL: "http://127.0.0.1:1337" }), "http://127.0.0.1:7777");
  assert.equal(faceBaseUrl(7777, { AGENTBOX_BOXD_URL: "http://100.114.30.43:13370" }), "http://host.docker.internal:7777");
  assert.equal(faceBaseUrl(7777, { AGENTBOX_MCP_FACE_URL: "http://172.17.0.1:7777" }), "http://172.17.0.1:7777");
});

test("Delegate with tools: the file is written before the job starts, the token rides the environment, the job is bound; an attached box gets no face", async () => {
  const { dispatchTool } = await import("./tools.ts");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { AgentBus } = await import("../agents/bus.ts");
  const root = mkdtempSync(join(tmpdir(), "agentbox-delegate-face-"));
  try {
    const registry = new AgentRegistry(root);
    const agent = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const face = new McpFace({ mcp: () => fakeManager(["a__x"]), jobsOf: () => undefined, auditPath: null });
    face.baseUrl = "http://host.docker.internal:7777";
    const writes: { path: string; content: string }[] = [];
    const starts: { command: string; env?: Record<string, string> }[] = [];
    const box = {
      exec: async () => ({ stdout: "/usr/bin/claude", stderr: "", exit_code: 0, timed_out: false }),
      writeFile: async (path: string, content: string) => { writes.push({ path, content }); return { path, bytes: content.length }; },
      startJob: async (command: string, options: { env?: Record<string, string> }) => { starts.push({ command, env: options.env }); return { job_id: "job-7", log_path: "/tmp/job-7.log" }; },
    };
    const context = { agent, registry, bus, box, mcpFace: face, allowedMcpTools: ["a__x"], boxKind: "docker", workId: "w1", conversation: "main" } as never;

    const result = await dispatchTool("Delegate", { preset: "claude", prompt: "check the issue", tools: ["a__x"] }, context);
    assert.match(result.text, /Delegated to claude as job-7/);
    assert.match(result.text, /may call 1 MCP tool through this host \(a__x\)/);
    assert.equal(writes.length, 1);
    assert.match(writes[0]!.path, /^\/home\/box\/work\/\.lumenbox\/mcp\/[0-9a-f]{32}\.json$/);
    assert.match(writes[0]!.content, /"type": "http"/);
    assert.equal(starts.length, 1);
    assert.match(starts[0]!.command, /--mcp-config '\/home\/box\/work\/\.lumenbox\/mcp\/[0-9a-f]{32}\.json' --strict-mcp-config/);
    const token = starts[0]!.env?.LUMENBOX_MCP_TOKEN;
    assert.ok(token !== undefined && token.length === 64, "the token rides the environment");
    assert.ok(!starts[0]!.command.includes(token!), "and not the command line");
    assert.ok(!writes[0]!.content.includes(token!), "and not the file");
    const route = face.active()[0]!;
    assert.equal(route.jobId, "job-7", "bound after start");
    assert.ok(face.authenticate(route.key, token) !== undefined);

    // A tool the turn itself may not call cannot be lent.
    const refused = await dispatchTool("Delegate", { preset: "claude", prompt: "x", tools: ["b__y"] }, context);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not an MCP tool you may call/);
    assert.equal(starts.length, 1, "nothing started");

    // An attached box: no face, said plainly, job still starts.
    const attached = await dispatchTool("Delegate", { preset: "claude", prompt: "x", tools: ["a__x"] }, { ...(context as object), boxKind: "attached" } as never);
    assert.match(attached.text, /not reachable from this box/);
    assert.equal(starts.length, 2);
    assert.equal(starts[1]!.env?.LUMENBOX_MCP_TOKEN, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Delegate records the job before the box hears of it, under an id the host minted; Jobs settles it (docs/32 slice two)", async () => {
  const { dispatchTool } = await import("./tools.ts");
  const { AgentRegistry } = await import("../agents/registry.ts");
  const { AgentBus } = await import("../agents/bus.ts");
  const { PendingWork } = await import("./pending-work.ts");
  const root = mkdtempSync(join(tmpdir(), "agentbox-delegate-ledger-"));
  try {
    const registry = new AgentRegistry(root);
    const agent = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const ledger = new PendingWork(join(root, "pending-work.jsonl"));
    const order: string[] = [];
    let started: { command: string; jobId?: string } | undefined;
    const box = {
      exec: async () => ({ stdout: "/usr/bin/claude", stderr: "", exit_code: 0, timed_out: false }),
      writeFile: async () => ({}),
      startJob: async (command: string, options: { jobId?: string }) => {
        order.push(`start:${ledger.open().length}`);
        started = { command, jobId: options.jobId };
        return { job_id: options.jobId ?? "job-boxmade", log_path: `/tmp/${options.jobId}.log` };
      },
      jobs: async () => ({ jobs: [{ job_id: started!.jobId!, command: "", running: false, exit_code: 0, started_at: "", log_path: "", log_bytes: 0 }] }),
    };
    const context = { agent, registry, bus, box, pendingWork: ledger, boxKind: "docker", workId: "w1", conversation: "main" } as never;
    const result = await dispatchTool("Delegate", { preset: "claude", prompt: "fix it" }, context);
    assert.match(result.text, /Delegated to claude as job-[0-9a-f]{16}/);
    assert.deepEqual(order, ["start:1"], "one record open before the box was asked");
    assert.match(started!.jobId!, /^job-[0-9a-f]{16}$/);
    const open = ledger.open();
    assert.equal(open.length, 1);
    assert.equal(open[0]?.kind, "delegate");
    assert.equal(open[0]?.child, started!.jobId);
    assert.equal(open[0]?.admitted, true);

    // The next Jobs list sees it exited and settles the record.
    await dispatchTool("Jobs", { action: "list" }, context);
    assert.deepEqual(ledger.open(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
