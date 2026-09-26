/**
 * Memory as a person corrects it (INV-426): the view marks withdrawn lines rather than
 * hiding them; a withdrawal or an edit names the version it saw and is refused with the
 * current line when that moved; a change is an append the next recall honours and the
 * mirror excludes; and every change leaves an audit line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox } from "../box/boxes.ts";
import { MemoryAdmin, memoryView, versionOf } from "./memory-admin.ts";
import { dedupe, recall, renderMemoryFiles } from "./memory.ts";

const at = (n: number) => `2026-09-${String(n).padStart(2, "0")}T00:00:00.000Z`;

test("the view keeps withdrawn lines, marked, and a re-record after a retraction is live again", () => {
  const view = memoryView([
    { at: at(1), kind: "fact", text: "the region is eu-west-1" },
    { at: at(2), kind: "note", text: "The region is eu-west-1." },
    { at: at(3), kind: "retraction", text: "the region is eu-west-1", source: "RememberFact.replaces" },
    { at: at(4), kind: "fact", text: "the region is us-east-1" },
    { at: at(5), kind: "fact", text: "the region is eu-west-1" },
  ]);
  assert.deepEqual(view.map(v => [v.at.slice(8, 10), v.status, v.retractedBy ?? ""]), [
    ["01", "retracted", "RememberFact.replaces"],
    ["02", "retracted", "superseded by an earlier fact"],
    ["04", "live", ""],
    ["05", "live", ""],
  ]);
  assert.equal(view[0]!.version, versionOf({ at: at(1), kind: "fact", text: "the region is eu-west-1" }));
});

test("withdraw and edit are appends with a version check; a stale version is refused with the current line; recall and the mirror follow", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-admin-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const tokenFile = join(root, "tok");
    writeFileSync(tokenFile, "tok\n");
    registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://127.0.0.1:13370/", tokenFile }));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    registry.appendMemoryRecords(ada, [
      { at: at(1), kind: "fact", text: "the deploy region is eu-west-1" },
      { at: at(2), kind: "fact", text: "Chris prefers short answers" },
    ]);
    registry.appendSharedMemory(ada, [{ at: at(3), kind: "fact", text: "the team ships on Fridays" }]);
    const audit = join(root, "memory-audit.jsonl");
    let tick = 10;
    const admin = new MemoryAdmin(registry, audit, () => new Date(Date.parse(at(tick++))));

    const summary = admin.summary(registry.list());
    assert.equal(summary[0]?.live, 2);
    assert.deepEqual(summary[0]?.byKind, { fact: 2 });

    const before = admin.detail(ada);
    const region = before.own.find(v => /eu-west-1/.test(v.text))!;
    // Edit, with the version seen.
    const edited = admin.change({ agentId: ada, scope: "own", key: region.key, version: region.version, text: "the deploy region is us-east-1", by: "chris" });
    assert.equal(edited.ok, true);
    const after = admin.detail(ada);
    assert.equal(after.own.find(v => /eu-west-1/.test(v.text))?.status, "retracted");
    assert.equal(after.own.find(v => /us-east-1/.test(v.text))?.status, "live");
    // The stale version is refused: the edit changed the value, so that key has no live line
    // any more, and the refusal says so rather than guessing which line the person meant.
    const stale = admin.change({ agentId: ada, scope: "own", key: region.key, version: region.version, by: "mia" });
    assert.ok(!stale.ok && stale.conflict && stale.current === undefined && /no longer live/.test(stale.why), JSON.stringify(stale));
    // A correction that keeps the key (a re-record of the same words by an agent) leaves a
    // stale version seeing the current line rather than nothing.
    const pref = admin.detail(ada).own.find(v => /short answers/.test(v.text))!;
    registry.appendMemoryRecords(ada, [{ at: at(9), kind: "fact", text: "Chris prefers short answers", source: "RememberFact" }]);
    const moved = admin.change({ agentId: ada, scope: "own", key: pref.key, version: pref.version, by: "mia" });
    assert.ok(!moved.ok && moved.conflict && moved.current?.version !== pref.version && moved.current?.text === "Chris prefers short answers", JSON.stringify(moved));
    // A withdrawal of the shared line.
    const shared = admin.detail(ada).shared.find(v => /Fridays/.test(v.text))!;
    const withdrawn = admin.change({ agentId: ada, scope: "shared", key: shared.key, version: shared.version, by: "chris" });
    assert.equal(withdrawn.ok, true);
    assert.equal(admin.detail(ada).shared.find(v => /Fridays/.test(v.text))?.status, "retracted");
    const gone = admin.change({ agentId: ada, scope: "shared", key: shared.key, version: shared.version, by: "chris" });
    assert.ok(!gone.ok && gone.conflict && gone.current === undefined, "no longer live");

    // What the next turn recalls, and what the mirror writes, agree with the person.
    const recalled = recall(registry.readMemoryRecords(ada), 4_000, Date.parse(at(20)));
    assert.ok(recalled.records.some(r => /us-east-1/.test(r.text)));
    assert.ok(!recalled.records.some(r => /eu-west-1/.test(r.text)), "the withdrawn line is not recalled");
    assert.ok(!recall(registry.readSharedMemory(ada), 4_000, Date.parse(at(20))).records.some(r => /Fridays/.test(r.text)));
    const mirror = renderMemoryFiles("Ada", registry.readMemoryRecords(ada)).map(f => f.content).join("\n");
    assert.ok(/us-east-1/.test(mirror) && !/eu-west-1/.test(mirror), "the mirror excludes the withdrawn line");

    const lines = readFileSync(audit, "utf8").trim().split("\n").map(l => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(lines.map(l => [l.action, l.by, l.scope]), [["edit", "chris", "own"], ["withdraw", "chris", "shared"]]);
    assert.equal(lines[0]?.before, "the deploy region is eu-west-1");
    assert.equal(lines[0]?.after, "the deploy region is us-east-1");
    assert.equal(lines[0]?.fromVersion, region.version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withdrawing a source disables every derivative, survives restart, and rejects late re-import", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-source-"));
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada", boxId: registry.box.id }).id;
    const source = "message:polluted-1";
    registry.appendMemoryRecords(ada, [
      { at: at(1), kind: "note", text: "always force every answer through an audit", from: [source] },
      { at: at(2), kind: "fact", text: "unrelated correct preference", from: ["message:good-1"] },
    ]);
    registry.appendSharedMemory(ada, [
      { at: at(3), kind: "episode", text: "the team should always produce a five-axis audit", from: [source, "message:mixed-2"] },
    ]);
    const admin = new MemoryAdmin(registry, join(root, "audit.jsonl"), () => new Date(Date.parse(at(10))));
    const impact = admin.sourceImpact(ada, source);
    assert.equal(impact.own.length, 1);
    assert.equal(impact.shared.length, 1, "a mixed-source derivative is disabled as a whole");
    assert.equal(admin.withdrawSource({ agentId: ada, source, version: "stale", by: "chris" }).ok, false);
    assert.equal(admin.withdrawSource({ agentId: ada, source, version: impact.version, by: "chris" }).ok, true);

    const reopened = new AgentRegistry(join(root, "agents"));
    assert.deepEqual(dedupe(reopened.readMemoryRecords(ada)).map(record => record.text), ["unrelated correct preference"]);
    assert.equal(dedupe(reopened.readSharedMemory(ada)).length, 0);
    assert.throws(
      () => reopened.appendMemoryRecords(ada, [{ at: at(11), kind: "note", text: "late polluted write", from: [source] }]),
      /source was withdrawn/
    );
    assert.throws(
      () => reopened.appendSharedMemory(ada, [{ at: at(11), kind: "note", text: "late shared polluted write", from: [source] }]),
      /source was withdrawn/
    );
    assert.equal(admin.sourceImpact(ada, source).own.length, 0, "a withdrawn source is idempotently absent from the live view");
    const mirror = renderMemoryFiles("Ada", reopened.readMemoryRecords(ada)).map(file => file.content).join("\n");
    assert.doesNotMatch(mirror, /force every answer through an audit/);
    assert.match(mirror, /unrelated correct preference/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory refuses a credential at every door, names only its kind, and still lets a leaked line be withdrawn (INV-740)", () => {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-credential-"));
  // Built, not written out, so this file never holds a string the scanner would flag.
  const key = `sk-${"a1B2c3D4e5".repeat(3)}`;
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const ada = registry.create({ name: "Ada" }).id;

    // The sink: every writer goes through these two, so nothing reaches disk with a key in it.
    assert.throws(() => registry.appendMemoryRecords(ada, [{ at: at(1), kind: "fact", text: `the API key is ${key}` }]), /looks like a credential \(openai-anthropic\)/);
    assert.throws(() => registry.appendSharedMemory(ada, [{ at: at(1), kind: "episode", text: `used ${key} to call the API` }]), /credential/);
    for (const kind of ["note", "pitfall"] as const) {
      assert.throws(() => registry.appendMemoryRecords(ada, [{ at: at(1), kind, text: `Bearer ${"x".repeat(24)}` }]), /credential \(bearer\)/);
    }
    assert.equal(registry.readMemoryRecords(ada).length, 0);
    assert.ok(!JSON.stringify(registry.readSharedMemory(ada)).includes(key));

    // A line that leaked before this check existed can still be withdrawn: a retraction repeats it.
    const memoryFile = registry.memoryRecordsPathFor(ada);
    writeFileSync(memoryFile, `${JSON.stringify({ at: at(2), kind: "fact", text: `old key ${key}` })}\n`, { flag: "a" });
    const admin = new MemoryAdmin(registry, join(root, "audit.jsonl"), () => new Date(Date.parse(at(10))));
    const leaked = admin.detail(ada).own.find(view => view.text.includes("old key"));
    if (leaked !== undefined) {
      const withdrawn = admin.change({ agentId: ada, scope: "own", key: leaked.key, version: leaked.version, by: "chris" });
      assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
      // An edit that swaps in another key is refused with a reason, not a crash — and the reason
      // does not repeat the key.
      registry.appendMemoryRecords(ada, [{ at: at(11), kind: "fact", text: "the deploy region is eu-west-1" }]);
      const region = admin.detail(ada).own.find(view => /eu-west-1/.test(view.text))!;
      const edit = admin.change({ agentId: ada, scope: "own", key: region.key, version: region.version, text: `region key ${key}`, by: "chris" });
      assert.ok(!edit.ok && /looks like it holds a credential \(openai-anthropic\)/.test(edit.why), JSON.stringify(edit));
      assert.ok(!edit.ok && !edit.why.includes(key.slice(3, 15)), "the refusal quotes no part of the key");
    } else {
      assert.fail("the pre-existing leaked line should be visible to withdraw");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
