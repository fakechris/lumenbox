import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { createPoppyFetch } from "./poppy-fetch.ts";
import type { PoppyManager } from "./poppy/manager.ts";

/**
 * These tests validate the bridge logic — whether Poppy headers are
 * requested in the right circumstances — not the actual HTTP transport,
 * which requires a real server (and is covered by web.test.ts).
 */

function stubOptions() {
  return { home: "/tmp/poppy-test", origin: "https://test.agent.example" };
}

describe("createPoppyFetch", () => {
  test("returns fetch function and manager", () => {
    const { fetch, manager } = createPoppyFetch(stubOptions());
    assert.equal(typeof fetch, "function");
    assert.equal(fetch.length, 1);
    assert.ok(manager);
    assert.equal(manager.ready, false, "manager not yet initialised");
  });

  test("manager starts uninitialised (lazy init on first use)", () => {
    const { manager } = createPoppyFetch(stubOptions());
    assert.equal(manager.ready, false);
  });

  test("fetch falls through to plain fetchPage when manager init fails", async () => {
    const { fetch } = createPoppyFetch(
      { home: "/nonexistent-path-that-will-fail-init", origin: "https://test.agent.example" },
      () => {},
    );
    // The actual fetch will fail (no real server), but it should not throw from Poppy logic
    try {
      await fetch("https://not-a-real-host.test/page");
    } catch (error) {
      // Expected: WebError from DNS/network, NOT a Poppy init error
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("PoppyManager"));
    }
  });
});
