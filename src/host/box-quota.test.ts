import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoxEntry } from "../box/boxes.ts";
import { DEFAULT_CONFIG } from "../config.ts";
import { personalAllocationRefusal, personalBoxesOf, personalQuotaFor } from "./box-quota.ts";
const box = (id: string, members: BoxEntry["members"]): BoxEntry => ({ id, name: id, kind: "attached", displayFloor: 1, workDir: "/work", createdAt: "2026-10-02", members });

test("personal allocation limits preserve unconfigured installs and honor explicit zero and person overrides", () => {
  assert.equal(personalQuotaFor("ada", DEFAULT_CONFIG), undefined);
  const config = { ...DEFAULT_CONFIG, personalBoxQuota: 0, personBoxQuotas: { ada: 2 } };
  assert.equal(personalQuotaFor("ada", config), 2);
  assert.equal(personalQuotaFor("bob", config), 0);
  assert.equal(personalQuotaFor("toString", config), 0, "prototype names are not overrides");
  const entries = [box("one", ["ada"]), box("shared", ["ada", "bob"]), box("all", "everyone"), box("empty", [])];
  assert.equal(personalBoxesOf(entries, "ada").length, 1);
  assert.match(personalAllocationRefusal(entries, entries[1]!, ["bob"], config)!, /quota 0/);
  assert.equal(personalAllocationRefusal(entries, entries[1]!, ["ada"], config), undefined);
});

test("quota blocks new allocations, including duplicate member IDs, but permits an unchanged over-quota allocation and release", () => {
  const one = box("one", ["ada"]), other = box("other", "everyone");
  const config = { ...DEFAULT_CONFIG, personalBoxQuota: 1 };
  assert.match(personalAllocationRefusal([one, other], other, ["ada", "ada"], config)!, /quota 1/);
  assert.equal(personalAllocationRefusal([one], one, ["ada"], { ...config, personalBoxQuota: 0 }), undefined);
  assert.equal(personalAllocationRefusal([one], one, "everyone", config), undefined);
  assert.equal(personalAllocationRefusal([one], one, [], config), undefined);
});
