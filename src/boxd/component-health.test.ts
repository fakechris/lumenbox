/**
 * Tests for restart policy.
 *
 * These use an injected clock because the whole subject is time: a component that dies
 * once an hour is healthy and one that dies every second is not, and the only difference
 * between them is when.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentHealth, type ComponentPolicy } from "./component-health.ts";
import { startedComponents } from "./displays.ts";

const POLICY: ComponentPolicy = {
  windowMs: 60_000,
  maxInWindow: 3,
  backoffBaseMs: 1000,
  backoffMaxMs: 8000,
  giveUpAfterEpisodes: 2,
  optional: ["picom"],
};

/** A clock the test moves by hand. */
function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

test("one restart is a hiccup, not a problem", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);

  const status = health.restarted("x11vnc");
  assert.equal(status.state, "backoff");
  assert.equal(status.restarts, 1);

  // Past its backoff it is eligible again, and nothing is reported as wrong.
  time.advance(2000);
  assert.equal(health.stateOf("x11vnc"), "ok");
  assert.equal(health.degraded(), false);
});

test("backoff grows, so a flapping component is not retried every tick", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);

  health.restarted("x11vnc");
  time.advance(1001);
  assert.equal(health.stateOf("x11vnc"), "ok", "1s after the first restart");

  health.restarted("x11vnc");
  time.advance(1001);
  assert.equal(health.stateOf("x11vnc"), "backoff", "second restart waits 2s");
  time.advance(1000);
  assert.equal(health.stateOf("x11vnc"), "ok");
});

test("past the cap it is abandoned rather than hammered", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);

  for (let i = 0; i < POLICY.maxInWindow + 1; i++) {
    health.restarted("x11vnc");
    time.advance(100);
  }

  const status = health.statusOf("x11vnc");
  assert.equal(status.state, "crashloop");
  assert.match(status.reason ?? "", /more than 3 times/);
  assert.ok(health.blocked().includes("x11vnc"));
  assert.equal(health.degraded(), true);
});

test("a crashloop heals once the restarts age out", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);
  for (let i = 0; i < POLICY.maxInWindow + 1; i++) health.restarted("x11vnc");
  assert.equal(health.stateOf("x11vnc"), "crashloop");

  // The window is what makes this self-healing: a box that was briefly broken recovers
  // without anyone restarting it.
  time.advance(POLICY.windowMs + 1);
  assert.equal(health.stateOf("x11vnc"), "ok");
  assert.equal(health.degraded(), false);
});

test("the compositor is given up on, because a flapping one is worse than none", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);

  // Episode one: hits the cap, then cools off.
  for (let i = 0; i < POLICY.maxInWindow + 1; i++) health.restarted("picom");
  assert.equal(health.stateOf("picom"), "crashloop");
  assert.equal(health.statusOf("picom").crashloops, 1);

  time.advance(POLICY.windowMs + 1);
  assert.equal(health.stateOf("picom"), "ok", "eligible again after cooling off");

  // Episode two: no longer eligible for anything.
  for (let i = 0; i < POLICY.maxInWindow + 1; i++) health.restarted("picom");
  const status = health.statusOf("picom");
  assert.equal(status.state, "disabled");
  assert.equal(status.crashloops, 2);
  assert.match(status.reason ?? "", /runs without it/);

  // And permanently: ageing out does not bring it back.
  time.advance(POLICY.windowMs * 10);
  assert.equal(health.stateOf("picom"), "disabled");
});

test("a component the desktop cannot work without is never disabled", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);

  for (let episode = 0; episode < 5; episode++) {
    for (let i = 0; i < POLICY.maxInWindow + 1; i++) health.restarted("Xvfb");
    time.advance(POLICY.windowMs + 1);
  }

  // Crashloop, over and over, but always eligible again: there is no useful desktop
  // without X, so giving up would only hide the problem.
  assert.equal(health.stateOf("Xvfb"), "ok");
  assert.ok(health.statusOf("Xvfb").crashloops >= 4);
});

test("the report names every component it knows about", () => {
  const time = clock();
  const health = new ComponentHealth(POLICY, time.now);
  health.restarted("x11vnc");
  health.restarted("picom");

  assert.deepEqual(
    health.report().map(status => status.name),
    ["picom", "x11vnc"]
  );
});

test("the components a repair reports are the ones counted", () => {
  // start-display's own line is the only record of what was missing, so parsing it is
  // what connects "something was restarted" to the policy that decides what that means.
  assert.deepEqual(
    startedComponents("[display 1] ready (started: Xvfb xfwm4 picom x11vnc websockify)"),
    ["Xvfb", "xfwm4", "picom", "x11vnc", "websockify"]
  );
  // The autocutsel entries carry their selection in parentheses; the component is the
  // binary, not the selection.
  assert.deepEqual(
    startedComponents("ready (started: autocutsel(PRIMARY) autocutsel(CLIPBOARD) plank)"),
    ["autocutsel", "autocutsel", "plank"]
  );
  assert.deepEqual(startedComponents("[display 1] already healthy"), []);
});
