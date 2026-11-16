import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { poppyBrowserJoinUrl, clearJoinCache } from "./poppy-browser.ts";

/** A minimal fake PoppyManager for testing. */
function fakeManager(domains: Record<string, string | null> = {}) {
  return {
    ready: true,
    async browserJoin(domain: string) {
      const url = domains[domain];
      if (url === undefined || url === null) return null;
      return { url, raw: {} };
    },
  } as unknown as Parameters<typeof poppyBrowserJoinUrl>[0];
}

describe("poppyBrowserJoinUrl", () => {
  beforeEach(() => clearJoinCache());

  test("returns a join URL for a supported domain", async () => {
    const mgr = fakeManager({ "shop.example": "https://shop.example/join?t=abc" });
    const url = await poppyBrowserJoinUrl(mgr, "ada", "https://shop.example/products");
    assert.equal(url, "https://shop.example/join?t=abc");
  });

  test("returns undefined for a domain without Browser Join", async () => {
    const mgr = fakeManager({ "shop.example": null });
    const url = await poppyBrowserJoinUrl(mgr, "ada", "https://shop.example/products");
    assert.equal(url, undefined);
  });

  test("returns undefined on subsequent calls (cached)", async () => {
    const mgr = fakeManager({ "shop.example": "https://shop.example/join?t=abc" });
    const first = await poppyBrowserJoinUrl(mgr, "ada", "https://shop.example/products");
    assert.equal(first, "https://shop.example/join?t=abc");

    const second = await poppyBrowserJoinUrl(mgr, "ada", "https://shop.example/other-page");
    assert.equal(second, undefined);
  });

  test("each agent joins its own session, and a plain-http page is never joined", async () => {
    const mgr = fakeManager({ "shop.example": "https://shop.example/join?t=abc" });
    assert.ok(await poppyBrowserJoinUrl(mgr, "ada", "https://shop.example/a"));
    assert.ok(await poppyBrowserJoinUrl(mgr, "bob", "https://shop.example/a"), "Bob's browser is not joined by Ada's join");
    assert.equal(await poppyBrowserJoinUrl(mgr, "cy", "http://shop.example/a"), undefined);
  });

  test("handles invalid URLs gracefully", async () => {
    const mgr = fakeManager({});
    const url = await poppyBrowserJoinUrl(mgr, "ada", "not-a-url");
    assert.equal(url, undefined);
  });
});
