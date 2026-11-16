import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pkceChallenge, clientAssertion, OAuthError } from "./oauth.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("PKCE", () => {
  test("generates a verifier and challenge of the right shape", async () => {
    const { verifier, challenge } = await pkceChallenge();
    assert.ok(verifier.length >= 32);
    assert.ok(challenge.length >= 32);
    assert.ok(!challenge.includes("+"));
    assert.ok(!challenge.includes("/"));
    assert.ok(!challenge.includes("="));
    // Verifier and challenge must differ (challenge is a hash).
    assert.notEqual(verifier, challenge);
  });

  test("different calls produce different verifiers", async () => {
    const a = await pkceChallenge();
    const b = await pkceChallenge();
    assert.notEqual(a.verifier, b.verifier);
  });
});

describe("clientAssertion", () => {
  test("produces a JWT with the right claims", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poppy-oauth-"));
    try {
      const identity = await loadOrCreateIdentity(dir, "https://test.example");
      const jwt = await clientAssertion(identity, "https://auth.company.com/token");

      // A JWT has three base64url parts.
      const parts = jwt.split(".");
      assert.equal(parts.length, 3);

      // Decode the header.
      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      assert.equal(header.alg, "ES256");
      assert.equal(header.kid, identity.kid);

      // Decode the payload.
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      assert.equal(payload.iss, identity.clientId);
      assert.equal(payload.sub, identity.clientId);
      assert.equal(payload.aud, "https://auth.company.com/token");
      assert.ok(typeof payload.jti === "string");
      assert.ok(typeof payload.iat === "number");
      assert.ok(typeof payload.exp === "number");
      assert.ok(payload.exp > payload.iat);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OAuthError", () => {
  test("carries detail alongside the message", () => {
    const err = new OAuthError("Token exchange failed", '{"error":"invalid_grant"}');
    assert.equal(err.message, "Token exchange failed");
    assert.equal(err.detail, '{"error":"invalid_grant"}');
    assert.ok(err instanceof Error);
  });
});
