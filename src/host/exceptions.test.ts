/**
 * The exception list (INV-1741): five sources enter it, the same failure is one entry with a count,
 * each Retry goes down its own kind's path, and a resolved entry stays a week.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionFor, isDecision } from "./attention.ts";
import { ExceptionLedger, groupExceptions, KEEP_RESOLVED_MS, LEDGER_KIND, noteJobEnd, noteRoutineEnd, noteTurnEnd, retryException, type RetryDeps } from "./exceptions.ts";
import { noteDelivery } from "../web/exception-routes.ts";

function fixture(taskOf?: (agentId: string, conversation: string) => string | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-exceptions-"));
  let clock = new Date("2026-11-07T09:00:00Z");
  const ledger = new ExceptionLedger(join(dir, "exceptions.jsonl"), { now: () => clock, ...(taskOf !== undefined ? { taskOf } : {}) });
  return { dir, ledger, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Records which path each Retry took; each answer can be set per test. */
function retryDeps(over: Partial<RetryDeps> = {}): { deps: RetryDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      rerunTurn: async (agent, conversation, note) => { calls.push(`turn ${agent}/${conversation}: ${note.split("\n")[0]}`); },
      rerunCommand: async (agent, conversation, command) => { calls.push(`job ${agent}/${conversation}: ${command}`); return { exit_code: 0 }; },
      redeliver: async chatKey => { calls.push(`delivery ${chatKey}`); return { tried: 1, sent: 1 }; },
      runRoutine: async slug => { calls.push(`routine ${slug}`); return { ok: true }; },
      reconnectBox: async () => { calls.push("box"); return { connected: true, detail: "answering" }; },
      ...over,
    },
  };
}

test("each of the five sources enters the list under its task, and a success resolves it", () => {
  const f = fixture((agent, conversation) => (agent === "ada" && conversation === "c1" ? "t7" : undefined));
  try {
    assert.equal(LEDGER_KIND, "feed");
    noteTurnEnd(f.ledger, "ada", "c1", [{ lane: "user" }], new Error("429 Too Many Requests: the plan ran out"));
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "npm run build" }, { exit_code: 2, tail: "compiling\nerror TS2304: Cannot find name" });
    noteDelivery(f.ledger, "failed", { chatKey: "feishu:oc_room", error: "socket hang up" }, chatKey => (chatKey === "feishu:oc_room" ? "t7" : undefined));
    noteRoutineEnd(f.ledger, "morning-brief", "ada", "failed", "its turn failed (network)");
    f.ledger.failed({ kind: "box", subject: "box-1", reason: "connect ECONNREFUSED" });

    const open = f.ledger.list();
    assert.deepEqual(open.map(entry => entry.kind).sort(), ["box", "delivery", "job", "routine", "turn"]);
    const job = open.find(entry => entry.kind === "job")!;
    assert.equal(job.task, "t7", "a job is its conversation's task's");
    assert.equal(job.reason, "exit code 2: error TS2304: Cannot find name", "the reason is the exit and the last line it printed");
    assert.equal(open.find(entry => entry.kind === "delivery")!.task, "t7");

    const groups = groupExceptions(open, id => (id === "t7" ? "Ship the build" : undefined));
    assert.equal(groups[0]!.title, "t7: Ship the build");
    assert.equal(groups[0]!.open, 3, "turn, job and delivery under the task; routine and box under their kinds");
    assert.deepEqual(groups.slice(1).map(group => group.title).sort(), ["box", "routine"]);

    // Each source's success resolves its own entry and nothing else.
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "npm run build" }, { exit_code: 0, tail: "" });
    noteTurnEnd(f.ledger, "ada", "c1", [{ lane: "user" }]);
    noteDelivery(f.ledger, "sent", { chatKey: "feishu:oc_room" }, () => undefined);
    noteRoutineEnd(f.ledger, "morning-brief", "ada", "partial", undefined);
    f.ledger.succeeded({ kind: "box", subject: "box-1" });
    assert.ok(f.ledger.list().every(entry => entry.resolution === "succeeded"));
  } finally {
    f.cleanup();
  }
});

test("the same failure is one entry with a count; a new kind of reason or a break after a fix is a new one", () => {
  const f = fixture();
  try {
    const job = { agentId: "ada", conversation: "c1", command: "pytest" };
    noteJobEnd(f.ledger, job, { exit_code: 1, tail: "1 failed" });
    f.advance(60_000);
    noteJobEnd(f.ledger, job, { exit_code: 1, tail: "2 failed" });
    let entries = f.ledger.list();
    assert.equal(entries.length, 1, "not one line per failure");
    assert.equal(entries[0]!.attempt, 2);
    assert.equal(entries[0]!.reason, "exit code 1: 2 failed", "the latest reason");
    const first = entries[0]!.id;

    // Killed at the cap is a timeout, not a tool error: a different kind of reason, its own entry.
    noteJobEnd(f.ledger, job, { killed: true, tail: "" });
    assert.equal(f.ledger.list().length, 2);

    noteJobEnd(f.ledger, job, { exit_code: 0, tail: "" });
    noteJobEnd(f.ledger, job, { exit_code: 1, tail: "1 failed" });
    entries = f.ledger.list();
    const again = entries.find(entry => entry.resolvedAt === undefined)!;
    assert.notEqual(again.id, first, "broken again after it worked is a new episode");
    assert.equal(again.attempt, 1);
  } finally {
    f.cleanup();
  }
});

test("a background turn's failure is its source's to count, not a second line", () => {
  const f = fixture();
  try {
    noteTurnEnd(f.ledger, "ada", "main", [{ lane: "background" }], new Error("provider overloaded"));
    assert.equal(f.ledger.list().length, 0);
    noteTurnEnd(f.ledger, "ada", "main", [{ lane: "user" }, { lane: "background" }], new Error("provider overloaded"));
    assert.equal(f.ledger.list().length, 1, "a person's message in the turn makes it a turn failure");
  } finally {
    f.cleanup();
  }
});

test("Retry goes down each kind's own path and settles what it can know at once", async () => {
  const f = fixture();
  try {
    noteTurnEnd(f.ledger, "ada", "c1", [{ lane: "user" }], new Error("tool exploded"));
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "make" }, { exit_code: 2, tail: "" });
    noteDelivery(f.ledger, "failed", { chatKey: "dingtalk:cid", error: "timeout" }, () => undefined);
    noteRoutineEnd(f.ledger, "digest", "ada", "failed", "its turn failed (rate_limit)");
    f.ledger.failed({ kind: "box", subject: "box-1", reason: "ECONNREFUSED" });
    const { deps, calls } = retryDeps();
    const id = (kind: string) => f.ledger.list().find(entry => entry.kind === kind)!.id;

    const turn = await retryException(f.ledger, id("turn"), "Chris", deps);
    assert.equal(turn.ok, true);
    assert.equal(f.ledger.get(id("turn"))!.resolvedAt, undefined, "a turn is settled by how the new turn ends, not by starting it");
    assert.equal(f.ledger.get(id("turn"))!.retriedBy, "Chris");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0], "turn ada/c1: [host] Your last turn here failed (1 time): tool exploded");

    assert.deepEqual(await retryException(f.ledger, id("job"), "Chris", deps), { ok: true, detail: "the command succeeded", resolved: true });
    assert.deepEqual(await retryException(f.ledger, id("delivery"), "Chris", deps), { ok: true, detail: "1 message sent", resolved: true });
    assert.deepEqual(await retryException(f.ledger, id("routine"), "Chris", deps), { ok: true, detail: "the routine is running" });
    assert.deepEqual(await retryException(f.ledger, id("box"), "Chris", deps), { ok: true, detail: "answering", resolved: true });
    assert.deepEqual(calls.slice(1), ["job ada/c1: make", "delivery dingtalk:cid", "routine digest", "box"]);

    assert.deepEqual(await retryException(f.ledger, id("job"), "Chris", deps), { ok: false, detail: "already resolved" });

    // A task still blocked by another (INV-1740) is not started by a Retry: the turn is refused, the entry left as it was.
    noteTurnEnd(f.ledger, "ada", "c9", [{ lane: "user" }], new Error("tool exploded"));
    const blockedTurn = f.ledger.list().find(entry => entry.kind === "turn" && entry.conversation === "c9")!.id;
    f.ledger.failed({ kind: "turn", agent: "ada", conversation: "c9", subject: "c9", task: "t9", reason: "tool exploded" });
    const onTask = f.ledger.list().find(entry => entry.task === "t9")!;
    const gated = retryDeps({ notReady: task => (task === "t9" ? "t9 is blocked by t5, which is not finished, so it has not started." : undefined) });
    assert.deepEqual(await retryException(f.ledger, onTask.id, "Chris", gated.deps), { ok: false, detail: "t9 is blocked by t5, which is not finished, so it has not started." });
    assert.deepEqual(gated.calls, [], "nothing was started");
    assert.equal(f.ledger.get(onTask.id)!.attempt, 1, "a refusal is not another failure");
    assert.equal((await retryException(f.ledger, blockedTurn, "Chris", gated.deps)).ok, true, "an entry with no blocked task retries as before");
  } finally {
    f.cleanup();
  }
});

test("a Retry that fails again counts again; one that outlives its window is left to the job watch", async () => {
  const f = fixture();
  try {
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "make" }, { exit_code: 2, tail: "" });
    const id = f.ledger.list()[0]!.id;
    const failing = retryDeps({ rerunCommand: async () => ({ exit_code: 2, tail: "make: *** [all] Error 2\n" }) });
    assert.deepEqual(await retryException(f.ledger, id, "Chris", failing.deps), { ok: false, detail: "exit code 2: make: *** [all] Error 2" });
    assert.equal(f.ledger.get(id)!.attempt, 2);
    const unreachable = retryDeps({ rerunCommand: async () => { throw new Error("the agent's box is not connected"); } });
    assert.deepEqual(await retryException(f.ledger, id, "Chris", unreachable.deps), { ok: false, detail: "the agent's box is not connected" });
    assert.equal(f.ledger.list().length, 1, "a Retry that fails for another reason still counts on the entry it retried");
    assert.equal(f.ledger.get(id)!.attempt, 3);

    const slow = retryDeps({ rerunCommand: async () => ({ running: true }) });
    assert.equal((await retryException(f.ledger, id, "Chris", slow.deps)).ok, true);
    assert.equal(f.ledger.get(id)!.resolvedAt, undefined);
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "make" }, { exit_code: 0, tail: "" });
    assert.equal(f.ledger.get(id)!.resolution, "succeeded", "the watch's end settles it");

    noteDelivery(f.ledger, "failed", { chatKey: "dingtalk:cid", error: "timeout" }, () => undefined);
    const delivery = f.ledger.list().find(entry => entry.kind === "delivery")!.id;
    const halfSent = retryDeps({ redeliver: async () => ({ tried: 2, sent: 1 }) });
    assert.deepEqual(await retryException(f.ledger, delivery, "Chris", halfSent.deps), { ok: false, detail: "1 of 2 still not sent" });
  } finally {
    f.cleanup();
  }
});

test("Hand to me makes it a decision on the attention strip; Dismiss resolves it", () => {
  const f = fixture();
  try {
    noteRoutineEnd(f.ledger, "digest", "ada", "failed", "its turn failed (auth)");
    const entry = f.ledger.list()[0]!;
    f.ledger.hand(entry.id, "Chris");
    const handed = f.ledger.list().filter(item => item.handedAt !== undefined && item.resolvedAt === undefined);
    const attention = attentionFor({ principalId: "p1", identities: [], tasks: [], questions: [], nameOf: id => id, exceptionsHanded: handed });
    const item = attention.mine.find(candidate => candidate.kind === "exception");
    assert.equal(item?.ref, entry.id);
    assert.match(item?.title ?? "", /routine failed 1 time: digest/);
    assert.equal(isDecision("exception"), true, "counted with the decisions, not a row of its own");

    f.ledger.dismiss(entry.id, "Chris");
    assert.equal(f.ledger.get(entry.id)!.resolution, "dismissed");
    assert.equal(f.ledger.get(entry.id)!.resolvedBy, "Chris");
  } finally {
    f.cleanup();
  }
});

test("a resolved entry stays a week, and a compaction keeps every count and decision", () => {
  const f = fixture();
  try {
    f.ledger.failed({ kind: "box", subject: "box-1", reason: "ECONNREFUSED" });
    f.ledger.succeeded({ kind: "box", subject: "box-1" });
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "make" }, { exit_code: 2, tail: "" });
    noteJobEnd(f.ledger, { agentId: "ada", conversation: "c1", command: "make" }, { exit_code: 2, tail: "" });
    const job = f.ledger.list().find(entry => entry.kind === "job")!;
    f.ledger.hand(job.id, "Chris");

    f.advance(KEEP_RESOLVED_MS - 60_000);
    assert.equal(f.ledger.list().length, 2, "six days later the resolved one is still history");
    f.advance(120_000);
    assert.deepEqual(f.ledger.list().map(entry => entry.kind), ["job"], "past a week it is gone; the open one stays");

    f.ledger.compact();
    const after = f.ledger.get(job.id)!;
    assert.equal(after.attempt, 2);
    assert.equal(after.handedBy, "Chris");
    assert.ok(!readFileSync(join(f.dir, "exceptions.jsonl"), "utf8").includes("box-1"), "the expired entry left the file");
  } finally {
    f.cleanup();
  }
});
