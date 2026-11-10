/** The side door's change feed (INV-1508): a long poll over the board's own changes, bounded, scoped, and let go of. */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { newPursuit } from "../host/goal-mode.ts";
import { TaskStore } from "../host/tasks.ts";
import { SIDE_DOOR_CAPABILITIES } from "./mcp-contract.ts";
import { handleMcpRequest, mintMcpToken, principalForToken } from "./mcp-server.ts";
import { mcpServerTools } from "./mcp-tools.ts";
import { ForkEvents } from "../host/fork-events.ts";
import { ChangeFeed, describeWatch, feedForks } from "./mcp-watch.ts";

function wired(capacity?: number) {
  const board = new TaskStore(null);
  const feed = new ChangeFeed({ ...(capacity !== undefined ? { capacity } : {}), stageOf: task => (task.status === "review" ? "person/review" : undefined) });
  board.onChange(task => feed.record(task));
  return { board, feed };
}
const mine = (who: string) => (event: { requester: string }) => event.requester === who;

test("execution watermarks invalidate the task summary and cursors reset across process epochs", () => {
  const { board, feed } = wired();
  const task = board.create({ title: "long work", requester: "p1" })!;
  const cursor = feed.since(undefined, () => true).cursor;
  feed.recordExecution(task, "observation-1");
  const result = feed.since(cursor, mine("p1"));
  assert.deepEqual(result.events.map(e => e.execution), [{ revision: "observation-1" }]);
  assert.equal(JSON.stringify(result).includes("tool_input"), false);
  assert.equal(new ChangeFeed().since(result.cursor, () => true).reset, true);
  assert.equal(feed.since("0", () => true).reset, true, "legacy numeric cursors reacquire a snapshot once");
});

test("a wait returns as soon as a matching task moves; with nothing, it times out empty on the same cursor", async () => {
  const { board, feed } = wired();
  const start = feed.since(undefined, mine("p1"));
  assert.deepEqual(start.events, [], "no cursor: nothing yet, and where to start");
  const task = board.create({ title: "count sales", requester: "p1" })!;
  assert.deepEqual(feed.since(start.cursor, mine("p1")).events, [], "a task's creation is not on the board's change stream; its first move is");
  const t0 = Date.now();
  const waiting = feed.wait(start.cursor, mine("p1"), 5_000);
  setTimeout(() => board.update(task.id, { status: "doing" }, "a1"), 20);
  const woke = await waiting;
  assert.ok(Date.now() - t0 < 2_000, "woke on the change, not at the limit");
  assert.equal(woke.events.length, 1);
  assert.equal(woke.events[0]!.status, "doing");
  const quiet = await feed.wait(woke.cursor, mine("p1"), 60);
  assert.deepEqual([quiet.events, quiet.cursor, quiet.reset], [[], woke.cursor, false]);
  assert.equal(feed.waiting(), 0);
});

test("only what a watcher reads is an event: status, stage, a goal's status and pause; a note is not", () => {
  const { board, feed } = wired();
  const cursor = feed.since(undefined, () => true).cursor;
  const plain = board.create({ title: "count", requester: "p1" })!;
  board.update(plain.id, { status: "doing" }, "a1");
  board.update(plain.id, { status: "review", note: "held" }, "a1");
  const task = board.create({ title: "digest", requester: "p1", conversation: "c1", pursuit: newPursuit({ objective: "digest", workId: "w" }) })!;
  board.update(task.id, { status: "doing" }, "a1");
  board.update(task.id, { note: "just a note" }, "a1");
  board.setPursuit(task.id, p => ({ ...p, status: "paused", pausedReason: "budget" }), "stopped");
  const seen = feed.since(cursor, () => true).events;
  assert.deepEqual(seen.map(event => [event.taskId === plain.id ? "plain" : "goal", event.status, event.stage, event.pursuit?.status, event.pursuit?.pausedReason]), [
    ["plain", "doing", undefined, undefined, undefined],
    ["plain", "review", "person/review", undefined, undefined],
    ["goal", "doing", undefined, "active", undefined],
    ["goal", "blocked", undefined, "paused", "budget"],
  ], "the goal's note made no event; its pause did");
});

test("a fork of a task's turn is on the feed, step by step, for the task's requester; a fork with no task is not (INV-1667)", () => {
  const { board, feed } = wired();
  const forks = new ForkEvents(null);
  feedForks(feed, forks, id => board.get(id));
  const task = board.create({ title: "price check", requester: "p1" })!;
  const cursor = feed.since(undefined, () => true).cursor;
  forks.spawned({ id: "pw-1", agentId: "a1", parent: "main", child: "fork/main-q-1", brief: "find pricing", taskId: task.id });
  forks.spawned({ id: "pw-2", agentId: "a1", parent: "main", child: "fork/main-q-2", brief: "aside" });
  forks.fenced("a1", "fork/main-q-1", "SendToAgent");
  forks.reported("pw-1", "blocked", "needs the team");
  const seen = feed.since(cursor, mine("p1"));
  assert.deepEqual(seen.events.map(event => [event.taskId, event.fork?.event, event.fork?.status]), [
    [task.id, "fork.spawned", "running"],
    [task.id, "fork.fenced", "fenced"],
    [task.id, "fork.reported", "fenced"],
  ]);
  assert.match(describeWatch(seen), /fork\.fenced fork\/main-q-1 \(fenced: SendToAgent\) "find pricing"/);
  assert.deepEqual(feed.since(cursor, mine("p2")).events, [], "scoped like every other event: by the task's requester");
});

test("a cursor older than the ring says reset; scope mine sees only my tasks; all sees everyone's", () => {
  const { board, feed } = wired(3);
  const cursor = feed.since(undefined, () => true).cursor;
  let recent = cursor;
  for (let i = 0; i < 5; i++) {
    board.update(board.create({ title: `t${i}`, requester: i % 2 === 0 ? "p1" : "p2" })!.id, { status: "doing" }, "a1");
    if (i === 1) recent = feed.since(undefined, () => true).cursor;
  }
  assert.equal(feed.since(cursor, () => true).reset, true, "two of five changes are gone");
  assert.equal(feed.since("999", () => true).reset, true, "a cursor from the future is not trusted");
  const held = feed.since(recent, () => true);
  assert.equal(held.reset, false);
  assert.deepEqual(feed.since(recent, mine("p1")).events.map(event => event.requester), ["p1", "p1"]);
  assert.deepEqual(held.events.map(event => event.requester), ["p1", "p2", "p1"]);
});

test("concurrent watches each wake for their own changes and none other", async () => {
  const { board, feed } = wired();
  const cursor = feed.since(undefined, () => true).cursor;
  const one = feed.wait(cursor, mine("p1"), 1_000);
  const two = feed.wait(cursor, mine("p2"), 300);
  assert.equal(feed.waiting(), 2);
  board.update(board.create({ title: "for p1", requester: "p1" })!.id, { status: "doing" }, "a1");
  assert.equal((await one).events.length, 1);
  assert.equal(feed.waiting(), 1, "p2's watch was not woken by p1's task");
  assert.equal((await two).events.length, 0);
  assert.equal(feed.waiting(), 0);
});

test("a caller that hangs up mid-wait lets go of its listener, through the real door", async () => {
  const { feed } = wired();
  const token = mintMcpToken("p1", "watch");
  const tools = mcpServerTools({ registry: {} as never, orchestrator: { tasks: undefined } as never, principals: { resolve: id => ({ name: id }) }, workDir: "/w", log: () => {}, listen: () => () => {}, changeFeed: feed });
  const server: Server = createServer((req, res) => void handleMcpRequest(req, res, { tools, principalFor: presented => principalForToken(presented, [token]), log: () => {} }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const call = (args: Record<string, unknown>, signal?: AbortSignal) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "watch", arguments: args } }), ...(signal !== undefined ? { signal } : {}),
    });
    const first = await (await call({})).json() as { result: { structuredContent: { cursor: string } } };
    const cursor = first.result.structuredContent.cursor;
    const hangup = new AbortController();
    const pending = call({ since: cursor, wait_seconds: 20 }, hangup.signal).catch(() => undefined);
    for (let i = 0; i < 50 && feed.waiting() === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(feed.waiting(), 1, "the watch is waiting");
    hangup.abort();
    await pending;
    for (let i = 0; i < 50 && feed.waiting() > 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(feed.waiting(), 0, "and let go when the caller left");
    assert.equal(SIDE_DOOR_CAPABILITIES.watch, true);
    assert.equal(SIDE_DOOR_CAPABILITIES.streaming, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
