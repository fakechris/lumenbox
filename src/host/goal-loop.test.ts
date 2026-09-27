import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "./tasks.ts";
import { newPursuit, type GoalMarker } from "./goal-mode.ts";
import { ANTI_SPIN_LIMIT, CONTINUATION_DELAY_MS, GoalLoop, MAX_CONTINUATION_RETRIES, RETRY_BACKOFF_MS, STALL_LIMIT, isWorkingTool, type GoalLoopDeps } from "./goal-loop.ts";

/**
 * A harness around the loop: a fake bus that records wakes, a clock that only moves when the
 * test moves it, timers that fire when the test says so, and a chat that keeps what it was told.
 */
function harness(over: Partial<GoalLoopDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-goal-loop-"));
  const tasks = new TaskStore(join(dir, "tasks.jsonl"));
  let nowMs = Date.parse("2026-09-27T09:00:00Z");
  const timers: { fn: () => void; at: number; cancelled: boolean }[] = [];
  const wakes: { agentId: string; text: string; goal?: GoalMarker }[] = [];
  const told: string[] = [];
  const busy: string[] = [];
  let active = false;
  let queued = 0;
  const deps: GoalLoopDeps = {
    tasks,
    agentName: () => "Nova",
    bus: {
      isActive: () => active,
      queuedCount: () => queued,
      sendFromUser: (agentId, text, options) => { wakes.push({ agentId, text, ...(options.goal !== undefined ? { goal: options.goal } : {}) }); return 1; },
      wake: async () => {},
    },
    busy: () => busy,
    wakeGate: () => ({ allowed: true }),
    durableState: () => ({ plan: "p", todos: [] }),
    notify: async (_task, text) => { told.push(text); },
    log: () => {},
    now: () => new Date(nowMs),
    schedule: (fn, ms) => { const entry = { fn, at: nowMs + ms, cancelled: false }; timers.push(entry); return { cancel: () => { entry.cancelled = true; } }; },
    ...over,
  };
  const loop = new GoalLoop(deps);
  const fire = () => { const due = timers.splice(0).filter(t => !t.cancelled); for (const t of due) t.fn(); return due.length; };
  const task = tasks.create({ title: "quarterly", requester: "principal-user", assigneeId: "nova", conversation: "feishu-private", pursuit: newPursuit({ objective: "quarterly report", workId: "w-1", chatKey: "feishu:private" }) })!;
  return {
    tasks, loop, wakes, told, timers, fire, task,
    tick: (ms: number) => { nowMs += ms; },
    setBusy: (value: boolean) => { active = value; },
    setQueued: (value: number) => { queued = value; },
    setBlocked: (...reasons: string[]) => { busy.length = 0; busy.push(...reasons); },
    pursuit: () => tasks.get(task.id)!.pursuit!,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const CONV = "feishu-private";

test("an idle conversation with an active goal gets one continuation after the delay, and only one", () => {
  const h = harness();
  try {
    h.loop.onTurnFinished("nova");
    assert.equal(h.wakes.length, 0, "not before the delay");
    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0]!.at - Date.parse("2026-09-27T09:00:00Z"), CONTINUATION_DELAY_MS);
    h.loop.onTurnFinished("nova");
    assert.equal(h.timers.length, 1, "a second consideration while one is pending arms nothing");
    h.fire();
    assert.equal(h.wakes.length, 1);
    const wake = h.wakes[0]!;
    assert.equal(wake.agentId, "nova");
    assert.match(wake.text, /<host_notification source="goal">[\s\S]*<objective>\nquarterly report\n<\/objective>[\s\S]*Stopping is not finishing/);
    assert.deepEqual({ taskId: wake.goal?.taskId, workId: wake.goal?.workId, seq: wake.goal?.seq, finishOnly: wake.goal?.finishOnly }, { taskId: h.task.id, workId: "w-1", seq: 1, finishOnly: undefined });
    assert.equal(h.pursuit().spent.continuations, 1, "counted at start, on the board");
    // While it runs nothing else is armed.
    assert.equal(h.loop.turnStarting("nova", CONV, [{ id: "g1", fromId: "user", fromName: "user", text: wake.text, priority: false, receivedAt: "", synthetic: true, goal: wake.goal }]), true);
    h.loop.onTurnFinished("nova");
    assert.equal(h.timers.length, 0, "not while the continuation runs");
  } finally { h.cleanup(); }
});

test("busy conversations, queued messages, questions and approvals hold the loop; a paused goal is never woken", () => {
  const h = harness();
  try {
    h.setBusy(true); h.loop.onTurnFinished("nova"); assert.equal(h.timers.length, 0, "a running turn");
    h.setBusy(false); h.setQueued(2); h.loop.onTurnFinished("nova"); assert.equal(h.timers.length, 0, "queued messages");
    h.setQueued(0); h.setBlocked("a question waiting on the person"); h.loop.onTurnFinished("nova"); assert.equal(h.timers.length, 0, "a question");
    h.setBlocked(); h.loop.onTurnFinished("nova"); assert.equal(h.timers.length, 1, "free at last");
    // Busy again by the time the delay elapses: the start is abandoned, not queued.
    h.setBusy(true); h.fire(); assert.equal(h.wakes.length, 0);
    h.setBusy(false);
    h.tasks.setPursuit(h.task.id, p => ({ ...p, status: "paused", pausedReason: "person" }), "paused", "principal-user");
    h.loop.onTurnFinished("nova");
    assert.equal(h.timers.length, 0, "a paused goal is not the loop's");
  } finally { h.cleanup(); }
});

test("a person speaking first makes a scheduled continuation stale, and the loop drops it at the door (review R6)", () => {
  const h = harness();
  try {
    h.loop.onTurnFinished("nova");
    const person = [{ id: "p1", fromId: "user", fromName: "user", text: "改一下标题", priority: false, receivedAt: "" }];
    assert.equal(h.loop.turnStarting("nova", CONV, person), true, "a person's turn always runs");
    assert.equal(h.fire(), 0, "the pending wake was cancelled when the person spoke");
    assert.equal(h.wakes.length, 0);
    // A wake that made it into the queue before the person spoke is not run.
    h.loop.onTurnFinished("nova");
    h.fire();
    assert.equal(h.wakes.length, 1);
    const stale = h.wakes[0]!;
    h.loop.turnStarting("nova", CONV, person); // the person overtook it
    assert.equal(h.loop.turnStarting("nova", CONV, [{ id: "g", fromId: "user", fromName: "user", text: stale.text, priority: false, receivedAt: "", synthetic: true, goal: stale.goal }]), false);
    assert.equal(h.pursuit().status, "active", "dropping a wake changes nothing on the board");
  } finally { h.cleanup(); }
});

test("three continuations without a working tool pause the goal as anti_spin, and the person is told", async () => {
  const h = harness();
  try {
    for (let i = 1; i <= ANTI_SPIN_LIMIT; i++) {
      h.loop.onTurnFinished("nova"); h.fire();
      const wake = h.wakes.at(-1)!;
      h.loop.turnStarting("nova", CONV, [{ id: `g${i}`, fromId: "user", fromName: "user", text: wake.text, priority: false, receivedAt: "", synthetic: true, goal: wake.goal }]);
      h.tick(60_000);
      await h.loop.turnEnded({ marker: wake.goal!, how: "done", worked: false });
      if (i < ANTI_SPIN_LIMIT) assert.equal(h.pursuit().status, "active", `still active after ${i}`);
    }
    assert.equal(h.pursuit().status, "paused");
    assert.equal(h.pursuit().pausedReason, "anti_spin");
    assert.equal(h.pursuit().spent.idleStreak, ANTI_SPIN_LIMIT);
    assert.equal(h.pursuit().spent.activeMs, ANTI_SPIN_LIMIT * 60_000, "active time accrues per continuation");
    assert.equal(h.tasks.get(h.task.id)?.status, "blocked");
    assert.match(h.told[0] ?? "", /目标 t1 已暂停：连续 3 次续跑没有做任何实际工作/);
    assert.equal(isWorkingTool("SetTodos"), false); assert.equal(isWorkingTool("Goal"), false); assert.equal(isWorkingTool("bash"), true);
  } finally { h.cleanup(); }
});

test("a working continuation resets the idle streak; an unchanged plan, todos and workspace across continuations is a stall", async () => {
  let manifest = new Map([["/home/box/work/a.md", "aaa"]]);
  const h = harness({ manifest: async () => manifest });
  try {
    const run = async (worked: boolean) => {
      h.loop.onTurnFinished("nova"); h.fire();
      const wake = h.wakes.at(-1)!;
      h.loop.turnStarting("nova", CONV, [{ id: `g${h.wakes.length}`, fromId: "user", fromName: "user", text: wake.text, priority: false, receivedAt: "", synthetic: true, goal: wake.goal }]);
      await h.loop.turnEnded({ marker: wake.goal!, how: "done", worked });
    };
    await run(false); await run(false);
    assert.equal(h.pursuit().spent.idleStreak, 2);
    await run(true);
    assert.equal(h.pursuit().spent.idleStreak, 0, "one working call clears the streak");
    // Working, but nothing changes: the state hash repeats.
    assert.equal(h.pursuit().spent.stallStreak, 2, "the hash was already the same twice while idle");
    assert.equal(h.pursuit().status, "paused", "STALL_LIMIT reached");
    assert.equal(h.pursuit().pausedReason, "stalled");
    assert.equal(STALL_LIMIT, 2);
    // A changed workspace would have kept it going.
    h.tasks.setPursuit(h.task.id, p => ({ ...p, status: "active", pausedReason: undefined, spent: { ...p.spent, stallStreak: 0 } }), "resumed", "principal-user");
    manifest = new Map([["/home/box/work/a.md", "bbb"]]);
    await run(true);
    assert.equal(h.pursuit().spent.stallStreak, 0);
    assert.equal(h.pursuit().status, "active");
  } finally { h.cleanup(); }
});

test("a failed continuation is retried with backoff, and after the retries the goal pauses as error", async () => {
  const h = harness();
  try {
    h.loop.onTurnFinished("nova"); h.fire();
    for (let failures = 1; failures <= MAX_CONTINUATION_RETRIES + 1; failures++) {
      const wake = h.wakes.at(-1)!;
      h.loop.turnStarting("nova", CONV, [{ id: `g${failures}`, fromId: "user", fromName: "user", text: wake.text, priority: false, receivedAt: "", synthetic: true, goal: wake.goal }]);
      await h.loop.turnEnded({ marker: wake.goal!, how: "failed", worked: false });
      if (failures <= MAX_CONTINUATION_RETRIES) {
        assert.equal(h.pursuit().status, "active");
        assert.equal(h.pursuit().spent.errorStreak, failures);
        assert.equal(h.timers.length, 1);
        assert.equal(h.timers[0]!.at - Date.parse("2026-09-27T09:00:00Z"), RETRY_BACKOFF_MS * 2 ** (failures - 1), `backoff ${failures}`);
        h.fire();
        assert.equal(h.wakes.length, failures + 1, "retried");
      }
    }
    assert.equal(h.pursuit().status, "paused");
    assert.equal(h.pursuit().pausedReason, "error");
    assert.match(h.told[0] ?? "", /连续几次续跑都失败了（最近一次：failed）/);
  } finally { h.cleanup(); }
});

test("at the continuation limit the last turn is finish-only, its report reaches the person, and the goal pauses", async () => {
  const h = harness();
  try {
    h.tasks.setPursuit(h.task.id, p => ({ ...p, limits: { ...p.limits, continuations: 2 }, spent: { ...p.spent, continuations: 2 } }), "two used");
    h.loop.onTurnFinished("nova"); h.fire();
    const wake = h.wakes[0]!;
    assert.equal(wake.goal?.finishOnly, true);
    assert.equal(wake.goal?.reason, "continuations");
    assert.match(wake.text, /Goal t1 is pausing: the continuation limit is reached\. This turn has one response and no tools/);
    h.loop.turnStarting("nova", CONV, [{ id: "g", fromId: "user", fromName: "user", text: wake.text, priority: false, receivedAt: "", synthetic: true, goal: wake.goal }]);
    await h.loop.turnEnded({ marker: wake.goal!, how: "done", worked: false, finalText: "做完了 1 和 2；3 还差数据。" });
    assert.equal(h.pursuit().status, "paused");
    assert.equal(h.pursuit().pausedReason, "continuations");
    assert.match(h.told[0] ?? "", /^做完了 1 和 2；3 还差数据。\n\n目标 t1 已暂停：续跑次数到了上限（2）/);
    // Active-time limit works the same way.
    h.tasks.setPursuit(h.task.id, p => ({ ...p, status: "active", pausedReason: undefined, limits: { continuations: 30, activeMs: 1_000 }, spent: { ...p.spent, activeMs: 1_000 } }), "resumed with time spent");
    h.loop.onTurnFinished("nova"); h.fire();
    assert.equal(h.wakes.at(-1)?.goal?.reason, "deadline");
  } finally { h.cleanup(); }
});

test("the wake gate holds a continuation, and rearm looks at every active goal after a restart", () => {
  const h = harness({ wakeGate: () => ({ allowed: false, reason: "stopped by the person" }) });
  try {
    h.loop.onTurnFinished("nova"); h.fire();
    assert.equal(h.wakes.length, 0, "refused by the gate");
    assert.equal(h.pursuit().spent.continuations, 0, "and not counted");
    const fresh = new GoalLoop({ ...(h.loop as unknown as { deps: GoalLoopDeps }).deps, wakeGate: () => ({ allowed: true }) });
    assert.equal(fresh.rearm(), 1);
    h.fire();
    assert.equal(h.wakes.length, 1, "a new process picks the goal up from the board");
    assert.equal(h.wakes[0]!.goal?.workId, "w-1", "under the same workId");
  } finally { h.cleanup(); }
});
