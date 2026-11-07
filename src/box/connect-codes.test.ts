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

test("a node credential is issued once per enrolment, hashed, replaced by the next enrolment, and refused with every box of the node once the node is revoked (INV-1697)", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-connect-node-"));
  try {
    const store = new ConnectCodeStore(join(dir, "connect.json"), "box_0123456789abcdef");
    const first = store.enrolNode({ name: "mac-studio", by: "p-ana" });
    assert.ok(first.ok);
    assert.match(first.credential, /^lbxn_[A-Za-z0-9_-]{32}$/);
    assert.ok(!readFileSync(join(dir, "connect.json"), "utf8").includes(first.credential), "stored hashed");
    assert.equal(store.verifyNode(first.credential).ok, true);
    assert.equal("credentialHash" in first.node, false, "a view never carries the hash");

    const again = store.enrolNode({ name: "mac-studio", by: "p-ana" });
    assert.ok(again.ok);
    assert.equal(again.node.id, first.node.id, "the same node, enrolled again");
    assert.deepEqual(store.verifyNode(first.credential), { ok: false, why: "unknown" }, "the credential it replaced stops working");

    store.register({ boxId: "box_a", name: "mac-studio-native", nodeId: again.node.id });
    store.register({ boxId: "box_b", name: "mac-studio-docker", nodeId: again.node.id });
    store.register({ boxId: "box_c", name: "lab", });
    assert.equal(store.nodeBox(again.node.id, "mac-studio-docker")?.boxId, "box_b");
    assert.deepEqual(store.listNodes().map(node => node.boxes.map(box => box.boxId)), [["box_a", "box_b"]]);

    assert.deepEqual(store.revokeNode(again.node.id, "p-ana"), ["box_a", "box_b"]);
    assert.deepEqual(store.verifyNode(again.credential), { ok: false, why: "revoked" });
    assert.equal(store.isRevoked("box_a") && store.isRevoked("box_b"), true, "every box on the node is cut off");
    assert.equal(store.isRevoked("box_c"), false, "and nothing else");
    assert.deepEqual(new ConnectCodeStore(join(dir, "connect.json"), "box_0123456789abcdef").revokedBoxIds(), ["box_a", "box_b"], "durable across a restart");
    assert.deepEqual(store.enrolNode({ name: "mac-studio", by: "p-ana" }), { ok: false, why: "revoked" }, "a revoked node does not sign its way back under its name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
