import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayManager } from "./displays.ts";

test("an idle managed empty desktop becomes dormant and a new demand starts a new incarnation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-resource-"));
  let now = 0, starts = 0, stops = 0;
  const manager = new DisplayManager(() => {}, dir, {
    now: () => now, idleMs: 100,
    create: async index => { starts++; return { index, display: `:${index}`, executor: { invalidateElements() {} }, detection: {} } as never; },
    capture: async () => ({ processes: [{ pid: 41, start: "100", name: "Xvfb" }] }),
    stop: async (_index, _snapshot, authorize) => { assert.ok(authorize()); stops++; return { stopped: true }; },
    adopted: () => false,
  });
  try {
    await manager.ensure(30);
    now = 101;
    await manager.reapIdle();
    assert.equal(manager.has(30), false);
    assert.equal(manager.resources().desktops[0]?.state, "dormant");
    await manager.ensure(30);
    assert.equal(starts, 2);
    assert.equal(stops, 1);
    assert.equal(manager.resources().reclaims, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture(options: { adopted?: boolean; idleMs?: number; failStop?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-resource-"));
  let now = 0, stops = 0;
  let beforeStop: (() => Promise<void>) | undefined;
  const manager = new DisplayManager(() => {}, dir, {
    now: () => now, idleMs: options.idleMs ?? 100,
    create: async index => ({ index, display: `:${index}`, executor: { invalidateElements() {} }, detection: {} }) as never,
    capture: async () => ({ processes: [{ pid: 41, start: "100", name: "Xvfb" }] }),
    stop: async (_index, _snapshot, authorize) => {
      await beforeStop?.();
      if (!authorize()) return { stopped: false };
      stops++; return options.failStop ? { stopped: false, failed: true, reason: "partial stop; process state unknown" } : { stopped: true };
    },
    adopted: () => options.adopted ?? false,
  });
  return { manager, tick: () => { now += 101; }, stops: () => stops,
    intercept: (fn: () => Promise<void>) => { beforeStop = fn; },
    dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a viewer or operation holds reclamation until its final reference closes", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(30);
    const a = f.manager.hold(30), b = f.manager.hold(30);
    f.tick(); await f.manager.reapIdle(); assert.equal(f.stops(), 0);
    a(); a(); f.tick(); await f.manager.reapIdle(); assert.equal(f.stops(), 0);
    b(); f.tick(); await f.manager.reapIdle(); assert.equal(f.stops(), 1);
  } finally { f.dispose(); }
});

test("a new request after the asynchronous process proof cancels reclamation", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(30); f.tick();
    let release!: () => void;
    f.intercept(async () => { await Promise.resolve(); release = f.manager.hold(30); });
    await f.manager.reapIdle();
    assert.equal(f.stops(), 0); assert.equal(f.manager.has(30), true);
    release();
  } finally { f.dispose(); }
});

test("pin, unknown workloads, adopted desktops and disabled reclamation retain sessions", async () => {
  for (const mode of ["pin", "workload", "adopted", "disabled", "control"] as const) {
    const f = fixture({ adopted: mode === "adopted", idleMs: mode === "disabled" ? 0 : 100 });
    try {
      await f.manager.ensure(30);
      if (mode === "pin") f.manager.pin(30, true);
      if (mode === "workload") f.manager.hold(30, true)();
      if (mode === "control") f.manager.armControl(30, 1, "projection");
      f.tick(); await f.manager.reapIdle();
      assert.equal(f.stops(), 0, mode);
      assert.ok(f.manager.resources().desktops[0]?.retained_reason, mode);
    } finally { f.dispose(); }
  }
});

test("a request arriving during startup retains its workload after startup completes", async () => {
  const f = fixture();
  try {
    const release = f.manager.hold(30, true);
    await f.manager.ensure(30); release(); f.tick();
    await f.manager.reapIdle(); assert.equal(f.stops(), 0);
    assert.match(f.manager.resources().desktops[0]!.retained_reason!, /workload/);
  } finally { f.dispose(); }
});

test("a fresh demand waits for the stop result and then starts the next incarnation", async () => {
  const f = fixture();
  try {
    await f.manager.ensure(30); f.tick();
    let finish!: () => void;
    f.intercept(() => new Promise<void>(resolve => { finish = resolve; }));
    const reap = f.manager.reapIdle();
    const demand = f.manager.ensure(30);
    finish(); await reap; await demand;
    assert.equal(f.stops(), 0, "demand invalidated the stop authorization");
    assert.equal(f.manager.has(30), true);
  } finally { f.dispose(); }
});

test("readiness renews a warm desktop without creating a dormant desktop", async () => {
  const f = fixture();
  try {
    assert.equal(await f.manager.ready(30), false);
    assert.equal(f.manager.resources().starts, 0);
    await f.manager.ensure(30);
    f.tick(); assert.equal(await f.manager.ready(30), true);
    await f.manager.reapIdle(); assert.equal(f.stops(), 0);
    f.tick(); await f.manager.reapIdle();
    assert.equal(await f.manager.ready(30), false);
    assert.equal(f.manager.resources().starts, 1);
  } finally { f.dispose(); }
});


test("invalid owner indices are refused before a persistent claim can be written", () => {
  const f = fixture();
  try {
    for (const index of [0, 33, 100000, NaN, 1.5]) assert.throws(() => f.manager.assertOwner(index, "owner"));
  } finally { f.dispose(); }
});

test("a partial stop remains failed and new demand cannot reuse an uncertain desktop", async () => {
  const f = fixture({ failStop: true });
  try {
    await f.manager.ensure(30); f.tick(); await f.manager.reapIdle();
    assert.equal(f.manager.resources().desktops[0]?.state, "failed");
    assert.equal(await f.manager.ready(30), false);
    await assert.rejects(f.manager.ensure(30), /process state is unknown/);
    f.tick(); await f.manager.reapIdle(); assert.equal(f.stops(), 1);
  } finally { f.dispose(); }
});
