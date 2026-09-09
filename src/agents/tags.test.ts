/**
 * Teams.
 *
 * The rule that matters is that an agent can be in several. A person asked for this after a
 * template stamped five agents at once and the alphabetical list stopped being findable — but the
 * example they gave was an ops agent that every project uses, which a single team would have
 * forced a lie about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry, normaliseTags, MAX_TAGS } from "./registry.ts";

test("a team name is one spelling, whatever was typed", () => {
  assert.deepEqual(normaliseTags(["Editorial", "editorial ", " EDITORIAL"]), ["editorial"]);
  assert.deepEqual(normaliseTags(["content team"]), ["content-team"], "a space is a hyphen, not a second team");
  assert.deepEqual(normaliseTags(["编辑部"]), ["编辑部"], "and a team can be named in any language");
  // Junk is dropped rather than refused: this is called from a tool, and a refusal there costs a
  // turn to learn something the system can fix.
  assert.deepEqual(normaliseTags(["ops!", "", "   ", 7, null]), ["ops"]);
  assert.equal(normaliseTags(["a", "b", "c", "d", "e", "f", "g"]).length, MAX_TAGS);
  assert.deepEqual(normaliseTags(["x".repeat(80)]), [], "and a sentence is not a team name");
});

test("an agent is born with teams, keeps them, and can be in several", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-tags-"));
  try {
    const registry = new AgentRegistry(root);
    const scout = registry.create({ name: "scout", boxId: registry.box.id, tags: ["Content Team"] });
    assert.deepEqual(scout.profile.tags, ["content-team"]);

    // The case the design is for: one agent, two departments.
    const ops = registry.create({ name: "ops", boxId: registry.box.id, tags: ["content-team", "infra"] });
    assert.deepEqual(ops.profile.tags, ["content-team", "infra"]);

    // Update replaces the list, and an empty list removes it from every team.
    assert.deepEqual(registry.update(ops.id, { tags: ["infra"] }).profile.tags, ["infra"]);
    assert.equal(registry.update(ops.id, { tags: [] }).profile.tags, undefined);

    // Survives a reload: this is a profile field, not a session's idea.
    assert.deepEqual(new AgentRegistry(root).get(scout.id).profile.tags, ["content-team"]);

    // No team is a normal state, not an empty string.
    const loner = registry.create({ name: "loner", boxId: registry.box.id });
    assert.equal(loner.profile.tags, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
