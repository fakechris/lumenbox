/** Team memory a person approves first (INV-1581): off changes nothing; on holds team writes until an admin decides. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import { saveConfig } from "../config.ts";
import { dedupe } from "./memory.ts";
import { dispatchTool } from "./tools.ts";
import { decideReview, forTeamTier, pendingOf, pendingReviews, teamReviewOn } from "./team-memory-review.ts";

function world() {
  const home = mkdtempSync(join(tmpdir(), "agentbox-team-review-"));
  const previous = process.env.AGENTBOX_HOME;
  process.env.AGENTBOX_HOME = home;
  const registry = new AgentRegistry(join(home, "agents"));
  const bus = new AgentBus(registry, async () => {});
  const ada = registry.create({ name: "Ada" }), bob = registry.create({ name: "Bob" });
  const remember = (agent: typeof ada, fact: string) => dispatchTool("RememberFact", { fact, scope: "team" }, { agent, registry, bus, box: undefined });
  const recall = (agent: typeof ada, search: string) => dispatchTool("Recall", { search }, { agent, registry, bus, box: undefined });
  const live = (agentId: string) => dedupe(registry.readSharedMemory(agentId)).map(record => record.text);
  return {
    registry, ada, bob, remember, recall, live,
    cleanup: () => { process.env.AGENTBOX_HOME = previous; rmSync(home, { recursive: true, force: true }); },
  };
}

test("off (the default): a team write is shared at once, as before", async () => {
  const w = world();
  try {
    assert.equal(teamReviewOn(), false, "absent means off");
    const said = await w.remember(w.ada, "the staging database is Postgres 16");
    assert.match(said.text, /Kept and shared/);
    assert.deepEqual(w.live(w.bob.id), ["the staging database is Postgres 16"]);
    assert.deepEqual(pendingReviews(w.registry.readSharedMemory()), []);
  } finally {
    w.cleanup();
  }
});

test("on: Ada's team write waits; Bob cannot read it until an admin approves; then every agent has it", async () => {
  const w = world();
  try {
    saveConfig({ teamMemoryReview: true });
    const said = await w.remember(w.ada, "invoices over 10k need Mia's sign-off");
    assert.match(said.text, /waiting for a person's approval/);
    assert.deepEqual(w.live(w.bob.id), [], "not live for Bob");
    assert.deepEqual(w.live(w.ada.id), [], "not live for Ada either: it is not anyone's memory yet");
    assert.doesNotMatch((await w.recall(w.bob, "invoices")).text, /Mia's sign-off/, "Bob's Recall does not see it");
    assert.match((await w.recall(w.ada, "")).text, /Waiting for a person's approval[\s\S]*Mia's sign-off/, "Ada is told it waits");
    assert.match((await w.remember(w.ada, "invoices over 10k need Mia's sign-off")).text, /already waiting/, "not queued twice");

    const [pending] = pendingOf(w.registry.readSharedMemory(), w.ada.id);
    assert.ok(pending !== undefined);
    const approved = decideReview(w.registry, w.ada.id, pending.version, "approved", "Chris");
    assert.equal(approved.ok, true);
    assert.deepEqual(w.live(w.bob.id), ["invoices over 10k need Mia's sign-off"], "live for Bob after approval");
    assert.match((await w.recall(w.bob, "invoices")).text, /Mia's sign-off/);
    assert.deepEqual(pendingReviews(w.registry.readSharedMemory()), [], "nothing left waiting");
    assert.equal(decideReview(w.registry, w.ada.id, pending.version, "rejected", "Chris").ok, false, "decided once");
  } finally {
    w.cleanup();
  }
});

test("on: a rejected write is never live and is no longer waiting; the decision is on record", async () => {
  const w = world();
  try {
    saveConfig({ teamMemoryReview: true });
    await w.remember(w.ada, "the prod password is in the wiki");
    const [pending] = pendingReviews(w.registry.readSharedMemory());
    assert.equal(decideReview(w.registry, w.ada.id, pending!.version, "rejected", "Chris").ok, true);
    assert.deepEqual(w.live(w.bob.id), []);
    assert.deepEqual(pendingReviews(w.registry.readSharedMemory()), []);
    const decision = w.registry.readSharedMemory().find(record => record.review?.decision === "rejected");
    assert.equal(decision?.review?.by, "Chris", "who rejected it is kept");
  } finally {
    w.cleanup();
  }
});

test("on: an agent's own tier is not reviewed", async () => {
  const w = world();
  try {
    saveConfig({ teamMemoryReview: true });
    const said = await dispatchTool("RememberFact", { fact: "I prefer short status notes" }, { agent: w.ada, registry: w.registry, bus: new AgentBus(w.registry, async () => {}), box: undefined });
    assert.match(said.text, /Kept\. It will be in your instructions/);
    assert.deepEqual(dedupe(w.registry.readMemoryRecords(w.ada.id)).map(record => record.text), ["I prefer short status notes"]);
  } finally {
    w.cleanup();
  }
});

test("forTeamTier holds only when on, and keeps the record otherwise unchanged", () => {
  const record = { at: "2026-11-05T00:00:00.000Z", kind: "fact" as const, text: "x" };
  assert.deepEqual(forTeamTier([record], false), [record]);
  const [held] = forTeamTier([record], true);
  assert.equal(held!.text, "x");
  assert.ok(held!.held !== undefined);
});
