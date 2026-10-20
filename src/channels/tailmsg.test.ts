/**
 * The tailmsg door's two pure parts (INV-1288): the envelope read strictly, and the wake
 * level that only ever goes down. The door itself is tested in tailmsg-door.test.ts.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalHost, isTailnetAddress, parseEnvelope, safeFileName, sameHost, validAgentName } from "./tailmsg-envelope.ts";
import { decideWake, inQuietHours, WakeCounters } from "./tailmsg-wake.ts";

const SELF = "dev-server.example.ts.net";
const letter = (over: Record<string, unknown> = {}) => ({ v: 1, id: "9f2c4e1ab07d33c5", from: "bot-box.example.ts.net", to: SELF, ts: "2026-10-08T14:00:00Z", text: "hello", ...over });

test("the envelope: the spec's fields, nothing else, each checked the way the spec says", () => {
  const ok = parseEnvelope(letter({ kind: "notice", wake: "now", agent: "codex", from_agent: "grok", reply_to: "1a2b3c4d5e6f7a8b" }), SELF);
  assert.ok("envelope" in ok);
  assert.equal(ok.envelope.wake, "now");
  assert.equal(ok.envelope.kind, "notice");
  const defaults = parseEnvelope(letter(), SELF);
  assert.ok("envelope" in defaults);
  assert.equal(defaults.envelope.wake, "batch", "wake defaults to batch");
  assert.equal(defaults.envelope.kind, "text");
  assert.ok("envelope" in parseEnvelope(letter({ to: "dev-server" }), SELF), "to may be the short name");

  const errorOf = (over: Record<string, unknown>) => {
    const r = parseEnvelope(letter(over), SELF);
    assert.ok("error" in r, `expected a refusal for ${JSON.stringify(over)}`);
    return r.error;
  };
  assert.match(errorOf({ extra: 1 }), /unknown field\(s\): extra/);
  assert.match(errorOf({ v: 2 }), /v must be 1/);
  assert.match(errorOf({ id: "short" }), /id must match/);
  assert.match(errorOf({ to: "other.example.ts.net" }), /to is not this host/);
  assert.match(errorOf({ ts: "2026-10-08 14:00" }), /ts must be UTC/);
  assert.match(errorOf({ wake: "urgent" }), /wake must be now, batch or none/);
  assert.match(errorOf({ agent: "a/b" }), /agent is not a valid agent name/);
  assert.match(errorOf({ agent: " spaced" }), /agent is not a valid agent name/);
  assert.match(errorOf({ kind: "x".repeat(40) }), /kind must be a short string/);
  assert.match(errorOf({ request: {} }), /request-lifecycle-v1 is not negotiated/);
  assert.match(errorOf({ fetch: [{ url: "http://evil.example.ts.net:7766/f/t/x", sha256: "a".repeat(64), size: 1 }] }), /not on the sender.*refused whole/);
  assert.match(errorOf({ fetch: [{ url: "https://bot-box.example.ts.net:7766/f/t/x", sha256: "a".repeat(64), size: 1 }] }), /must be http:\/\//);
  assert.match(errorOf({ fetch: [{ url: "http://bot-box.example.ts.net:7766/f/t/x", sha256: "nope", size: 1 }] }), /sha256 must be 64 lowercase hex/);
  assert.ok("envelope" in parseEnvelope(letter({ fetch: [{ url: "http://bot-box:7766/f/t/x", sha256: "a".repeat(64), size: 12, name: "x.pdf" }] }), SELF), "the sender's short name is the sender");

  assert.equal(validAgentName("私信联系人"), true);
  assert.equal(validAgentName("a\nb"), false);
  assert.equal(validAgentName(""), false);
  assert.equal(sameHost("bot-box", "bot-box.example.ts.net."), true);
  assert.equal(sameHost("bot-box.example.ts.net", "BOT-BOX.example.ts.net."), true);
  assert.equal(sameHost("bot-box2", "bot-box.example.ts.net"), false);
  assert.equal(canonicalHost("Dev-Server.Example.ts.net."), "dev-server.example.ts.net");
  assert.equal(isTailnetAddress("100.124.85.115"), true);
  assert.equal(isTailnetAddress("::ffff:100.64.0.1"), true);
  assert.equal(isTailnetAddress("100.128.0.1"), false);
  assert.equal(isTailnetAddress("192.168.1.9"), false);
  assert.equal(isTailnetAddress("fd7a:115c:a1e0::9801:557a"), true);
  assert.equal(safeFileName("../../etc/passwd", "f"), "passwd");
  assert.equal(safeFileName("报告 2026.pdf", "f"), "报告 2026.pdf");
  assert.equal(safeFileName(undefined, "file-1"), "file-1");
});

test("the wake level only goes down: ceiling, quiet hours, rate per sender and agent, unknown agent; the rate survives a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "tailmsg-wake-"));
  try {
    const path = join(dir, "wake-counters.json");
    const counters = new WakeCounters(path);
    const base = { sender: "bot-box.example.ts.net", agent: "codex", agentKnown: true, counters, now: 1_000_000, hour: 14 };
    const policy = { senderMax: [{ sender: "bot-box", max: "now" as const }], defaultMax: "batch" as const, quietHours: { start: 23, end: 7 }, ratePerHour: 2 };
    assert.deepEqual(decideWake({ ...base, requested: "now", policy }), { requested: "now", effective: "now" });
    assert.deepEqual(decideWake({ ...base, requested: "now", sender: "stranger.example.ts.net", policy }), { requested: "now", effective: "batch", reason: "default ceiling batch" });
    assert.deepEqual(decideWake({ ...base, requested: "now", policy, hour: 2 }), { requested: "now", effective: "batch", reason: "quiet hours" });
    assert.equal(inQuietHours(23, policy.quietHours), true);
    assert.equal(inQuietHours(7, policy.quietHours), false);
    assert.deepEqual(decideWake({ ...base, requested: "batch", policy }), { requested: "batch", effective: "batch" }, "a lower wish is not raised");
    assert.deepEqual(decideWake({ ...base, requested: "now", agentKnown: false, policy }), { requested: "now", effective: "batch", reason: "no such agent here" });
    // The second now in the hour is the last the rate allows; the third is batch — and after
    // a restart the counters remember it.
    assert.equal(decideWake({ ...base, requested: "now", policy, now: 1_000_100 }).effective, "now");
    assert.match(decideWake({ ...base, requested: "now", policy, now: 1_000_200 }).reason ?? "", /rate: 2 now-wakes per hour/);
    const reborn = new WakeCounters(path);
    assert.match(decideWake({ ...base, counters: reborn, requested: "now", policy, now: 1_000_300 }).reason ?? "", /rate/);
    assert.equal(decideWake({ ...base, counters: reborn, requested: "now", agent: "grok", policy, now: 1_000_300 }).effective, "now", "another agent has its own allowance");
    assert.equal(decideWake({ ...base, counters: reborn, requested: "now", policy, now: 1_000_000 + 3_600_001 }).effective, "now", "an hour later the allowance is back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
