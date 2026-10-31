/** The notarization gate (INV-1450): the verdict on what stapler and spctl print, and which artifacts it reads. */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { macArtifacts, notarizationVerdict } from "./notarization.mjs";

// Captured from the 0.3.8 arm64 artifacts, which were signed but not notarized.
const unstapled = { code: 65, output: "Processing: /x/LumenBox.app\nLumenBox.app does not have a ticket stapled to it.\n" };
const unnotarized = { code: 3, output: "LumenBox.app: rejected\nsource=Unnotarized Developer ID\norigin=Developer ID Application: Example (A69VRB2X6U)\n" };
const unsignedDmg = { code: 3, output: "LumenBox-0.3.8-arm64.dmg: rejected\nsource=no usable signature\n" };
// What the tools print for a notarized, stapled artifact.
const stapled = { code: 0, output: "Processing: /x/LumenBox.app\nThe validate action worked!\n" };
const notarized = { code: 0, output: "LumenBox.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Example (A69VRB2X6U)\n" };

test("a notarized, stapled artifact passes", () => {
  assert.deepEqual(notarizationVerdict(stapled, notarized), { ok: true, problems: [] });
});

test("0.3.8 as shipped fails, and says why in Gatekeeper's own words", () => {
  const app = notarizationVerdict(unstapled, unnotarized);
  assert.equal(app.ok, false);
  assert.deepEqual(app.problems, ["no notarization ticket stapled", "Gatekeeper rejects it (Unnotarized Developer ID)"]);
  assert.deepEqual(notarizationVerdict(unstapled, unsignedDmg).problems[1], "Gatekeeper rejects it (no usable signature)");
});

test("notarized but not stapled still fails: a person offline on first open is blocked", () => {
  assert.deepEqual(notarizationVerdict(unstapled, notarized).problems, ["no notarization ticket stapled"]);
});

test("a stapled ticket does not outvote Gatekeeper, and an unexpected tool error is reported, not read as a pass", () => {
  assert.equal(notarizationVerdict(stapled, unnotarized).ok, false);
  assert.equal(notarizationVerdict(stapled, { code: 0, output: "" }).ok, false, "exit 0 without 'accepted' is not acceptance");
  assert.deepEqual(notarizationVerdict({ code: 1, output: "Processing: /x\nCould not validate ticket\n" }, notarized).problems, ["stapler validate failed: Could not validate ticket"]);
});

test("the artifacts read are this version's dmgs and the staged apps of this version only", () => {
  const dist = mkdtempSync(join(tmpdir(), "notarize-"));
  for (const dir of ["mac-arm64", "mac"]) mkdirSync(join(dist, dir, "LumenBox.app"), { recursive: true });
  for (const name of ["LumenBox-0.3.9-arm64.dmg", "LumenBox-0.3.9.dmg", "LumenBox-0.3.8.dmg", "LumenBox-0.3.9-mac.zip"]) writeFileSync(join(dist, name), "");
  const versions = { [join(dist, "mac-arm64", "LumenBox.app")]: "0.3.9", [join(dist, "mac", "LumenBox.app")]: "0.3.8" };
  const found = macArtifacts(dist, "0.3.9", app => versions[app]).map(a => `${a.kind}:${a.path.slice(dist.length + 1)}`).sort();
  assert.deepEqual(found, ["app:mac-arm64/LumenBox.app", "dmg:LumenBox-0.3.9-arm64.dmg", "dmg:LumenBox-0.3.9.dmg"]);
  assert.deepEqual(macArtifacts(join(dist, "absent"), "0.3.9"), []);
});
