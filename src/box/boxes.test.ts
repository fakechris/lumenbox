/**
 * Many boxes, one registry (docs/30): the list migrates from the single record and keeps its
 * id, an agent is created into a box and stays there, desktops are allocated per box from
 * its floor, and a box with residents cannot be forgotten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import { BOXES_FILENAME, attachedBox, ensureBoxes, tokenOf } from "./boxes.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentbox-boxes-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("the list migrates from box.json and keeps the installation's id; a foreign list is refused", () => {
  const { root, cleanup } = fixture();
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const path = join(root, "agents", BOXES_FILENAME);
    assert.ok(existsSync(path), "boxes.json was written on first contact");
    const [own] = registry.listBoxes();
    assert.equal(own?.id, registry.box.id);
    assert.equal(own?.kind, "docker");
    assert.equal(own?.displayFloor, 1);
    assert.equal(registry.defaultBox().id, registry.box.id);

    // A second registry on the same directory reads the same list.
    assert.equal(new AgentRegistry(join(root, "agents")).listBoxes()[0]?.id, own?.id);

    // A list without this installation's box is somebody else's and must not be adopted.
    writeFileSync(path, JSON.stringify([{ id: "box_other", name: "theirs" }]));
    assert.throws(() => ensureBoxes(path, registry.box), /does not contain this installation's box/);
  } finally {
    cleanup();
  }
});

test("an agent is created into a box, stays there, and gets a desktop from that box's floor", () => {
  const { root, cleanup } = fixture();
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const tokenFile = join(root, "grok.token");
    writeFileSync(tokenFile, "secret-token\n");
    const grok = registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://127.0.0.1:13370/", tokenFile, displayFloor: 10 }));
    assert.equal(grok.endpoint?.baseUrl, "http://127.0.0.1:13370");
    assert.equal(tokenOf(grok), "secret-token");
    assert.equal(readFileSync(join(root, "agents", BOXES_FILENAME), "utf8").includes("secret-token"), false, "the token is never in the record");

    const ada = registry.create({ name: "Ada" });
    const rex = registry.create({ name: "Rex" });
    const vera = registry.create({ name: "Vera", boxId: grok.id });
    const ops = registry.create({ name: "Ops", boxId: grok.id });
    assert.equal(ada.profile.boxId, registry.box.id, "the default is the installation's own box");
    assert.equal(vera.profile.boxId, grok.id);
    assert.deepEqual([ada, rex].map(record => record.profile.displayIndex), [1, 2]);
    assert.deepEqual([vera, ops].map(record => record.profile.displayIndex), [10, 11], "the attached box counts from its floor");
    assert.equal(registry.boxOf(vera.id).name, "grok");
    assert.deepEqual(registry.agentsIn(grok.id).map(record => record.profile.name).sort(), ["Ops", "Vera"]);

    // Immutable: update has no such field, and the profile on disk still says grok.
    registry.update(vera.id, { name: "Vera 2" });
    assert.equal(registry.get(vera.id).profile.boxId, grok.id);

    // Unknown box: refused at creation, not discovered at the first turn.
    assert.throws(() => registry.create({ name: "Nope", boxId: "box_missing" }), /attach it first/);
    assert.throws(() => registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://x", tokenFile })), /already attached/);

    // A box with residents cannot be forgotten; the own box never can.
    assert.throws(() => registry.detachBox("grok"), /2 agent\(s\) live in grok/);
    assert.throws(() => registry.detachBox(registry.box.id), /own box cannot be detached/);
    registry.remove(vera.id, { archive: false });
    registry.remove(ops.id, { archive: false });
    registry.detachBox("grok");
    assert.equal(registry.listBoxes().length, 1);
  } finally {
    cleanup();
  }
});

test("a box name and endpoint are checked before anything is written", () => {
  assert.throws(() => attachedBox({ name: "not a name!", baseUrl: "http://x", tokenFile: "/t" }), /not a box name/);
  assert.throws(() => attachedBox({ name: "ok", baseUrl: "nope", tokenFile: "/t" }), /not a URL/);
  assert.throws(() => attachedBox({ name: "ok", baseUrl: "ftp://x", tokenFile: "/t" }), /http or https/);
  assert.equal(tokenOf(attachedBox({ name: "ok", baseUrl: "http://x", tokenFile: "/nonexistent/token" })), undefined);
});

test("an attached box can move to a new address and keep its id, its name and its agents", () => {
  const { root, cleanup } = fixture();
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const tokenFile = join(root, "grok.token");
    writeFileSync(tokenFile, "t\n");
    const grok = registry.attachBox(attachedBox({ name: "grok", baseUrl: "http://127.0.0.1:13370", tokenFile, displayFloor: 10 }));
    const kai = registry.create({ name: "Kai", boxId: grok.id });
    const moved = registry.updateBox("grok", { endpoint: { baseUrl: "http://100.114.30.43:13370/", tokenFile } });
    assert.equal(moved.id, grok.id);
    assert.equal(moved.endpoint?.baseUrl, "http://100.114.30.43:13370");
    assert.equal(moved.displayFloor, 10, "unchanged unless asked");
    assert.equal(registry.boxOf(kai.id).endpoint?.baseUrl, "http://100.114.30.43:13370");
    assert.equal(new AgentRegistry(join(root, "agents")).boxByName("grok")?.endpoint?.baseUrl, "http://100.114.30.43:13370", "written through");
    assert.throws(() => registry.updateBox(registry.box.id, { endpoint: { baseUrl: "http://x", tokenFile } }), /own box has no endpoint/);
    assert.throws(() => registry.updateBox("nope", { displayFloor: 3 }), /No box named/);
  } finally {
    cleanup();
  }
});
