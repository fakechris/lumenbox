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
    log.append({ at: at(9), box: "agentbox", host: "api.search.test", port: 443, allowed: true, attribution: "unattributed" });
    log.append({ at: at(10), box: "grok", host: "vendor.test", port: 443, allowed: false, attribution: "unattributed", reason: "not allowed" });
    log.append({ at: at(11), box: "agentbox", host: "evil.test", port: 80, allowed: false, attribution: "unattributed", reason: "not allowed" });
    log.append({ at: at(12), box: "unknown", host: "x.test", port: 443, allowed: false, attribution: "unattributed", reason: "unauthorized" });
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
      { at: at(1), box: "grok", host: "a.test", port: 443, allowed: true, attribution: "unattributed" },
      { at: at(2), box: "grok", host: "b.test", port: 443, allowed: false, attribution: "unattributed", reason: "not allowed" },
      { at: at(3), box: "grok", host: "b.test", port: 443, allowed: false, attribution: "unattributed", reason: "not allowed" },
      { at: at(4), box: "agentbox", host: "c.test", port: 80, allowed: true, attribution: "unattributed" },
    ],
    {}
  );
  assert.deepEqual(summariseEvents(events), [
    { box: "grok", allowed: 1, refused: 2, refusedHosts: ["b.test:443"] },
    { box: "agentbox", allowed: 1, refused: 0, refusedHosts: [] },
  ]);
});

// ── by call (INV-784) ─────────────────────────────────────────────────────────────
import { refusedLine } from "./events.ts";

test("events are queried by agent, turn and tool call, and a line written before attribution reads as unattributed", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-netevents-"));
  try {
    const path = join(dir, "network-events.jsonl");
    const log = new NetworkEventLog(path);
    log.append({ at: at(9), box: "agentbox", host: "a.test", port: 443, allowed: true, attribution: "call", agentId: "ada", turnId: "t-1", toolUseId: "toolu_1" });
    log.append({ at: at(10), box: "agentbox", host: "b.test", port: 443, allowed: false, reason: "not allowed", attribution: "call", agentId: "ada", turnId: "t-1", toolUseId: "toolu_2", jobId: "job-0123abcd" });
    log.append({ at: at(11), box: "agentbox", host: "c.test", port: 443, allowed: true, attribution: "call", agentId: "bob", turnId: "t-2", toolUseId: "toolu_3" });
    writeFileSync(path, `${JSON.stringify({ at: at(12), box: "agentbox", host: "old.test", port: 80, allowed: true })}\n`, { flag: "a" });

    assert.deepEqual(log.query({ turn: "t-1" }).events.map(e => e.host), ["b.test", "a.test"]);
    assert.deepEqual(log.query({ agent: "bob" }).events.map(e => e.host), ["c.test"]);
    assert.deepEqual(log.query({ toolUse: "toolu_2", refused: true }).events.map(e => e.jobId), ["job-0123abcd"]);
    const old = log.query().events.find(e => e.host === "old.test");
    assert.equal(old?.attribution, "unattributed");
    assert.equal(old?.agentId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the refusal line is one line, hosts once each, nothing when nothing was refused", () => {
  const event = (host: string, allowed: boolean) => ({ at: at(1), box: "b", host, port: 443, allowed, attribution: "unattributed" as const });
  assert.equal(refusedLine([event("a.test", true)]), undefined);
  assert.equal(refusedLine([event("a.test", false)]), "1 outbound connection refused: a.test");
  assert.equal(refusedLine([event("a.test", false), event("b.test", false), event("a.test", false), event("c.test", true)]), "3 outbound connections refused: a.test, b.test");
  const many = ["h1", "h2", "h3"].map(host => event(host, false));
  assert.equal(refusedLine(many, 2), "3 outbound connections refused: h1, h2 and 1 more");
});
