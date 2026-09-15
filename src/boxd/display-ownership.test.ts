/**
 * Tests for a desktop keeping its owner across a boxd restart.
 *
 * The X servers, the window manager and everything an agent opened are separate processes. They
 * survive boxd being restarted in place and are reattached to rather than recreated — but ownership
 * lived only in the daemon's memory, so the first agent to name a desktop after a restart adopted a
 * colleague's live screen, with their browser and their session on it, and locked the original out.
 *
 * A desktop that is already in the manager's map is used throughout, which is what lets these run
 * without an X server: the claim is bookkeeping, and bookkeeping is the part on test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayManager, DisplayOwnershipError } from "./displays.ts";

/** High enough that it cannot collide with a desktop a developer is actually running. */
const INDEX = 31;
const OWNER_FILE = `/tmp/agentbox-display-${INDEX}.owner`;

/** A manager with a live but unclaimed desktop already in its map. */
function withDesktop(): DisplayManager {
  const manager = new DisplayManager(() => {});
  const desktops = (manager as unknown as { desktops: Map<number, unknown> }).desktops;
  desktops.set(INDEX, { index: INDEX, display: `:${INDEX}`, owner: undefined });
  return manager;
}

test("an unclaimed desktop is free for whoever asks first", () => {
  rmSync(OWNER_FILE, { force: true });
  const manager = new DisplayManager(() => {});
  // No record and nothing in memory: a fresh container. Refusing here would mean no agent could
  // ever take a desktop at all.
  manager.assertOwner(INDEX, "anyone");
  manager.assertOwner(INDEX, undefined);
});

test("a claim survives a restart, and locks out everyone but its owner", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    assert.ok(existsSync(OWNER_FILE), "the claim is on disk, not only in this process");

    // A fresh daemon over the same still-running desktop: nothing in its map.
    const successor = new DisplayManager(() => {});
    assert.throws(
      () => successor.assertOwner(INDEX, "token-for-rex"),
      DisplayOwnershipError,
      "a colleague must not adopt a desktop that is still someone else's"
    );
    successor.assertOwner(INDEX, "token-for-ada"); // and the real owner still gets in
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("what is written down is a hash, never the owner's token", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    const written = readFileSync(OWNER_FILE, "utf8");
    // The agent has a shell as this same uid and can read this file. Storing the token would hand
    // it a colleague's desktop credential, which is a worse problem than the one being fixed.
    assert.ok(!written.includes("token-for-ada"));
    const record = JSON.parse(written) as { hash: string; at: number };
    assert.match(record.hash, /^[0-9a-f]{32}$/);
    assert.ok(record.at > 0, "and when it was last touched, which is what makes it a lease");
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});


test("a claim nobody has touched lapses, so a dead agent does not park a desktop forever", async () => {
  // A claim with no expiry is a lock, and a lock held by an agent that no longer exists is a
  // desktop nobody can ever use again — one failure turned into a permanent one, fixable only by
  // recreating the container. Found by running two agents against a box that had been up for a
  // day: both were refused their own desktops by owners that no longer existed.
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");

    // Rewrite the claim as though it were made long ago; the owner has not touched it since.
    const stale = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { hash: string; at: number };
    writeFileSync(OWNER_FILE, JSON.stringify({ ...stale, at: Date.now() - 31 * 60_000 }));

    const successor = new DisplayManager(() => {});
    successor.assertOwner(INDEX, "token-for-rex");
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("an owner that is still working keeps its desktop", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    const manager = withDesktop();
    await manager.ensure(INDEX, "token-for-ada");
    const first = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { at: number };

    // Every screenshot and every click goes through assertOwner, so working renews the lease.
    await new Promise(resolve => setTimeout(resolve, 5));
    manager.assertOwner(INDEX, "token-for-ada");
    const renewed = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { at: number };
    assert.ok(renewed.at >= first.at, "using it moves the clock");

    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "token-for-rex"),
      DisplayOwnershipError
    );
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("an unreadable or legacy lease is refused, not treated as a free desktop", () => {
  // The safer half of the two-states fix. A file we cannot parse — a torn write, or the old
  // bare-hash format — might be a live owner whose write was interrupted, so it must not read as an
  // unclaimed desktop and be handed to the next agent. This is fail-closed on purpose; atomic
  // writes mean a torn file does not happen in practice.
  rmSync(OWNER_FILE, { force: true });
  try {
    writeFileSync(OWNER_FILE, "0123456789abcdef0123456789abcdef");
    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "somebody-else"),
      DisplayOwnershipError
    );
    // An empty file — a torn rename target — is likewise not "free".
    writeFileSync(OWNER_FILE, "");
    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "somebody-else"),
      DisplayOwnershipError
    );
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("the lease is written atomically, leaving no partial file", async () => {
  // Temp-plus-rename, so a reader never sees a half-written claim — the hole that let a torn write
  // read as an unclaimed desktop.
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    const record = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { hash: string; at: number };
    assert.match(record.hash, /^[0-9a-f]{32}$/);
    // No leftover temp file beside it.
    const dir = OWNER_FILE.slice(0, OWNER_FILE.lastIndexOf("/"));
    const leftovers = readdirSync(dir).filter(
      name => name.startsWith("agentbox-display-") && name.includes(".tmp")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("a reused desktop refuses its previous owner's token", async () => {
  // The index is recycled; the token is not. Once a successor holds the desktop, the previous
  // owner presenting its old token is just another stranger — otherwise a lapsed claim would be
  // a way back into a screen that now shows someone else's session.
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    const stale = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { hash: string; at: number };
    writeFileSync(OWNER_FILE, JSON.stringify({ ...stale, at: Date.now() - 31 * 60_000 }));

    const successor = new DisplayManager(() => {});
    successor.assertOwner(INDEX, "token-for-rex");
    assert.throws(() => successor.assertOwner(INDEX, "token-for-ada"), DisplayOwnershipError);
    assert.throws(() => new DisplayManager(() => {}).assertOwner(INDEX, "token-for-ada"), DisplayOwnershipError);
    successor.assertOwner(INDEX, "token-for-rex");
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

// ── a person takes the desktop, the agent waits (INV-404) ─────────────────────────
import { UserInControlError } from "./displays.ts";

test("while a person holds the desktop, an agent's write is refused; handing back or lapsing frees it", () => {
  const manager = withDesktop();
  manager.assertAgentControls(INDEX);
  assert.equal(manager.list().find(d => d.index === INDEX)?.controller, "agent");

  const lease = manager.takeOver(INDEX, 60_000);
  assert.ok(lease.until > lease.since);
  assert.throws(() => manager.assertAgentControls(INDEX), UserInControlError);
  assert.throws(() => manager.assertAgentControls(INDEX), /USER_IN_CONTROL/);
  const shown = manager.list().find(d => d.index === INDEX);
  assert.equal(shown?.controller, "user");
  assert.ok(shown?.user_until !== undefined);

  // Taking over again renews, keeping the original start.
  const renewed = manager.takeOver(INDEX, 120_000);
  assert.equal(renewed.since, lease.since);
  assert.ok(renewed.until > lease.until);

  manager.handBack(INDEX);
  manager.assertAgentControls(INDEX);
  manager.handBack(INDEX);

  // A takeover that was never handed back lapses on its own.
  manager.takeOver(INDEX, 1);
  const desktop = (manager as unknown as { desktops: Map<number, { userControl?: { until: number } }> }).desktops.get(INDEX)!;
  desktop.userControl!.until = Date.now() - 1;
  manager.assertAgentControls(INDEX);
  assert.equal(manager.userInControl(INDEX), undefined);

  // Nothing to take over on a desktop that is not running.
  assert.throws(() => manager.takeOver(INDEX + 1, 1000), /not running/);
});


// ── the external control guard ────────────────────────────────

import { DisplayGuardError } from "./displays.ts";

const GUARD_INDEX = 30;

/** Guard tests persist to temp dirs; swept on process exit. */
const guardDirs: string[] = [];
process.on("exit", () => {
  for (const dir of guardDirs) rmSync(dir, { recursive: true, force: true });
});

/** A manager whose guard state persists to a temp dir, like production's data dir. */
function managedManager(): { manager: DisplayManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-guard-"));
  guardDirs.push(dir);
  return { manager: new DisplayManager(() => {}, dir), dir };
}

test("an unmanaged desktop refuses nothing: the unmanaged callers keep their path", () => {
  const { manager } = managedManager();
  manager.assertControl(GUARD_INDEX, {});
  manager.assertControl(GUARD_INDEX, { epoch: 1, op_token: "anything" });
  assert.equal(manager.controlEpoch(GUARD_INDEX), undefined);
  assert.equal(manager.isManaged(GUARD_INDEX), false);
});

test("an active generation binds exactly: older, missing, or self-appointed newer epochs are refused", () => {
  const { manager } = managedManager();
  manager.armControl(GUARD_INDEX, 5, "token-abc");
  assert.equal(manager.controlEpoch(GUARD_INDEX), 5);
  assert.equal(manager.isManaged(GUARD_INDEX), true);
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 5, op_token: "token-abc" }));
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 4, op_token: "token-abc" }), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, {}), DisplayGuardError, "a managed desktop requires an epoch");
  assert.throws(
    () => manager.assertControl(GUARD_INDEX, { epoch: 6, op_token: "token-abc" }),
    DisplayGuardError,
    "a generation ahead of the bound one came through an ordinary channel and is refused"
  );
});

test("the op-token projection must match when one stands", () => {
  const { manager } = managedManager();
  manager.armControl(GUARD_INDEX, 5, "token-abc");
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 5 }), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 5, op_token: "token-old" }), DisplayGuardError);
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 5, op_token: "token-abc" }));
  // A desktop armed without a token gates on the generation alone.
  manager.armControl(GUARD_INDEX + 1, 2);
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX + 1, { epoch: 2 }));
});

test("only trusted entries advance the generation; an arm older than the bound one is refused", () => {
  const { manager } = managedManager();
  manager.armControl(GUARD_INDEX, 5, "token-abc");
  manager.armControl(GUARD_INDEX, 8, "token-def");
  assert.equal(manager.controlEpoch(GUARD_INDEX), 8);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 8, op_token: "token-abc" }), DisplayGuardError);
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 8, op_token: "token-def" }));
  assert.throws(() => manager.armControl(GUARD_INDEX, 7, "token-old"), DisplayGuardError);
  // Re-arming at the same generation with no token is a retry, not a revocation: the
  // standing projection survives.
  manager.armControl(GUARD_INDEX, 8);
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 8, op_token: "token-def" }));
});

test("revocation drops the token, bumps the generation, and refuses ordinary calls until re-armed", () => {
  const { manager } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  const result = manager.revokeControl(GUARD_INDEX, "revoke-1", 12);
  assert.deepEqual(result, { epoch: 13, applied: true });
  assert.equal(manager.controlEpoch(GUARD_INDEX), 13);
  // The revoked state is not the never-armed state: ordinary calls are refused outright,
  // not silently ungated — even with a current-generation-looking attempt.
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 13, op_token: "token-A" }), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 13 }), DisplayGuardError);
  // A new projection re-arms; the desktop is live again at the new generation.
  manager.armControl(GUARD_INDEX, 14, "token-B");
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 14, op_token: "token-B" }));
});

test("a replayed or stale revocation is a no-op and cannot disturb a newer grant", () => {
  const { manager } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  assert.deepEqual(manager.revokeControl(GUARD_INDEX, "revoke-1", 12), { epoch: 13, applied: true });
  manager.armControl(GUARD_INDEX, 14, "token-B");
  // The same outbox retry arrives after B established itself: the generation no longer
  // matches, so nothing moves — and the same id is never applied twice.
  assert.deepEqual(manager.revokeControl(GUARD_INDEX, "revoke-1", 12), { epoch: 14, applied: false });
  assert.deepEqual(manager.revokeControl(GUARD_INDEX, "revoke-1", 12), { epoch: 14, applied: false });
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 14, op_token: "token-B" }));
  assert.equal(manager.controlEpoch(GUARD_INDEX), 14);
  // A revocation aimed at the CURRENT generation applies; its retry then no-ops.
  assert.deepEqual(manager.revokeControl(GUARD_INDEX, "revoke-2", 14), { epoch: 15, applied: true });
  assert.deepEqual(manager.revokeControl(GUARD_INDEX, "revoke-2", 14), { epoch: 15, applied: false });
});

test("the managed state survives a restart: unreconciled desktops refuse ordinary calls until controller re-projects", () => {
  const { manager, dir } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  manager.revokeControl(GUARD_INDEX, "revoke-1", 12);
  assert.equal(manager.controlEpoch(GUARD_INDEX), 13);

  // A fresh daemon over the same data dir: the desktop is still controller-managed, the
  // generation is still 13, and — crucially — ordinary calls are closed until the
  // trusted entries reconcile. An empty in-memory map must not read as "never managed".
  const successor = new DisplayManager(() => {}, dir);
  assert.equal(successor.isManaged(GUARD_INDEX), true);
  assert.equal(successor.controlEpoch(GUARD_INDEX), 13);
  assert.throws(() => successor.assertControl(GUARD_INDEX, { epoch: 13, op_token: "token-A" }), DisplayGuardError);
  assert.throws(() => successor.assertControl(GUARD_INDEX, {}), DisplayGuardError);

  // controller's projection at the current generation, bound to this boot, reconciles and re-arms.
  successor.armControl(GUARD_INDEX, 13, "token-C", successor.reconcileToken);
  assert.doesNotThrow(() => successor.assertControl(GUARD_INDEX, { epoch: 13, op_token: "token-C" }));
  // A stale projection older than the persisted generation is refused.
  assert.throws(() => successor.armControl(GUARD_INDEX, 12, "token-old"), DisplayGuardError);
});

test("a revocation arriving first after a restart reconciles from controller's own words", () => {
  const { manager, dir } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  const successor = new DisplayManager(() => {}, dir);
  assert.throws(() => successor.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }), DisplayGuardError);
  // controller revokes the generation it knows, bound to this boot: authoritative, so it
  // reconciles the desktop too.
  assert.deepEqual(successor.revokeControl(GUARD_INDEX, "revoke-9", 12, successor.reconcileToken), { epoch: 13, applied: true });
  assert.throws(() => successor.assertControl(GUARD_INDEX, { epoch: 13 }), DisplayGuardError, "revoked stays closed to ordinary calls");
});

test("guard persistence failure does not publish the new generation", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-guard-"));
  guardDirs.push(dir);
  const blockedPath = join(dir, "guard.json");
  writeFileSync(blockedPath, "a regular file, so the dir path is taken");
  const fileAsDir = join(dir, "guard.json", "nested");
  const manager = new DisplayManager(() => {}, fileAsDir);
  assert.throws(() => manager.armControl(GUARD_INDEX, 5, "token-A"), DisplayGuardError, "an unwritable state dir refuses to arm");
  assert.equal(manager.controlEpoch(GUARD_INDEX), undefined, "the failed arm published no generation");
  // And an unreadable state path fails closed: the desktop cannot be proven unmanaged,
  // so it reads as possibly-managed and ordinary calls stay closed until healed.
  assert.equal(manager.isManaged(GUARD_INDEX), true);
  assert.throws(() => manager.assertControl(GUARD_INDEX, {}), DisplayGuardError);
});

test("generation regression: an unreconciled desktop opens only for a projection bound to this boot", () => {
  const { manager, dir } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  const successor = new DisplayManager(() => {}, dir);
  // A delayed equal-value projection from before the restart — however legitimate it
  // once was — cannot mark itself current: no token, no reconcile.
  assert.throws(
    () => successor.armControl(GUARD_INDEX, 12),
    (error: unknown) => error instanceof DisplayGuardError && /reconcile token/.test(error.message)
  );
  assert.throws(
    () => successor.armControl(GUARD_INDEX, 12, "token-old", "not-this-boots-token"),
    (error: unknown) => error instanceof DisplayGuardError && /reconcile token/.test(error.message)
  );
  assert.throws(() => successor.assertControl(GUARD_INDEX, { epoch: 12 }), DisplayGuardError, "still closed");
  // This boot's token reconciles — tokenless is exactly what controller sent, and means it.
  successor.armControl(GUARD_INDEX, 12, undefined, successor.reconcileToken);
  assert.doesNotThrow(() => successor.assertControl(GUARD_INDEX, { epoch: 12 }));
});

test("generation regression: a corrupt guard file fails closed; recovery is token-bound, per-desktop, and persists until scope confirmation", () => {
  const { manager, dir } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  writeFileSync(join(dir, "guard.json"), "{bad json", "utf8");
  const successor = new DisplayManager(() => {}, dir);
  // The corruption must not read as "never managed": ordinary calls stay closed.
  assert.throws(() => successor.assertControl(GUARD_INDEX, {}), DisplayGuardError);
  assert.throws(() => successor.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }), DisplayGuardError);
  assert.equal(successor.isManaged(GUARD_INDEX + 1), true, "no desktop can be proven unmanaged");
  // Recovery requires this boot's token — an old projection cannot mark itself current.
  assert.throws(
    () => successor.armControl(GUARD_INDEX, 12, "token-old"),
    (error: unknown) => error instanceof DisplayGuardError && /recover/.test(error.message)
  );
  // A trusted arm persists the desktop with the partial marker: it re-opens immediately,
  // but the reboot must not read the still-unknown neighbour as unmanaged.
  successor.armControl(GUARD_INDEX, 12, "token-B", successor.reconcileToken);
  assert.doesNotThrow(() => successor.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-B" }));
  const rebooted = new DisplayManager(() => {}, dir);
  assert.equal(rebooted.isManaged(GUARD_INDEX + 1), true, "a partial file keeps the neighbour unknown");
  assert.throws(() => rebooted.assertControl(GUARD_INDEX + 1, {}), DisplayGuardError);
  // controller's trusted scope confirmation completes the recovery; only then does a boot
  // know the rest were never managed.
  rebooted.armControl(GUARD_INDEX, 12, "token-B", rebooted.reconcileToken, true);
  const finalBoot = new DisplayManager(() => {}, dir);
  assert.equal(finalBoot.isManaged(GUARD_INDEX + 1), false, "a boot over the complete file knows who is unmanaged");
  assert.doesNotThrow(() => finalBoot.assertControl(GUARD_INDEX + 1, {}));
});

test("generation regression: a failed revoke write does not poison the dedup record — the retry applies", () => {
  const { manager, dir } = managedManager();
  manager.armControl(GUARD_INDEX, 12, "token-A");
  // Make the state path unwritable, revoke, watch it refuse.
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "a regular file now");
  assert.throws(() => manager.revokeControl(GUARD_INDEX, "revoke-A", 12), DisplayGuardError);
  // The live state is untouched AND the dedup list is untouched: the disk never got
  // either half of the transaction.
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }));
  // Filesystem recovers; the same outbox retry arrives and now applies cleanly.
  rmSync(dir, { force: true });
  mkdirSync(dir);
  const result = manager.revokeControl(GUARD_INDEX, "revoke-A", 12);
  assert.deepEqual(result, { epoch: 13, applied: true });
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }), DisplayGuardError);
});

test("generation regression: a revocation that arrives before the arm leaves a tombstone", () => {
  const { manager, dir } = managedManager();
  // Nothing has ever stood here, but controller's revocation is already on its way first.
  const tombstone = manager.revokeControl(GUARD_INDEX, "revoke-early", 12);
  assert.deepEqual(tombstone, { epoch: 13, applied: true });
  assert.equal(manager.isManaged(GUARD_INDEX), true);
  // The delayed arm of the revoked generation is below the tombstone: refused.
  assert.throws(() => manager.armControl(GUARD_INDEX, 12, "token-A"), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 12, op_token: "token-A" }), DisplayGuardError);
  // A genuinely newer grant arms above the bound and is untouched.
  manager.armControl(GUARD_INDEX, 14, "token-B");
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 14, op_token: "token-B" }));
  // And the tombstone survives a restart: a late arm of the revoked generation is
  // refused on a fresh daemon over the same state.
  const rebooted = new DisplayManager(() => {}, dir);
  assert.equal(rebooted.controlEpoch(GUARD_INDEX), 14);
  assert.throws(() => rebooted.armControl(GUARD_INDEX, 12, "token-A"), DisplayGuardError);
});

test("generation regression: a revocation ahead of the local projection leaves a tombstone, before and after a reboot", () => {
  const { manager } = managedManager();
  // Local state lags: epoch 10 stands, controller's arm12 is still in flight, and the
  // revocation of 12 arrives first. The revocation targets a FUTURE grant — it must
  // still bound the generation, or the late arm resurrects an already-revoked grant.
  manager.armControl(GUARD_INDEX, 10, "synthetic-old");
  const revoke = manager.revokeControl(GUARD_INDEX, "revoke-ahead", 12);
  assert.deepEqual(revoke, { epoch: 13, applied: true });
  assert.throws(() => manager.armControl(GUARD_INDEX, 12, "synthetic-late"), DisplayGuardError);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 12, op_token: "synthetic-late" }), DisplayGuardError);
  // A genuinely newer grant arms above the tombstone and works.
  manager.armControl(GUARD_INDEX, 14, "synthetic-new");
  assert.doesNotThrow(() => manager.assertControl(GUARD_INDEX, { epoch: 14, op_token: "synthetic-new" }));

  // And the tombstone survives a restart: the late arm is refused on a fresh daemon.
  const { manager: first, dir: dir2 } = managedManager();
  first.armControl(GUARD_INDEX, 10);
  assert.deepEqual(first.revokeControl(GUARD_INDEX, "revoke-ahead-2", 12), { epoch: 13, applied: true });
  const rebooted = new DisplayManager(() => {}, dir2);
  assert.equal(rebooted.controlEpoch(GUARD_INDEX), 13);
  assert.throws(
    () => rebooted.armControl(GUARD_INDEX, 12, undefined, rebooted.reconcileToken),
    DisplayGuardError
  );
  assert.throws(() => rebooted.assertControl(GUARD_INDEX, { epoch: 12 }), DisplayGuardError);
});

test("generation regression: structurally corrupt state fails closed instead of crashing or reading unmanaged", () => {
  // Every one of these shapes must load (no boot crash) with the desktop closed —
  // arrays, null maps, null records, and wrong-typed fields alike.
  for (const state of [
    { displays: [] },
    { displays: { "3": { epoch: "bad" } } },
    { displays: null },
    { displays: { "3": null } },
    { displays: "nope" },
    [1, 2, 3],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "agentbox-guard-"));
    guardDirs.push(dir);
    writeFileSync(join(dir, "guard.json"), JSON.stringify(state), "utf8");
    const manager = new DisplayManager(() => {}, dir);
    assert.equal(manager.isManaged(3), true, `state ${JSON.stringify(state)} must fail closed`);
    assert.throws(() => manager.assertControl(3, {}), DisplayGuardError);
    // A trusted arm heals: the file is rewritten complete and the desktop re-opens.
    manager.armControl(3, 5, "tok", manager.reconcileToken, true);
    assert.doesNotThrow(() => manager.assertControl(3, { epoch: 5, op_token: "tok" }));
    const rebooted = new DisplayManager(() => {}, dir);
    assert.equal(rebooted.isManaged(4), false, "healed file knows the rest were unmanaged");
  }
});

test("committed revocation ends its human lease so the teach reaper can finish; stale revoke preserves the successor", () => {
  const { manager } = managedManager();
  const desktops = (manager as unknown as { desktops: Map<number, unknown> }).desktops;
  desktops.set(GUARD_INDEX, { index: GUARD_INDEX, display: `:${GUARD_INDEX}` });
  manager.armControl(GUARD_INDEX, 5, "token-five");
  manager.takeOver(GUARD_INDEX, 60_000);
  assert.ok(manager.userInControl(GUARD_INDEX));
  manager.revokeControl(GUARD_INDEX, "abort-five", 5);
  assert.equal(manager.userInControl(GUARD_INDEX), undefined);
  assert.throws(() => manager.assertControl(GUARD_INDEX, { epoch: 5, op_token: "token-five" }), DisplayGuardError);
  manager.armControl(GUARD_INDEX, 7, "token-seven");
  manager.takeOver(GUARD_INDEX, 60_000);
  manager.revokeControl(GUARD_INDEX, "late-five", 5);
  assert.ok(manager.userInControl(GUARD_INDEX));
});
