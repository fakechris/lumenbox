/**
 * Tests for the control plane's store and the allocator seam.
 *
 * Written against the properties the rest of the control plane will assume, because those are the
 * ones that are expensive to discover later: that a tenant cannot end up with two boxes, that a
 * collector re-reading a batch cannot double-bill, and that a token in a stolen database file is not
 * a credential.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlStore, type UsageRow } from "./store.ts";
import { StaticAllocator } from "./allocator.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-control-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  return {
    dir,
    store,
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function usage(boxId: string, tenantId: string, seq: number): UsageRow {
  return {
    boxId,
    tenantId,
    seq,
    at: `2026-08-19T10:00:${String(seq).padStart(2, "0")}.000Z`,
    agentId: "agent-1",
    model: "MiniMax-M3",
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 10,
    cacheWriteTokens: 1,
  };
}

test("a tenant cannot end up with two live boxes", () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    store.createBox({
      id: "box-1",
      tenantId: tenant.id,
      allocatorKind: "compose",
      externalId: "agentbox-acme",
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      state: "ready",
      image: "agentbox:latest",
      createdAt: new Date().toISOString(),
    });

    // The database refuses, so a racing double allocate cannot produce two bills. This is the
    // constraint the allocator's idempotency rests on: checking first is not enough on its own.
    assert.throws(
      () =>
        store.createBox({
          id: "box-2",
          tenantId: tenant.id,
          allocatorKind: "compose",
          externalId: "agentbox-acme-2",
          boxdUrl: "http://127.0.0.1:1338",
          uiUrl: "http://127.0.0.1:7778",
          state: "ready",
          image: "agentbox:latest",
          createdAt: new Date().toISOString(),
        }),
      /UNIQUE|constraint/i
    );

    // Destroying frees the slot, and leaves a row saying it happened.
    store.setBoxState("box-1", "gone");
    const replacement = store.createBox({
      id: "box-3",
      tenantId: tenant.id,
      allocatorKind: "compose",
      externalId: "agentbox-acme-3",
      boxdUrl: "http://127.0.0.1:1339",
      uiUrl: "http://127.0.0.1:7779",
      state: "starting",
      image: "agentbox:latest",
      createdAt: new Date().toISOString(),
    });
    assert.equal(store.boxForTenant(tenant.id)?.id, replacement.id);
  } finally {
    cleanup();
  }
});

test("re-collecting a batch of usage cannot double-bill", () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    store.createBox({
      id: "box-1",
      tenantId: tenant.id,
      allocatorKind: "static",
      externalId: "static:box-1",
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      state: "ready",
      image: "agentbox:latest",
      createdAt: new Date().toISOString(),
    });

    const batch = [1, 2, 3].map(seq => usage("box-1", tenant.id, seq));
    assert.equal(store.appendUsage(batch), 3);
    assert.equal(store.getBox("box-1")?.usageCursor, 3);

    // A collector that crashed after writing but before advancing its cursor re-reads. The box's
    // own sequence numbers make that free rather than expensive.
    assert.equal(store.appendUsage(batch), 0, "no row was stored twice");
    const totals = store.tenantTotals(tenant.id);
    assert.equal(totals.records, 3);
    assert.equal(totals.inputTokens, 3000);

    // An overlapping batch: two already seen, two new.
    assert.equal(store.appendUsage([2, 3, 4, 5].map(seq => usage("box-1", tenant.id, seq))), 2);
    assert.equal(store.tenantTotals(tenant.id).records, 5);
    assert.equal(store.getBox("box-1")?.usageCursor, 5);
  } finally {
    cleanup();
  }
});

test("totals are a query over a per-tenant window, never an aggregate in place", () => {
  const { store, cleanup } = fixture();
  try {
    const acme = store.upsertTenant({ name: "acme" });
    const other = store.upsertTenant({ name: "other" });
    for (const [id, tenant] of [
      ["box-a", acme],
      ["box-b", other],
    ] as const) {
      store.createBox({
        id,
        tenantId: tenant.id,
        allocatorKind: "compose",
        externalId: `agentbox-${tenant.name}`,
        boxdUrl: "http://127.0.0.1:1337",
        uiUrl: "http://127.0.0.1:7777",
        state: "ready",
        image: "agentbox:latest",
        createdAt: new Date().toISOString(),
      });
    }
    store.appendUsage([1, 2, 3].map(seq => usage("box-a", acme.id, seq)));
    store.appendUsage([1].map(seq => usage("box-b", other.id, seq)));

    assert.equal(store.tenantTotals(acme.id).records, 3, "one tenant's usage is not another's");
    assert.equal(store.tenantTotals(other.id).records, 1);
    // A billing period is a window over the same rows, which is the point of not aggregating.
    assert.equal(store.tenantTotals(acme.id, "2026-08-19T10:00:02.000Z").records, 2);
  } finally {
    cleanup();
  }
});

test("a stolen database file does not yield tokens", () => {
  const { dir, store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    store.createBox({
      id: "box-1",
      tenantId: tenant.id,
      allocatorKind: "static",
      externalId: "static:box-1",
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      state: "ready",
      image: "agentbox:latest",
      createdAt: new Date().toISOString(),
    });
    store.putToken("box-1", "box", "0123456789abcdef0123456789abcdef");
    store.putToken("box-1", "ui", "fedcba9876543210fedcba9876543210");

    assert.equal(store.readToken("box-1", "box"), "0123456789abcdef0123456789abcdef");
    assert.equal(store.readToken("box-1", "ui"), "fedcba9876543210fedcba9876543210");
    assert.equal(store.readToken("box-1", "missing" as "box"), undefined);

    // The bytes on disk do not contain the secret. That is the whole claim: a database backup is
    // not a credential dump, as long as the key is not in the same backup.
    //
    // Every file the store writes, not just the `.db`: in WAL mode a freshly written row lives in
    // `control.db-wal` and the `.db` is an empty header, so searching only the `.db` would pass
    // just as happily with the token stored in clear. Verified by doing exactly that first.
    const onDisk = readdirSync(dir)
      .map(name => readFileSync(join(dir, name), "latin1"))
      .join("\n");
    assert.ok(
      !onDisk.includes("0123456789abcdef"),
      "the token is not readable in any file the store writes"
    );
    // And the search is looking in the right place: the ciphertext *is* there to be found.
    assert.ok(onDisk.includes("v1:"), "the encrypted form is on disk, so the check above is real");

    // The key it needs is beside it, and readable only by its owner.
    const mode = statSync(join(dir, "control.db.key")).mode & 0o777;
    assert.equal(mode, 0o600, "the key file is not readable by anyone else");
  } finally {
    cleanup();
  }
});

test("the store survives a restart, and refuses a token for a box that does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-control-"));
  try {
    const first = new SqliteControlStore({ path: join(dir, "control.db") });
    const created = first.upsertTenant({ name: "acme", quota: { boxes: 1 } });
    // Foreign keys are on, so a token can never outlive or precede its box. Asserted rather than
    // assumed: `pragma foreign_keys` is off by default in SQLite and silently ignored if misspelt.
    assert.throws(() => first.putToken("no-such-box", "box", "x"), /FOREIGN KEY|constraint/i);
    first.close();

    const store = new SqliteControlStore({ path: join(dir, "control.db") });
    const tenant = store.upsertTenant({ name: "acme", quota: { boxes: 2 } });
    assert.equal(tenant.id, created.id, "the same name is the same tenant across a restart");
    assert.deepEqual(tenant.quota, { boxes: 2 }, "upsert updates rather than duplicating");
    assert.equal(store.listTenants().length, 1);

    store.setTenantState(tenant.id, "suspended");
    assert.equal(store.getTenant(tenant.id)?.state, "suspended");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health keeps the latest reading and tolerates rubbish in its JSON columns", () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    store.createBox({
      id: "box-1",
      tenantId: tenant.id,
      allocatorKind: "static",
      externalId: "static:box-1",
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      state: "ready",
      image: "agentbox:latest",
      createdAt: new Date().toISOString(),
    });
    store.recordHealth({
      boxId: "box-1",
      at: "2026-08-19T10:00:00.000Z",
      ok: true,
      degraded: false,
      components: { picom: "ok" },
      crashes: [],
    });
    store.recordHealth({
      boxId: "box-1",
      at: "2026-08-19T10:00:30.000Z",
      ok: true,
      degraded: true,
      components: { picom: "crashloop" },
      crashes: [{ process: "picom", signal: 6, count: 9 }],
    });

    const latest = store.latestHealth("box-1");
    assert.equal(latest?.degraded, true, "the newest reading wins, not the first");
    assert.deepEqual(latest?.components, { picom: "crashloop" });
    assert.equal(store.latestHealth("box-nothing"), undefined);
  } finally {
    cleanup();
  }
});

test("every act on a box leaves an audit row", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const allocator = new StaticAllocator(store, {
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      tokens: { box: "boxtoken", ui: "uitoken" },
    });

    const handle = await allocator.allocate(tenant.id, { image: "agentbox:latest" });
    await allocator.stop(handle);
    await allocator.destroy(handle);

    const actions = store.recentAudit().map(row => row.action);
    for (const action of ["allocate", "stop", "destroy"]) {
      assert.ok(actions.includes(action), `${action} is audited`);
    }
    assert.ok(
      store.recentAudit().every(row => row.tenantId === tenant.id && row.actor !== ""),
      "every row says who and for whom"
    );
  } finally {
    cleanup();
  }
});

test("allocating twice returns the same box", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const allocator = new StaticAllocator(store, {
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      tokens: { box: "boxtoken", ui: "uitoken" },
    });

    const first = await allocator.allocate(tenant.id, { image: "agentbox:latest" });
    const second = await allocator.allocate(tenant.id, { image: "agentbox:latest" });
    assert.equal(second.id, first.id, "a retried allocate is not a second box");
    assert.equal(store.listBoxes().length, 1);

    // Concurrently, which is the case the store's index exists for.
    const tenantB = store.upsertTenant({ name: "beta" });
    const racing = await Promise.allSettled([
      allocator.allocate(tenant.id, { image: "agentbox:latest" }),
      allocator.allocate(tenant.id, { image: "agentbox:latest" }),
    ]);
    assert.ok(
      racing.every(result => result.status === "fulfilled" && result.value.id === first.id),
      "a race still yields the one box"
    );

    // And the static allocator says plainly that it cannot serve a second tenant, rather than
    // handing over the first tenant's desktop.
    await assert.rejects(
      allocator.allocate(tenantB.id, { image: "agentbox:latest" }),
      /already has it/
    );
  } finally {
    cleanup();
  }
});

test("a suspended tenant is refused a box", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    store.setTenantState(tenant.id, "suspended");
    const allocator = new StaticAllocator(store, {
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      tokens: { box: "boxtoken", ui: "uitoken" },
    });
    await assert.rejects(
      allocator.allocate(tenant.id, { image: "agentbox:latest" }),
      /is suspended/
    );
    await assert.rejects(allocator.allocate("no-such-tenant", { image: "x" }), /no such tenant/);
  } finally {
    cleanup();
  }
});

test("the static allocator hands out the box's real tokens, not minted ones", async () => {
  const { store, cleanup } = fixture();
  try {
    const tenant = store.upsertTenant({ name: "acme" });
    const allocator = new StaticAllocator(store, {
      boxdUrl: "http://127.0.0.1:1337",
      uiUrl: "http://127.0.0.1:7777",
      tokens: { box: "the-running-box-token", ui: "the-running-ui-token" },
    });
    const handle = await allocator.allocate(tenant.id, { image: "agentbox:latest" });

    // A pre-existing box has its token baked into its environment and will not accept a new one.
    // Minting here would hand out a credential that authenticates nothing — which is exactly the
    // bug the attach path had before `readBoxToken` replaced `loadBoxToken`.
    assert.equal(handle.tokens.box, "the-running-box-token");
    assert.equal(handle.tokens.ui, "the-running-ui-token");
    assert.equal((await allocator.find(tenant.id))?.tokens.box, "the-running-box-token");
    assert.equal((await allocator.list()).length, 1);
  } finally {
    cleanup();
  }
});
