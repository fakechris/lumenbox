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
import {
  adminRecipients,
  decideUpgrade,
  STALE_WAIT_HOURS,
  UPGRADE_WORD,
  upgradeMessage,
} from "./upgrade.ts";
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
  // And it offers nothing nothing implements. It used to end `Reply "wait" to postpone
  // it` with no handler for the word anywhere — the reply went in and was answered by
  // silence, which is how the next notice stops being believed too.
  assert.doesNotMatch(message, /Reply "/);
  assert.match(message, /does not postpone it/);
  assert.match(message, /agentbox box upgrade/);
});

const risky = {
  runningJobs: [],
  strayFiles: ["/home/box/report.md"],
  moreStrayFiles: false,
} satisfies Preflight;

test("the ask offers the word that is actually wired, and says what it does not do", () => {
  // The rule this file exists to hold: the message may not offer anything nothing
  // implements. `Reply "upgrade" to go ahead` had no handler anywhere, which is how
  // somebody concluded the bot could act on the box and asked it to back up the files
  // the notice had listed (2026-09-15). The word is wired now — see the manager test
  // that parses this very constant — and what it does is stated exactly.
  const decision = decideUpgrade({ preflight: risky, watching: 0, hour: 4 });
  assert.equal(decision.action, "ask");
  const message = upgradeMessage(decision, "Your box");
  assert.match(message, new RegExp(`Reply "${UPGRADE_WORD}"`));
  assert.match(message, /records your decision and nothing else/);
  // Still not a promise to upgrade now: the box is recreated by the run that reads the
  // decision, and a message that blurred those two would be the same lie in a new place.
  assert.match(message, /recreated by the next upgrade run/);
  // The file still has to be named, or the person has nothing to decide with.
  assert.match(message, /report\.md/);
  // "wait" remains unimplemented, and so remains unoffered.
  assert.doesNotMatch(upgradeMessage(decideUpgrade({ preflight: quiet, watching: 2, hour: 14 }), "the box"), /"wait"/);
});

test("a question already answered is not asked again, and the reason says so", () => {
  const asked = decideUpgrade({ preflight: risky, watching: 0, hour: 4 });
  assert.equal(asked.action, "ask", "without a decision, it asks");

  const answered = decideUpgrade({ preflight: risky, watching: 0, hour: 4, approved: true });
  assert.equal(answered.action, "go");
  // The reason has to be the true one. "Nothing would be lost" is what makes an
  // unattended upgrade defensible and it is false here — something will be lost, and a
  // person looked at the list and accepted it. That line is what explains the missing
  // file afterwards.
  assert.match(answered.why, /approved it/);
  assert.doesNotMatch(answered.why, /nothing would be lost/i);

  // The other two asks are answered too: a box that could not be inspected, and a
  // protocol change. Somebody was shown each of those and said yes.
  assert.equal(
    decideUpgrade({ preflight: { ...quiet, unknown: "connection refused" }, watching: 0, hour: 4, approved: true }).action,
    "go"
  );
  assert.equal(
    decideUpgrade({ preflight: quiet, watching: 0, hour: 4, protocolChanges: true, approved: true }).action,
    "go"
  );
});

test("an approval authorises the loss, not the moment", () => {
  // What they agreed to was destroying those files. They said nothing about interrupting
  // the two people currently watching, so that rule still runs — an approval that
  // silenced it would turn "yes, take the files" into "yes, close their tabs now".
  const watched = decideUpgrade({ preflight: risky, watching: 2, hour: 14, approved: true });
  assert.equal(watched.action, "announce");

  // And the quiet window still holds it: the timing was never the question.
  const early = decideUpgrade({ preflight: risky, watching: 0, hour: 14, quietHour: 4, approved: true });
  assert.equal(early.action, "wait");
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
