import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { accountedGoalCost, ModelRetries } from "./model-retries.ts";

test("recovered rounds reset consecutive failures while turn and durable work allowances remain spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-retries-"));
  try {
    const first = new ModelRetries(dir, "goal-1", 2, 3);
    const handedOff = new ModelRetries(dir, "goal-1", 2, 3);
    assert.equal(first.reserve(), true);
    assert.equal(first.attempt, 2);
    first.succeeded();
    assert.equal(first.attempt, 1);
    assert.equal(first.reserve(), true);
    first.succeeded();
    assert.equal(first.reserve(), false, "success cannot refund the turn allowance");
    assert.equal(handedOff.reserve(), true, "another executor observes earlier reservations at the shared work root");
    const resumed = new ModelRetries(dir, "goal-1", 2, 3);
    assert.equal(resumed.reserve(), false);
    resumed.succeeded();
    assert.equal(resumed.reserve(), false, "restart cannot refund the work allowance");
    assert.equal(new ModelRetries(dir, "goal-2", 2, 3).reserve(), true, "independent work has its own allowance");
    for (const ledger of readdirSync(join(dir, "model-retries"))) writeFileSync(join(dir, "model-retries", ledger), "corrupt");
    assert.throws(() => new ModelRetries(dir, "goal-1"), /JSON/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("known response costs survive restart, retain the prior reported floor and cannot be charged twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-cost-recovery-"));
  try {
    const first = new ModelRetries(dir, "goal");
    first.seedCost(100); first.recordCost("response-1", 18);
    const resumed = new ModelRetries(dir, "goal");
    resumed.seedCost(118); resumed.recordCost("response-1", 18);
    assert.equal(resumed.knownCost, 118);
    resumed.recordCost("response-2", 30);
    assert.equal(first.knownCost, 148, "another executor observes the same durable total");
    assert.equal(accountedGoalCost(148, 18, resumed), 148, "overlapping executor/verifier reports do not charge the same response twice");
    assert.equal(accountedGoalCost(100, 18), 118, "legacy callers without a durable cost ledger retain incremental accounting");
    assert.throws(() => resumed.recordCost("response-1", 19), /changed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the work allowance is counted over a day: long work is not paused for ever by its hundred-and-twentieth blip (INV-1823)", () => {
  const dir = mkdtempSync(join(tmpdir(), "model-retries-window-"));
  try {
    let now = Date.parse("2026-11-12T00:00:00Z");
    const hour = 3_600_000;
    const open = () => new ModelRetries(dir, "long-goal", 100, 3, 24 * hour, () => now);
    const first = open();
    assert.equal(first.reserve(), true); assert.equal(first.reserve(), true); assert.equal(first.reserve(), true);
    assert.equal(first.reserve(), false, "a storm inside the window is still bounded");
    assert.equal(open().reserve(), false, "and a restart inside it refunds nothing");
    now += 23 * hour;
    assert.equal(open().reserve(), false);
    now += 2 * hour;
    const later = open();
    assert.equal(later.reserve(), true, "a day on, the allowance is there again");
    assert.equal(later.exhausted, false);
    now += 25 * hour;
    // A ledger written before times were kept: its reservations take the file's last write, so they age out too.
    const legacyDir = mkdtempSync(join(tmpdir(), "model-retries-legacy-"));
    const old = new ModelRetries(legacyDir, "old-goal", 100, 2, 24 * hour, () => Date.now());
    old.reserve(); old.reserve();
    const file = join(legacyDir, "model-retries", readdirSync(join(legacyDir, "model-retries"))[0]!);
    writeFileSync(file, '{"retry":1}\n{"retry":2}\n');
    assert.equal(new ModelRetries(legacyDir, "old-goal", 100, 2, 24 * hour, () => Date.now()).exhausted, true, "just written: still counted");
    assert.equal(new ModelRetries(legacyDir, "old-goal", 100, 2, 24 * hour, () => Date.now() + 25 * hour).exhausted, false, "a day after its last write: aged out");
    rmSync(legacyDir, { recursive: true, force: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
