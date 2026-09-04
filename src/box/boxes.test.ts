/**
 * Many boxes, one registry (docs/30): the list migrates from the single record and keeps its
 * id, an agent is created into a box and stays there, desktops are allocated per box from
 * its floor, and a box with residents cannot be forgotten.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRegistry } from "../agents/registry.ts";
import { attachedBox, BOXES_FILENAME, ensureBoxes, tokenOf } from "./boxes.ts";

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

test("members read in any shape the file has held: the three bindings, and the honest default", () => {
  const { root, cleanup } = fixture();
  try {
    const agents = join(root, "agents");
    new AgentRegistry(agents); // writes boxes.json
    const path = join(agents, BOXES_FILENAME);
    const ownId = JSON.parse(readFileSync(join(agents, "box.json"), "utf8")).id;

    // Legacy shapes still load: "everyone" and the bare id list.
    writeFileSync(path, JSON.stringify([{ id: ownId, name: "own", members: "everyone" }]), "utf8");
    assert.deepEqual(new AgentRegistry(agents).listBoxes()[0]!.members, { kind: "everyone" });
    writeFileSync(path, JSON.stringify([{ id: ownId, name: "own", members: ["p-ada", "p-bob"] }]), "utf8");
    assert.deepEqual(new AgentRegistry(agents).listBoxes()[0]!.members, {
      kind: "listed",
      principalIds: ["p-ada", "p-bob"],
    });

    // The three bindings round-trip, and garbage degrades to the honest default.
    const shapes: Array<unknown> = [
      { kind: "everyone" },
      { kind: "listed", principalIds: ["p-ada"] },
      { kind: "department", channelId: "feishu", departmentVendorId: "od_1" },
      { nonsense: true }, // not a members shape anyone wrote on purpose
    ];
    const expected = [
      { kind: "everyone" },
      { kind: "listed", principalIds: ["p-ada"] },
      { kind: "department", channelId: "feishu", departmentVendorId: "od_1" },
      { kind: "everyone" },
    ];
    for (let i = 0; i < shapes.length; i++) {
      writeFileSync(path, JSON.stringify([{ id: ownId, name: "own", members: shapes[i] }]), "utf8");
      assert.deepEqual(
        new AgentRegistry(agents).listBoxes()[0]!.members,
        expected[i],
        `shape ${i} normalized`,
      );
    }

    // setBoxMembers changes only that, and it survives a reload.
    const registry = new AgentRegistry(agents);
    registry.setBoxMembers(ownId, { kind: "listed", principalIds: ["p-ada"] });
    assert.deepEqual(new AgentRegistry(agents).listBoxes()[0]!.members, {
      kind: "listed",
      principalIds: ["p-ada"],
    });
  } finally {
    cleanup();
  }
});

test("a box names one scope: setBoxScope persists, and it is the box's workers' vault reach", () => {
  const { root, cleanup } = fixture();
  try {
    const registry = new AgentRegistry(join(root, "agents"));
    const own = registry.defaultBox();
    assert.equal(own.scopeId, undefined, "a box without a scope grants no scope secrets — fail closed");

    registry.setBoxScope(own.id, "team");
    assert.equal(new AgentRegistry(join(root, "agents")).defaultBox().scopeId, "team", "the scope survives a reload");

    // And it can be taken away again — removing reach is an operator act like granting it.
    registry.setBoxScope(own.id, undefined);
    assert.equal(new AgentRegistry(join(root, "agents")).defaultBox().scopeId, undefined);
  } finally {
    cleanup();
  }
});
