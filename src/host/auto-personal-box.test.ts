/**
 * What a member is told about the box made for them (INV-2221): "being prepared" lasts until what
 * follows the start has ended — the reconnect, and their agent being made — not only until the box
 * is up. Otherwise a direct message in that moment went past "your agent is being prepared" to a
 * shared box's agent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxEntry } from "../box/boxes.ts";
import { AutoPersonalBoxes } from "./auto-personal-box.ts";
import { PersonalBoxes } from "./personal-boxes.ts";

test("a box that has started is still being prepared until its ready step has ended", async () => {
  const home = mkdtempSync(join(tmpdir(), "inv2221-auto-box-"));
  const entries: BoxEntry[] = [];
  let agentMade: () => void = () => {};
  const making = new Promise<void>(resolve => { agentMade = resolve; });
  let reachedReady: () => void = () => {};
  const atReady = new Promise<void>(resolve => { reachedReady = resolve; });
  try {
    const boxes = new PersonalBoxes({
      home, entries: () => entries, quota: () => 1, authorize: () => true, residents: () => 0,
      attach: entry => { entries.push(entry); }, detach: () => {},
      driver: { start: async () => "http://127.0.0.1:1", remove: async () => {} },
    });
    const auto = new AutoPersonalBoxes({ home, boxes, when: () => "activation", eligible: () => true, quota: () => 1, log: () => {}, ready: async () => { reachedReady(); await making; } });
    assert.deepEqual(auto.activated([{ id: "ana", name: "Ana" }], () => "Ana's computer"), ["ana"]);
    await atReady;
    assert.equal(boxes.list("ana")[0]!.status, "ready", "the box itself is up");
    assert.deepEqual(auto.view("ana"), { state: "preparing" }, "and her agent is not made yet");
    agentMade();
    for (let waited = 0; auto.view("ana") !== undefined && waited < 200; waited++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(auto.view("ana"), undefined, "once it is, nothing is being prepared");
  } finally { agentMade(); rmSync(home, { recursive: true, force: true }); }
});
