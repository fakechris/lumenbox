import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { TokenStore } from "./token-store.ts";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ISSUER = "https://auth.shop.example";
const key = TokenStore.key("ada", "shop.example");
const token = (accessToken: string, ms: number, refreshToken?: string) => ({ accessToken, tokenType: "Bearer", expiresAt: Date.now() + ms, ...(refreshToken ? { refreshToken } : {}) });

function withStore(run: (store: TokenStore, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "poppy-tokens-"));
  try {
    run(new TokenStore(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("TokenStore", () => {
  test("a token is kept per person and domain, owner-only on disk, and survives a restart", () => {
    withStore((store, dir) => {
      store.set(key, ISSUER, { ...token("at_1", 3600_000, "rt_1"), scope: "read" });
      assert.equal(store.get(key, ISSUER)?.accessToken, "at_1");
      assert.equal(store.get(TokenStore.key("bob", "shop.example"), ISSUER), undefined, "another person's sign-in is not this one's");
      assert.equal(new TokenStore(dir).get(key, ISSUER)?.refreshToken, "rt_1");
      assert.equal(statSync(join(dir, "poppy-tokens.json")).mode & 0o777, 0o600);
    });
  });

  test("a site that names another Company's issuer is not handed that Company's token", () => {
    withStore(store => {
      store.set(key, ISSUER, token("at_shop", 3600_000));
      assert.equal(store.get(TokenStore.key("ada", "evil.example"), ISSUER), undefined, "keyed by the domain it was granted at");
      assert.equal(store.get(key, "https://auth.evil.example"), undefined, "and only while that domain still names its issuer");
    });
  });

  test("a refresh that sends no new refresh token keeps the old one", () => {
    withStore(store => {
      store.set(key, ISSUER, token("at_1", 3600_000, "rt_1"));
      store.set(key, ISSUER, token("at_2", 3600_000), { refreshed: true });
      assert.equal(store.get(key, ISSUER)?.refreshToken, "rt_1");
      assert.equal(store.get(key, ISSUER)?.accessToken, "at_2");
    });
  });

  test("a sign-in that sends no refresh token does not inherit the last account's", () => {
    withStore(store => {
      store.set(key, ISSUER, token("at_old_account", 3600_000, "rt_old_account"));
      store.set(key, ISSUER, token("at_new_account", 3600_000));
      assert.equal(store.get(key, ISSUER)?.refreshToken, undefined);
    });
  });

  test("validity and refresh-ahead", () => {
    withStore(store => {
      store.set(key, ISSUER, token("at", 3600_000));
      const fresh = store.get(key, ISSUER)!;
      assert.ok(store.hasValid(fresh) && !store.needsRefresh(fresh));
      store.set(key, ISSUER, token("at", 30_000));
      const soon = store.get(key, ISSUER)!;
      assert.ok(store.hasValid(soon) && store.needsRefresh(soon), "inside the minute before expiry");
      store.set(key, ISSUER, token("at", -1000));
      assert.ok(!store.hasValid(store.get(key, ISSUER)!));
    });
  });

  test("an entry written before tokens were keyed by person and domain is not used", () => {
    withStore((_, dir) => {
      writeFileSync(join(dir, "poppy-tokens.json"), JSON.stringify([{ issuer: ISSUER, accessToken: "old", tokenType: "Bearer", expiresAt: Date.now() + 3600_000, updatedAt: 0 }]));
      assert.equal(new TokenStore(dir).get(ISSUER, ISSUER), undefined);
    });
  });

  test("status names keys and issuers, never a token, and narrows to one person", () => {
    withStore(store => {
      store.set(key, ISSUER, token("at_secret", 3600_000, "rt_secret"));
      store.set(TokenStore.key("bob", "shop.example"), ISSUER, token("at_bob", 3600_000));
      const ada = store.status("ada|");
      assert.equal(ada.length, 1);
      assert.doesNotMatch(JSON.stringify(ada), /secret/);
    });
  });
});
