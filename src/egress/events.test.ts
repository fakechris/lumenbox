/**
 * The network event log: written by the relay, read by box and by time.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NetworkEventLog, filterEvents, summariseEvents } from "./events.ts";

const at = (h: number) => `2026-09-11T${String(h).padStart(2, "0")}:00:00.000Z`;

test("events are queried by box and time range, newest first, refusals on request", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-netevents-"));
  try {
    const log = new NetworkEventLog(join(dir, "network-events.jsonl"));
    assert.deepEqual(log.query(), { events: [], total: 0 }, "no file is no events");
    log.append({ at: at(9), box: "agentbox", host: "api.search.test", port: 443, allowed: true });
    log.append({ at: at(10), box: "grok", host: "vendor.test", port: 443, allowed: false, reason: "not allowed" });
    log.append({ at: at(11), box: "agentbox", host: "evil.test", port: 80, allowed: false, reason: "not allowed" });
    log.append({ at: at(12), box: "unknown", host: "x.test", port: 443, allowed: false, reason: "unauthorized" });
    // A torn line in the file costs that line, not the query.
    writeFileSync(join(dir, "network-events.jsonl"), "{torn\n", { flag: "a" });

    const all = log.query();
    assert.equal(all.total, 4);
    assert.deepEqual(all.events.map(e => e.host), ["x.test", "evil.test", "vendor.test", "api.search.test"], "newest first");
    assert.deepEqual(log.query({ box: "agentbox" }).events.map(e => e.host), ["evil.test", "api.search.test"]);
    assert.deepEqual(log.query({ from: at(10), to: at(11) }).events.map(e => e.host), ["evil.test", "vendor.test"]);
    assert.deepEqual(log.query({ refused: true, limit: 2 }).events.map(e => e.host), ["x.test", "evil.test"]);
    assert.equal(log.query({ refused: true, limit: 2 }).total, 3, "total counts the match, the limit cuts the page");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the summary says per box what was allowed, what was refused, and which hosts", () => {
  const events = filterEvents(
    [
      { at: at(1), box: "grok", host: "a.test", port: 443, allowed: true },
      { at: at(2), box: "grok", host: "b.test", port: 443, allowed: false, reason: "not allowed" },
      { at: at(3), box: "grok", host: "b.test", port: 443, allowed: false, reason: "not allowed" },
      { at: at(4), box: "agentbox", host: "c.test", port: 80, allowed: true },
    ],
    {}
  );
  assert.deepEqual(summariseEvents(events), [
    { box: "grok", allowed: 1, refused: 2, refusedHosts: ["b.test:443"] },
    { box: "agentbox", allowed: 1, refused: 0, refusedHosts: [] },
  ]);
});
