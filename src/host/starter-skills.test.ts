/**
 * Tests for which starter skills a box is offered.
 *
 * The decision under test carried a real bug: seeding only into an empty directory
 * meant a starter added later — `study-a-corpus` — could never reach a box that already
 * had the original three. Written, tested, committed, absent at runtime (docs/14). The
 * decision is now a pure function precisely so these cases run without a box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { starterSkillsWithEvals, unseededStarters } from "./starter-skills.ts";
import { catalogDataDir, hubSkillSlugs } from "./catalog.ts";
import { parseSkillFile, renderSkills, skillFrom } from "./skills.ts";

const starters = [{ slug: "alpha" }, { slug: "beta" }, { slug: "gamma" }];

test("a fresh box is offered everything", () => {
  assert.deepEqual(unseededStarters(undefined, [], starters), ["alpha", "beta", "gamma"]);
});

test("a starter added after the first seeding still arrives", () => {
  // The bug this replaces: alpha and beta on disk meant gamma never got offered.
  assert.deepEqual(unseededStarters("alpha\nbeta\n", ["alpha", "beta"], starters), ["gamma"]);
});

test("a deleted starter stays deleted", () => {
  // beta was offered once and is no longer on disk: that is a decision, not a gap.
  assert.deepEqual(unseededStarters("alpha\nbeta\ngamma\n", ["alpha", "gamma"], starters), []);
});

test("a pre-marker install is only offered what it has never had", () => {
  // No marker, but skills on disk: those were offered, whatever offered them.
  assert.deepEqual(unseededStarters(undefined, ["alpha", "beta"], starters), ["gamma"]);
});

test("a torn or padded marker still reads", () => {
  assert.deepEqual(unseededStarters("  alpha  \n\n\nbeta", ["other-skill"], starters), ["gamma"]);
});

test("every skill a fresh box starts with is described in the index, not just named", () => {
  // Past the budget a skill is listed by name only, and an agent opens what it can see is
  // relevant. Adding a package that pushed a shipped one down to its name would go unnoticed.
  const skills = [
    ...starterSkillsWithEvals().map(starter => skillFrom(starter.slug, parseSkillFile(starter.content))),
    ...hubSkillSlugs().map(slug => {
      const dir = join(catalogDataDir(), "skills", slug);
      const helpers = readdirSync(dir).filter(name => name !== "SKILL.md");
      return skillFrom(slug, parseSkillFile(readFileSync(join(dir, "SKILL.md"), "utf8")), helpers);
    }),
  ].map(result => {
    assert.ok("skill" in result, "problem" in result ? result.problem : "");
    return result.skill;
  });
  const rendered = renderSkills(skills);
  assert.doesNotMatch(rendered, /more not described here because the index is full/);
});
