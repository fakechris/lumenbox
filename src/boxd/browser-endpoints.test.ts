/**
 * Tests for the per-desktop CDP endpoint registry.
 *
 * No browsers are contacted: what can be got wrong is the bookkeeping — the epoch
 * comparison order, the idempotent heartbeat, the conditional unregister, and the
 * restart reconciliation against the persisted high-water mark. The three deterministic
 * reconciliation cases from §16.1 are here verbatim: a late epoch below the high water
 * is always refused, a matching live instance is restored without a session reset, and a
 * terminated instance leaves the desktop without an endpoint until a newer epoch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserEndpointRegistry, EndpointConflictError, EndpointPersistenceError, envEndpoints } from "./browser-endpoints.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "agentbox-endpoints-"));
}

function registry(dir: string, env: NodeJS.ProcessEnv = {}): BrowserEndpointRegistry {
  return new BrowserEndpointRegistry(() => {}, dir, env, () => 1_000_000);
}

const base = { host: "renderer.test", port: 9333, generation: 2, browserInstanceId: "instance-A" };

test("a first registration is stored and resolved; boxd never mints an epoch", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    const result = reg.register({ index: 3, ...base, endpointEpoch: 11 });
    assert.equal(result.outcome, "registered");
    const resolution = reg.resolve(3);
    assert.equal(resolution.kind, "endpoint");
    if (resolution.kind === "endpoint") {
      assert.equal(resolution.endpoint.host, "renderer.test");
      assert.equal(resolution.endpoint.port, 9333);
      assert.equal(resolution.endpoint.endpointEpoch, 11);
    }
    // boxd only stores what it was told — the epoch is controller's, not bumped on this side.
    const resolution2 = reg.resolve(3);
    if (resolution2.kind === "endpoint") assert.equal(resolution2.endpoint.endpointEpoch, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same five-tuple is an idempotent refresh, not a replacement", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    reg.register({ index: 3, ...base, endpointEpoch: 11 });
    const again = reg.register({ index: 3, ...base, endpointEpoch: 11 });
    assert.equal(again.outcome, "refreshed", "an unchanged registration replay must not replace");
    const restored = reg.register({ index: 3, ...base, endpointEpoch: 11 });
    assert.equal(restored.outcome, "refreshed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older epoch is session_superseded; the same epoch from another instance is refused", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    reg.register({ index: 3, ...base, endpointEpoch: 12 });
    assert.throws(
      () => reg.register({ index: 3, ...base, endpointEpoch: 11 }),
      (error: unknown) => error instanceof EndpointConflictError && /session_superseded/.test(error.message)
    );
    assert.throws(
      () => reg.register({ index: 3, ...base, browserInstanceId: "instance-B", endpointEpoch: 12 }),
      (error: unknown) => error instanceof EndpointConflictError && /session_superseded/.test(error.message)
    );
    // Nothing about the standing registration changed.
    const resolution = reg.resolve(3);
    assert.equal(resolution.kind, "endpoint");
    if (resolution.kind === "endpoint") assert.equal(resolution.endpoint.browserInstanceId, "instance-A");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a strictly newer epoch replaces — the only outcome that resets sessions and caches", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    reg.register({ index: 3, ...base, endpointEpoch: 12 });
    const replaced = reg.register({ index: 3, host: "renderer.test", port: 9444, generation: 3, browserInstanceId: "instance-B", endpointEpoch: 13 });
    assert.equal(replaced.outcome, "replaced");
    const resolution = reg.resolve(3);
    assert.equal(resolution.kind, "endpoint");
    if (resolution.kind === "endpoint") assert.equal(resolution.endpoint.endpointEpoch, 13);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unregister is conditional on the instance id", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    reg.register({ index: 3, ...base, endpointEpoch: 12 });
    // A late unregister from a replaced instance must not delete the new registration.
    assert.throws(
      () => reg.unregister(3, "instance-B"),
      (error: unknown) => error instanceof EndpointConflictError
    );
    assert.equal(reg.resolve(3).kind, "endpoint");
    // The standing instance unregisters: the endpoint clears, the high water stands.
    const result = reg.unregister(3, "instance-A");
    assert.equal(result.cleared, true);
    assert.equal(reg.resolve(3).kind, "blocked");
    // Its own late heartbeat cannot resurrect it.
    assert.throws(
      () => reg.register({ index: 3, ...base, endpointEpoch: 12 }),
      (error: unknown) => error instanceof EndpointConflictError && /terminated/.test(error.message)
    );
    // The successor registers with a higher epoch.
    const next = reg.register({ index: 3, ...base, browserInstanceId: "instance-C", endpointEpoch: 13 });
    assert.equal(next.outcome, "registered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── restart reconciliation ───────────────────────────────

/**
 * Writes a persisted state file as a previous boxd would have left it, then boots a
 * fresh registry over it — the restart under test.
 */
function rebootWithHighWater(dir: string, epoch: number, terminated = false): BrowserEndpointRegistry {
  writeFileSync(
    join(dir, "endpoints.json"),
    `${JSON.stringify({
      displays: {
        "3": { highWaterEpoch: epoch, ...base, terminated },
      },
    })}\n`,
    "utf8"
  );
  return registry(dir);
}

test("reconciliation: a late epoch below the high water is always 409 — never accepted because the instance died", () => {
  const dir = freshDir();
  try {
    const reg = rebootWithHighWater(dir, 12);
    // The gate is closed: no usable endpoint until controller's snapshot reconciles.
    const blocked = reg.resolve(3);
    assert.equal(blocked.kind, "blocked");
    assert.throws(
      () => reg.register({ index: 3, ...base, endpointEpoch: 11 }),
      (error: unknown) => error instanceof EndpointConflictError && /session_superseded/.test(error.message)
    );
    // And again after the instance is confirmed dead — a dead instance is never grounds
    // for accepting older news.
    const dead = rebootWithHighWater(dir, 12, true);
    assert.throws(
      () => dead.register({ index: 3, ...base, endpointEpoch: 11 }),
      (error: unknown) => error instanceof EndpointConflictError && /session_superseded/.test(error.message)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation: the trusted snapshot restores at the high water; a delayed equal-epoch message does not", () => {
  const dir = freshDir();
  try {
    const reg = rebootWithHighWater(dir, 12);
    // A delayed message replaying the persisted five-tuple WITHOUT this boot's token is
    // an ordinary late registration: refused, and the gate stays closed (an
    // equal-epoch replay must not complete reconciliation on its own).
    assert.throws(
      () => reg.register({ index: 3, ...base, endpointEpoch: 12 }),
      (error: unknown) => error instanceof EndpointConflictError && /reconcile token/.test(error.message)
    );
    assert.equal(reg.externalOpsOpen(3), false, "the late message did not open the gate");
    assert.equal(reg.resolve(3).kind, "blocked");
    // controller's current heartbeat carries the token it read from this boot: restored, and
    // the restore reads as a restore — no session reset, no cache clear.
    const result = reg.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: reg.reconcileToken });
    assert.equal(result.outcome, "restored");
    assert.equal(reg.resolve(3).kind, "endpoint");
    assert.equal(reg.externalOpsOpen(3), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation: an untrusted unregister while the gate is closed is a late message, not a confirmation", () => {
  const dir = freshDir();
  try {
    const reg = rebootWithHighWater(dir, 12);
    assert.throws(
      () => reg.unregister(3, "instance-A", 12),
      (error: unknown) => error instanceof EndpointConflictError && /reconcile token/.test(error.message)
    );
    assert.equal(reg.externalOpsOpen(3), false);
    // The trusted confirmation executes, keeps the high water, and marks termination.
    const result = reg.unregister(3, "instance-A", 12, reg.reconcileToken);
    assert.equal(result.cleared, false);
    assert.equal(reg.externalOpsOpen(3), true);
    const persisted = JSON.parse(readFileSync(join(dir, "endpoints.json"), "utf8")) as {
      displays: Record<string, { highWaterEpoch: number; terminated: boolean }>;
    };
    assert.equal(persisted.displays["3"]?.highWaterEpoch, 12, "termination keeps the high water");
    assert.equal(persisted.displays["3"]?.terminated, true);
    // And the terminated instance's own heartbeat no longer restores even with a token.
    assert.throws(() => reg.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: reg.reconcileToken }), /terminated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation: a terminated instance leaves no endpoint and no restore until a newer epoch", () => {
  const dir = freshDir();
  try {
    const reg = rebootWithHighWater(dir, 12, true);
    // Same instance, same epoch, trusted — still not restored: controller confirmed the
    // termination, and the marker survives the restart.
    assert.throws(
      () => reg.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: reg.reconcileToken }),
      (error: unknown) => error instanceof EndpointConflictError && /terminated/.test(error.message)
    );
    // And without the token it is refused even earlier, as a late message.
    assert.throws(() => reg.register({ index: 3, ...base, endpointEpoch: 12 }), /reconcile token/);
    assert.equal(reg.resolve(3).kind, "blocked", "no usable endpoint until the successor registers");
    // A refusal is not a reconciliation: the gate stays closed until controller speaks with a
    // higher epoch.
    assert.equal(reg.externalOpsOpen(3), false);
    // The successor with a higher epoch registers normally — the replace outcome resets
    // nothing here (a restarted boxd holds no sessions), but it reopens the gate.
    const next = reg.register({ index: 3, ...base, browserInstanceId: "instance-C", endpointEpoch: 13, reconcileToken: reg.reconcileToken });
    assert.equal(next.outcome, "replaced");
    assert.equal(reg.externalOpsOpen(3), true);
    assert.equal(reg.resolve(3).kind, "endpoint");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconciliation: a newer epoch replaces and reopens the gate, and the high water is persisted", () => {
  const dir = freshDir();
  try {
    const reg = rebootWithHighWater(dir, 12);
    const result = reg.register({
      index: 3,
      host: "renderer.test",
      port: 9555,
      generation: 4,
      browserInstanceId: "instance-D",
      endpointEpoch: 14,
      reconcileToken: reg.reconcileToken,
    });
    assert.equal(result.outcome, "replaced");
    assert.equal(reg.externalOpsOpen(3), true);
    const persisted = JSON.parse(readFileSync(join(dir, "endpoints.json"), "utf8")) as {
      displays: Record<string, { highWaterEpoch: number; browserInstanceId: string }>;
    };
    assert.equal(persisted.displays["3"]?.highWaterEpoch, 14);
    assert.equal(persisted.displays["3"]?.browserInstanceId, "instance-D");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restarted boxd keeps the high water it had persisted before dying", () => {
  const dir = freshDir();
  try {
    const first = registry(dir);
    first.register({ index: 3, ...base, endpointEpoch: 12 });
    // Simulate the restart: a fresh registry over the same data dir.
    const second = registry(dir);
    assert.equal(second.externalOpsOpen(3), false, "the gate starts closed on persisted state");
    assert.throws(() => second.register({ index: 3, ...base, endpointEpoch: 11 }), EndpointConflictError);
    const restored = second.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: second.reconcileToken });
    assert.equal(restored.outcome, "restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence failure refuses the registration and publishes nothing", () => {
  const dir = freshDir();
  try {
    // A regular file where the data dir would be: every write fails deterministically,
    // and the unusable path degrades the registry (it cannot prove anything unmanaged).
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "file");
    const broken = registry(blocked);
    // Recovery work requires this boot's token first; without it the message is a
    // delayed one, and with it the write itself fails — either way nothing publishes.
    assert.throws(
      () => broken.register({ index: 3, ...base, endpointEpoch: 12 }),
      (error: unknown) => error instanceof EndpointConflictError
    );
    assert.throws(
      () => broken.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: broken.reconcileToken }),
      (error: unknown) => error instanceof EndpointPersistenceError
    );
    // The state path is unusable, so the box cannot prove desktop 3 unmanaged either:
    // nothing was published, and resolution fails closed rather than driving a local
    // browser on a box whose endpoint state cannot be trusted.
    assert.equal(broken.resolve(3).kind, "blocked");
    // A healthy registry over a real dir has no memory of the failed acceptance: no
    // phantom high water leaked onto disk.
    const healthy = registry(dir);
    assert.equal(healthy.externalOpsOpen(3), true);
    // And on the failed box itself a trusted retry keeps failing rather than
    // accumulating half-state: still nothing published.
    assert.throws(
      () => broken.register({ index: 3, ...base, endpointEpoch: 12, reconcileToken: broken.reconcileToken }),
      EndpointPersistenceError
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted high water is honoured across restarts even when the accepting boot could not persist a later change", () => {
  const dir = freshDir();
  try {
    const first = registry(dir);
    first.register({ index: 3, ...base, endpointEpoch: 12 }); // persisted: H=12
    // Simulate the restart: the gate is closed and a lower epoch is refused.
    const second = registry(dir);
    assert.equal(second.externalOpsOpen(3), false);
    assert.throws(() => second.register({ index: 3, ...base, endpointEpoch: 11 }), /session_superseded/);
    // The successor at a higher epoch replaces and re-persists.
    assert.equal(
      second.register({ index: 3, ...base, browserInstanceId: "instance-C", endpointEpoch: 13, reconcileToken: second.reconcileToken }).outcome,
      "replaced"
    );
    const third = registry(dir);
    assert.throws(
      () => third.register({ index: 3, ...base, browserInstanceId: "instance-C", endpointEpoch: 12 }),
      /reconcile token|session_superseded/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file is not read as a fresh system: the box fails closed until controller re-registers", () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, "endpoints.json"), '{"displays": {"3": {broken', "utf8");
    const reg = registry(dir);
    // We cannot prove desktop 4 is unmanaged, so we do not drive a local browser for it.
    assert.equal(reg.resolve(4).kind, "blocked");
    // controller's trusted snapshot re-registers display 4; the write lands with the partial
    // marker — recovery is per-desktop, and a reboot must not turn the still-unknown
    // desktop 5 into "unmanaged".
    const result = reg.register({
      index: 4,
      ...base,
      browserInstanceId: "instance-H",
      endpointEpoch: 21,
      reconcileToken: reg.reconcileToken,
    });
    assert.equal(result.outcome, "registered");
    assert.equal(reg.resolve(4).kind, "endpoint");
    assert.equal(reg.resolve(5).kind, "blocked", "one desktop's heal does not clear the unknown set");
    const rebooted = registry(dir);
    assert.equal(rebooted.resolve(5).kind, "blocked", "a reboot over a partial file keeps 5 unknown");
    // controller's trusted scope confirmation is the only thing that completes the recovery:
    // the file is rewritten complete, and the next boot knows 5 was never managed.
    rebooted.register({ index: 4, ...base, browserInstanceId: "instance-H", endpointEpoch: 21, reconcileToken: rebooted.reconcileToken, scopeComplete: true });
    const finalBoot = registry(dir);
    assert.equal(finalBoot.resolve(5).kind, "local", "a boot over the complete file knows 5 was never managed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env fallback seeds an endpoint only where controller registered nothing", () => {
  const dir = freshDir();
  try {
    const env = { BOXD_CDP_DISPLAY_5: "chrome-svc:9444", BOXD_CDP_DISPLAY_BAD: "no-port-here", BOXD_CDP_DISPLAY_99: "far:1" };
    assert.deepEqual([...envEndpoints(env).entries()], [[5, { host: "chrome-svc", port: 9444 }]]);
    const reg = registry(dir, env);
    const seeded = reg.resolve(5);
    assert.equal(seeded.kind, "endpoint");
    if (seeded.kind === "endpoint") assert.equal(seeded.endpoint.port, 9444);
    assert.equal(reg.resolve(4).kind, "local");
    // A registration supersedes the seed from then on.
    const result = reg.register({ index: 5, host: "renderer.test", port: 9666, generation: 1, browserInstanceId: "instance-E", endpointEpoch: 7 });
    assert.equal(result.outcome, "registered");
    const resolution = reg.resolve(5);
    assert.equal(resolution.kind, "endpoint");
    if (resolution.kind === "endpoint") assert.equal(resolution.endpoint.port, 9666);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registrations persist the identity; a torn state file boots empty rather than half-trusting it", () => {
  const dir = freshDir();
  try {
    const reg = registry(dir);
    reg.register({ index: 3, ...base, endpointEpoch: 12 });
    assert.ok(existsSync(join(dir, "endpoints.json")));
    // Torn write: the high-water knowledge is gone, and — worse than half-parsed live
    // state — we no longer know which desktops are unmanaged, so nothing falls back to
    // a local browser until controller re-registers (fails closed, loudly, see degraded).
    writeFileSync(join(dir, "endpoints.json"), '{"displays": {"3": {broken', "utf8");
    const rebooted = registry(dir);
    assert.equal(rebooted.externalOpsOpen(3), true, "no parseable record, no per-desktop gate to hold");
    assert.equal(rebooted.resolve(3).kind, "blocked", "but the unreadable file fails closed, not fresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generation regression: a HIGHER delayed registration without the boot token is still a late message", () => {
  const dir = freshDir();
  try {
    const first = registry(dir);
    first.register({ index: 3, ...base, endpointEpoch: 12 }); // persisted H=12
    const reboot = registry(dir);
    // controller has since allocated A13 and then moved to B14; the A13 message was delayed
    // and arrives without this boot's token. A higher epoch sorts after the high water
    // but does not prove the message is current: refused, gate stays closed.
    assert.throws(
      () => reboot.register({ index: 3, ...base, browserInstanceId: "stale-A13", endpointEpoch: 13 }),
      (error: unknown) => error instanceof EndpointConflictError && /reconcile token/.test(error.message)
    );
    assert.equal(reboot.externalOpsOpen(3), false);
    // The trusted B14 snapshot opens the gate.
    const current = reboot.register({
      index: 3,
      host: "renderer.test",
      port: 9777,
      generation: 5,
      browserInstanceId: "B14",
      endpointEpoch: 14,
      reconcileToken: reboot.reconcileToken,
    });
    assert.equal(current.outcome, "replaced");
    assert.equal(reboot.externalOpsOpen(3), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generation regression: degraded recovery is per-desktop, token-bound, and survives a reboot until scope confirmation", () => {
  const dir = freshDir();
  try {
    writeFileSync(join(dir, "endpoints.json"), '{"displays": {"3": {broken', "utf8");
    const reg = registry(dir);
    assert.equal(reg.resolve(3).kind, "blocked");
    assert.equal(reg.resolve(4).kind, "blocked");
    // Recovery work requires this boot's token: a stale epoch-1 registration without it
    // is a delayed message, not the current snapshot.
    assert.throws(
      () => reg.register({ index: 3, ...base, browserInstanceId: "stale-1", endpointEpoch: 1 }),
      (error: unknown) => error instanceof EndpointConflictError && /recover/.test(error.message)
    );
    // controller's trusted snapshot re-registers desktop 3 (epoch 1 — the lost high water
    // cannot be enforced); the write lands with the partial marker, so 3 is known again...
    const result = reg.register({ index: 3, ...base, browserInstanceId: "healed-3", endpointEpoch: 1, reconcileToken: reg.reconcileToken });
    assert.equal(result.outcome, "registered");
    assert.equal(reg.resolve(3).kind, "endpoint");
    // ...but desktop 4 stays blocked: display 3's clean write proves nothing about the
    // records the corrupt file lost — and a reboot must not forget that 4 is unknown.
    assert.equal(reg.resolve(4).kind, "blocked", "no global heal from one display's registration");
    const rebooted = registry(dir);
    assert.equal(rebooted.resolve(4).kind, "blocked", "the partial marker survives the reboot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generation regression: every structural corruption shape fails closed — loads without crashing, never reads unmanaged", () => {
  // A file this daemon wrote never looks like any of these, so each must fail closed
  // rather than read as "controller never managed" — and the boot must not crash on one.
  for (const state of [
    { unexpected: true },
    42,
    { displays: [] },
    { displays: { "3": { highWaterEpoch: "bad" } } },
    { displays: null },
    { displays: { "3": null } },
    { displays: "nope" },
    [1, 2, 3],
  ]) {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, "endpoints.json"), JSON.stringify(state), "utf8");
      const reg = registry(dir);
      assert.equal(reg.resolve(3).kind, "blocked", `state ${JSON.stringify(state)} must fail closed`);
      // A trusted registration heals the desktop and, with scope confirmation, the file.
      const result = reg.register({
        index: 3,
        ...base,
        browserInstanceId: "healed",
        endpointEpoch: 5,
        reconcileToken: reg.reconcileToken,
        scopeComplete: true,
      });
      assert.equal(result.outcome, "registered");
      assert.equal(reg.resolve(3).kind, "endpoint");
      const rebooted = registry(dir);
      assert.equal(rebooted.resolve(4).kind, "local", "the healed complete file knows 4 was unmanaged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
