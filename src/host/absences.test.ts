/**
 * Tests for the startup statement of what is configured but absent.
 *
 * The property under test: a capability the source promises and the installation cannot
 * deliver is *named at startup*, rather than discovered by tracing a failure back to it.
 * All three of the findings that motivated this were found by accident (docs/14); the
 * environments here are exactly the ones the real installation was in for days.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { absences, describeAbsences } from "./absences.ts";
import { SEARCH_KEY_VARIABLE } from "./web.ts";
import { RELAY_TOKEN_VARIABLE, RELAY_URL_VARIABLE } from "./presets.ts";

const fully = {
  [SEARCH_KEY_VARIABLE]: "a-key",
  [RELAY_URL_VARIABLE]: "http://relay.local:8788",
  [RELAY_TOKEN_VARIABLE]: "box-scoped-token",
};

test("a fully provisioned environment has nothing to say", () => {
  assert.deepEqual(absences(fully), []);
  assert.deepEqual(describeAbsences(fully), []);
});

test("the environment this installation actually ran with is named, twice", () => {
  // No search key, no relay: the state every finding in docs/14 was discovered in.
  const found = absences({});
  assert.deepEqual(
    found.map(absence => absence.capability),
    ["web search", "delegated engines"]
  );
  // The detail carries the degradation, not just "unset" — the silent half is the bug.
  assert.match(found[0]!.detail, /degrade/);
  assert.match(found[1]!.detail, /no model credential/);
  // And each names its one-line fix.
  assert.match(found[0]!.remedy, new RegExp(SEARCH_KEY_VARIABLE));
  assert.match(found[1]!.remedy, new RegExp(RELAY_URL_VARIABLE));
});

test("an empty string is absent, not present", () => {
  // `KEY=""` in an env file looks configured and behaves unconfigured.
  const found = absences({ ...fully, [SEARCH_KEY_VARIABLE]: "" });
  assert.deepEqual(
    found.map(absence => absence.capability),
    ["web search"]
  );
});

test("half a relay is no relay", () => {
  const found = absences({ ...fully, [RELAY_TOKEN_VARIABLE]: "" });
  assert.deepEqual(
    found.map(absence => absence.capability),
    ["delegated engines"]
  );
});
