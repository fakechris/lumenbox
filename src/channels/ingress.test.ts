/**
 * Tests for the record of what arrived and what became of it.
 *
 * The property under test is that **nothing disappears quietly**. A message that arrived
 * and was discarded must be distinguishable, afterwards and from disk alone, from one
 * that never arrived and from one that is still being worked on. Those three produce the
 * same silence for the person waiting, and until this ledger existed they produced the
 * same silence in the records too — finding out which took two rounds of adding log lines
 * and asking somebody to send the message again.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ingress, ingressPath } from "./ingress.ts";

const arrival = (id: string, over: Partial<Parameters<Ingress["arrived"]>[0]> = {}) => ({
  id,
  channel: "feishu",
  identity: "feishu:ou_chris",
  chatKey: "feishu:oc_room",
  kind: "text",
  chars: 42,
  at: "2026-08-25T10:00:00.000Z",
  ...over,
});

test("the three ways nothing comes back are told apart", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-ingress-"));
  try {
    const ledger = new Ingress(ingressPath(home));
    ledger.arrived(arrival("m1"));
    ledger.decided("m1", "dropped", "unhandled message type post");
    ledger.arrived(arrival("m2"));
    ledger.decided("m2", "refused", "feishu:ou_stranger");
    ledger.arrived(arrival("m3")); // still going
    // m4 never arrived, and so is simply absent.

    const byId = new Map(new Ingress(ingressPath(home)).list().map(r => [r.id, r]));
    assert.equal(byId.get("m1")?.fate, "dropped");
    // The reason is the whole point: "dropped" alone would still leave somebody guessing.
    assert.match(byId.get("m1")?.reason ?? "", /unhandled message type post/);
    assert.equal(byId.get("m2")?.fate, "refused");
    assert.equal(byId.get("m3")?.fate, undefined);
    assert.equal(byId.has("m4"), false);

    // The one state no other record in the system can show.
    assert.deepEqual(new Ingress(ingressPath(home)).unresolved().map(r => r.id), ["m3"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("what arrived survives the process that recorded it", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-ingress-"));
  try {
    const path = ingressPath(home);
    new Ingress(path).arrived(arrival("m1", { kind: "post", chars: 900 }));
    // A different instance, standing in for the next process — which is when anybody
    // actually reads this.
    const [record] = new Ingress(path).list();
    assert.equal(record?.kind, "post");
    assert.equal(record?.chars, 900);
    assert.equal(record?.identity, "feishu:ou_chris");

    // A crash mid-append leaves a torn line and nothing else.
    appendFileSync(path, '{"event":"arrived","arrival":{"id":"m2","cha');
    assert.deepEqual(new Ingress(path).list().map(r => r.id), ["m1"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the ledger is a queue of open questions, not a history", () => {
  const home = mkdtempSync(join(tmpdir(), "lumen-ingress-"));
  try {
    const path = ingressPath(home);
    const ledger = new Ingress(path);
    ledger.arrived(arrival("open-one"));
    for (let index = 0; index < 600; index++) {
      ledger.arrived(arrival(`m${index}`));
      ledger.decided(`m${index}`, "admitted");
    }
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    assert.ok(lines < 400, `should stay bounded, got ${lines}`);

    // And the unresolved one survives compaction, which is the only thing compaction
    // could get catastrophically wrong: it is the record somebody is looking for.
    assert.deepEqual(new Ingress(path).unresolved().map(r => r.id), ["open-one"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
