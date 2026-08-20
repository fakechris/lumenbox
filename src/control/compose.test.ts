/**
 * Tests for the compose allocator, with Docker substituted.
 *
 * The whole suite has to pass with no Docker on PATH — the same standard the box provisioner is held
 * to — so the container manager and the volume removal are both injected. What is checked here is
 * everything that is *not* Docker: the names, which decide whose volumes a box inherits; the
 * recreate decision; and that destroying a box really does take all three of its volumes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxConfig, BoxStatus, ContainerState } from "../box/docker.ts";
import { SqliteControlStore } from "./store.ts";
import { ComposeAllocator, containerNameFor, type ContainerManager } from "./compose.ts";

interface Call {
  containerName: string;
  action: "state" | "up" | "down";
  detail?: unknown;
  env?: string[];
}

/**
 * A fake engine: remembers which containers "exist" and records every call.
 *
 * `existing` seeds containers that were there before the control plane looked, which is the case
 * that matters — a restarted control plane, or a lost row.
 */
function fakeEngine(existing: Record<string, ContainerState> = {}) {
  const calls: Call[] = [];
  const state = { ...existing };
  const ports = new Map<string, { boxd: number; ui: number }>();
  let nextPort = 32000;

  const factory = (config: Partial<BoxConfig> | undefined): ContainerManager => {
    const containerName = String(config?.containerName);
    return {
      async state(): Promise<ContainerState> {
        calls.push({ containerName, action: "state" });
        return state[containerName] ?? "missing";
      },
      async status(): Promise<BoxStatus> {
        // Ports move on restart in reality, so the fake moves them too — otherwise a test would
        // pass against a fake that is kinder than Docker.
        const current = state[containerName] ?? "missing";
        if (current !== "running") return { state: current, containerName };
        const port = ports.get(containerName);
        return {
          state: "running",
          containerName,
          boxdUrl: `http://127.0.0.1:${port?.boxd}`,
          uiUrl: `http://127.0.0.1:${port?.ui}`,
        };
      },
      async up(options): Promise<{ status: BoxStatus }> {
        calls.push({
          containerName,
          action: "up",
          detail: options,
          env: config?.runArgs,
        });
        state[containerName] = "running";
        // Two distinct ephemeral ports, which is the thing a second tenant on one host needs. A
        // fresh pair on every `up`, because that is what Docker does — and it is exactly what made
        // the stored URL go stale.
        const boxdPort = nextPort++;
        const uiPort = nextPort++;
        ports.set(containerName, { boxd: boxdPort, ui: uiPort });
        return {
          status: {
            state: "running",
            containerName,
            boxdUrl: `http://127.0.0.1:${boxdPort}`,
            uiUrl: `http://127.0.0.1:${uiPort}`,
          },
        };
      },
      async down(options): Promise<void> {
        calls.push({ containerName, action: "down", detail: options });
        state[containerName] = options?.remove === true ? "missing" : "exited";
      },
    };
  };

  return { factory, calls, state, ports };
}

function fixture(existing?: Record<string, ContainerState>) {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-compose-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  const engine = fakeEngine(existing);
  const removed: string[] = [];
  const allocator = new ComposeAllocator(store, {
    image: "agentbox/box:test",
    managerFactory: engine.factory,
    removeVolume: async name => {
      removed.push(name);
    },
  });
  return {
    store,
    allocator,
    engine,
    removed,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a tenant name becomes a container name that is safe, stable and unique", () => {
  const name = (tenantName: string, tenantId = "tenant-1") =>
    containerNameFor("agentbox", tenantName, tenantId);

  assert.match(name("Acme"), /^agentbox-acme-[0-9a-f]{8}$/);
  assert.match(name("Acme Corp"), /^agentbox-acme-corp-[0-9a-f]{8}$/);
  // A name is where a tenant's input reaches a command line. Replaced, not escaped.
  assert.match(name("a; rm -rf /"), /^agentbox-a-rm-rf-[0-9a-f]{8}$/);
  assert.match(name("  spaced  "), /^agentbox-spaced-[0-9a-f]{8}$/);

  // The id, not the name, decides the suffix — because the readable part is lossy in both
  // directions and the *volumes* are named from this string. "Acme Inc" and "Acme-Inc" flatten to
  // the same thing, and so do two names sharing a forty-character prefix; without the id,
  // allocating the second tenant recreated the first tenant's container against the first tenant's
  // work volume, handing over their files and their logged-in browser.
  assert.notEqual(name("Acme Inc", "tenant-1"), name("Acme-Inc", "tenant-2"));
  assert.notEqual(
    name(`${"a".repeat(40)}-one`, "tenant-1"),
    name(`${"a".repeat(40)}-two`, "tenant-2")
  );
  assert.equal(name("Acme", "tenant-1"), name("Acme", "tenant-1"), "stable across restarts");

  // A name Docker cannot hold is not a tenant we refuse. Refusing would mean a system that only
  // serves people whose company name is spelt in ASCII.
  assert.match(name("北京公司"), /^agentbox-t[0-9a-f]{8}$/);
  assert.notEqual(name("北京公司", "tenant-1"), name("上海公司", "tenant-2"));
  assert.match(name("🚀"), /^agentbox-t[0-9a-f]{8}$/);

  // Truncation must not leave a trailing dash before the suffix, which Docker rejects.
  const long = name(`${"a".repeat(38)} corp`);
  assert.ok(!long.includes("--"), `${long} must not contain an empty segment`);
  assert.ok(!long.endsWith("-"));
});

test("two tenants get two containers, two volume sets and two ports", async () => {
  const { store, allocator, engine, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const beta = store.upsertTenant({ name: "beta" });

    const one = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const two = await allocator.allocate(beta.id, { image: "agentbox/box:test" });

    assert.equal(one.externalId, containerNameFor("agentbox", "acme", acme.id));
    assert.equal(two.externalId, containerNameFor("agentbox", "beta", beta.id));
    assert.notEqual(one.uiUrl, two.uiUrl, "two boxes cannot share the UI port");
    assert.notEqual(one.boxdUrl, two.boxdUrl);
    assert.notEqual(one.tokens.ui, two.tokens.ui, "one UI token per box, not one per fleet");
    assert.notEqual(one.tokens.box, two.tokens.box);

    // Volumes are derived from the container name by BoxManager, so distinct names is the whole
    // guarantee that one tenant cannot read another's work.
    assert.notEqual(one.externalId, two.externalId);

    // And the store agrees with what was created, which is what survives a restart.
    assert.equal(store.boxForTenant(acme.id)?.uiUrl, one.uiUrl);
    assert.equal(store.boxForTenant(beta.id)?.uiUrl, two.uiUrl);
    assert.equal(engine.state[containerNameFor("agentbox", "acme", acme.id)], "running");
    assert.equal(engine.state[containerNameFor("agentbox", "beta", beta.id)], "running");
  } finally {
    cleanup();
  }
});

test("a container left over from a previous life is recreated, not adopted", async () => {
  // The tenant is created first, because its id is part of the container's name now.
  const seed = fixture();
  const acme = seed.store.upsertTenant({ name: "acme" });
  seed.cleanup();

  const { store, allocator, engine, cleanup } = fixture({
    [containerNameFor("agentbox", "acme", acme.id)]: "running",
  });
  try {
    store.upsertTenant({ id: acme.id, name: "acme" });
    await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    const up = engine.calls.find(call => call.action === "up");
    // Adopting it would leave a box whose baked-in token is not the one just issued, so every call
    // to it would come back Unauthorized with nothing pointing at the cause. Recreating keeps the
    // volumes, which is where the tenant's work is.
    assert.deepEqual(up?.detail, { recreate: true, onOutput: undefined });
  } finally {
    cleanup();
  }
});

test("a fresh tenant's box is not recreated", async () => {
  const { store, allocator, engine, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const up = engine.calls.find(call => call.action === "up");
    assert.ok(up, "the container was brought up");
    assert.equal((up.detail as { recreate?: boolean }).recreate, false);
  } finally {
    cleanup();
  }
});

test("stopping keeps the container and the volumes; destroying takes all three", async () => {
  const { store, allocator, engine, removed, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    await allocator.stop(handle);
    assert.deepEqual(
      engine.calls.filter(call => call.action === "down").map(call => call.detail),
      [{ remove: false }],
      "stop is reversible: the container is kept"
    );
    assert.deepEqual(removed, [], "stop never touches a volume");
    assert.equal(store.getBox(handle.id)?.state, "stopped");

    await allocator.destroy(handle);
    assert.deepEqual(
      removed,
      ["work", "config", "hostd"].map(
        suffix => `${containerNameFor("agentbox", "acme", acme.id)}-${suffix}`
      ),
      "all three volumes go, or the next box with this name inherits them"
    );
    assert.equal(store.getBox(handle.id)?.state, "gone");
    // The row stays: it is how anyone learns later that this tenant had a box and it was taken.
    assert.equal(store.boxForTenant(acme.id), undefined, "and the slot is free again");
  } finally {
    cleanup();
  }
});

test("a volume that cannot be removed is loud, not swallowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-compose-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  try {
    const engine = fakeEngine();
    const allocator = new ComposeAllocator(store, {
      image: "agentbox/box:test",
      managerFactory: engine.factory,
      removeVolume: async name => {
        if (name.endsWith("-config")) throw new Error("volume is in use");
      },
    });
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    // A leftover volume is worse than a failed destroy: the next box for this tenant name would
    // pick it up and hand one tenant's browser sessions to their replacement.
    await assert.rejects(allocator.destroy(handle), /volumes remain/);
    assert.notEqual(
      store.getBox(handle.id)?.state,
      "gone",
      "a box whose volumes survived is not gone, and the state must not claim it is"
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restarting a box keeps its volumes and says so in the audit", async () => {
  const { store, allocator, engine, removed, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    await allocator.restart(handle);

    assert.deepEqual(removed, [], "restart is not destroy");
    assert.equal(
      engine.calls.filter(call => call.action === "down").length,
      1,
      "stopped once, then brought back up"
    );
    assert.equal(store.getBox(handle.id)?.state, "ready");
    assert.ok(store.recentAudit().some(row => row.action === "restart"));
  } finally {
    cleanup();
  }
});

test("provider configuration reaches the box as environment", async () => {
  const { store, allocator, engine, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    await allocator.allocate(acme.id, {
      image: "agentbox/box:test",
      env: { AGENTBOX_PROVIDER: "minimax", AGENTBOX_COMPACT_AT_TOKENS: "40000" },
    });
    const up = engine.calls.find(call => call.action === "up");
    assert.deepEqual(up?.env, [
      "--env",
      "AGENTBOX_PROVIDER=minimax",
      "--env",
      "AGENTBOX_COMPACT_AT_TOKENS=40000",
    ]);
  } finally {
    cleanup();
  }
});

test("a restart moves the ports, and reconcile corrects the store", async () => {
  const { store, allocator, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const original = handle.boxdUrl;

    // What `docker restart` does to a container published on an ephemeral port. Without reconcile
    // the stored URL points at a port nothing listens on: the collector marks a healthy box
    // unreachable forever and the gateway serves a permanent 502. Measured on a real box, which
    // moved from host port 32855 to 32857 while the store kept 32855.
    await allocator.restart(handle);
    const afterRestart = store.getBox(handle.id)!;
    assert.notEqual(afterRestart.boxdUrl, original, "the fake moves ports, as Docker does");
    assert.equal(afterRestart.state, "ready");

    // And a stale handle can be corrected by asking, which is what the collector does before it
    // writes a box off.
    const stale = { ...handle, boxdUrl: original, uiUrl: handle.uiUrl };
    const corrected = await allocator.reconcile(stale);
    assert.equal(corrected?.boxdUrl, afterRestart.boxdUrl);
    assert.ok(
      store.recentAudit().some(row => row.action === "reconcile.moved"),
      "a box that moved is worth an audit row: it explains a gap in metering"
    );
  } finally {
    cleanup();
  }
});

test("reconcile calls a vanished container gone, and a failed lookup nothing", async () => {
  const { store, allocator, engine, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const handle = await allocator.allocate(acme.id, { image: "agentbox/box:test" });

    // Someone removed it by hand. The row has to say so, or the tenant can never be given another.
    delete engine.state[containerNameFor("agentbox", "acme", acme.id)];
    assert.equal(await allocator.reconcile(handle), undefined);
    assert.equal(store.getBox(handle.id)?.state, "gone");
    assert.equal(store.boxForTenant(acme.id), undefined, "the slot is free again");
  } finally {
    cleanup();
  }
});

test("a Docker engine that is down does not condemn every box", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-compose-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  try {
    const engine = fakeEngine();
    const acme = store.upsertTenant({ name: "acme" });
    const working = new ComposeAllocator(store, {
      image: "agentbox/box:test",
      managerFactory: engine.factory,
      removeVolume: async () => {},
    });
    const handle = await working.allocate(acme.id, { image: "agentbox/box:test" });

    // The engine itself is unreachable, so the lookup throws rather than reporting absence. Marking
    // every box `gone` on the strength of a failed question would destroy the fleet's record at the
    // exact moment nothing can be checked.
    const blind = new ComposeAllocator(store, {
      image: "agentbox/box:test",
      managerFactory: () => ({
        async state() {
          throw new Error("Cannot connect to the Docker daemon");
        },
        async status() {
          throw new Error("Cannot connect to the Docker daemon");
        },
        async up() {
          throw new Error("Cannot connect to the Docker daemon");
        },
        async down() {},
      }),
      removeVolume: async () => {},
    });
    const result = await blind.reconcile(handle);
    assert.equal(result?.boxdUrl, handle.boxdUrl, "nothing changed");
    assert.equal(store.getBox(handle.id)?.state, "ready", "and nothing was condemned");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});


test("losing an allocation race does not destroy the winner's container", async () => {
  // A container's name is derived from its tenant, so two racers create the *same* one. The loser
  // then tore down "its" container — which was the winner's — taking all three volumes with it, and
  // both callers came back holding a handle to something that no longer existed. A tenant's whole
  // work volume, deleted by a duplicate request.
  const { store, allocator, engine, removed, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const spec = { image: "agentbox/box:test" };

    const [first, second] = await Promise.all([
      allocator.allocate(acme.id, spec),
      allocator.allocate(acme.id, spec),
    ]);

    assert.equal(first.id, second.id, "one box, whichever of them won");
    assert.deepEqual(removed, [], "no volumes were removed");
    assert.ok(
      !engine.calls.some(call => call.action === "down"),
      `nothing was torn down, got ${JSON.stringify(engine.calls.map(call => call.action))}`
    );
    assert.equal(engine.state[first.externalId], "running", "and the container is still up");

    // And there is exactly one box row: the slot is single, which is what makes the race possible
    // in the first place.
    assert.equal(store.boxForTenant(acme.id)?.id, first.id);
  } finally {
    cleanup();
  }
});
