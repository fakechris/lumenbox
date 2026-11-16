import { describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoppyFetch, poppyFor } from "./poppy-fetch.ts";
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

  test("a fetch with Poppy on still goes through the guarded fetch, and Poppy's own failures do not surface", async t => {
    // Hermetic: discovery's own requests are refused here, and the page is a loopback address the
    // guarded fetch refuses before any connection — so nothing leaves this machine.
    const home = mkdtempSync(join(tmpdir(), "poppy-fetch-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in tests"); });
    const { fetch } = createPoppyFetch({ home, origin: "https://test.agent.example" }, () => {});
    await assert.rejects(fetch("http://127.0.0.1/page"), (error: Error) => !error.message.includes("PoppyManager"));
  });
});

describe("poppyFor", () => {
  test("off unless the operator turned it on and the host has a public https address", () => {
    const home = "/nonexistent-poppy-home";
    assert.equal(poppyFor({}, home, () => {}), undefined, "off by default");
    assert.equal(poppyFor({ AGENTBOX_PUBLIC_URL: "https://agent.example" }, home, () => {}), undefined, "a public address alone does not turn it on");
    assert.equal(poppyFor({ AGENTBOX_POPPY: "1" }, home, () => {}), undefined, "nothing a Company could verify a session against");
    assert.equal(poppyFor({ AGENTBOX_POPPY: "1", AGENTBOX_PUBLIC_URL: "http://agent.example" }, home, () => {}), undefined, "not over plain http");
    const on = poppyFor({ AGENTBOX_POPPY: "1", AGENTBOX_PUBLIC_URL: "https://agent.example/" }, home, () => {});
    assert.equal(typeof on?.webFetch, "function");
    assert.equal(on?.poppyManager.ready, false, "made lazily: nothing written until it is used");
  });
});
