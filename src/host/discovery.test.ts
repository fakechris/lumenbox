/** A sensing routine's finding as a proposal (INV-1652): the fingerprint, the parse, the line. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeDiscovery, DISCOVERY_FIELDS, discoveryFingerprint, parseDiscovery } from "./discovery.ts";

test("the fingerprint is of source and finding, not wording around them", () => {
  const a = discoveryFingerprint("https://github.com/x/y/pull/12", "CI failed on main for 2 days");
  assert.equal(discoveryFingerprint("  https://github.com/x/y/pull/12 ", "ci   failed on MAIN for 2 days"), a);
  assert.notEqual(discoveryFingerprint("https://github.com/x/y/pull/13", "CI failed on main for 2 days"), a);
  assert.notEqual(discoveryFingerprint("https://github.com/x/y/pull/12", "CI failed on main for 3 days"), a);
});

test("a discovery parses from the tool's fields, bounded, or not at all without a kind, source and evidence", () => {
  const parsed = parseDiscovery({ discovery_kind: "problem", source: "t1293", evidence: "doing for 9 days, nothing moved", why_now: "the requester asked twice" });
  assert.deepEqual(parsed, { kind: "problem", source: "t1293", evidence: "doing for 9 days, nothing moved", whyNow: "the requester asked twice", fingerprint: discoveryFingerprint("t1293", "doing for 9 days, nothing moved") });
  assert.equal(parseDiscovery({ discovery_kind: "rumour", source: "x", evidence: "y" }), undefined);
  assert.equal(parseDiscovery({ discovery_kind: "todo", source: "", evidence: "y" }), undefined);
  assert.equal(parseDiscovery({ discovery_kind: "todo", source: "x" }), undefined);
  assert.equal(parseDiscovery({ discovery_kind: "todo", source: "x", evidence: "e".repeat(700) })!.evidence.length, 500);
  assert.equal(describeDiscovery(parsed!), "problem from t1293 — the requester asked twice");
  assert.deepEqual(DISCOVERY_FIELDS.discovery_kind.enum, ["todo", "problem", "opportunity", "decision"]);
});
