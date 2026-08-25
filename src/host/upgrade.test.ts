/**
 * Tests for deciding when to upgrade somebody's box.
 *
 * This is the part of upgrading that is impossible to arrange in reality — a half-broken
 * box with two people watching at three in the morning — and the part where being wrong is
 * expensive in both directions. Upgrading when it costs somebody something is rude and
 * occasionally destructive; asking when it costs nobody anything trains people to click
 * through the question, which is how the one that mattered gets clicked through too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { adminRecipients, decideUpgrade, STALE_WAIT_HOURS, upgradeMessage } from "./upgrade.ts";
import type { Preflight } from "../box/preflight.ts";

const quiet: Preflight = { runningJobs: [], strayFiles: [], moreStrayFiles: false };
const busy: Preflight = {
  runningJobs: [{ id: "j1", command: "npm run build" }],
  strayFiles: [],
  moreStrayFiles: false,
};

test("an idle box with nobody watching is upgraded without asking", () => {
  const decision = decideUpgrade({ preflight: quiet, watching: 0, hour: 4 });
  assert.equal(decision.action, "go");
});

test("safety is decided before convenience", () => {
  // Work that would be destroyed is not made expendable by everyone being asleep, so the
  // ask must survive the most permissive possible timing.
  const asleep = decideUpgrade({ preflight: busy, watching: 0, hour: 4, quietHour: 4 });
  assert.equal(asleep.action, "ask");
  assert.match(asleep.action === "ask" ? asleep.detail : "", /npm run build/);

  // And a broken box is not repaired by waiting for 4am.
  const broken = decideUpgrade({
    boxFailing: "the browser could not be driven",
    preflight: busy,
    watching: 3,
    hour: 14,
    quietHour: 4,
  });
  assert.equal(broken.action, "repair");
  assert.match(broken.why, /repair rather than a risk/);
});

test("people who are here are told and can stop it, rather than asked for permission", () => {
  const decision = decideUpgrade({ preflight: quiet, watching: 2, hour: 14 });
  assert.equal(decision.action, "announce");
  assert.match(decision.why, /2 people are/);

  const alone = decideUpgrade({ preflight: quiet, watching: 1, hour: 14 });
  assert.match(alone.why, /1 person is/);

  // The message leads with the cost, not the offer: someone skimming should still learn
  // that their tabs are about to close.
  const message = upgradeMessage(decision, "the box");
  assert.match(message, /lost/);
  assert.match(message, /logins are kept/);
  assert.match(message, /"wait"/);
});

test("a protocol change is always asked about, because it can break the caller too", () => {
  const decision = decideUpgrade({
    preflight: quiet,
    watching: 0,
    hour: 4,
    quietHour: 4,
    protocolChanges: true,
  });
  assert.equal(decision.action, "ask");
  assert.match(decision.why, /protocol/);
});

test("a quiet hour is waited for, but not forever", () => {
  const waiting = decideUpgrade({ preflight: quiet, watching: 0, hour: 14, quietHour: 4 });
  assert.equal(waiting.action, "wait");
  assert.match(waiting.why, /4:00/);

  assert.equal(decideUpgrade({ preflight: quiet, watching: 0, hour: 4, quietHour: 4 }).action, "go");

  // A window the machine is never awake for is a box that never upgrades and never says
  // why, which is indistinguishable from a broken feature.
  const stale = decideUpgrade({
    preflight: quiet,
    watching: 0,
    hour: 14,
    quietHour: 4,
    waitingHours: STALE_WAIT_HOURS,
  });
  assert.equal(stale.action, "ask");
  assert.match(stale.action === "ask" ? stale.detail : "", /pick an hour/);
});

test("a box that could not be inspected is asked about, not assumed to be empty", () => {
  const decision = decideUpgrade({
    preflight: { ...quiet, unknown: "connection refused" },
    watching: 0,
    hour: 4,
  });
  // "Nothing found" and "could not look" must not reach the same conclusion — the second
  // would authorise an unattended upgrade of a box nobody could check.
  assert.equal(decision.action, "ask");
  assert.match(decision.why, /could not be inspected/);
});

test("every admin is told, and only admins", () => {
  const recipients = adminRecipients([
    { role: "admin", identities: ["feishu:ou_chris"] },
    { role: "driver", identities: ["feishu:ou_someone"] },
    { role: "viewer", identities: ["telegram:9"] },
    { role: "admin", identities: ["telegram:1", "web:abc"] },
  ]);

  // Both admins, across both channels. Nominating one would be a single point of absence:
  // they go on holiday and the box stops being upgradeable.
  assert.deepEqual(recipients, [
    { adapter: "feishu", identity: "feishu:ou_chris" },
    { adapter: "telegram", identity: "telegram:1" },
  ]);

  // A web identity has nowhere to push to; that person sees it on the page instead.
  assert.ok(!recipients.some(r => r.adapter === "web"));
});
