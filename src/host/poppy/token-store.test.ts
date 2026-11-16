import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TokenStore } from "./token-store.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpStore(): { store: TokenStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "poppy-tokens-"));
  return { store: new TokenStore(dir), dir };
}

describe("TokenStore", () => {
  test("stores and retrieves a token", () => {
    const { store, dir } = tmpStore();
    try {
      store.set("https://auth.example.com", {
        accessToken: "at_123",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000,
        refreshToken: "rt_456",
        scope: "read write",
      });

      const got = store.get("https://auth.example.com");
      assert.ok(got);
      assert.equal(got.accessToken, "at_123");
      assert.equal(got.refreshToken, "rt_456");
      assert.equal(got.scope, "read write");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persists across instances", () => {
    const { dir } = tmpStore();
    try {
      const store1 = new TokenStore(dir);
      store1.set("https://auth.example.com", {
        accessToken: "at_persist",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000,
      });

      const store2 = new TokenStore(dir);
      const got = store2.get("https://auth.example.com");
      assert.ok(got);
      assert.equal(got.accessToken, "at_persist");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hasValid and needsRefresh report correctly", () => {
    const { store, dir } = tmpStore();
    try {
      // Token valid for 1 hour.
      store.set("fresh", {
        accessToken: "at",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000,
      });
      assert.equal(store.hasValid("fresh"), true);
      assert.equal(store.needsRefresh("fresh"), false);

      // Token expired 1 second ago.
      store.set("stale", {
        accessToken: "at",
        tokenType: "Bearer",
        expiresAt: Date.now() - 1000,
      });
      assert.equal(store.hasValid("stale"), false);
      assert.equal(store.needsRefresh("stale"), true);

      // No token.
      assert.equal(store.hasValid("unknown"), false);
      assert.equal(store.needsRefresh("unknown"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("remove deletes a token", () => {
    const { store, dir } = tmpStore();
    try {
      store.set("https://auth.example.com", {
        accessToken: "at",
        tokenType: "Bearer",
        expiresAt: Date.now() + 3600_000,
      });
      assert.ok(store.get("https://auth.example.com"));

      store.remove("https://auth.example.com");
      assert.equal(store.get("https://auth.example.com"), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("status() summarises all stored tokens", () => {
    const { store, dir } = tmpStore();
    try {
      store.set("a", { accessToken: "x", tokenType: "Bearer", expiresAt: Date.now() + 3600_000, refreshToken: "r" });
      store.set("b", { accessToken: "y", tokenType: "Bearer", expiresAt: Date.now() - 1000 });

      const s = store.status();
      assert.equal(s.length, 2);
      const a = s.find(t => t.issuer === "a");
      assert.ok(a);
      assert.equal(a.hasAccess, true);
      assert.equal(a.hasRefresh, true);
      const b = s.find(t => t.issuer === "b");
      assert.ok(b);
      assert.equal(b.hasAccess, false);
      assert.equal(b.hasRefresh, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
