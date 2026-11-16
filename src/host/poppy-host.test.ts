import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { poppyFor } from "./poppy-host.ts";

describe("poppyFor", () => {
  test("off unless the operator turned it on and the host has a public https address", () => {
    const home = "/nonexistent-poppy-home";
    assert.equal(poppyFor({}, home, () => {}), undefined, "off by default");
    assert.equal(poppyFor({ AGENTBOX_PUBLIC_URL: "https://agent.example" }, home, () => {}), undefined, "a public address alone does not turn it on");
    assert.equal(poppyFor({ AGENTBOX_POPPY: "1" }, home, () => {}), undefined, "nothing a Company could verify a session against");
    assert.equal(poppyFor({ AGENTBOX_POPPY: "1", AGENTBOX_PUBLIC_URL: "http://agent.example" }, home, () => {}), undefined, "not over plain http");
    const on = poppyFor({ AGENTBOX_POPPY: "1", AGENTBOX_PUBLIC_URL: "https://agent.example/" }, home, () => {});
    assert.equal(on?.forAgent("ada").poppyManager, on?.poppyManager);
    assert.equal(on?.poppyManager.ready, false, "made lazily: nothing written until a Poppy tool runs");
  });

  test("a turn gets the manager and nothing else: no WebFetch of Poppy's own, so ordinary pages are untouched", () => {
    const on = poppyFor({ AGENTBOX_POPPY: "1", AGENTBOX_PUBLIC_URL: "https://agent.example" }, "/nonexistent-poppy-home", () => {});
    assert.deepEqual(Object.keys(on!.forAgent("ada")), ["poppyManager"]);
  });
});
