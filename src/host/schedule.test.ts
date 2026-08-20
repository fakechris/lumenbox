/**
 * Tests for scheduled skills.
 *
 * Three of these are about the ways an automation goes wrong quietly rather than loudly: firing twice
 * for one window, piling runs on top of each other, and catching up on a backlog nobody asked for.
 * Each is cheap to get wrong and expensive to notice, because the symptom is a bill.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeSchedule,
  isDue,
  parseSchedule,
  Scheduler,
  triggerPrompt,
  type Scheduled,
} from "./schedule.ts";

function scheduleOf(text: string) {
  const result = parseSchedule(text);
  assert.ok("schedule" in result, `expected ${text} to parse: ${JSON.stringify(result)}`);
  return result.schedule;
}

const at = (iso: string) => new Date(iso);

test("cron fields, ranges, lists and steps are read", () => {
  assert.deepEqual(scheduleOf("0 9 * * 1-5").hours, [9]);
  assert.deepEqual(scheduleOf("0 9 * * 1-5").daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(scheduleOf("0,30 * * * *").minutes, [0, 30]);
  assert.deepEqual(scheduleOf("*/15 * * * *").minutes, [0, 15, 30, 45]);
  assert.equal(scheduleOf("* * * * *").minutes, undefined, "a star is any, not a list of sixty");
  assert.deepEqual(scheduleOf("@daily").hours, [0]);
  assert.equal(scheduleOf("@every 30m").everyMs, 1_800_000);
  assert.equal(scheduleOf("@every 2 hours").everyMs, 7_200_000);
});

test("a schedule that cannot be read is refused with what would work", () => {
  // Refused rather than approximated: a schedule meaning something slightly different from what its
  // author expected is worse than one that did not load.
  const wrong = parseSchedule("0 9 * *");
  assert.ok("problem" in wrong);
  assert.match(wrong.problem, /has 4 field\(s\); a cron schedule has five/);

  const named = parseSchedule("@yearly");
  assert.ok("problem" in named);
  assert.match(named.problem, /@every 30m/, "the message names the forms that do work");

  for (const bad of ["61 * * * *", "0 25 * * *", "0 9 * * 9", "abc * * * *", "0 9-5 * * *"]) {
    assert.ok("problem" in parseSchedule(bad), `${bad} should be refused`);
  }

  // A sub-minute interval is refused rather than silently rounded: an automation that claims to run
  // every ten seconds and runs every sixty is lying to whoever wrote it.
  const tooFast = parseSchedule("@every 0 m");
  assert.ok("problem" in tooFast);
});

test("one window fires once, however often the clock is checked", () => {
  // The scheduler ticks twice a minute so a busy event loop cannot make it miss a window. That makes
  // this the thing standing between a daily report and two daily reports.
  const daily = scheduleOf("0 9 * * *");
  assert.equal(isDue(daily, at("2026-08-20T09:00:10"), undefined), true);
  assert.equal(isDue(daily, at("2026-08-20T09:00:40"), at("2026-08-20T09:00:10")), false);
  // The next day is a different window.
  assert.equal(isDue(daily, at("2026-08-21T09:00:05"), at("2026-08-20T09:00:10")), true);
});

test("a missed window is not caught up", () => {
  // Two days down: "the daily report" arguably wants two runs and "check every hour" emphatically
  // does not want forty-eight, and a cron expression cannot say which. So nothing is replayed.
  const daily = scheduleOf("0 9 * * *");
  assert.equal(
    isDue(daily, at("2026-08-22T14:00:00"), at("2026-08-20T09:00:00")),
    false,
    "14:00 is not the window, however many were missed"
  );
  assert.equal(isDue(daily, at("2026-08-22T09:00:00"), at("2026-08-20T09:00:00")), true);
});

test("an interval schedule waits its interval", () => {
  const every30 = scheduleOf("@every 30m");
  assert.equal(isDue(every30, at("2026-08-20T09:00:00"), undefined), true, "first run is immediate");
  assert.equal(isDue(every30, at("2026-08-20T09:20:00"), at("2026-08-20T09:00:00")), false);
  assert.equal(isDue(every30, at("2026-08-20T09:30:00"), at("2026-08-20T09:00:00")), true);
});

test("weekday and day-of-month schedules are respected", () => {
  const weekdays = scheduleOf("0 9 * * 1-5");
  assert.equal(isDue(weekdays, at("2026-08-21T09:00:00"), undefined), true, "Friday");
  assert.equal(isDue(weekdays, at("2026-08-22T09:00:00"), undefined), false, "Saturday");

  const monthly = scheduleOf("0 0 1 * *");
  assert.equal(isDue(monthly, at("2026-09-01T00:00:00"), undefined), true);
  assert.equal(isDue(monthly, at("2026-09-02T00:00:00"), undefined), false);
});

test("a schedule reads as words, not as cron", () => {
  // A cron expression is not something to make a person read back.
  assert.match(describeSchedule(scheduleOf("0 9 * * 1-5")), /at 09:00/);
  assert.match(describeSchedule(scheduleOf("0 9 * * 1-5")), /on Mon, Tue, Wed, Thu, Fri/);
  assert.match(describeSchedule(scheduleOf("@every 2 hours")), /every 2 hour/);
  assert.match(describeSchedule(scheduleOf("@every 30m")), /every 30 minute/);
});

test("a scheduled turn says it was a timer, not a person", () => {
  const prompt = triggerPrompt("Weekly report", "/home/box/work/skills/weekly/SKILL.md", "at 09:00");
  // The distinction it exists for: an agent that believes someone is waiting asks clarifying
  // questions nobody will answer, and hurries.
  assert.match(prompt, /started by a timer, not by a person/);
  assert.match(prompt, /Nobody is waiting on a reply/);
  assert.match(prompt, /Weekly report/);
  assert.match(prompt, /SKILL\.md/);
  // And how its output reaches anyone, since nobody is watching the screen.
  assert.match(prompt, /write it under \/home\/box\/work and say the path/);
  assert.match(prompt, /this will come round again/, "so it does not retry in place");
});

// ── the runner ────────────────────────────────────────────────────────────────────────

function runnerFixture(options: { hold?: boolean } = {}) {
  const runs: { agent: string; prompt: string }[] = [];
  const lines: string[] = [];
  let release: (() => void) | undefined;
  let clock = at("2026-08-20T09:00:00");

  const skill: Scheduled = {
    slug: "weekly",
    name: "Weekly report",
    path: "/home/box/work/skills/weekly/SKILL.md",
    schedule: scheduleOf("@every 30m"),
  };

  const scheduler = new Scheduler({
    due: async () => [skill],
    run: async (agent, prompt) => {
      runs.push({ agent, prompt });
      if (options.hold === true) {
        await new Promise<void>(resolve => {
          release = resolve;
        });
      }
    },
    defaultAgent: () => "agent-ada",
    now: () => clock,
    log: line => lines.push(line),
  });

  return {
    scheduler,
    runs,
    lines,
    advance: (minutes: number) => {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    finish: () => release?.(),
  };
}

test("a due skill fires, once, with the trigger prompt", async () => {
  const fixture = runnerFixture();
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 1);
  assert.equal(fixture.runs[0]?.agent, "agent-ada", "the default agent when none is named");
  assert.match(fixture.runs[0]?.prompt ?? "", /\[scheduled\]/);

  // Ticking again inside the interval does nothing.
  fixture.advance(10);
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 1);

  fixture.advance(25);
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 2);
});

test("a run that is still going is skipped, and said", async () => {
  const fixture = runnerFixture({ hold: true });
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 1);

  // An hourly job taking seventy minutes meets its own next fire. Piling a second run on top turns a
  // slow problem into an avalanche.
  fixture.advance(35);
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 1, "no second run on top of the first");
  // And a silent skip is indistinguishable from a schedule that stopped working.
  assert.ok(
    fixture.lines.some(line => /skipped, the previous run has not finished/.test(line)),
    `expected a skip line, got ${JSON.stringify(fixture.lines)}`
  );

  fixture.finish();
  await new Promise(resolve => setImmediate(resolve));
  fixture.advance(35);
  await fixture.scheduler.tick();
  assert.equal(fixture.runs.length, 2, "and it resumes once the first finishes");
});

test("a failing run is reported and does not stop the schedule", async () => {
  const lines: string[] = [];
  let attempts = 0;
  let clock = at("2026-08-20T09:00:00");
  const scheduler = new Scheduler({
    due: async () => [
      {
        slug: "weekly",
        name: "Weekly",
        path: "/p",
        schedule: scheduleOf("@every 30m"),
      },
    ],
    run: async () => {
      attempts += 1;
      throw new Error("the box was restarting");
    },
    defaultAgent: () => "agent-ada",
    now: () => clock,
    log: line => lines.push(line),
  });

  await scheduler.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.ok(lines.some(line => /run failed — the box was restarting/.test(line)));

  // Not retried now — a scheduled run that failed will come round again, and retrying immediately
  // would be a second unasked-for turn on top of one that just went wrong.
  clock = new Date(clock.getTime() + 31 * 60_000);
  await scheduler.tick();
  assert.equal(attempts, 2, "the next window is the retry");
});

test("a schedule with nobody to run it is reported rather than dropped", async () => {
  const lines: string[] = [];
  const scheduler = new Scheduler({
    due: async () => [
      { slug: "x", name: "X", path: "/p", schedule: scheduleOf("@every 30m") },
    ],
    run: async () => {},
    defaultAgent: () => undefined,
    log: line => lines.push(line),
  });
  await scheduler.tick();
  assert.ok(lines.some(line => /no agent to run it/.test(line)));
});

test("a box that cannot be read does not stop the scheduler", async () => {
  const lines: string[] = [];
  let failing = true;
  const scheduler = new Scheduler({
    due: async () => {
      if (failing) throw new Error("box restarting");
      return [{ slug: "x", name: "X", path: "/p", schedule: scheduleOf("@every 30m") }];
    },
    run: async () => {},
    defaultAgent: () => "a",
    log: line => lines.push(line),
  });

  await scheduler.tick();
  assert.ok(lines.some(line => /could not read schedules/.test(line)));

  // The next tick is thirty seconds away, and it works.
  failing = false;
  await scheduler.tick();
  assert.ok(lines.some(line => /firing/.test(line)));
});
