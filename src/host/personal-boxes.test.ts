import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalQuotaFor } from "./box-quota.ts";
import { PersonalBoxes } from "./personal-boxes.ts";
import type { BoxEntry } from "../box/boxes.ts";

test("personal creation reserves quota before awaiting, deduplicates requests and survives reopening", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-boxes-"));
  const entries: BoxEntry[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let starts = 0;
  const options = {
    home,
    entries: () => entries,
    quota: () => 1 as number | undefined,
    authorize: () => true,
    attach: (entry: BoxEntry) => {
      entries.push(entry);
    },
    detach: (id: string) => {
      entries.splice(
        entries.findIndex((e) => e.id === id),
        1,
      );
    },
    residents: () => 0,
    driver: {
      start: async () => {
        starts++;
        await gate;
        return "http://127.0.0.1:1234";
      },
      remove: async () => {},
    },
  };
  const boxes = new PersonalBoxes(options);
  try {
    const first = boxes.create("alice", "request-1");
    assert.equal(boxes.list("alice")[0]!.status, "provisioning");
    await assert.rejects(boxes.create("alice", "request-2"), /quota/i);
    const duplicate = boxes.create("alice", "request-1");
    release();
    assert.equal((await first).id, (await duplicate).id);
    assert.equal(starts, 1);
    assert.equal(entries[0]!.members[0], "alice");
    const reopened = new PersonalBoxes(options);
    assert.equal(reopened.list("alice")[0]!.status, "ready");
    assert.equal(reopened.list("bob").length, 0);
    await assert.rejects(reopened.retry("bob", entries[0]!.id), /not found/i);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed starts release reservations; retry preserves identity and removal explicitly retains or erases data", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-lifecycle-"));
  const entries: BoxEntry[] = [];
  let fail = true;
  const removed: boolean[] = [];
  const boxes = new PersonalBoxes({
    home,
    entries: () => entries,
    quota: () => 1,
    authorize: () => true,
    attach: (entry) => {
      const old = entries.findIndex((e) => e.id === entry.id);
      if (old >= 0) entries[old] = entry;
      else entries.push(entry);
    },
    detach: (id) => {
      entries.splice(
        entries.findIndex((e) => e.id === id),
        1,
      );
    },
    residents: () => 0,
    driver: {
      start: async () => {
        if (fail) throw new Error("private docker details");
        return "http://127.0.0.1:1";
      },
      remove: async (_row, data) => {
        removed.push(data);
      },
    },
  });
  try {
    const failed = await boxes.create("alice", "one");
    assert.equal(failed.status, "failed");
    assert.equal(boxes.quotaEntries().length, 0);
    assert.ok(!JSON.stringify(boxes.list("alice")).includes("private docker"));
    fail = false;
    assert.equal((await boxes.retry("alice", failed.id)).status, "ready");
    assert.equal((await boxes.remove("alice", failed.id, false)).status, "detached");
    assert.equal(boxes.list("alice")[0]!.dataRetained, true);
    assert.equal((await boxes.retry("alice", failed.id)).id, failed.id);
    assert.equal((await boxes.remove("alice", failed.id, true)).status, "deleted");
    assert.deepEqual(boxes.list("alice"), []);
    assert.equal(existsSync(failed.tokenFile), false, "permanent deletion removes the bearer secret");
    assert.deepEqual(removed, [false, false, true]);
    assert.equal(
      (await boxes.create("alice", "one")).status,
      "deleted",
      "old request cannot recreate deleted data",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("revocation during Docker start cleans up before releasing quota and never publishes access", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-revoke-"));
  let permitted = true,
    cleanupFails = true,
    attached = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const boxes = new PersonalBoxes({
    home,
    entries: () => [],
    quota: () => 1,
    authorize: () => permitted,
    attach: () => {
      attached++;
    },
    detach: () => {},
    residents: () => 0,
    driver: {
      start: async () => {
        await gate;
        return "http://127.0.0.1:1";
      },
      remove: async () => {
        if (cleanupFails) throw new Error("unavailable");
      },
    },
  });
  try {
    const starting = boxes.create("alice", "one");
    permitted = false;
    release();
    const row = await starting;
    assert.equal(row.status, "deleting");
    assert.equal(attached, 0);
    assert.equal(boxes.quotaEntries().length, 1, "unfinished cleanup retains reservation");
    await assert.rejects(boxes.create("alice", "two"), /revoked/);
    cleanupFails = false;
    assert.equal((await boxes.retry("alice", row.id)).status, "detached");
    assert.equal(boxes.quotaEntries().length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("two managers sharing durable reservations do not duplicate effects", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-two-managers-"));
  let starts = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const options = {
    home,
    entries: () => [],
    quota: () => 1,
    authorize: () => true,
    attach: () => {},
    detach: () => {},
    residents: () => 0,
    driver: {
      start: async () => {
        starts++;
        await gate;
        return "http://127.0.0.1:1";
      },
      remove: async () => {},
    },
  };
  try {
    const a = new PersonalBoxes(options),
      b = new PersonalBoxes(options);
    const pending = a.create("alice", "one");
    const existing = await b.create("alice", "one");
    await b.retry("alice", existing.id);
    await assert.rejects(b.create("alice", "two"), /quota/);
    assert.equal(starts, 1);
    release();
    await pending;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a killed provisioning process recovers the same box and reservation after restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-restart-"));
  const moduleUrl = new URL("./personal-boxes.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--experimental-transform-types",
      "--input-type=module",
      "-e",
      `
    import { PersonalBoxes } from ${JSON.stringify(moduleUrl)};
    const boxes = new PersonalBoxes({home: process.env.PROBE_HOME, entries: () => [], quota: () => 1, authorize: () => true,
      attach: () => {}, detach: () => {}, residents: () => 0, driver: {
        start: async row => { process.stdout.write(row.id + "\\n"); await new Promise(() => {}); }, remove: async () => {} }});
    setInterval(() => {}, 1000);
    void boxes.create("alice", "stable-request");
  `,
    ],
    { env: { ...process.env, PROBE_HOME: home }, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    const [data] = await once(child.stdout!, "data");
    const id = String(data).trim();
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const stored = new DatabaseSync(join(home, "personal-boxes.sqlite"));
    const staleRecord = JSON.parse(
      (stored.prepare("SELECT data FROM boxes WHERE id=?").get(id) as { data: string }).data,
    );
    staleRecord.worker = process.pid; // Fault injection: the old PID has been reused by a live, unrelated process.
    stored.prepare("UPDATE boxes SET data=? WHERE id=?").run(JSON.stringify(staleRecord), id);
    stored.close();
    const started: string[] = [];
    const boxes = new PersonalBoxes({
      home,
      entries: () => [],
      quota: () => 1,
      authorize: () => true,
      attach: () => {},
      detach: () => {},
      residents: () => 0,
      driver: {
        start: async (row) => {
          started.push(row.id);
          return "http://127.0.0.1:1";
        },
        remove: async () => {},
      },
    });
    assert.equal(boxes.list("alice")[0]!.status, "interrupted");
    assert.equal((await boxes.create("alice", "stable-request")).id, id);
    assert.deepEqual(started, [], "duplicate HTTP request observes rather than steals a dead worker's lease");
    await assert.rejects(boxes.create("alice", "other"), /quota/);
    assert.equal((await boxes.retry("alice", id)).status, "ready");
    assert.deepEqual(started, [id]);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("new allocations use the strictest department quota and stale directory membership denies recovery", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-departments-"));
  let eligible = true;
  const entries: BoxEntry[] = [];
  const boxes = new PersonalBoxes({
    home,
    entries: () => entries,
    quota: (owner) =>
      personalQuotaFor(
        owner,
        { activityLimit: 100, personalBoxQuota: 3, departmentBoxQuotas: { sales: 2, engineering: 1 } },
        { eligible, departmentKeys: ["sales", "engineering"] },
      ),
    authorize: () => eligible,
    attach: (entry) => {
      entries.push(entry);
    },
    detach: () => {},
    residents: () => 0,
    driver: { start: async () => "http://127.0.0.1:1", remove: async () => {} },
  });
  try {
    await boxes.create("alice", "one");
    await assert.rejects(boxes.create("alice", "two"), /quota/);
    eligible = false;
    await assert.rejects(boxes.create("alice", "three"), /revoked/);
    assert.equal(entries.length, 1, "directory departure does not silently destroy existing data");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("deletion intent survives an interrupted detach and cleanup does not require creation permission", async () => {
  const home = mkdtempSync(join(tmpdir(), "personal-delete-recovery-"));
  const entries: BoxEntry[] = [];
  let interrupted = true,
    permitted = true;
  const options = {
    home,
    entries: () => entries,
    quota: () => 1,
    authorize: () => permitted,
    attach: (entry: BoxEntry) => {
      entries.push(entry);
    },
    residents: () => 0,
    detach: (id: string) => {
      entries.splice(
        entries.findIndex((entry) => entry.id === id),
        1,
      );
      if (interrupted) throw new Error("detach interrupted");
    },
    driver: { start: async () => "http://127.0.0.1:1", remove: async () => {} },
  };
  try {
    const first = new PersonalBoxes(options);
    const row = await first.create("alice", "one");
    permitted = false;
    assert.equal((await first.remove("alice", row.id, false)).status, "deleting");
    assert.equal(entries.length, 0);
    const restarted = new PersonalBoxes(options);
    assert.equal(restarted.list("alice")[0]!.status, "deleting");
    interrupted = false;
    assert.equal((await restarted.retry("alice", row.id)).status, "detached");
    assert.equal(restarted.quotaEntries().length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
