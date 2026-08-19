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
  let nextPort = 32000;

  const factory = (config: Partial<BoxConfig> | undefined): ContainerManager => {
    const containerName = String(config?.containerName);
    return {
      async state(): Promise<ContainerState> {
        calls.push({ containerName, action: "state" });
        return state[containerName] ?? "missing";
      },
      async up(options): Promise<{ status: BoxStatus }> {
        calls.push({
          containerName,
          action: "up",
          detail: options,
          env: config?.runArgs,
        });
        state[containerName] = "running";
        // Two distinct ephemeral ports, which is the thing a second tenant on one host needs.
        const boxdPort = nextPort++;
        const uiPort = nextPort++;
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

  return { factory, calls, state, tokensSeen: (name: string) => name };
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

test("a tenant name becomes a container name that is safe and stable", () => {
  assert.equal(containerNameFor("agentbox", "Acme"), "agentbox-acme");
  assert.equal(containerNameFor("agentbox", "Acme Corp"), "agentbox-acme-corp");
  // A name is where a tenant's input reaches a command line. Replaced, not escaped.
  assert.equal(containerNameFor("agentbox", "a; rm -rf /"), "agentbox-a-rm-rf");
  assert.equal(containerNameFor("agentbox", "  spaced  "), "agentbox-spaced");

  // A name Docker cannot hold is not a tenant we refuse. Refusing would mean a system that only
  // serves people whose company name is spelt in ASCII.
  const beijing = containerNameFor("agentbox", "北京公司");
  const shanghai = containerNameFor("agentbox", "上海公司");
  assert.match(beijing, /^agentbox-t[0-9a-f]{12}$/);
  assert.notEqual(beijing, shanghai, "two such names are not the same container");
  assert.equal(beijing, containerNameFor("agentbox", "北京公司"), "and it is stable across restarts");
  assert.match(containerNameFor("agentbox", "🚀"), /^agentbox-t[0-9a-f]{12}$/);

  // Long names truncate without leaving a trailing dash, which Docker rejects.
  const long = containerNameFor("agentbox", `${"a".repeat(38)} corp`);
  assert.ok(!long.endsWith("-"), `${long} must not end in a dash`);
});

test("two tenants get two containers, two volume sets and two ports", async () => {
  const { store, allocator, engine, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const beta = store.upsertTenant({ name: "beta" });

    const one = await allocator.allocate(acme.id, { image: "agentbox/box:test" });
    const two = await allocator.allocate(beta.id, { image: "agentbox/box:test" });

    assert.equal(one.externalId, "agentbox-acme");
    assert.equal(two.externalId, "agentbox-beta");
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
    assert.equal(engine.state["agentbox-acme"], "running");
    assert.equal(engine.state["agentbox-beta"], "running");
  } finally {
    cleanup();
  }
});

test("a container left over from a previous life is recreated, not adopted", async () => {
  const { store, allocator, engine, cleanup } = fixture({ "agentbox-acme": "running" });
  try {
    const acme = store.upsertTenant({ name: "acme" });
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
    assert.equal((up?.detail as { recreate?: boolean }).recreate, false);
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
      ["agentbox-acme-work", "agentbox-acme-config", "agentbox-acme-hostd"],
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
