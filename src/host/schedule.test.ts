/**
 * Tests for scheduled skills.
 *
 * Three of these are about the ways an automation goes wrong quietly rather than loudly: firing twice
 * for one window, piling runs on top of each other, and catching up on a backlog nobody asked for.
 * Each is cheap to get wrong and expensive to notice, because the symptom is a bill.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeSchedule,
  isDue,
  knownTimezone,
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

test("a schedule in a named zone fires at that zone's clock, not the host's", () => {
  // "06:30 ET" fired at 06:30 wherever the machine happened to be. The instants below are
  // absolute, so this test says the same thing on any developer's laptop and in CI.
  const brief = scheduleOf("30 6 * * *");
  const NY = "America/New_York";
  // 2026-08-20 is EDT (UTC-4), so 06:30 in New York is 10:30 UTC.
  assert.equal(isDue(brief, new Date("2026-08-20T10:30:00Z"), undefined, NY), true);
  assert.equal(isDue(brief, new Date("2026-08-20T06:30:00Z"), undefined, NY), false, "06:30 UTC is 02:30 in New York");
  // And in January the same wall clock is an hour later in UTC, which is the half nobody
  // gets right by hand — a scheduler that drifts twice a year looks correct for months.
  assert.equal(isDue(brief, new Date("2026-01-20T11:30:00Z"), undefined, NY), true, "EST");
  assert.equal(isDue(brief, new Date("2026-01-20T10:30:00Z"), undefined, NY), false);
});

test("a zone shifts the day and the weekday too, not only the hour", () => {
  // 22:00 Sunday in New York is Monday 02:00 UTC: an implementation that converted the
  // hour and kept the host's weekday would fire on the wrong day, once a week, forever.
  const retro = scheduleOf("0 22 * * 0");
  const NY = "America/New_York";
  assert.equal(isDue(retro, new Date("2026-08-24T02:00:00Z"), undefined, NY), true, "Sunday 22:00 ET");
  assert.equal(isDue(retro, new Date("2026-08-23T02:00:00Z"), undefined, NY), false, "Saturday 22:00 ET");
});

test("an unknown zone is refused where it is written, not where it fires", () => {
  // The failure this prevents is silent: an unrecognised name would fall back to the host
  // clock and run at plausible-looking wrong times forever. "ET" is the common mistake.
  assert.equal(knownTimezone("America/New_York"), true);
  assert.equal(knownTimezone("Asia/Shanghai"), true);
  assert.equal(knownTimezone("ET"), false);
  assert.equal(knownTimezone("Eastern"), false);
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

test("a description never claims a schedule runs less often than it does", () => {
  // This text is what a person reviews before leaving an automation running unattended, and what
  // the model is told a scheduled turn is for. Understating the frequency is worse than showing
  // them the cron expression.
  //
  // All three were wrong: only the first minute was read, an unrestricted minute field was treated
  // as minute zero, and the month was ignored entirely.
  assert.match(describeSchedule(scheduleOf("* 9 * * *")), /every minute of 09:00/);
  assert.match(describeSchedule(scheduleOf("* * * * *")), /every minute/);
  assert.match(describeSchedule(scheduleOf("0,30 * * * *")), /every hour at :00, :30/);
  assert.match(describeSchedule(scheduleOf("0,30 9 * * *")), /at 09:00, 09:30/);
  assert.match(describeSchedule(scheduleOf("0 0 1 3 *")), /in Mar/);
  assert.match(describeSchedule(scheduleOf("15 * * * *")), /every hour at :15/);
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
    // No run history: these tests are about the firing rules, and a default path would have them
    // writing into the developer's own state directory.
    path: null,
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
    // No run history: these tests are about the firing rules, and a default path would have them
    // writing into the developer's own state directory.
    path: null,
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
    path: null,
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
    path: null,
  });

  await scheduler.tick();
  assert.ok(lines.some(line => /could not read schedules/.test(line)));

  // The next tick is thirty seconds away, and it works.
  failing = false;
  await scheduler.tick();
  assert.ok(lines.some(line => /firing/.test(line)));
});


// ── the run history ───────────────────────────────────────────────────────────────────

test("a window already fired is not fired again after a restart", async () => {
  // lastRun used to be process-local, so a restart meant every cron window that had already fired
  // in the current minute fired again, and every @every schedule became immediately due. A box that
  // restarts often ran its automations far more often than they said — and an unattended automation
  // firing twice is a duplicate side effect nobody watched.
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sched-"));
  const path = join(dir, "schedules.jsonl");
  try {
    const daily: Scheduled = {
      slug: "report",
      name: "Daily report",
      path: "/p",
      schedule: scheduleOf("0 9 * * *"),
    };
    let clock = at("2026-08-20T09:00:05");
    const runs: string[] = [];
    const make = () =>
      new Scheduler({
        due: async () => [daily],
        run: async agent => {
          runs.push(agent);
        },
        defaultAgent: () => "agent-ada",
        now: () => clock,
        path,
      });

    await make().tick();
    assert.equal(runs.length, 1);

    // Restarted twenty seconds later, still inside the 09:00 window.
    clock = at("2026-08-20T09:00:25");
    await make().tick();
    assert.equal(runs.length, 1, "the window it already ran is not repeated");

    // Tomorrow is a different window, and it still fires.
    clock = at("2026-08-21T09:00:05");
    await make().tick();
    assert.equal(runs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an interval schedule does not become due again just because the box restarted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sched-"));
  const path = join(dir, "schedules.jsonl");
  try {
    const every30: Scheduled = {
      slug: "poll",
      name: "Poll",
      path: "/p",
      schedule: scheduleOf("@every 30m"),
    };
    let clock = at("2026-08-20T09:00:00");
    let runs = 0;
    const make = () =>
      new Scheduler({
        due: async () => [every30],
        run: async () => {
          runs += 1;
        },
        defaultAgent: () => "agent-ada",
        now: () => clock,
        path,
      });

    await make().tick();
    assert.equal(runs, 1, "the first run is immediate");

    clock = at("2026-08-20T09:05:00");
    await make().tick();
    assert.equal(runs, 1, "five minutes into a thirty-minute interval, a restart changes nothing");

    clock = at("2026-08-20T09:31:00");
    await make().tick();
    assert.equal(runs, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run interrupted by a restart is reported, not resumed and not repeated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sched-"));
  const path = join(dir, "schedules.jsonl");
  try {
    const skill: Scheduled = {
      slug: "long",
      name: "Long job",
      path: "/p",
      schedule: scheduleOf("@every 30m"),
    };
    let clock = at("2026-08-20T09:00:00");
    const lines: string[] = [];

    // A run that starts and never settles: the process died holding it.
    const dying = new Scheduler({
      due: async () => [skill],
      run: () => new Promise<void>(() => {}),
      defaultAgent: () => "agent-ada",
      now: () => clock,
      path,
    });
    await dying.tick();

    // The replacement sees a start with no end. It must not treat that as running — that would
    // block this schedule forever — nor as never having happened, which would fire the same window
    // again.
    clock = at("2026-08-20T09:05:00");
    let runs = 0;
    const successor = new Scheduler({
      due: async () => [skill],
      run: async () => {
        runs += 1;
      },
      defaultAgent: () => "agent-ada",
      now: () => clock,
      log: line => lines.push(line),
      path,
    });
    assert.ok(
      lines.some(line => /interrupted by a restart; not resumed, not repeated/.test(line)),
      `expected the interruption to be reported, got ${JSON.stringify(lines)}`
    );

    await successor.tick();
    assert.equal(runs, 0, "not repeated: its window has passed");

    // And the schedule is not wedged — the next window runs normally.
    clock = at("2026-08-20T09:31:00");
    await successor.tick();
    assert.equal(runs, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn history line turns off one record, not every automation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-sched-"));
  const path = join(dir, "schedules.jsonl");
  try {
    writeFileSync(path, '{"slug":"poll","at":"2026-08-20T09:00:00.000Z","event":"start');
    let runs = 0;
    const scheduler = new Scheduler({
      due: async () => [
        { slug: "poll", name: "Poll", path: "/p", schedule: scheduleOf("@every 30m") },
      ],
      run: async () => {
        runs += 1;
      },
      defaultAgent: () => "agent-ada",
      now: () => at("2026-08-20T09:10:00"),
      path,
    });
    await scheduler.tick();
    assert.equal(runs, 1, "an unreadable line must not make one bad byte switch automations off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a delivering skill hands its chat to the runner; a silent one hands nothing", async () => {
  // The gap this closes: every scheduled skill was the silent kind. The turn ran in the
  // main conversation, which no chat reads, so a morning brief worked perfectly and
  // nobody ever saw one.
  const handed: (string | undefined)[] = [];
  const scheduler = new Scheduler({
    due: async () => [
      {
        slug: "brief",
        name: "Morning brief",
        path: "/p",
        schedule: scheduleOf("@every 30m"),
        deliver: "feishu:oc_room",
      },
      { slug: "tidy", name: "Tidy downloads", path: "/p", schedule: scheduleOf("@every 30m") },
    ],
    run: async (_agent, _prompt, deliver) => {
      handed.push(deliver);
    },
    defaultAgent: () => "agent-ada",
    now: () => at("2026-08-20T09:00:00"),
    path: null,
  });
  await scheduler.tick();
  assert.deepEqual(handed, ["feishu:oc_room", undefined]);
});

test("a delivering run is told its words reach people; a silent one is told to write files", () => {
  // Same skill, two very different jobs. Without this the delivering run would answer
  // "the brief has been written to /home/box/work/notes/brief.md" — a report that a
  // report exists, pushed into a chat where the person wanted the thing itself.
  const silent = triggerPrompt("Tidy", "/p", "every day at 03:00");
  assert.match(silent, /record the result where it can be found later/);
  assert.match(silent, /write it under \/home\/box\/work and say the path/);

  const delivering = triggerPrompt("Brief", "/p", "every day at 06:30", "feishu:oc_room");
  assert.match(delivering, /your reply is delivered to a chat/);
  assert.match(delivering, /make it the thing itself/);
  assert.match(delivering, /read on a phone/);
  // Both still say a person is not waiting to answer questions.
  assert.match(silent, /\[scheduled\]/);
  assert.match(delivering, /Nobody will answer a question/);
});

test("running one by hand is the same path, and does not consume the scheduled window", async () => {
  // A rehearsal must exercise what will actually fire at 06:30 — and must not make
  // tomorrow's real run disappear because somebody tried it today.
  const prompts: string[] = [];
  const clock = at("2026-08-20T09:00:00");
  const scheduler = new Scheduler({
    due: async () => [
      { slug: "brief", name: "Brief", path: "/p", schedule: scheduleOf("@every 30m"), deliver: "feishu:oc_room" },
    ],
    run: async (_agent, prompt) => {
      prompts.push(prompt);
    },
    defaultAgent: () => "agent-ada",
    now: () => clock,
    path: null,
  });

  const started = await scheduler.runNow("brief");
  assert.deepEqual(started, { ok: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /delivered to a chat/, "the same prompt the timer would send");

  // The window still belongs to the timer.
  await scheduler.tick();
  assert.equal(prompts.length, 2, "the scheduled run happened as though nothing had");

  const missing = await scheduler.runNow("nope");
  assert.equal(missing.ok, false);
});
