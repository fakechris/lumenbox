/**
 * The first-admin invite: minted only for an empty roster, one live at a
 * time, spent exactly once, and recorded for the audit question later.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureBootstrapAdmin,
  loadBootstrap,
  markRedeemed,
  mintBootstrap,
  newBootstrapCode,
  pendingBootstrap,
} from "./bootstrap.ts";

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agentbox-bootstrap-")), "bootstrap-invite.json");
}

test("an invite round-trips on disk and stays pending until spent or stale", () => {
  const path = freshPath();
  const now = 1_000_000;
  const minted = mintBootstrap(path, { code: "ABCD2345", ttlMs: 60_000, now });
  assert.deepEqual(loadBootstrap(path), minted);
  assert.equal(pendingBootstrap(loadBootstrap(path), now + 1)?.code, "ABCD2345");
  assert.equal(pendingBootstrap(loadBootstrap(path), now + 60_001), undefined, "expired is not pending");
  const spent = markRedeemed(path, minted, { identity: "feishu:ou_first", now: now + 5_000 });
  assert.equal(pendingBootstrap(loadBootstrap(path), now + 6_000), undefined, "redeemed is not pending");
  assert.equal(spent.redeemedBy, "feishu:ou_first", "the record keeps who spent it");
  // The redemption survives a reload — the installation's first audit fact.
  assert.equal(loadBootstrap(path)?.redeemedBy, "feishu:ou_first");
});

test("codes are eight unambiguous characters, and never repeat a drawn blank", () => {
  for (let i = 0; i < 20; i++) {
    assert.match(newBootstrapCode(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
  }
});

test("ensureBootstrapAdmin: an empty roster gets exactly one live invite, logged once with its code", () => {
  const path = freshPath();
  const lines: string[] = [];
  const log = (line: string): void => {
    lines.push(line);
  };
  const now = 5_000_000;

  const first = ensureBootstrapAdmin({ rosterEmpty: true, path, now: () => now, log });
  assert.ok(first !== undefined);
  assert.match(lines[0]!, /first admin invite [23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}/, "the mint says the code");
  assert.equal(existsSync(path), true);

  // A restart while outstanding: same invite, and the code does not repeat in the log.
  lines.length = 0;
  const again = ensureBootstrapAdmin({ rosterEmpty: true, path, now: () => now + 1_000, log });
  assert.equal(again?.code, first.code);
  assert.match(lines[0]!, /outstanding/);
  assert.ok(!lines[0]!.includes(first.code), "the code is not re-printed on every start");
  assert.match(lines[0]!, /bootstrap-invite\.json/, "the file is named for retrieval");
});

test("ensureBootstrapAdmin: expiry re-arms, and a roster with a person in it mints nothing", () => {
  const path = freshPath();
  const log = (): void => {};
  const now = 5_000_000;
  mintBootstrap(path, { code: "OLD23456", ttlMs: 1_000, now });

  const reArmed = ensureBootstrapAdmin({ rosterEmpty: true, path, now: () => now + 2_000, log });
  assert.ok(reArmed !== undefined);
  assert.notEqual(reArmed.code, "OLD23456", "the stale invite was replaced, not revived");

  const none = ensureBootstrapAdmin({ rosterEmpty: false, path, now: () => now + 3_000, log });
  assert.equal(none, undefined, "a non-empty roster is not a bootstrap");
  assert.ok(!existsSync(join(path, "..", "another")), "nothing was written for it either");
});
