/**
 * Tests for the collector and the meter.
 *
 * The claims that matter are about arithmetic under failure: that a collector which dies mid-sweep
 * and re-reads does not double-bill, that it catches up rather than losing an outage, that one dead
 * box does not stop metering for everyone, and that a box which recovers is un-marked without anyone
 * intervening.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteControlStore } from "./store.ts";
import { Collector, meterTenants } from "./collector.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-collector-"));
  const store = new SqliteControlStore({ path: join(dir, "control.db") });
  return {
    store,
    /** Creates a tenant and a box, and returns both ids. */
    add(name: string, quota?: Record<string, unknown>) {
      const tenant = store.upsertTenant({ name, quota });
      const box = store.createBox({
        id: `box-${name}`,
        tenantId: tenant.id,
        allocatorKind: "compose",
        externalId: `agentbox-${name}`,
        boxdUrl: `http://box-${name}:1337`,
        uiUrl: `http://box-${name}:7777`,
        state: "ready",
        image: "agentbox/box:test",
        createdAt: new Date().toISOString(),
      });
      store.putToken(box.id, "ui", `ui-token-${name}`);
      return { tenantId: tenant.id, boxId: box.id };
    },
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface FakeBox {
  /** Undefined means the box does not answer at all. */
  health?: { degraded?: boolean; crashes?: unknown };
  /** Every record the box has, from seq 1. The fake honours `?since=` like the real one. */
  usage?: { seq: number; tokens: number }[];
  usageStatus?: number;
}

/**
 * A fake fleet: one entry per box name, honouring the cursor.
 *
 * `requests` records every URL, which is how the cursor's behaviour is checked — the interesting
 * property is not what came back but what was asked for.
 */
function fakeFleet(boxes: Record<string, FakeBox>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const name = /box-([a-z0-9-]+)/.exec(url)?.[1] ?? "";
    const box = boxes[name];

    if (url.includes("/health")) {
      if (box?.health === undefined) throw new Error("connection refused");
      return new Response(
        JSON.stringify({
          display: ":1",
          uptime_seconds: 100,
          crashes: box.health.crashes ?? [],
          desktop_health: [
            { index: 1, degraded: box.health.degraded === true, components: [] },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url.includes("/api/usage")) {
      // The real box gates this endpoint, so the token has to be right or the test proves nothing.
      const authorization = (init?.headers as Record<string, string>)?.authorization ?? "";
      if (authorization !== `Bearer ui-token-${name}`) {
        return new Response("unauthorized", { status: 401 });
      }
      if (box?.usageStatus !== undefined && box.usageStatus !== 200) {
        return new Response("no", { status: box.usageStatus });
      }
      const since = Number(new URL(url).searchParams.get("since") ?? 0);
      const records = (box?.usage ?? [])
        .filter(record => record.seq > since)
        .map(record => ({
          seq: record.seq,
          at: `2026-08-19T10:00:${String(record.seq).padStart(2, "0")}.000Z`,
          agentId: "agent-1",
          model: "MiniMax-M3",
          inputTokens: record.tokens,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }));
      return new Response(JSON.stringify({ records }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

test("a sweep records health, marks it seen, and separates degraded from ok", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    add("beta");
    const fleet = fakeFleet({
      acme: { health: {} },
      beta: { health: { degraded: true, crashes: [{ process: "picom", count: 9 }] } },
    });
    const collector = new Collector({ store, fetchImpl: fleet.fetchImpl });

    const result = await collector.sweep();
    assert.equal(result.boxes, 2);
    assert.equal(result.healthy, 1);
    assert.equal(result.degraded, 1, "a degraded box is not counted as healthy");
    assert.equal(result.unreachable, 0);

    // The distinction is the point: a box with an abandoned compositor still serves a screen, and a
    // dashboard that collapsed these into one boolean would be lying about it.
    assert.equal(store.latestHealth("box-acme")?.degraded, false);
    assert.equal(store.latestHealth("box-beta")?.degraded, true);
    assert.deepEqual(store.latestHealth("box-beta")?.crashes, [{ process: "picom", count: 9 }]);
    assert.ok(store.getBox("box-acme")?.lastSeenAt !== undefined);
  } finally {
    cleanup();
  }
});

test("usage is pulled with a cursor, and re-reading a page cannot double-bill", async () => {
  const { store, add, cleanup } = fixture();
  try {
    const { tenantId } = add("acme");
    const fleet = fakeFleet({
      acme: { health: {}, usage: [1, 2, 3].map(seq => ({ seq, tokens: 100 })) },
    });
    const collector = new Collector({ store, fetchImpl: fleet.fetchImpl });

    assert.equal((await collector.sweep()).usageRowsStored, 3);
    assert.equal(store.tenantTotals(tenantId).inputTokens, 300);
    assert.match(fleet.requests.at(-1) ?? "", /since=0/, "the first sweep asks from the beginning");

    // Second sweep, nothing new: the cursor moved, so the box is asked only for what follows.
    assert.equal((await collector.sweep()).usageRowsStored, 0);
    assert.match(fleet.requests.at(-1) ?? "", /since=3/, "the cursor advanced");
    assert.equal(store.tenantTotals(tenantId).inputTokens, 300, "nothing was counted twice");

    // The box produces more while the collector is away, and it catches up rather than losing it.
    fleet.requests.length = 0;
    const more = new Collector({
      store,
      fetchImpl: fakeFleet({
        acme: { health: {}, usage: [1, 2, 3, 4, 5].map(seq => ({ seq, tokens: 100 })) },
      }).fetchImpl,
    });
    assert.equal((await more.sweep()).usageRowsStored, 2, "only the new records were stored");
    assert.equal(store.tenantTotals(tenantId).inputTokens, 500);
  } finally {
    cleanup();
  }
});

test("a fresh collector resumes from the store rather than re-reading everything", async () => {
  const { store, add, cleanup } = fixture();
  try {
    const { tenantId } = add("acme");
    const usage = [1, 2, 3, 4].map(seq => ({ seq, tokens: 50 }));

    await new Collector({ store, fetchImpl: fakeFleet({ acme: { health: {}, usage } }).fetchImpl })
      .sweep();
    assert.equal(store.tenantTotals(tenantId).records, 4);

    // A restarted collector keeps no memory of its own. The cursor lives in the store precisely so
    // that this is a resume and not a replay.
    const fleet = fakeFleet({ acme: { health: {}, usage } });
    const restarted = new Collector({ store, fetchImpl: fleet.fetchImpl });
    assert.equal((await restarted.sweep()).usageRowsStored, 0);
    assert.match(fleet.requests.at(-1) ?? "", /since=4/);
    assert.equal(store.tenantTotals(tenantId).records, 4);
  } finally {
    cleanup();
  }
});

test("one dead box does not stop metering for anyone else", async () => {
  const { store, add, cleanup } = fixture();
  try {
    const acme = add("acme");
    add("dead");
    const fleet = fakeFleet({
      acme: { health: {}, usage: [{ seq: 1, tokens: 1000 }] },
      // `dead` has no health entry, so the fake throws — as a refused connection does.
    });
    const lines: string[] = [];
    const collector = new Collector({
      store,
      fetchImpl: fleet.fetchImpl,
      failuresBeforeUnreachable: 2,
      log: line => lines.push(line),
    });

    const first = await collector.sweep();
    assert.equal(first.healthy, 1, "the live box was still collected");
    assert.equal(first.unreachable, 1);
    assert.equal(store.tenantTotals(acme.tenantId).inputTokens, 1000);
    // One miss is not a verdict: a restart or a slow moment must not mark a box.
    assert.equal(store.getBox("box-dead")?.state, "ready");

    await collector.sweep();
    assert.equal(store.getBox("box-dead")?.state, "unreachable", "repeated silence is");
    assert.ok(store.recentAudit().some(row => row.action === "mark.unreachable"));
    assert.equal(store.latestHealth("box-dead")?.ok, false);
  } finally {
    cleanup();
  }
});

test("a box that comes back is un-marked without anyone intervening", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    const down = new Collector({
      store,
      fetchImpl: fakeFleet({}).fetchImpl,
      failuresBeforeUnreachable: 1,
    });
    await down.sweep();
    assert.equal(store.getBox("box-acme")?.state, "unreachable");

    // Otherwise a transient network fault becomes a box nobody ever un-marks, and the reaper keeps
    // restarting something that is fine.
    const up = new Collector({ store, fetchImpl: fakeFleet({ acme: { health: {} } }).fetchImpl });
    const result = await up.sweep();
    assert.equal(result.healthy, 1);
    assert.equal(store.getBox("box-acme")?.state, "ready");
  } finally {
    cleanup();
  }
});

test("a healthy box whose usage cannot be read is reported, not silently skipped", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    const lines: string[] = [];
    const collector = new Collector({
      store,
      fetchImpl: fakeFleet({ acme: { health: {}, usageStatus: 500 } }).fetchImpl,
      log: line => lines.push(line),
    });
    const result = await collector.sweep();

    // A box that is up but whose spending cannot be read is a box spending money invisibly, which is
    // the exact gap R-03 exists to close. It stays healthy — it is serving — but it must be said.
    assert.equal(result.healthy, 1);
    assert.equal(result.usageRowsStored, 0);
    assert.ok(
      lines.some(line => line.includes("usage unavailable")),
      `expected a warning, got ${JSON.stringify(lines)}`
    );
  } finally {
    cleanup();
  }
});

test("boxes that are not supposed to answer are not polled", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    add("beta");
    store.setBoxState("box-beta", "stopped");
    const fleet = fakeFleet({ acme: { health: {} }, beta: { health: {} } });
    const collector = new Collector({ store, fetchImpl: fleet.fetchImpl });

    const result = await collector.sweep();
    // Polling a stopped box would manufacture failures and then act on them.
    assert.equal(result.boxes, 1);
    assert.ok(!fleet.requests.some(url => url.includes("box-beta")));
  } finally {
    cleanup();
  }
});

test("the meter totals per tenant and says who is over, without acting on it", async () => {
  const { store, add, cleanup } = fixture();
  try {
    const acme = add("acme", { monthlyTokens: 250 });
    const beta = add("beta", { monthlyTokens: 10_000 });
    const nolimit = add("gamma");
    const collector = new Collector({
      store,
      fetchImpl: fakeFleet({
        acme: { health: {}, usage: [1, 2, 3].map(seq => ({ seq, tokens: 100 })) },
        beta: { health: {}, usage: [{ seq: 1, tokens: 500 }] },
        gamma: { health: {}, usage: [{ seq: 1, tokens: 999_999 }] },
      }).fetchImpl,
    });
    await collector.sweep();

    const meters = meterTenants(store);
    const byName = new Map(meters.map(meter => [meter.tenantName, meter]));
    assert.equal(byName.get("acme")?.inputTokens, 300);
    assert.equal(byName.get("acme")?.overBudget, true, "300 tokens against a 250 limit");
    assert.equal(byName.get("beta")?.overBudget, false);
    // No quota is not a quota of zero. A tenant without a limit is not over it.
    assert.equal(byName.get("gamma")?.limitTokens, undefined);
    assert.equal(byName.get("gamma")?.overBudget, false);

    // Reporting only: nothing here stops a tenant, and the box is untouched by being over.
    assert.equal(store.getBox(`box-acme`)?.state, "ready");
    assert.equal(store.getTenant(acme.tenantId)?.state, "active");
    assert.ok(beta.tenantId !== nolimit.tenantId);

    // A window, because a billing period is one.
    const later = meterTenants(store, "2026-08-19T10:00:03.000Z");
    assert.equal(later.find(meter => meter.tenantName === "acme")?.records, 1);
  } finally {
    cleanup();
  }
});

test("a box whose port moved is relocated, not written off", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    // The box is alive at a new address; the store still has the old one. This is what a restart
    // leaves behind, and it is indistinguishable from death unless someone asks.
    const fleet = fakeFleet({ moved: { health: {}, usage: [{ seq: 1, tokens: 42 }] } });
    const lines: string[] = [];
    const collector = new Collector({
      store,
      fetchImpl: fleet.fetchImpl,
      failuresBeforeUnreachable: 1,
      log: line => lines.push(line),
      allocator: {
        kind: "compose" as const,
        async reconcile(handle) {
          return {
            ...handle,
            boxdUrl: "http://box-moved:1337",
            uiUrl: "http://box-moved:7777",
          };
        },
      },
    });

    const result = await collector.sweep();
    assert.equal(result.healthy, 1, "found at its new address");
    assert.equal(store.getBox("box-acme")?.state, "ready", "not written off");
    assert.ok(lines.some(line => line.includes("moved to")), `expected a note, got ${JSON.stringify(lines)}`);
  } finally {
    cleanup();
  }
});

test("a box that really is dead is still written off after relocating fails", async () => {
  const { store, add, cleanup } = fixture();
  try {
    add("acme");
    // reconcile finds nothing new — the address is right and the box is simply gone. The relocation
    // attempt must not become a way to never mark anything unreachable.
    const collector = new Collector({
      store,
      fetchImpl: fakeFleet({}).fetchImpl,
      failuresBeforeUnreachable: 1,
      allocator: {
        kind: "compose" as const,
        async reconcile(handle) {
          return handle;
        },
      },
    });
    await collector.sweep();
    assert.equal(store.getBox("box-acme")?.state, "unreachable");
  } finally {
    cleanup();
  }
});
