/** The app's supervision process (INV-1527): its settings, its own token, the run queue, and a run start to end. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskStore } from "../host/tasks.ts";
import type { ModelAsk } from "../supervisor/openai.ts";
import { handleMcpRequest } from "../web/mcp-server.ts";
import { McpTokenStore } from "../web/mcp-tokens.ts";
import { mcpServerTools } from "../web/mcp-tools.ts";
import { ChangeFeed } from "../web/mcp-watch.ts";
import { DEFAULT_SUPERVISION, readSupervisionConfig } from "./config.ts";
import { notifyLine, Supervision } from "./main.ts";
import { enqueue, listRuns, readStatus, requestStop, runDir, takeNext } from "./queue.ts";
import { ensureToken, SUPERVISION_TOKEN_LABEL, tokenFile } from "./token.ts";

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervision-"));
  writeFileSync(join(dir, "principals.json"), JSON.stringify({ principals: [{ id: "p-chris", name: "Chris", role: "admin" }] }));
  return dir;
}

test("settings default to on, take what is set, and ignore what is not valid", () => {
  const dir = home();
  try {
    const path = join(dir, "config.json");
    assert.deepEqual(readSupervisionConfig(path), DEFAULT_SUPERVISION, "no file: on, with defaults");
    writeFileSync(path, JSON.stringify({ provider: "x", supervision: { watchdog: { enabled: false, stallMinutes: 15, pausedMinutes: -3 }, supervisor: { model: "gpt-6.1-terra", budget: 9000, agent: " Ops " } } }));
    const read = readSupervisionConfig(path);
    assert.deepEqual(read.watchdog, { enabled: false, stallMinutes: 15, pausedMinutes: 30, judge: true });
    assert.deepEqual([read.supervisor.model, read.supervisor.budget, read.supervisor.agent, read.supervisor.maxModelCalls], ["gpt-6.1-terra", 9000, "Ops", 60]);
    writeFileSync(path, "{ broken");
    assert.deepEqual(readSupervisionConfig(path), DEFAULT_SUPERVISION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the token is issued once for the admin, kept 0600, reused, and issued again only on renew", async () => {
  const dir = home();
  try {
    const minted: Record<string, unknown>[] = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => { minted.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ token: `lmbx_${++n}` }), { status: 200 }); }) as typeof fetch;
    const deps = { home: dir, url: "http://127.0.0.1:7777", uiToken: () => "ui", fetch: fetchImpl };
    assert.equal(await ensureToken(deps), "lmbx_1");
    assert.equal(await ensureToken(deps), "lmbx_1", "reused, not issued again");
    assert.deepEqual(minted, [{ principalId: "p-chris", label: SUPERVISION_TOKEN_LABEL }]);
    assert.equal(statSync(tokenFile(dir)).mode & 0o777, 0o600);
    assert.equal(await ensureToken(deps, { renew: true }), "lmbx_2");
    assert.equal(readFileSync(tokenFile(dir), "utf8").trim(), "lmbx_2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the queue hands each request out once, oldest first, and a stop is a file the run can see", () => {
  const dir = home();
  try {
    enqueue(dir, { id: "r-b", objective: "B" }, new Date("2026-11-02T10:00:01Z"));
    enqueue(dir, { id: "r-a", objective: "A" }, new Date("2026-11-02T10:00:00Z"));
    assert.equal(readStatus(dir, "r-a")?.state, "queued");
    assert.equal(takeNext(dir)?.id, "r-a");
    assert.equal(takeNext(dir)?.id, "r-b");
    assert.equal(takeNext(dir), undefined, "taken once");
    assert.ok(existsSync(join(runDir(dir, "r-a"), "request.json")));
    assert.equal(requestStop(dir, "r-a"), true);
    assert.equal(requestStop(dir, "nope"), false);
    assert.deepEqual(listRuns(dir).map(run => run.id), ["r-b", "r-a"], "newest first");
    assert.throws(() => enqueue(dir, { id: "../x", objective: "x" }), /letters, digits/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A real door on a real board, whose token store the supervision process mints into through the token endpoint. */
async function liveDoor(dir: string) {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const tokens = new McpTokenStore(undefined);
  const agent = { id: "a1", profile: { name: "Ada" } };
  const tools = mcpServerTools({
    registry: { tryGet: () => agent, resolve: () => agent, list: () => [agent], contextMode: () => "normal" } as never,
    orchestrator: { tasks: board, contextBlockers: () => [], prompt: async () => {}, ensureDefaultAgent: () => agent } as never,
    principals: { resolve: id => ({ name: id }) }, workDir: "/w", log: () => {}, listen: () => () => {},
    mayDrive: () => true, changeFeed: feed,
  });
  const server: Server = createServer((req, res) => {
    if (req.url === "/api/mcp/tokens") {
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => { const asked = JSON.parse(body); res.end(JSON.stringify(tokens.mint(asked.principalId, asked.label))); });
      return;
    }
    void handleMcpRequest(req, res, { tools, principalFor: presented => tokens.principalFor(presented), log: () => {} });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  void dir;
  return { board, tokens, url, stop: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("a queued run goes start to end through the door, with its status, transcript and summary; no key and stop are said plainly", async () => {
  const dir = home();
  const door = await liveDoor(dir);
  try {
    const lines: string[] = [];
    let goalId = "";
    let completeGoals = true;
    const ask: ModelAsk = async request => {
      if (request.input[0] !== undefined && "role" in request.input[0] && /start now/.test(request.input[0].content)) return { id: "r1", calls: [{ callId: "c1", name: "goal_start", arguments: { objective: "Ship it" } }], text: "", usage: { input: 10, output: 2, reasoning: 0 } };
      const out = request.input[0] as { output?: string };
      if (out.output !== undefined) {
        goalId = /^(t\d+)/.exec(out.output)?.[1] ?? goalId;
        if (completeGoals) setTimeout(() => door.board.setPursuit(goalId, p => ({ ...p, status: "complete" }), "verified"), 30);
      }
      return { id: "r2", calls: [], text: "started", usage: { input: 10, output: 2, reasoning: 0 } };
    };
    let keyed = true;
    const supervision = new Supervision({
      home: dir, url: door.url, uiToken: () => "ui", fetch,
      config: () => ({ ...DEFAULT_SUPERVISION, watchdog: { ...DEFAULT_SUPERVISION.watchdog, enabled: false } }),
      askFor: () => (keyed ? ask : undefined),
      emit: line => lines.push(line), sleep: async () => {}, watchSeconds: 1,
    });
    await supervision.connect(new AbortController().signal);
    assert.equal(door.tokens.list()[0]?.label, SUPERVISION_TOKEN_LABEL, "it issued its own token");
    enqueue(dir, { id: "run-1", objective: "Ship it", budget: 4000 });
    assert.equal(await supervision.runOne(), true);
    const status = readStatus(dir, "run-1")!;
    assert.deepEqual([status.state, status.outcome, status.goalId, status.modelCalls], ["done", "completed", goalId, 2]);
    assert.equal(door.board.get(goalId)!.pursuit?.limits.budget, 4000, "the request's budget reached the goal");
    assert.ok(readFileSync(join(runDir(dir, "run-1"), "summary.md"), "utf8").includes("Outcome: completed"));
    const transcript = readFileSync(join(runDir(dir, "run-1"), "transcript.jsonl"), "utf8");
    assert.ok(!transcript.includes(readFileSync(tokenFile(dir), "utf8").trim()), "the token is not in the transcript");

    keyed = false;
    enqueue(dir, { id: "run-2", objective: "x" });
    await supervision.runOne();
    assert.equal(readStatus(dir, "run-2")?.state, "failed");
    assert.ok(lines.includes(notifyLine("A supervisor run could not start", "No key for the supervisor's model is configured.")), "said to the person through the app");

    keyed = true;
    completeGoals = false;
    enqueue(dir, { id: "run-3", objective: "Ship it again" });
    const stopping = supervision.runOne();
    setTimeout(() => requestStop(dir, "run-3"), 50);
    await stopping;
    assert.equal(readStatus(dir, "run-3")?.state, "stopped");
    assert.equal(await supervision.runOne(), false, "the queue is empty");
  } finally {
    await door.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
