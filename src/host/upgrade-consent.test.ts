/**
 * Tests for the record that carries a person's answer to the upgrade question.
 *
 * Every test here is about a way the record could say yes to something nobody agreed to.
 * That is the only interesting failure: a consent that is missed costs one re-ask, and a
 * consent that is over-applied costs whatever was in /home/box.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONSENT_GOOD_FOR_HOURS,
  consentFor,
  lossesFingerprint,
  recordUpgradeConsent,
  upgradeConsentPath,
} from "./upgrade-consent.ts";

const home = () => mkdtempSync(join(tmpdir(), "consent-"));
const LOSSES = lossesFingerprint("  /home/box/report.md");

test("a decision authorises the image it was made about, and no other", () => {
  const path = upgradeConsentPath(home());
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_a", at: new Date().toISOString() });

  assert.equal(consentFor(path, "0.31", LOSSES)?.by, "feishu:ou_a");
  // The next image is a different question. Approving 0.31 says nothing about 0.32, and
  // an upgrade is exactly the moment that distinction stops being pedantic.
  assert.equal(consentFor(path, "0.32", LOSSES), undefined);
});

test("a decision stops applying when what it would cost changes", () => {
  // The property the fingerprint exists for. They approved losing one report; if a day's
  // work has appeared in /home/box since, nobody has agreed to lose *that*.
  const path = upgradeConsentPath(home());
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_a", at: new Date().toISOString() });

  const nowAlsoDestroys = lossesFingerprint("  /home/box/report.md\n  /home/box/three-days-of-work.md");
  assert.equal(consentFor(path, "0.31", nowAlsoDestroys), undefined);
  assert.equal(consentFor(path, "0.31", LOSSES)?.by, "feishu:ou_a", "the answer they did give still stands");
});

test("a decision goes stale, because a situation can change in ways the findings do not show", () => {
  const path = upgradeConsentPath(home());
  const when = new Date(Date.now() - (CONSENT_GOOD_FOR_HOURS + 1) * 3_600_000).toISOString();
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_a", at: when });
  assert.equal(consentFor(path, "0.31", LOSSES), undefined);

  // And the same record inside the window is good.
  const fresh = new Date(Date.now() - 60_000).toISOString();
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_b", at: fresh });
  assert.equal(consentFor(path, "0.31", LOSSES)?.by, "feishu:ou_b");
});

test("the newest answer wins, and a torn line does not hide it", () => {
  const path = upgradeConsentPath(home());
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_a", at: new Date(Date.now() - 120_000).toISOString() });
  recordUpgradeConsent(path, { image: "0.31", losses: LOSSES, by: "feishu:ou_b", at: new Date().toISOString() });
  assert.equal(consentFor(path, "0.31", LOSSES)?.by, "feishu:ou_b");

  // A crash mid-append leaves half a line. Every ledger here skips it rather than
  // treating the file as unreadable, and this one is read newest-first, so the torn
  // line is the *first* thing it meets.
  writeFileSync(path, `${'{"image":"0.31","losses"'}`, { flag: "a" });
  assert.equal(consentFor(path, "0.31", LOSSES)?.by, "feishu:ou_b");
});

test("nothing recorded is not consent", () => {
  assert.equal(consentFor(upgradeConsentPath(home()), "0.31", LOSSES), undefined);
});
