/**
 * The directory merge: what a sync did to what was there. The rule under
 * test hardest is the honest-scope one — absence deactivates only under
 * full visibility — because it is the difference between "the org updated"
 * and "somebody lost their access".
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Directories, type DirectorySnapshot, mergeDirectory } from "./directory.ts";

function snapshot(people: DirectorySnapshot["people"], departments: DirectorySnapshot["departments"] = []): DirectorySnapshot {
  return { departments, people };
}

const NOW = "2026-09-04T00:00:00.000Z";
const LATER = "2026-09-05T00:00:00.000Z";

test("a first sync lands everyone active, with the structure as the vendor holds it", () => {
  const { merged, changes } = mergeDirectory(
    undefined,
    "feishu",
    snapshot(
      [
        { vendorSubject: "ou_1", name: "One", departmentVendorIds: ["od_1"] },
        { vendorSubject: "ou_2", name: "Two", departmentVendorIds: ["od_1"] },
      ],
      [{ vendorId: "od_1", name: "研发部", parentVendorId: "0" }],
    ),
    "partial",
    NOW,
  );
  assert.equal(changes.added, 2);
  assert.equal(changes.deactivated, 0);
  assert.equal(merged.people.every(person => person.active), true);
  assert.deepEqual(merged.departments.map(d => d.name), ["研发部"]);
  assert.equal(merged.syncedAt, NOW);
});

test("full visibility: absence deactivates; the person is kept, not deleted", () => {
  const first = mergeDirectory(
    undefined,
    "feishu",
    snapshot([
      { vendorSubject: "ou_1", name: "One", departmentVendorIds: [] },
      { vendorSubject: "ou_2", name: "Two", departmentVendorIds: [] },
    ]),
    "full",
    NOW,
  ).merged;
  const { merged, changes } = mergeDirectory(
    first,
    "feishu",
    snapshot([{ vendorSubject: "ou_1", name: "One", departmentVendorIds: [] }]),
    "full",
    LATER,
  );
  assert.equal(changes.deactivated, 1);
  const two = merged.people.find(person => person.vendorSubject === "ou_2");
  assert.ok(two !== undefined, "the departed person is still on the record");
  assert.equal(two.active, false);
  assert.equal(two.lastSeenAt, NOW, "their last seen is the last sync that had them");

  // And back again: reactivation, not a new person.
  const third = mergeDirectory(
    merged,
    "feishu",
    snapshot([
      { vendorSubject: "ou_1", name: "One", departmentVendorIds: [] },
      { vendorSubject: "ou_2", name: "Two", departmentVendorIds: [] },
    ]),
    "full",
    LATER,
  );
  assert.equal(third.changes.reactivated, 1);
  assert.equal(third.merged.people.find(p => p.vendorSubject === "ou_2")?.firstSeenAt, NOW, "first seen survives the round trip");
});

test("partial visibility: absence means nothing at all — the load-bearing rule", () => {
  const first = mergeDirectory(
    undefined,
    "feishu",
    snapshot([{ vendorSubject: "ou_1", name: "One", departmentVendorIds: [] }]),
    "partial",
    NOW,
  ).merged;
  // The app's visible range narrowed; the person vanished from the walk.
  const { merged, changes } = mergeDirectory(first, "feishu", snapshot([]), "partial", LATER);
  assert.equal(changes.deactivated, 0, "a partial view deactivates nobody");
  assert.equal(merged.people.find(p => p.vendorSubject === "ou_1")?.active, true);
  assert.equal(merged.people.find(p => p.vendorSubject === "ou_1")?.lastSeenAt, NOW, "the stale lastSeen says what happened");
});

test("renames and department moves are counted, and order is stable", () => {
  const first = mergeDirectory(
    undefined,
    "feishu",
    snapshot([
      { vendorSubject: "ou_1", name: "One", departmentVendorIds: ["od_1"] },
      { vendorSubject: "ou_2", name: "Two", departmentVendorIds: ["od_1"] },
    ]),
    "partial",
    NOW,
  ).merged;
  const { merged, changes } = mergeDirectory(
    first,
    "feishu",
    snapshot([
      { vendorSubject: "ou_2", name: "Two", departmentVendorIds: ["od_2"] },
      { vendorSubject: "ou_1", name: "一", departmentVendorIds: ["od_1", "od_2"] },
    ]),
    "partial",
    LATER,
  );
  assert.equal(changes.renamed, 1);
  assert.equal(changes.added, 0);
  const one = merged.people.find(p => p.vendorSubject === "ou_1")!;
  assert.equal(one.name, "一");
  assert.deepEqual(one.departmentVendorIds, ["od_1", "od_2"]);
});

test("personOf offers active people only — inactive and unknown are both nothing", () => {
  const store = new Directories(join(mkdtempSync(join(tmpdir(), "agentbox-dir-")), "directory.json"));
  store.merge(
    "feishu",
    snapshot([{ vendorSubject: "ou_1", name: "One", departmentVendorIds: [] }]),
    "full",
    NOW,
  );
  assert.equal(store.personOf("feishu", "ou_1")?.name, "One");
  assert.equal(store.personOf("feishu", "ou_gone"), undefined, "never synced is nothing");
  // A departure, then the question again.
  store.merge("feishu", snapshot([]), "full", LATER);
  assert.equal(store.personOf("feishu", "ou_1"), undefined, "deactivated is nothing");
});

test("the store round-trips through the file a second instance reads", () => {
  const path = join(mkdtempSync(join(tmpdir(), "agentbox-dir-")), "directory.json");
  const writer = new Directories(path);
  writer.merge(
    "dingtalk",
    snapshot([{ vendorSubject: "staff_9", name: "Nine", departmentVendorIds: ["1"] }], [
      { vendorId: "1", name: "root", parentVendorId: null },
    ]),
    "full",
    NOW,
  );
  const reader = new Directories(path);
  assert.equal(reader.of("dingtalk")?.people.length, 1);
  assert.equal(reader.of("dingtalk")?.visibility, "full");
  assert.equal(reader.personOf("dingtalk", "staff_9")?.name, "Nine");
});
