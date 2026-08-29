/**
 * Tests for answers that were earned but not handed over.
 *
 * The property that matters is survival: an entry written by a process that then dies has
 * to be readable by the next one, because that is the only situation in which anybody
 * reads this file. Everything else here is about not delivering the same answer twice,
 * which is the failure mode a retry queue invents if it is careless.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deliveries, deliveriesPath } from "./deliveries.ts";

const entry = (id: string) => ({
  id,
  chatKey: "feishu:oc_room",
  conversation: "feishu-oc_room",
  agentId: "a1",
  before: 7,
  at: "2026-08-25T02:00:00.000Z",
});

test("what was owed survives the process that owed it", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-deliveries-"));
  try {
    const path = deliveriesPath(home);
    const first = new Deliveries(path);
    first.open(entry("d1"));
    first.open(entry("d2"));

    // A different instance, standing in for the next process. This is the only moment
    // anyone reads this file, so reading it fresh is the case worth testing.
    const next = new Deliveries(path);
    const owed = next.pending();
    assert.deepEqual(
      owed.map(d => d.id).sort(),
      ["d1", "d2"],
      "both should still be owed"
    );
    // The index is the whole trick: everything the agent said past it is the reply.
    assert.equal(owed[0]?.before, 7);

    next.close("d1");
    assert.deepEqual(new Deliveries(path).pending().map(d => d.id), ["d2"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a half-written last line is skipped, since a crash is why this file exists", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-deliveries-"));
  try {
    const path = deliveriesPath(home);
    const store = new Deliveries(path);
    store.open(entry("d1"));
    // Exactly what a process killed mid-append leaves behind.
    appendFileSync(path, '{"event":"open","delivery":{"id":"d2","cha');

    // The intact entry must survive the torn one, or one bad write loses the queue.
    assert.deepEqual(new Deliveries(path).pending().map(d => d.id), ["d1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the file is a queue, not a history, and does not grow for ever", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-deliveries-"));
  try {
    const path = deliveriesPath(home);
    const store = new Deliveries(path);
    store.open(entry("keep"));
    for (let index = 0; index < 250; index++) {
      store.open(entry(`d${index}`));
      store.close(`d${index}`);
    }

    // The property is bounded growth, not a particular size: 250 settled pairs would be
    // 501 lines unbroken, and compaction keeps it to the tail since the last rewrite.
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    assert.ok(lines < 200, `queue should stay bounded, got ${lines} lines`);

    // And the still-owed entry survives the rewrite, which is the only thing compaction
    // could get catastrophically wrong: losing it loses an answer somebody paid for.
    assert.deepEqual(new Deliveries(path).pending().map(d => d.id), ["keep"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("crash, then namespace replacement: recovery produces a reported dead letter", () => {
  // The docs/22 §7 item 2 named test. An answer earned under tenant A must not be
  // delivered through whatever now occupies the `feishu` door.
  const home = mkdtempSync(join(tmpdir(), "lumen-deliveries-"));
  try {
    const path = deliveriesPath(home);
    // The process that dies: owes one answer, stamped with the world it saw.
    const before = new Deliveries(path);
    before.open({ ...entry("owed"), incarnation: 1 });
    // A legacy record from before stamps existed rides along — it reads as 1.
    before.open(entry("legacy"));

    // The next process wakes up after the feishu channel was replaced.
    const warnings: string[] = [];
    const after = new Deliveries(path, {
      incarnationOf: chatKey => (chatKey.startsWith("feishu:") ? 2 : 1),
      warn: line => warnings.push(line),
    });
    assert.deepEqual(after.pending(), [], "nothing is owed to the new tenant");
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /dead letter/);
    // Reported once, not on every recovery pass: the dead letters were closed.
    warnings.length = 0;
    assert.deepEqual(after.pending(), []);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an answer owed under the current incarnation is still owed", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-deliveries-"));
  try {
    const path = deliveriesPath(home);
    new Deliveries(path).open({ ...entry("current"), incarnation: 1 });
    const after = new Deliveries(path, { incarnationOf: () => 1 });
    assert.equal(after.pending().length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
