/**
 * Tests for the promise a `record` makes.
 *
 * Two ledgers described themselves in prose as records of what happened and were compacted
 * as queues. The tests that matter are the ones that would have failed then: write enough
 * to force a compaction, then ask the file the question it exists to answer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ingress, LEDGER_KIND as INGRESS_KIND } from "../channels/ingress.ts";
import { TurnLedger, LEDGER_KIND as TURNS_KIND } from "./resume.ts";
import { PolicyGate, LEDGER_KIND as POLICY_KIND } from "./policy.ts";
import { archivedLines, archivePathFor, archivePaths, archiveSettled } from "./jsonl.ts";

function dir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "agentbox-ledger-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test("an archive is named for its month, found again, and never rewritten", () => {
  const { path, cleanup } = dir();
  try {
    const ledger = join(path, "ingress.jsonl");
    assert.equal(archivePathFor(ledger, new Date("2026-09-22T10:00:00Z")), join(path, "ingress.2026-09.jsonl"));
    archiveSettled(ledger, ['{"a":1}'], new Date("2026-09-22T10:00:00Z"));
    archiveSettled(ledger, ['{"a":2}'], new Date("2026-09-22T23:00:00Z"));
    archiveSettled(ledger, ['{"a":3}'], new Date("2026-10-01T00:00:00Z"));
    assert.deepEqual(archivePaths(ledger).map(p => p.slice(path.length + 1)), [
      "ingress.2026-09.jsonl",
      "ingress.2026-10.jsonl",
    ]);
    // Appended, not replaced: September holds both of its lines.
    assert.deepEqual(archivedLines(ledger), ['{"a":1}', '{"a":2}', '{"a":3}']);
    // And the live file is not one of its own archives.
    writeFileSync(ledger, '{"live":true}\n');
    assert.deepEqual(archivedLines(ledger).length, 3);
    assert.equal(archiveSettled(ledger, ["", "  "]), undefined, "nothing to move writes nothing");
  } finally {
    cleanup();
  }
});

test("ingress keeps every arrival's fate across a compaction, and still answers the sweep", () => {
  const { path, cleanup } = dir();
  try {
    const ingress = new Ingress(join(path, "ingress.jsonl"));
    assert.equal(INGRESS_KIND, "record");
    // Well past the 500-line compaction threshold, all of them decided.
    for (let n = 0; n < 600; n++) {
      ingress.arrived({
        id: `m-${n}`,
        channel: "feishu-personal",
        identity: "ou_person",
        chatKey: "oc_room",
        kind: "text",
        chars: 10,
        at: new Date(Date.UTC(2026, 8, 20, 0, 0, n)).toISOString(),
      });
      ingress.decided(`m-${n}`, n % 3 === 0 ? "refused" : "admitted", n % 3 === 0 ? "not a known person" : undefined);
    }

    // The live file did compact: this is the behaviour being preserved, not removed.
    const live = readFileSync(join(path, "ingress.jsonl"), "utf8").split("\n").filter(l => l.trim() !== "");
    assert.ok(live.length < 600, `the live file is still bounded (${live.length} lines)`);

    const history = ingress.list({ archived: true });
    assert.equal(history.length, 600, "every arrival is still there");
    assert.equal(history.filter(record => record.fate === "refused").length, 200);
    assert.equal(history.find(record => record.id === "m-0")?.reason, "not a known person");

    // The question this ledger must never get wrong: a replayed old message was decided.
    assert.equal(ingress.decidedAlready("m-0"), true, "an archived decision is still a decision");
    assert.equal(ingress.decidedAlready("m-599"), true);
    assert.equal(ingress.decidedAlready("never-seen"), false);
  } finally {
    cleanup();
  }
});

test("an undecided arrival stays in the live file, where the sweep looks for it", () => {
  const { path, cleanup } = dir();
  try {
    const ingress = new Ingress(join(path, "ingress.jsonl"));
    const arrive = (id: string, at: string) =>
      ingress.arrived({ id, channel: "feishu-personal", identity: "ou_p", chatKey: "oc_r", kind: "text", chars: 3, at });
    arrive("open-one", new Date(Date.UTC(2026, 8, 20, 0, 0, 0)).toISOString());
    for (let n = 0; n < 600; n++) {
      arrive(`m-${n}`, new Date(Date.UTC(2026, 8, 20, 0, 1, n)).toISOString());
      ingress.decided(`m-${n}`, "admitted");
    }
    assert.deepEqual(ingress.unresolved().map(record => record.id), ["open-one"]);
    assert.equal(ingress.decidedAlready("open-one"), false, "and it is not treated as handled");
    // Live-only reading stays cheap and still sees what is open.
    assert.equal(ingress.list().some(record => record.id === "open-one"), true);
  } finally {
    cleanup();
  }
});

test("the turn ledger archives instead of emptying, so what a turn cost survives", () => {
  const { path, cleanup } = dir();
  try {
    const ledger = join(path, "turns.jsonl");
    const turns = new TurnLedger(ledger, () => {});
    assert.equal(TURNS_KIND, "record");
    const ids: string[] = [];
    for (let n = 0; n < 5_100; n++) {
      const id = turns.begin({
        agentId: "a1",
        about: `task ${n}`,
        id: `turn-${n}`,
        conversation: "main",
        model: "claude-opus-5",
        build: { version: "0.2.1", commit: "abc1234" },
      });
      ids.push(id);
      turns.end(id, "done");
    }

    const live = readFileSync(ledger, "utf8").split("\n").filter(l => l.trim() !== "");
    assert.ok(live.length < 10_200, `the live file is bounded (${live.length} lines)`);

    // Every turn is still readable, with the fields that make it worth keeping.
    const archived = archivedLines(ledger).map(line => JSON.parse(line) as Record<string, unknown>);
    const all = [...archived, ...live.map(line => JSON.parse(line) as Record<string, unknown>)];
    const begins = all.filter(record => record.event === "begin");
    assert.equal(begins.length, 5_100, "no turn was dropped");
    assert.equal(all.filter(record => record.event === "end").length, 5_100);
    assert.equal(begins[0]!.model, "claude-opus-5");
    assert.deepEqual(begins[0]!.build, { version: "0.2.1", commit: "abc1234" });
    assert.equal(begins[0]!.id, ids[0]);
  } finally {
    cleanup();
  }
});

test("compaction only ever moves a line: nothing is both archived and live, nothing is neither", () => {
  const { path, cleanup } = dir();
  try {
    const ingress = new Ingress(join(path, "ingress.jsonl"));
    for (let n = 0; n < 700; n++) {
      ingress.arrived({ id: `m-${n}`, channel: "c", identity: "i", chatKey: "k", kind: "text", chars: 1, at: new Date(Date.UTC(2026, 8, 20, 0, 0, n)).toISOString() });
      if (n % 2 === 0) ingress.decided(`m-${n}`, "admitted");
    }
    const idsIn = (lines: string[]) =>
      new Set(lines.map(line => {
        const record = JSON.parse(line) as { arrival?: { id?: string }; id?: string };
        return record.arrival?.id ?? record.id;
      }));
    const live = idsIn(readFileSync(join(path, "ingress.jsonl"), "utf8").split("\n").filter(l => l.trim() !== ""));
    const archived = idsIn(archivedLines(join(path, "ingress.jsonl")));
    for (const id of live) assert.ok(!archived.has(id), `${id} is in both files`);
    assert.equal(live.size + archived.size, 700, "every arrival is in exactly one of them");
  } finally {
    cleanup();
  }
});

test("the archived-decision index is rebuilt when an archive grows, not cached into a wrong answer", () => {
  const { path, cleanup } = dir();
  try {
    const ingress = new Ingress(join(path, "ingress.jsonl"));
    const arrive = (id: string, n: number) =>
      ingress.arrived({ id, channel: "c", identity: "i", chatKey: "k", kind: "text", chars: 1, at: new Date(Date.UTC(2026, 8, 20, 0, 0, n % 60)).toISOString() });

    for (let n = 0; n < 600; n++) {
      arrive(`first-${n}`, n);
      ingress.decided(`first-${n}`, "admitted");
    }
    // Reading it once builds the index.
    assert.equal(ingress.decidedAlready("first-0"), true);
    assert.equal(ingress.decidedAlready("second-0"), false);

    // A second compaction appends to the same archive. The cached answer for the new ids
    // was false a moment ago and must not stay false.
    for (let n = 0; n < 600; n++) {
      arrive(`second-${n}`, n);
      ingress.decided(`second-${n}`, "refused", "not a known person");
    }
    assert.equal(ingress.decidedAlready("second-0"), true, "the index noticed the archive grew");
    assert.equal(ingress.decidedAlready("first-0"), true, "and did not forget the first batch");
    assert.equal(ingress.decidedAlready("never-arrived"), false);
  } finally {
    cleanup();
  }
});

test("the policy log keeps every approval across a compaction: old lines move to the archive, standing grants stay live (INV-812)", () => {
  const { path, cleanup } = dir();
  try {
    assert.equal(POLICY_KIND, "record");
    const ledger = join(path, "policy.jsonl");
    const line = (o: unknown) => JSON.stringify(o);
    const old = [
      line({ at: "2026-09-01T00:00:00Z", kind: "approval-requested", id: "ap-1", fingerprint: "fp-1", agentId: "a1", description: "deploy" }),
      line({ at: "2026-09-01T00:00:01Z", kind: "approval-granted", id: "ap-1", by: "chris" }),
      line({ at: "2026-09-01T00:00:02Z", kind: "approval-used", id: "ap-1" }),
      line({ at: "2026-09-01T00:00:03Z", kind: "approval-granted-always", id: "ap-2", by: "chris", fingerprint: "fp-2", description: "read the wiki", agentId: "a1" }),
    ];
    // Past the 20,000-event threshold, so opening the gate compacts it.
    const filler = Array.from({ length: 20_100 }, (_, n) => line({ at: "2026-09-02T00:00:00Z", kind: "checked", request: "model-call", agentId: "a1", allowed: true, n }));
    writeFileSync(ledger, `${[...old, ...filler].join("\n")}\n`);
    new PolicyGate({
      path: ledger,
      limits: { budgetWindowHours: 24, wakesPerWindow: 30, wakeWindowMinutes: 10, approvalRequiredTools: [], approvalRequiredCommands: [] },
    });

    const live = readFileSync(ledger, "utf8").trim().split("\n");
    assert.ok(live.length < 6_000, `compacted: ${live.length} live lines`);
    // The approval and who granted it are still there to read — in the archive, not gone.
    const archived = archivedLines(ledger);
    for (const event of old.slice(0, 3)) assert.ok(archived.includes(event), `archived: ${event}`);
    assert.equal(archived.length + live.length - 1, old.length + filler.length, "every line is live or archived; the standing grant is re-stated once");
    // And a standing grant is still live, so the gate still honours it.
    assert.ok(live.some(entry => entry.includes('"approval-granted-always"') && entry.includes("fp-2")));
  } finally {
    cleanup();
  }
});
