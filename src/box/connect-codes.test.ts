/**
 * The connection-code lifecycle (INV-434): a code is one-time, expires, is bound to this
 * installation and never listed; a registration yields a runner credential that
 * reconnects idempotently until revoked; and a revoked registration is refused, said so.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectCodeStore, installationPrefix } from "./connect-codes.ts";

test("a code is redeemed once, expires, refuses another installation's, and is never on disk or in a list", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-connect-"));
  try {
    const clock = { now: Date.parse("2026-09-14T10:00:00Z") };
    const store = new ConnectCodeStore(join(dir, "connect.json"), "box_0123456789abcdef", () => new Date(clock.now));
    const minted = store.mint({ by: "chris", name: "lab-2" });
    assert.match(minted.code, /^lbx-01234567-[A-Za-z0-9_-]{16}$/);
    assert.equal(installationPrefix("box_0123456789abcdef"), "01234567");
    assert.equal(minted.expiresAt, "2026-09-14T10:15:00.000Z");
    const listed = store.listPending();
    assert.deepEqual(listed, [{ by: "chris", mintedAt: "2026-09-14T10:00:00.000Z", expiresAt: "2026-09-14T10:15:00.000Z", name: "lab-2" }]);
    assert.ok(!readFileSync(join(dir, "connect.json"), "utf8").includes(minted.code), "the code is stored hashed");

    assert.deepEqual(store.redeem("lbx-ffffffff-somethingelse"), { ok: false, why: "wrong-installation" });
    assert.deepEqual(store.redeem("lbx-01234567-nope"), { ok: false, why: "unknown" });
    assert.deepEqual(store.redeem(minted.code), { ok: true, name: "lab-2" });
    assert.deepEqual(store.redeem(minted.code), { ok: false, why: "used" }, "one-time");
    assert.deepEqual(store.listPending(), []);

    const late = store.mint({ by: "chris" });
    clock.now += 16 * 60_000;
    assert.deepEqual(store.redeem(late.code), { ok: false, why: "expired" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a registration issues a runner credential; reconnects are the same box until revoked, and revocation is said", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-connect-"));
  try {
    const store = new ConnectCodeStore(join(dir, "connect.json"), "box_0123456789abcdef");
    const runner = store.register({ boxId: "box_lab2", name: "lab-2", version: "0.2.1" });
    assert.match(runner, /^lbxr_/);
    assert.ok(!readFileSync(join(dir, "connect.json"), "utf8").includes(runner), "the credential is stored hashed");
    const ok = store.verifyRunner(runner);
    assert.ok(ok.ok && ok.registration.boxId === "box_lab2");
    assert.deepEqual(store.verifyRunner("lbxr_nope"), { ok: false, why: "unknown" });
    assert.equal(store.stateOf("box_lab2", true), "connected");
    assert.equal(store.stateOf("box_lab2", false), "offline");
    assert.equal(store.stateOf("box_other", true), undefined);
    store.seen("box_lab2", "0.2.2");
    assert.equal(store.registrationOf("box_lab2")?.version, "0.2.2");

    assert.equal(store.revoke("box_lab2", "chris"), true);
    assert.equal(store.revoke("box_nobody", "chris"), false);
    assert.deepEqual(store.verifyRunner(runner), { ok: false, why: "revoked" });
    assert.equal(store.stateOf("box_lab2", true), "revoked", "revoked wins over answering");
    assert.equal(store.isRevoked("box_lab2"), true);

    // Survives a restart: a new store over the same file knows the revocation.
    const again = new ConnectCodeStore(join(dir, "connect.json"), "box_0123456789abcdef");
    assert.deepEqual(again.verifyRunner(runner), { ok: false, why: "revoked" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
