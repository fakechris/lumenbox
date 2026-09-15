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
import { recall, renderMemoryFiles } from "./memory.ts";

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
