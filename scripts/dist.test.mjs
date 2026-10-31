/** The dist wrapper's notarization parts (INV-1450): which credentials notarytool gets, and how its answer is read. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { notaryCredentials, submissionStatus } from "./dist.mjs";

test("credentials come from the variables electron-builder reads, the keychain profile first, and none means none", () => {
  assert.deepEqual(notaryCredentials({ APPLE_KEYCHAIN_PROFILE: "lumenbox", APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "K", APPLE_API_ISSUER: "I" }), ["--keychain-profile", "lumenbox"]);
  assert.deepEqual(notaryCredentials({ APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "K", APPLE_API_ISSUER: "I" }), ["--key", "/k.p8", "--key-id", "K", "--issuer", "I"]);
  assert.deepEqual(notaryCredentials({ APPLE_ID: "a@b", APPLE_APP_SPECIFIC_PASSWORD: "p", APPLE_TEAM_ID: "T" }), ["--apple-id", "a@b", "--password", "p", "--team-id", "T"]);
  assert.equal(notaryCredentials({ APPLE_API_KEY: "/k.p8", APPLE_API_KEY_ID: "K" }), undefined, "an incomplete set is no credentials, not a half-attempt");
  assert.equal(notaryCredentials({}), undefined);
});

test("only an Accepted submission counts", () => {
  const done = "Conducting pre-submission checks for LumenBox-0.3.9-arm64.dmg and initiating connection to the Apple notary service...\nProcessing complete\n  id: 2efe2717-52ef-43a5-96dc-0797e4ca1041\n  status: Accepted\n";
  assert.equal(submissionStatus(done), "Accepted");
  assert.equal(submissionStatus(done.replace("Accepted", "Invalid")), "Invalid");
  assert.equal(submissionStatus("Error: HTTP status code: 401. Unable to authenticate."), undefined);
});
