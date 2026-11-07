/**
 * The item shape and the admission check (INV-1725, docs/98 §4 and §6).
 *
 * Three claims: the new fields survive a write and a read; a record older than them keeps the
 * visibility it had; and a scope or surface the reader is not entitled to never reaches ranking —
 * an unknown scope is visible to nobody, another box's record to nobody outside it, and a
 * cite-only item is read by id and never recalled.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AgentRegistry } from "../agents/registry.ts";
import { AgentBus } from "../agents/bus.ts";
import type { BoxEntry } from "../box/boxes.ts";
import type { MemoryRecord } from "./memory.ts";
import { versionOf } from "./memory-admin.ts";
import { admitted, citedById, evidenceKind, recallable, scopeOf, type MemoryReader } from "./memory-scope.ts";
import { fakeModel } from "./testing/fake-model.ts";
import { dispatchTool } from "./tools.ts";
import { runTurn } from "./turn.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-memory-scope-"));
  const registry = new AgentRegistry(root);
  const sales = registry.attachBox({
    id: "box-sales", name: "sales", kind: "attached", displayFloor: 10, workDir: "/home/box/work",
    members: ["p-ann", "p-ben"], createdAt: new Date().toISOString(),
  } as never) as BoxEntry;
  return { registry, sales, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const fact = (text: string, extra: Partial<MemoryRecord> = {}): MemoryRecord => ({ at: "2026-11-07T01:00:00.000Z", kind: "fact", text, ...extra });

test("the new fields are written and read back as given; an L3 record carries none of them", () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const item = fact("releases ship on Thursdays", {
      scope: `box:${registry.box.id}`, surface: "recall", owner: "p-ann",
      evidence: ["task:t12", "inv:INV-1581", "commit:0344280", "doc:docs/98", "receipt:r-9", "c-1@2026-11-07T00:59:00.000Z"],
      validFrom: "2026-11-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z", supersedes: "abc123def456",
      verifiedBy: "p-ben", verifiedAt: "2026-11-07T02:00:00.000Z", reviewBy: "2027-02-01T00:00:00.000Z",
    });
    registry.appendSharedMemory(ada.id, [item]);
    const [read] = registry.readSharedMemory(ada.id);
    const { via: _via, box: _box, ...stored } = read!;
    assert.deepEqual(stored, item);
    assert.deepEqual(item.evidence!.map(evidenceKind), ["task", "inv", "commit", "doc", "receipt", "conversation"]);
    assert.equal(evidenceKind("whatever"), undefined, "an untyped reference is not evidence");

    registry.appendMemoryRecords(ada.id, [fact("Ada prefers short answers")]);
    const own = registry.readMemoryRecords(ada.id);
    assert.equal(own.length, 1);
    for (const field of ["scope", "surface", "owner", "evidence", "validFrom", "validUntil", "supersedes", "verifiedBy", "verifiedAt", "reviewBy"]) {
      assert.equal(field in own[0]!, false, `an agent's own record leaves ${field} absent`);
    }
  } finally {
    cleanup();
  }
});

test("records older than the fields keep the visibility they had", () => {
  assert.equal(scopeOf(fact("mine"), "own"), "agent", "an agent's own record is the agent's");
  assert.equal(scopeOf(fact("box", { box: "b1" }), "shared"), "box:b1", "a shared record is its box's");
  assert.equal(scopeOf(fact("all", { box: "b1", audience: "everyone" }), "shared"), "org", "an approved promotion is every box's (INV-1722)");
  assert.equal(
    scopeOf(fact("held", { box: "b1", audience: "everyone", held: { question: "q", confidence: 1 } }), "shared"),
    "box:b1",
    "a promotion nobody approved stays in its box"
  );
  assert.equal(scopeOf(fact("before boxes"), "shared"), "org", "a record from before boxes was visible everywhere, and still is");
  assert.equal(scopeOf(fact("given", { box: "b1", scope: "agent" }), "shared"), "agent", "a stored scope is used as given");
});

test("scope is admitted before ranking: unknown, missing or other boxes admit nobody, and a box asks mayEnterBox", () => {
  const { registry, sales, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const sam = registry.create({ name: "Sam", boxId: sales.id });
    registry.appendSharedMemory(sam.id, [
      fact("sales quota is 40 deals"),
      fact("only Sam's own", { scope: "agent" }),
      fact("for the whole organisation", { scope: "org" }),
      fact("a scope nobody defined", { scope: "team" as never }),
      fact("a box that is gone", { scope: "box:box-gone" }),
      fact("the default box's, kept from sales", { scope: `box:${registry.box.id}` }),
    ]);
    const texts = (records: MemoryRecord[]) => records.map(record => record.text).sort();

    assert.deepEqual(texts(registry.readSharedMemory(sam.id, "p-ann")), ["for the whole organisation", "only Sam's own", "sales quota is 40 deals"]);
    assert.deepEqual(texts(registry.readSharedMemory(sam.id)), ["for the whole organisation", "only Sam's own", "sales quota is 40 deals"], "the operator's credential is in every box");
    assert.deepEqual(texts(registry.readSharedMemory(sam.id, "p-carl")), ["for the whole organisation", "only Sam's own"], "a person who may not enter sales reads none of it");
    assert.deepEqual(
      texts(registry.readSharedMemory(ada.id)),
      ["for the whole organisation", "the default box's, kept from sales"],
      "another box's record and another agent's are invisible across boxes"
    );

    // The check itself, without the registry: the same answers from the same inputs.
    const reader: MemoryReader = { agentId: ada.id, boxId: registry.box.id, boxById: id => registry.boxById(id) };
    assert.deepEqual(texts(admitted([fact("x", { scope: "box:" as never }), fact("y", { scope: 7 as never })], "shared", reader)), [], "a malformed scope admits nobody");
    assert.deepEqual(texts(admitted([fact("mine")], "own", reader)), ["mine"], "an agent reads its own tier as before");
    const inGoneBox: MemoryReader = { agentId: ada.id, boxId: "box-gone", boxById: () => undefined };
    assert.deepEqual(texts(admitted([fact("z", { scope: "box:box-gone" })], "shared", inGoneBox)), [], "a box that no longer exists admits nobody");
  } finally {
    cleanup();
  }
});

test("a cite-only item is never recalled, by the prompt or by Recall, and is read by its id", async () => {
  const { registry, cleanup } = fixture();
  try {
    const ada = registry.create({ name: "Ada" });
    const bus = new AgentBus(registry, async () => {});
    const citeOnly = fact("the Thursday release quokka list lives in doc 98", { surface: "cite-only" });
    registry.appendSharedMemory(ada.id, [fact("the Thursday release goes out at noon"), citeOnly, fact("an odd surface on Thursday release", { surface: "pinned" as never })]);
    registry.appendMemoryRecords(ada.id, [fact("my own Thursday release note", { surface: "cite-only" })]);

    const live = registry.readSharedMemory(ada.id);
    assert.equal(live.length, 3, "admitted: a surface does not decide who may read it");
    assert.deepEqual(recallable(live).map(record => record.text), ["the Thursday release goes out at noon"], "an undefined surface is not recalled either");
    assert.equal(citedById(live, versionOf(citeOnly))?.text, citeOnly.text);
    assert.equal(citedById(live, "000000000000"), undefined);

    const recall = await dispatchTool("Recall", { search: "Thursday release" }, { agent: ada, registry, bus, box: undefined as never });
    assert.match(recall.text, /goes out at noon/);
    assert.doesNotMatch(recall.text, /quokka|odd surface|my own Thursday/, "Recall finds only what may be recalled");

    const systems: string[] = [];
    const client = fakeModel(({ params }) => {
      systems.push((params.system as Anthropic.TextBlockParam[]).map(block => block.text).join("\n"));
      return { id: "m", type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "ok", citations: null }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
    });
    await runTurn(ada, [{ id: "m1", fromId: "user", fromName: "user", text: "when does the Thursday release go out?", priority: false, receivedAt: "" }], new AbortController().signal, { client, registry, bus, box: undefined, resolution: undefined });
    assert.match(systems[0]!, /goes out at noon/, "a recall item reaches the prompt");
    assert.doesNotMatch(systems[0]!, /quokka|odd surface|my own Thursday/, "a cite-only item never does");
  } finally {
    cleanup();
  }
});
