/**
 * Tests for the three answers a starter skill can get.
 *
 * The marker used to record *that* a skill had been offered and not *which version*, so
 * "already there" and "already correct" were the same answer. A skill shipped broken
 * reached new boxes when it was fixed and could never reach the box that already had the
 * broken copy, and nothing said so.
 *
 * The rule this file has always protected is unchanged and now outranks everything else:
 * a person's edit is theirs. What changed is that we can tell an edit from an old copy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markerEntries,
  needsInspection,
  seedingPlan,
  skillDigest,
  starterSupersedes,
  unseededStarters,
} from "./starter-skills.ts";

const OURS = [
  { slug: "alpha", content: "# alpha\nthe fixed version\n" },
  { slug: "beta", content: "# beta\nunchanged since we wrote it\n" },
];
const OLD_ALPHA = "# alpha\nthe broken version\n";

test("the marker carries a version per slug, and an old marker still reads", () => {
  const read = markerEntries("alpha 1a2b3c4d\nbeta 5e6f7a8b\n");
  assert.equal(read.get("alpha"), "1a2b3c4d");
  assert.equal(read.size, 2);

  // Every line a pre-INV-688 marker wrote is a bare slug. Offered, version unknown.
  const older = markerEntries("alpha\nbeta\n");
  assert.equal(older.has("alpha"), true);
  assert.equal(older.get("alpha"), undefined);

  assert.equal(markerEntries(undefined).size, 0);
  assert.equal(markerEntries("\n  \n").size, 0);
});

test("a skill nobody has been offered is seeded, exactly as before", () => {
  const plan = seedingPlan({ existing: [], starters: OURS });
  assert.deepEqual(plan.seed, ["alpha", "beta"]);
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.keptLocal, []);
  // And the old entry point still answers the old question.
  assert.deepEqual(unseededStarters(undefined, [], OURS), ["alpha", "beta"]);
});

test("a skill we have since fixed, untouched in the box, is replaced", () => {
  // This is the case that did not exist before: the box has our old copy, exactly as we
  // left it, and we have a better one.
  const markerText = `alpha ${skillDigest(OLD_ALPHA)}\nbeta ${skillDigest(OURS[1]!.content)}\n`;
  assert.deepEqual(needsInspection(markerText, ["alpha", "beta"], OURS), ["alpha"], "beta needs no round trip");

  const plan = seedingPlan({
    markerText,
    existing: ["alpha", "beta"],
    starters: OURS,
    inBox: new Map([["alpha", OLD_ALPHA]]),
  });
  assert.deepEqual(plan.update, ["alpha"]);
  assert.deepEqual(plan.seed, []);
  assert.deepEqual(plan.keptLocal, []);
});

test("a skill somebody edited is left alone, and named", () => {
  const markerText = `alpha ${skillDigest(OLD_ALPHA)}\n`;
  const theirs = `${OLD_ALPHA}\nand a line the owner added\n`;
  const plan = seedingPlan({
    markerText,
    existing: ["alpha"],
    starters: OURS,
    inBox: new Map([["alpha", theirs]]),
  });
  assert.deepEqual(plan.keptLocal, ["alpha"]);
  assert.deepEqual(plan.update, [], "an edit outranks having a newer version");
});

test("an old marker with no version is treated as edited, because we cannot tell", () => {
  // The conservative reading of "we do not know what is in there" is "it is not ours to
  // replace". Every box seeded before this change is in exactly this state.
  const plan = seedingPlan({
    markerText: "alpha\n",
    existing: ["alpha"],
    starters: OURS,
    inBox: new Map([["alpha", OLD_ALPHA]]),
  });
  assert.deepEqual(plan.keptLocal, ["alpha"]);
  assert.deepEqual(plan.update, []);
  // It is still worth looking at, which is how it gets reported rather than passed over.
  assert.deepEqual(needsInspection("alpha\n", ["alpha"], OURS), ["alpha"]);
});

test("a skill we could not read is not overwritten", () => {
  // `inBox` has no entry: the read failed. We do not replace what we could not look at.
  const plan = seedingPlan({
    markerText: `alpha ${skillDigest(OLD_ALPHA)}\n`,
    existing: ["alpha"],
    starters: OURS,
    inBox: new Map(),
  });
  assert.deepEqual(plan.keptLocal, ["alpha"]);
});

test("a skill somebody deleted stays deleted, however new our version is", () => {
  // The rule this file has protected from the start. Reseeding it would be the
  // config-file-overwrite bug wearing a different coat.
  const plan = seedingPlan({
    markerText: `alpha ${skillDigest(OLD_ALPHA)}\n`,
    existing: [],
    starters: OURS,
  });
  assert.deepEqual(plan.seed, ["beta"], "beta was never offered, alpha was deleted");
  assert.deepEqual(plan.update, []);
  assert.deepEqual(plan.keptLocal, []);
});

test("a box already holding our current version is left entirely alone", () => {
  const markerText = OURS.map(one => `${one.slug} ${skillDigest(one.content)}`).join("\n");
  assert.deepEqual(needsInspection(markerText, ["alpha", "beta"], OURS), []);
  const plan = seedingPlan({ markerText, existing: ["alpha", "beta"], starters: OURS });
  assert.deepEqual(plan, { seed: [], update: [], keptLocal: [] });
});

test("a box that arrived at our version by another route is recognised, not fought", () => {
  // The marker says one thing, the file says another, and the file happens to be exactly
  // what we would write. Reporting that as an edit would name a person who did us a favour.
  const plan = seedingPlan({
    markerText: "alpha\n",
    existing: ["alpha"],
    starters: OURS,
    inBox: new Map([["alpha", OURS[0]!.content]]),
  });
  for (const list of [plan.seed, plan.update, plan.keptLocal]) assert.ok(!list.includes("alpha"));
  // beta is a separate question: never offered, so it is seeded, which is the old rule.
  assert.deepEqual(plan.seed, ["beta"]);
});

test("a skill may name its own past versions, which is how an old box gets a fix at all", () => {
  // The case this whole mechanism was built for. A box seeded before the marker carried
  // versions has a bare slug and our broken copy, and the conservative rule would leave
  // it holding a skill that cannot run. Naming the exact bytes we shipped is proof the
  // file is ours, and it is an allow-list rather than a heuristic: a version nobody
  // listed stays the owner's.
  const broken = "# alpha\nthe version we shipped and then fixed\n";
  const fixed = [{ slug: "alpha", content: "# alpha\nthe fix\n", supersedes: [skillDigest(broken)] }];

  const plan = seedingPlan({
    markerText: "alpha\n", // pre-INV-688: offered, version unknown
    existing: ["alpha"],
    starters: fixed,
    inBox: new Map([["alpha", broken]]),
  });
  assert.deepEqual(plan.update, ["alpha"]);
  assert.deepEqual(plan.keptLocal, []);

  // And an edit of that same broken version is still the owner's.
  const edited = `${broken}\nplus a line they added\n`;
  const theirs = seedingPlan({
    markerText: "alpha\n",
    existing: ["alpha"],
    starters: fixed,
    inBox: new Map([["alpha", edited]]),
  });
  assert.deepEqual(theirs.keptLocal, ["alpha"]);
  assert.deepEqual(theirs.update, []);
});

test("the daily-research-digest fix names the exact version this repository shipped broken", () => {
  // Pinned rather than described. The version of 2026-09-24 told the agent to read a host
  // path the box cannot see; the digest below is the one measured in the running box.
  const digest = starterSupersedes("daily-research-digest");
  assert.deepEqual(digest, ["5e8ec37f"]);
});
