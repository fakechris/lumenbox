/** The watchdog (INV-1509): its rules from the record, and the loop end to end through the real side door. */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { attentionFor } from "../host/attention.ts";
import { newPursuit } from "../host/goal-mode.ts";
import { currentFlag, FLAG_COOLDOWN_MS } from "../host/task-flag.ts";
import { TaskStore } from "../host/tasks.ts";
import { handleMcpRequest, mintMcpToken, principalForToken } from "../web/mcp-server.ts";
import { mcpServerTools } from "../web/mcp-tools.ts";
import { ChangeFeed } from "../web/mcp-watch.ts";
import { type Door, doorClient, DoorUnreachable } from "./client.ts";
import { Watchdog } from "./main.ts";
import { DEFAULT_LIMITS, findingsFor } from "./rules.ts";
import { taskRecord } from "../web/mcp-record.ts";

const T0 = new Date("2026-11-02T08:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const nameOf = (id: string) => id;

test("each rule fires on what the record shows and stays quiet otherwise", () => {
  const board = new TaskStore(null);
  const plain = board.create({ title: "count", requester: "p1", assigneeId: "a1", now: T0 })!;
  board.update(plain.id, { status: "doing" }, "a1", undefined, T0);
  const record = () => taskRecord(board.get(plain.id)!, { nameOf });
  assert.deepEqual(findingsFor(record(), false, at(59)), [], "under the hour: quiet");
  assert.deepEqual(findingsFor(record(), false, at(61)).map(f => f.rule), ["stalled"]);
  assert.equal(findingsFor(record(), false, at(61))[0]!.note, findingsFor(record(), false, at(300))[0]!.note, "the note does not count minutes, so the same flag is recognised");
  board.deliveryCommand(plain.id, "submit", "a1", { note: "held" }, undefined, at(1));
  assert.deepEqual(findingsFor(record(), false, at(300)), [], "in review: a person's, not stalled");

  const goal = board.create({ title: "digest", requester: "p1", conversation: "c1", pursuit: newPursuit({ objective: "digest", workId: "w", now: T0 }), now: T0 })!;
  board.update(goal.id, { status: "doing" }, "a1", undefined, T0);
  const goalRecord = () => taskRecord(board.get(goal.id)!, { nameOf });
  assert.deepEqual(findingsFor(goalRecord(), true, at(61)).map(f => [f.rule, f.pause]), [["stalled", undefined]], "mine, but not yet long enough to pause");
  assert.deepEqual(findingsFor(goalRecord(), true, at(121)).map(f => [f.rule, f.pause]), [["stalled", true]], "mine and two hours: pause too");
  assert.deepEqual(findingsFor(goalRecord(), false, at(121)).map(f => f.pause), [undefined], "never pause somebody else's goal");
  board.setPursuit(goal.id, p => ({ ...p, spent: { ...p.spent, rejections: 2 } }), "verification failed", undefined, T0);
  assert.ok(findingsFor(goalRecord(), false, at(1)).some(f => f.rule === "verification-failing"));
  board.setPursuit(goal.id, p => ({ ...p, status: "paused", pausedReason: "budget" }), "budget", undefined, T0);
  assert.deepEqual(findingsFor(goalRecord(), false, at(29)).map(f => f.rule), [], "stopped under half an hour ago: quiet");
  assert.deepEqual(findingsFor(goalRecord(), false, at(31)).map(f => f.rule), ["stopped-unattended"]);
  board.setPursuit(goal.id, p => ({ ...p, pausedReason: "person" }), "the person paused it", "p1", T0);
  assert.deepEqual(findingsFor(goalRecord(), false, at(300)).map(f => f.rule), [], "a person's own pause is nobody's problem");
  assert.deepEqual(DEFAULT_LIMITS, { stallMinutes: 60, pausedMinutes: 30, rejections: 2, pauseOwnMinutes: 120 });
});

async function sideDoor(board: TaskStore, feed: ChangeFeed, notices: string[]) {
  const token = mintMcpToken("p1", "watchdog");
  const tools = mcpServerTools({
    registry: { tryGet: () => undefined, resolve: () => ({ id: "a1", profile: { name: "Ada" } }), list: () => [], contextMode: () => "normal" } as never,
    orchestrator: { tasks: board, contextBlockers: () => [], prompt: async () => {}, ensureDefaultAgent: () => ({ id: "a1", profile: { name: "Ada" } }) } as never,
    principals: { resolve: id => ({ name: id === "p1" ? "Chris" : id }) },
    workDir: "/w", log: () => {}, listen: () => () => {},
    mayDrive: () => true, changeFeed: feed, notifyTask: (_task, text) => notices.push(text),
  });
  const server: Server = createServer((req, res) => void handleMcpRequest(req, res, { tools, principalFor: presented => principalForToken(presented, [token]), log: () => {} }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, token: token.token, stop: () => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("end to end: a stalled task gets one flag through the door, lands on the person's list and in its chat, and a quiet board stays quiet", async () => {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const notices: string[] = [];
  const door = await sideDoor(board, feed, notices);
  try {
    const stalled = board.create({ title: "count sales", requester: "p1", assigneeId: "a1", now: T0 })!;
    board.update(stalled.id, { status: "doing" }, "a1", undefined, T0);
    const fresh = board.create({ title: "fresh", requester: "p2", now: at(50) })!;
    board.update(fresh.id, { status: "doing" }, "a1", undefined, at(50));
    let now = at(61);
    const logs: string[] = [];
    const watchdog = new Watchdog({ door: doorClient(door.url, door.token), waitSeconds: 0, log: line => logs.push(line), now: () => now });
    const first = await watchdog.tick();
    assert.deepEqual(first, [`flagged ${stalled.id} stalled`], "the stalled one, not the fresh one");
    assert.equal(currentFlag(board.get(stalled.id)!)?.by, "p1", "in the token holder's name");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /needs a look — Chris: no change on its record/);
    const attention = attentionFor({ principalId: "p1", identities: [], tasks: board.list(), questions: [], nameOf: id => (id === "p1" ? "Chris" : id) });
    assert.ok(attention.mine.some(item => item.kind === "flagged" && item.ref === stalled.id && /Chris flagged it/.test(item.detail)), "on the needs-you list");
    assert.equal(board.get(stalled.id)!.status, "doing", "a flag moves nothing");
    now = at(90);
    assert.deepEqual(await watchdog.tick(), [], "the same finding inside the cooldown: nothing said twice");
    assert.equal(notices.length, 1);
    now = new Date(at(61).getTime() + FLAG_COOLDOWN_MS + 60_000);
    const later = await watchdog.tick();
    assert.ok(later.includes(`flagged ${fresh.id} stalled`), "six hours on, the other task is stalled too: its own first flag");
    assert.equal(notices.filter(text => text.startsWith(stalled.id)).length, 1, "past the watchdog's cooldown, the door's still holds: the same note while the status has not moved is one flag");
    board.update(stalled.id, { status: "blocked", note: "waiting on a key" }, "a1");
    assert.equal(currentFlag(board.get(stalled.id)!), undefined, "the status moved: the flag no longer holds");
    const client = doorClient(door.url, door.token);
    board.update(fresh.id, { status: "done", note: "ok" }, "p2");
    assert.match((await client.call("raise_attention", { task_id: fresh.id, note: "look" }, { idempotencyKey: "x1" })).text, /has ended/);
    assert.match((await client.call("raise_attention", { task_id: "t999", note: "look" }, { idempotencyKey: "x2" })).text, /No task t999/);
    assert.match((await client.call("raise_attention", { task_id: stalled.id, note: " " }, { idempotencyKey: "x3" })).text, /needs a note/);
  } finally {
    await door.stop();
  }
});

test("it pauses only its own stalled goal, and never resumes, completes or touches a budget", async () => {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const door = await sideDoor(board, feed, []);
  try {
    const own = board.create({ title: "digest", requester: "p1", assigneeId: "a1", conversation: "c1", pursuit: newPursuit({ objective: "digest", workId: "w", now: T0, budget: 1000 }), now: T0 })!;
    board.update(own.id, { status: "doing" }, "a1", undefined, T0);
    const theirs = board.create({ title: "their digest", requester: "p2", assigneeId: "a1", conversation: "c2", pursuit: newPursuit({ objective: "x", workId: "w2", now: T0 }), now: T0 })!;
    board.update(theirs.id, { status: "doing" }, "a1", undefined, T0);
    const calls: string[] = [];
    const real = doorClient(door.url, door.token);
    const spy: Door = { call: (name, args, options) => { calls.push(name); return real.call(name, args, options); } };
    const watchdog = new Watchdog({ door: spy, waitSeconds: 0, log: () => {}, now: () => at(121) });
    const did = await watchdog.tick();
    assert.ok(did.includes(`paused ${own.id}`));
    assert.ok(!did.includes(`paused ${theirs.id}`), "somebody else's goal is flagged, never paused");
    assert.ok(did.includes(`flagged ${theirs.id} stalled`));
    assert.equal(board.get(own.id)!.pursuit?.status, "paused");
    assert.equal(board.get(own.id)!.pursuit?.limits.budget, 1000, "budget untouched");
    assert.deepEqual([...new Set(calls)].sort(), ["goal_control", "raise_attention", "task_status", "watch"], "the only doors it knocks on");
  } finally {
    await door.stop();
  }
});

test("a door that stops answering runs the operator's command once per outage, and says when it is back", async () => {
  let up = false;
  const downs: string[] = [];
  const logs: string[] = [];
  const door: Door = {
    call: async name => {
      if (!up) throw new DoorUnreachable("connect ECONNREFUSED 127.0.0.1:7777");
      return name === "watch" ? { text: "", isError: false, structured: { events: [], cursor: "0", reset: false } } : { text: "", isError: false, structured: { tasks: [] } };
    },
  };
  const watchdog = new Watchdog({ door, waitSeconds: 0, log: line => logs.push(line), onDown: async reason => { downs.push(reason); } });
  assert.deepEqual(await watchdog.tick(), [], "one miss is not an outage");
  assert.deepEqual(await watchdog.tick(), ["down"]);
  assert.deepEqual(await watchdog.tick(), [], "still down: told once");
  assert.equal(downs.length, 1);
  assert.match(downs[0]!, /ECONNREFUSED/);
  up = true;
  await watchdog.tick();
  assert.ok(logs.some(line => /answers again/.test(line)));
  up = false;
  await watchdog.tick();
  await watchdog.tick();
  assert.equal(downs.length, 2, "a new outage is told again");
});

test("the decision model is not asked unless it was given", async () => {
  const board = new TaskStore(null);
  const feed = new ChangeFeed();
  board.onChange(task => feed.record(task));
  const door = await sideDoor(board, feed, []);
  try {
    const goal = board.create({ title: "digest", requester: "p1", assigneeId: "a1", conversation: "c1", pursuit: newPursuit({ objective: "digest", workId: "w", now: T0 }), now: T0 })!;
    board.update(goal.id, { status: "doing" }, "a1", undefined, T0);
    const quiet = new Watchdog({ door: doorClient(door.url, door.token), waitSeconds: 0, log: () => {}, now: () => at(5) });
    assert.deepEqual(await quiet.tick(), [], "a moving goal and no judge: nothing");
    let asked = 0;
    const judged = new Watchdog({ door: doorClient(door.url, door.token), waitSeconds: 0, log: () => {}, now: () => at(5), judge: async () => { asked++; return "the decision model reads its latest moves as not advancing the checklist"; } });
    const did = await judged.tick();
    assert.equal(asked, 1);
    assert.deepEqual(did, [`flagged ${goal.id} stalled`], "a judge's no is a flag for a person, nothing more");
  } finally {
    await door.stop();
  }
});

test("a refused token is said once and is not an outage: no on-down command, and a later acceptance clears it (INV-1520)", async () => {
  const { DoorRefused } = await import("./client.ts");
  let refuse = true;
  const logs: string[] = [];
  const downs: string[] = [];
  const door: Door = {
    call: async name => {
      if (refuse) throw new DoorRefused("http://127.0.0.1:7777/mcp: HTTP 401");
      return name === "watch" ? { text: "", isError: false, structured: { events: [], cursor: "0", reset: false } } : { text: "", isError: false, structured: { tasks: [] } };
    },
  };
  const watchdog = new Watchdog({ door, waitSeconds: 0, log: line => logs.push(line), onDown: async reason => { downs.push(reason); } });
  for (let i = 0; i < 3; i++) assert.deepEqual(await watchdog.tick(), ["refused"]);
  assert.equal(logs.filter(line => /does not accept this token/.test(line)).length, 1, "said once");
  assert.deepEqual(downs, [], "not an outage");
  refuse = false;
  assert.deepEqual(await watchdog.tick(), []);
  refuse = true;
  await watchdog.tick();
  assert.equal(logs.filter(line => /does not accept this token/.test(line)).length, 2, "a new refusal after an acceptance is said again");
});
