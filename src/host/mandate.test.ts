/** A task's mandate (INV-1457): granted once, checked against the world now, withdrawn for good. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStale, grantMandate, reauthorisedBy, revalidateMandate } from "./mandate.ts";

const now = new Date("2026-11-01T06:00:00Z");

test("a person's own request is explicit; a proposal or a routine's work is inferred, with its source", () => {
  assert.equal(grantMandate({ by: "p-chris", now }).strength, "explicit");
  assert.equal(grantMandate({ by: "p-chris", proposedBy: "a1", now }).strength, "inferred");
  const routine = grantMandate({ by: "p-chris", source: "routine:daily-brief", rulesHash: "abc", now });
  assert.deepEqual({ strength: routine.strength, source: routine.source, rulesHash: routine.rulesHash, grantedAt: routine.grantedAt },
    { strength: "inferred", source: "routine:daily-brief", rulesHash: "abc", grantedAt: "2026-11-01T06:00:00.000Z" });
});

test("every way a mandate stops holding is reported, together", () => {
  const mandate = grantMandate({ by: "p-chris", source: "routine:x", rulesHash: "abc", now });
  assert.deepEqual(revalidateMandate(mandate, { mayDrive: () => true, rulesHash: "abc", sourceEnabled: () => true }), { ok: true });
  assert.deepEqual(revalidateMandate(mandate, { mayDrive: () => false, rulesHash: "def", sourceEnabled: () => false }),
    { ok: false, reasons: ["requester-cannot-drive", "rules-changed", "source-disabled"] });
  // No rule store, no source check: nothing to compare against is not a change.
  assert.deepEqual(revalidateMandate(mandate, { mayDrive: () => true }), { ok: true });
  // An explicit mandate has no source to switch off.
  assert.deepEqual(revalidateMandate(grantMandate({ by: "p-chris", now }), { mayDrive: () => true, sourceEnabled: () => false }), { ok: true });
});

test("only the person whose mandate it is, still able to drive, re-authorises; a withdrawn one nobody does", () => {
  const mandate = grantMandate({ by: "p-chris", now });
  const world = { mayDrive: (id: string) => id === "p-chris" };
  assert.equal(reauthorisedBy(mandate, "p-chris", world), true);
  assert.equal(reauthorisedBy(mandate, "p-mia", world), false);
  assert.equal(reauthorisedBy(mandate, "p-chris", { mayDrive: () => false }), false);
  assert.equal(reauthorisedBy({ ...mandate, withdrawn: { at: "t", by: "p-chris", reason: "stop" } }, "p-chris", world), false);
  assert.match(describeStale(["rules-changed", "source-disabled"]), /rules changed.*; .*no longer enabled/);
});
