/** What the app and its box are holding (INV-1559): admin only, every field there, a down box said plainly. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, openSync, readSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnosticsRoute, heapSnapshot, type DiagnosticsDeps } from "./diagnostics-routes.ts";

const CGROUP = "3957321728\n---lumenbox-section---\n4294967296\n---lumenbox-section---\nlow 0\nhigh 0\nmax 4206248\noom 1916\noom_kill 26\n---lumenbox-section---\nusage_usec 36134327605\nuser_usec 30000000000\nnr_throttled 12\n---lumenbox-section---\n";

function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  const commands: string[] = [];
  return {
    refusedAdmin: () => false,
    agents: () => [{ id: "a1", name: "Vic" }, { id: "a2", name: "Ada" }],
    activeTurns: id => (id === "a1" ? 2 : 0),
    queued: id => (id === "a1" ? 5 : 1),
    watchedJobs: id => (id === "a1" ? 40 : 0),
    eventSubscribers: () => 3,
    box: () => ({ exec: async (command, options) => { commands.push(`${options.actor}: ${command}`); return { stdout: CGROUP, exit_code: 0 }; } }),
    home: "/nonexistent",
    ...over,
  };
}

test("only an admin reads it; anyone else is refused before anything is measured", async () => {
  let measured = false;
  const refused = await diagnosticsRoute("GET /api/diagnostics/resources", deps({ refusedAdmin: () => true, agents: () => { measured = true; return []; } }));
  assert.deepEqual(refused, { status: 0, body: null }, "status 0: the refusal was already sent");
  assert.equal(measured, false);
  assert.deepEqual(await diagnosticsRoute("POST /api/diagnostics/heap-snapshot", deps({ refusedAdmin: () => true })), { status: 0, body: null });
  assert.equal(await diagnosticsRoute("GET /api/elsewhere", deps()), undefined, "not its route");
});

test("the process, the event loop, each agent's load, the open streams and the box's cgroup", async () => {
  const answer = await diagnosticsRoute("GET /api/diagnostics/resources", deps());
  assert.equal(answer?.status, 200);
  const body = answer!.body as Record<string, any>;
  for (const field of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"]) assert.equal(typeof body.process[field], "number", field);
  assert.ok(body.heapSpaces.some((space: { name: string }) => space.name === "old_space"));
  for (const field of ["meanMs", "p50Ms", "p99Ms", "maxMs"]) assert.equal(typeof body.eventLoop[field], "number", field);
  assert.equal(body.eventSubscribers, 3);
  assert.deepEqual(body.agents[0], { id: "a1", name: "Vic", activeTurns: 2, queued: 5, watchedJobs: 40 });
  assert.deepEqual(body.box, { memoryCurrent: 3957321728, memoryMax: 4294967296, memoryEvents: { low: 0, high: 0, max: 4206248, oom: 1916, oom_kill: 26 }, cpu: { usage_usec: 36134327605, user_usec: 30000000000, nr_throttled: 12 } });
});

test("a box that is down or missing is said, not thrown", async () => {
  const down = (await diagnosticsRoute("GET /api/diagnostics/resources", deps({ box: () => ({ exec: async () => { throw new Error("fetch failed"); } }) })))!.body as Record<string, any>;
  assert.deepEqual(down.box, { error: "fetch failed" });
  const none = (await diagnosticsRoute("GET /api/diagnostics/resources", deps({ box: () => undefined })))!.body as Record<string, any>;
  assert.deepEqual(none.box, { error: "no box connected" });
});

test("a heap snapshot is written under <home>/diagnostics in the format DevTools loads, and says how to remove it", () => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-diag-"));
  try {
    const written = heapSnapshot(home, new Date("2026-11-04T08:00:00.000Z"));
    assert.equal(written.path, join(home, "diagnostics", "2026-11-04T08-00-00-000Z.heapsnapshot"));
    assert.ok(written.bytes > 100_000);
    const head = Buffer.alloc(16);
    const fd = openSync(written.path, "r");
    readSync(fd, head, 0, 16, 0);
    closeSync(fd);
    assert.match(head.toString("utf8"), /^\{"snapshot":/, "the JSON shape Chrome DevTools → Memory → Load opens");
    assert.match(written.note, /conversations included/);
    assert.match(written.note, /delete the file/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
