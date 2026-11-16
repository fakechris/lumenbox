import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  base64url,
  sha256Base64url,
  generateKeyPair,
  generateExtractableKeyPair,
  exportPublicJwk,
  exportPrivateJwk,
  importPrivateKey,
  jwkThumbprint,
  signJwt,
  randomId,
  nowSeconds,
} from "./jose.ts";

describe("jose", () => {
  it("base64url encodes without padding", () => {
    const buf = new Uint8Array([72, 101, 108, 108, 111]);
    assert.equal(base64url(buf), "SGVsbG8");
  });

  it("sha256Base64url produces a stable hash", async () => {
    const hash = await sha256Base64url("hello");
    assert.equal(hash, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ");
  });

  it("generates an ES256 key pair", async () => {
    const pair = await generateKeyPair();
    assert.ok(pair.privateKey);
    assert.ok(pair.publicKey);
  });

  it("exports and imports a public JWK", async () => {
    const pair = await generateKeyPair();
    const jwk = await exportPublicJwk(pair.publicKey);
    assert.equal(jwk.kty, "EC");
    assert.equal(jwk.crv, "P-256");
    assert.ok(jwk.x);
    assert.ok(jwk.y);
  });

  it("computes a JWK thumbprint", async () => {
    const pair = await generateKeyPair();
    const jwk = await exportPublicJwk(pair.publicKey);
    const tp = await jwkThumbprint(jwk);
    assert.ok(tp.length > 10);
    // Stable for the same key.
    assert.equal(await jwkThumbprint(jwk), tp);
  });

  it("signs and verifies a JWT structure", async () => {
    const pair = await generateKeyPair();
    const jwt = await signJwt(
      { alg: "ES256", typ: "test+jwt" },
      { iss: "test", sub: "user", iat: nowSeconds() },
      pair.privateKey
    );
    const parts = jwt.split(".");
    assert.equal(parts.length, 3);

    // Header decodes to the right type.
    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
    assert.equal(header.typ, "test+jwt");
    assert.equal(header.alg, "ES256");
  });

  it("randomId produces unique values", () => {
    const ids = new Set(Array.from({ length: 100 }, () => randomId()));
    assert.equal(ids.size, 100);
  });

  it("round-trips an extractable private key", async () => {
    const pair = await generateExtractableKeyPair();
    const jwk = await exportPrivateJwk(pair.privateKey);
    const imported = await importPrivateKey(jwk);
    // Sign with the imported key.
    const jwt = await signJwt({ alg: "ES256" }, { test: true }, imported);
    assert.ok(jwt.split(".").length === 3);
  });
});
