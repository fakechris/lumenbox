import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryUserIdStore,
  userIdFor,
  DelegatedKeyManager,
  createSession,
} from "./session.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function testCompany(domain = "example.com") {
  return {
    protocolVersion: "0.4",
    name: "Test Company",
    domain,
    identifier: `https://${domain}`,
    raw: {},
  };
}

describe("User IDs", () => {
  it("generates a stable User ID per Company", () => {
    const store = new MemoryUserIdStore();
    const company = testCompany();
    const id1 = userIdFor(`ada|${company.domain}`, store);
    const id2 = userIdFor(`ada|${company.domain}`, store);
    assert.equal(id1, id2, "same Company → same User ID");
    assert.ok(id1.startsWith("usr_"));
  });

  it("different Companies get different User IDs", () => {
    const store = new MemoryUserIdStore();
    const a = userIdFor("ada|a.com", store);
    const b = userIdFor("ada|b.com", store);
    assert.notEqual(a, b, "different Companies → different User IDs");
  });
});

describe("DelegatedKeyManager", () => {
  it("issues a delegation and reuses it within its lifetime", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "poppy-test-"));
    try {
      const identity = await loadOrCreateIdentity(tmp, "https://test.example");
      const mgr = new DelegatedKeyManager(identity);
      const key1 = await mgr.getKey();
      assert.ok(key1.delegation.length > 50);
      assert.ok(key1.kid.length > 10);

      // Same key on second call (within lifetime).
      const key2 = await mgr.getKey();
      assert.equal(key2.kid, key1.kid);
      assert.equal(key2.delegation, key1.delegation);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("Session", () => {
  it("signs a Session JWT with the right structure", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "poppy-test-"));
    try {
      const identity = await loadOrCreateIdentity(tmp, "https://test.example");
      const company = testCompany();
      const store = new MemoryUserIdStore();
      const userId = userIdFor(`ada|${company.domain}`, store);
      const keyMgr = new DelegatedKeyManager(identity);
      const session = createSession(identity, company, userId, keyMgr);

      assert.ok(session.sid.length > 10);
      assert.equal(session.userId, userId);
      assert.equal(session.version, "0.4");

      const jwt = await session.sessionJwt("GET", "https://example.com/api/orders");
      const parts = jwt.split(".");
      assert.equal(parts.length, 3);

      const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString());
      assert.equal(header.typ, "poppy-session+jwt");
      assert.equal(header.alg, "ES256");
      assert.ok(header.kid);
      assert.ok(header.poppy_dlg);

      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
      assert.equal(payload.iss, identity.clientId);
      assert.equal(payload.aud, company.identifier);
      assert.equal(payload.sid, session.sid);
      assert.equal(payload.sub, userId);
      assert.equal(payload.htm, "GET");
      assert.equal(payload.htu, "https://example.com/api/orders");
      assert.ok(payload.iat);
      assert.ok(payload.jti);
      assert.equal(payload.ath, undefined, "no ath without access token");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("includes ath when an access token is given", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "poppy-test-"));
    try {
      const identity = await loadOrCreateIdentity(tmp, "https://test.example");
      const company = testCompany();
      const store = new MemoryUserIdStore();
      const userId = userIdFor(`ada|${company.domain}`, store);
      const keyMgr = new DelegatedKeyManager(identity);
      const session = createSession(identity, company, userId, keyMgr);

      const jwt = await session.sessionJwt("POST", "https://example.com/api/checkout", "fake-token-123");
      const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
      assert.ok(payload.ath, "ath present when access token is given");
      assert.ok(payload.ath.length > 10);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("headers() returns the right header names", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "poppy-test-"));
    try {
      const identity = await loadOrCreateIdentity(tmp, "https://test.example");
      const company = testCompany();
      const store = new MemoryUserIdStore();
      const userId = userIdFor(`ada|${company.domain}`, store);
      const keyMgr = new DelegatedKeyManager(identity);
      const session = createSession(identity, company, userId, keyMgr);

      const headers = await session.headers("GET", "https://example.com/api/orders");
      assert.ok(headers["Poppy-Session"]);
      assert.equal(headers["Poppy-Version"], "0.4");
      assert.equal(headers["Authorization"], undefined, "no Authorization without token");

      const headers2 = await session.headers("GET", "https://example.com/api/orders", "token-abc");
      assert.ok(headers2["Authorization"]?.startsWith("Bearer "));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
