/**
 * Run history and the failure pause (INV-1665). The failure this exists for: an hourly routine
 * broke at 22:00 and failed every hour until somebody read the log the next morning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionFor } from "./attention.ts";
import { cmdRoutines } from "./routine-runs-cli.ts";
import { runsOf, type RunRecord } from "./routine-runs.ts";
import { parseSchedule, Scheduler, type Scheduled, type SchedulerDeps } from "./schedule.ts";
import { upcomingFires } from "./schedule-time.ts";

function scheduleOf(text: string) {
  const parsed = parseSchedule(text);
  assert.ok("schedule" in parsed);
  return parsed.schedule;
}

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(path: string | null, outcomes: (() => Promise<void | { result: "done" | "failed"; reason?: string }>)[], precheck?: SchedulerDeps["precheck"]) {
  let clock = new Date("2026-11-05T09:00:00Z");
  const fired: number[] = [];
  const skill: Scheduled = { slug: "hourly", name: "Hourly check", path: "/p", schedule: scheduleOf("@every 1h") };
  const make = () => new Scheduler({
    due: async () => [skill],
    run: async () => {
      fired.push(clock.getTime());
      const next = outcomes.shift();
      return next === undefined ? { result: "done" as const } : next();
    },
    defaultAgent: () => "agent-ada",
    now: () => clock,
    path,
    ...(precheck !== undefined ? { precheck } : {}),
  });
  return { make, fired, advance: (hours: number) => { clock = new Date(clock.getTime() + hours * 3_600_000); } };
}

const fail = (reason: string) => async () => { throw new Error(reason); };

test("three failures in a row pause a routine with the last reason; resuming clears the count", async () => {
  const f = fixture(null, [fail("the API said 401"), async () => ({ result: "failed", reason: "its turn failed (provider)" }), fail("the API said 401 again")]);
  const scheduler = f.make();
  for (let window = 0; window < 3; window += 1) {
    await scheduler.tick();
    await settle();
    f.advance(1);
  }
  assert.equal(f.fired.length, 3);
  const hold = scheduler.holds.holdOf("hourly");
  assert.equal(hold?.code, "consecutive_failures");
  assert.match(hold?.reason ?? "", /failed 3 times in a row; the last: the API said 401 again/);

  await scheduler.tick();
  await settle();
  assert.equal(f.fired.length, 3, "the fourth window does not fire");
  const [status] = await scheduler.status();
  assert.equal(status?.paused, true);
  assert.equal(status?.nextRun, undefined);
  assert.deepEqual(status?.upcoming, []);
  assert.deepEqual(await scheduler.runNow("hourly"), { ok: false, reason: `Hourly check is paused (${hold!.reason}); resume it first.` });

  assert.equal(scheduler.resume("hourly", "Chris"), true);
  assert.equal(scheduler.holds.streakOf("hourly"), 0, "a resumed routine gets K fresh tries");
  await scheduler.tick();
  await settle();
  assert.equal(f.fired.length, 4, "and runs at its next window");
  assert.equal(scheduler.runs("hourly")[0]?.outcome, "done");
});

test("a routine missing a credential is skipped and paused before it starts, and runs once a person resumes it with the credential there (INV-1666)", async () => {
  let missing = true;
  const asked: string[] = [];
  const f = fixture(null, [], async (skill, agent) => {
    asked.push(`${skill.slug} as ${agent}`);
    return missing ? { code: "missing_credentials", text: "missing before it could start: connector github (GitHub is not connected here)" } : undefined;
  });
  const scheduler = f.make();
  await scheduler.tick();
  await settle();
  assert.equal(f.fired.length, 0, "nothing ran");
  assert.deepEqual(asked, ["hourly as agent-ada"]);
  assert.deepEqual(scheduler.runs("hourly").map(run => `${run.outcome} ${run.code}`), ["skipped missing_credentials"]);
  assert.equal(scheduler.holds.holdOf("hourly")?.code, "missing_credentials", "held through the same door as the failure streak");
  f.advance(1);
  await scheduler.tick();
  assert.equal(asked.length, 1, "a held routine is not asked again every window");
  assert.match(JSON.stringify(await scheduler.runNow("hourly")), /paused \(missing before it could start: connector github/);

  missing = false;
  scheduler.resume("hourly", "Chris");
  await scheduler.tick();
  await settle();
  assert.equal(f.fired.length, 1, "resumed with the credential there, it runs at its next window");
});

test("a run that ends done breaks the streak; K is a setting and 0 never pauses", async () => {
  const f = fixture(null, [fail("a"), fail("b"), async () => ({ result: "done" }), fail("c"), fail("d")]);
  const scheduler = f.make();
  for (let window = 0; window < 5; window += 1) {
    await scheduler.tick();
    await settle();
    f.advance(1);
  }
  assert.equal(scheduler.holds.holdOf("hourly"), undefined, "two, done, two: never three in a row");
  assert.equal(scheduler.holds.streakOf("hourly"), 2);
  scheduler.setPauseAfter(0);
  await scheduler.tick();
  await settle();
  assert.equal(scheduler.holds.holdOf("hourly"), undefined, "0 turns the pause off");
  assert.throws(() => scheduler.setPauseAfter(-1));
});

test("a hold and K survive a restart; the CLI prints the same runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-routine-runs-"));
  try {
    const path = join(dir, "schedules.jsonl");
    const f = fixture(path, [fail("disk full"), fail("disk full")]);
    const first = f.make();
    first.setPauseAfter(2);
    for (let window = 0; window < 2; window += 1) {
      await first.tick();
      await settle();
      f.advance(1);
    }
    assert.ok(first.holds.holdOf("hourly") !== undefined);

    const second = f.make();
    assert.equal(second.holds.pauseAfter, 2);
    assert.match(second.holds.holdOf("hourly")?.reason ?? "", /failed 2 times in a row; the last: disk full/);
    await second.tick();
    await settle();
    assert.equal(f.fired.length, 2, "still paused after the restart");

    const printed: string[] = [];
    assert.equal(cmdRoutines(["runs", "hourly"], line => printed.push(line), () => {}, path), 0);
    assert.match(printed[0] ?? "", /^hourly — paused by host .*disk full/);
    assert.equal(printed.filter(line => /\bfailed\s+disk full/.test(line)).length, 2);
    assert.match(printed.at(-1) ?? "", /Done means the run ended, not that its work was accepted/);
    assert.equal(cmdRoutines(["runs"], () => {}, () => {}, path), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger folds into runs, newest first: done, failed, skipped with its reason, interrupted", () => {
  const records: RunRecord[] = [
    { slug: "r", at: "2026-11-05T01:00:00Z", event: "started", agent: "ada" },
    { slug: "r", at: "2026-11-05T01:01:00Z", event: "finished", result: "done", ms: 60_000 },
    { slug: "r", at: "2026-11-05T02:00:00Z", event: "started", agent: "ada", manual: true },
    { slug: "r", at: "2026-11-05T02:00:30Z", event: "skipped", code: "overlap_in_flight", reason: "the previous run has not finished" },
    { slug: "r", at: "2026-11-05T02:01:00Z", event: "finished", result: "failed", reason: "boom" },
    { slug: "other", at: "2026-11-05T02:30:00Z", event: "started" },
    { slug: "r", at: "2026-11-05T03:00:00Z", event: "started", agent: "ada" },
  ];
  const runs = runsOf(records, "r");
  assert.deepEqual(runs.map(run => run.outcome), ["interrupted", "skipped", "failed", "done"]);
  assert.equal(runs[1]?.reason, "the previous run has not finished");
  assert.equal(runs[2]?.manual, true);
  assert.equal(runs[2]?.reason, "boom");
  assert.equal(runsOf(records, "r", { running: true })[0]?.outcome, "running", "the open run is running while this process owns it");
});

test("the next five times follow the cron in its zone, not the host's", () => {
  // 09:00 on weekdays in Shanghai is 01:00 UTC; from a Friday afternoon there, Monday is next.
  const next = upcomingFires(scheduleOf("0 9 * * 1-5"), new Date("2026-11-06T08:00:00Z"), undefined, "Asia/Shanghai");
  assert.deepEqual(next.map(at => at.toISOString()), ["2026-11-09T01:00:00.000Z", "2026-11-10T01:00:00.000Z", "2026-11-11T01:00:00.000Z", "2026-11-12T01:00:00.000Z", "2026-11-13T01:00:00.000Z"]);
  const hourly = upcomingFires(scheduleOf("@every 1h"), new Date("2026-11-06T08:00:00Z"), new Date("2026-11-06T07:30:00Z"));
  assert.deepEqual(hourly.map(at => at.toISOString().slice(11, 16)), ["08:30", "09:30", "10:30", "11:30", "12:30"]);
  assert.equal(upcomingFires(scheduleOf("@at 2026-11-07T09:00"), new Date("2026-11-06T08:00:00Z"), undefined).length, 1, "a one-time task has one");
});

test("a paused routine is a decision on the attention list, for everyone", () => {
  const answer = attentionFor({
    principalId: "p-1", identities: [], tasks: [], questions: [], nameOf: id => id,
    routinesHeld: [{ slug: "hourly", name: "Hourly check", at: "2026-11-05T12:00:00Z", by: "host", code: "consecutive_failures", reason: "failed 3 times in a row; the last: 401" }],
  });
  const item = answer.mine.find(entry => entry.kind === "routine-paused");
  assert.equal(item?.ref, "hourly");
  assert.match(item?.title ?? "", /Routine Hourly check is paused: failed 3 times in a row/);
});
