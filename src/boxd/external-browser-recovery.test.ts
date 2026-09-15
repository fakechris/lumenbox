import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, renameSync, rmSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayManager, DisplayGuardError } from "./displays.ts";
import { BrowserEndpointRegistry, EndpointConflictError } from "./browser-endpoints.ts";

const endpoint = { index: 3, host: "renderer.test", port: 9333, generation: 1, browserInstanceId: "A", endpointEpoch: 12 };

test("a crash after the durable rename cannot expose a complete file missing the registered target", t => {
  const dir = mkdtempSync(join(tmpdir(), "endpoint-commit-"));
  writeFileSync(join(dir, "endpoints.json"), JSON.stringify({ displays: {}, partial: true }));
  const registry = new BrowserEndpointRegistry(() => {}, dir, {});
  const originalRename = fs.renameSync;
  const interruptedRename = t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    originalRename(from, to);
    if (to === join(dir, "endpoints.json")) throw new Error("simulated interruption after durable rename");
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => registry.register({ ...endpoint, reconcileToken: registry.reconcileToken, scopeComplete: true }), /simulated interruption/);
  } finally {
    interruptedRename.mock.restore();
    syncBuiltinESMExports();
  }
  try {
    const reboot = new BrowserEndpointRegistry(() => {}, dir, {});
    assert.equal(reboot.resolve(3).kind, "blocked");
    assert.throws(() => reboot.register({ ...endpoint, endpointEpoch: 1, reconcileToken: reboot.reconcileToken }), EndpointConflictError);
    assert.equal(reboot.register({ ...endpoint, reconcileToken: reboot.reconcileToken }).outcome, "restored");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope recovery write failures keep targets closed and allow a successful retry", () => {
  for (const operation of ["arm", "revoke", "register"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "scope-retry-"));
    writeFileSync(join(dir, "guard.json"), JSON.stringify({ displays: {}, partial: true }));
    writeFileSync(join(dir, "endpoints.json"), JSON.stringify({ displays: {}, partial: true }));
    const guard = new DisplayManager(() => {}, dir);
    const registry = new BrowserEndpointRegistry(() => {}, dir, {});
    const run = () => {
      if (operation === "arm") return guard.armControl(3, 12, undefined, guard.reconcileToken, true);
      if (operation === "revoke") return guard.revokeControl(3, "revoke-12", 12, guard.reconcileToken, true);
      return registry.register({ ...endpoint, reconcileToken: registry.reconcileToken, scopeComplete: true });
    };
    renameSync(dir, `${dir}-saved`);
    writeFileSync(dir, "not a directory");
    try {
      assert.throws(run, /persist/);
      assert.equal(guard.isManaged(3), true);
      assert.throws(() => guard.assertControl(3, {}), DisplayGuardError);
      assert.equal(registry.resolve(3).kind, "blocked");
    } finally {
      rmSync(dir, { force: true });
      renameSync(`${dir}-saved`, dir);
    }
    try {
      run();
      if (operation === "register") {
        const reboot = new BrowserEndpointRegistry(() => {}, dir, {});
        assert.equal(reboot.resolve(4).kind, "local");
        assert.equal(reboot.register({ ...endpoint, reconcileToken: reboot.reconcileToken }).outcome, "restored");
      } else {
        const reboot = new DisplayManager(() => {}, dir);
        assert.equal(reboot.isManaged(4), false);
        assert.equal(reboot.controlEpoch(3), operation === "arm" ? 12 : 13);
        assert.throws(() => reboot.assertControl(3, {}), DisplayGuardError);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("guard recovery rejects malformed partial markers and wrong scope credentials", () => {
  for (const partial of ["true", 1, null]) {
    const dir = mkdtempSync(join(tmpdir(), "guard-corrupt-"));
    try {
      writeFileSync(join(dir, "guard.json"), JSON.stringify({ displays: {}, partial }));
      const guard = new DisplayManager(() => {}, dir);
      assert.equal(guard.isManaged(3), true);
      assert.throws(() => guard.assertControl(3, {}), DisplayGuardError);
      assert.throws(() => guard.armControl(3, 12, undefined, "wrong-boot", true), DisplayGuardError);
      guard.armControl(3, 12, undefined, guard.reconcileToken);
      assert.equal(new DisplayManager(() => {}, dir).isManaged(4), true);
      guard.revokeControl(3, "old-10", 10, guard.reconcileToken, true);
      const reboot = new DisplayManager(() => {}, dir);
      assert.equal(reboot.isManaged(4), false);
      assert.equal(reboot.controlEpoch(3), 12);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("corrupt partial flags and mixed valid/invalid records remain recoverable and closed", () => {
  for (const state of [
    ...["true", 1, null].map(partial => ({ displays: {}, partial })),
    { displays: { "3": { ...endpoint, highWaterEpoch: 12, terminated: false }, "4": null } },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-corrupt-"));
    try {
      writeFileSync(join(dir, "endpoints.json"), JSON.stringify(state));
      const registry = new BrowserEndpointRegistry(() => {}, dir, {});
      assert.equal(registry.resolve(3).kind, "blocked");
      assert.throws(() => registry.register(endpoint), EndpointConflictError);
      registry.register({ ...endpoint, reconcileToken: registry.reconcileToken });
      assert.equal(registry.resolve(3).kind, "endpoint");
      assert.equal(new BrowserEndpointRegistry(() => {}, dir, {}).resolve(4).kind, "blocked");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a refused endpoint change cannot complete recovery for unknown desktops", () => {
  const dir = mkdtempSync(join(tmpdir(), "endpoint-scope-"));
  try {
    writeFileSync(join(dir, "endpoints.json"), JSON.stringify({ displays: {}, partial: true }));
    const registry = new BrowserEndpointRegistry(() => {}, dir, {});
    registry.register({ ...endpoint, reconcileToken: registry.reconcileToken });
    assert.throws(() => registry.register({ ...endpoint, endpointEpoch: 11, reconcileToken: registry.reconcileToken, scopeComplete: true }), EndpointConflictError);
    assert.equal(registry.resolve(4).kind, "blocked");
    assert.equal(new BrowserEndpointRegistry(() => {}, dir, {}).resolve(4).kind, "blocked");
    assert.throws(() => registry.unregister(3, "another-instance", 12, registry.reconcileToken, true), EndpointConflictError);
    assert.equal(registry.resolve(4).kind, "blocked");
    assert.equal(new BrowserEndpointRegistry(() => {}, dir, {}).resolve(4).kind, "blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scope confirmation on an old revocation preserves every standing guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-scope-"));
  try {
    const manager = new DisplayManager(() => {}, dir);
    manager.armControl(3, 14, "synthetic-3");
    manager.armControl(4, 20, "synthetic-4");
    assert.deepEqual(manager.revokeControl(3, "old-12", 12, manager.reconcileToken, true), { epoch: 14, applied: false });
    assert.equal(manager.controlEpoch(3), 14);
    assert.equal(manager.controlEpoch(4), 20);
    assert.throws(() => manager.assertControl(3, {}), DisplayGuardError);
    assert.doesNotThrow(() => manager.assertControl(4, { epoch: 20, op_token: "synthetic-4" }));
    const reboot = new DisplayManager(() => {}, dir);
    assert.equal(reboot.controlEpoch(3), 14);
    assert.equal(reboot.controlEpoch(4), 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
