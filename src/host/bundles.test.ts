/**
 * Bundles: capability attached to a place.
 *
 * What must hold: a box's capability is the union of what the installation and the box
 * carry; skills narrow only when some bundle lists them; a repository mode conflict is
 * loud; a migration from scopes is a plan that drops chat bindings, keeps tools off the
 * bundle, and attaches nothing for an agent whose box it cannot name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleConflictError, BundleStore, narrowSkills, planMigration, unionBundles } from "./bundles.ts";

function tempStore(): { store: BundleStore; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-bundles-"));
  const path = join(dir, "bundles.json");
  return { store: new BundleStore(path), path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const alpha = { id: "alpha", name: "Alpha box", displayFloor: 1 } as { id: string; name: string };
const beta = { id: "beta", name: "Beta box" };

test("a box carries the installation's defaults plus its own, unioned, and grants their secrets", () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.save({
      bundles: [
        { id: "base", name: "Everyone", secretIds: ["SEARCH_KEY"], egressHosts: ["api.search.test"] },
        { id: "vendor", name: "Vendor work", secretIds: ["VENDOR_KEY"], skills: ["deploy"], instructions: "Vendor code style." },
      ],
      defaults: ["base"],
      boxes: { "Alpha box": ["vendor"] },
    });
    assert.equal(statSync(path).mode & 0o777, 0o600, "it names secrets, so it is private");

    const a = store.forBox(alpha)!;
    assert.deepEqual(a.names, ["Everyone", "Vendor work"]);
    assert.deepEqual(a.secretIds, ["SEARCH_KEY", "VENDOR_KEY"]);
    assert.deepEqual(a.skills, ["deploy"]);
    assert.deepEqual(a.instructions, ["Vendor code style."]);
    assert.ok(store.grantsSecret(alpha, "VENDOR_KEY"));
    assert.ok(store.grantsSecret(alpha, "SEARCH_KEY"), "the default's secret too");

    // Beta carries only the default: the vendor secret is not its to resolve, and with no
    // bundle listing skills it is offered every skill.
    const b = store.forBox(beta)!;
    assert.deepEqual(b.names, ["Everyone"]);
    assert.equal(b.skills, undefined);
    assert.ok(!store.grantsSecret(beta, "VENDOR_KEY"));
    assert.ok(!store.grantsSecret(undefined, "SEARCH_KEY"), "no box, no grant");
  } finally {
    cleanup();
  }
});

test("skills narrow to the union of what the bundles list, and not at all when none lists any", () => {
  const skills = [{ slug: "deploy" }, { slug: "triage" }, { slug: "write-docs" }];
  const listed = unionBundles([
    { id: "a", name: "A", secretIds: [], skills: ["deploy"] },
    { id: "b", name: "B", secretIds: [], skills: ["triage"] },
    { id: "c", name: "C", secretIds: [] },
  ]);
  assert.deepEqual(narrowSkills(skills, listed).map(s => s.slug), ["deploy", "triage"]);
  const none = unionBundles([{ id: "c", name: "C", secretIds: [] }]);
  assert.deepEqual(narrowSkills(skills, none).map(s => s.slug), ["deploy", "triage", "write-docs"]);
  assert.deepEqual(narrowSkills(skills, undefined).map(s => s.slug), ["deploy", "triage", "write-docs"]);
});

test("two bundles that disagree about a repository's mode are an error, not a quiet winner", () => {
  assert.throws(
    () =>
      unionBundles([
        { id: "a", name: "A", secretIds: [], repositories: [{ path: "/home/box/work/site", mode: "ro" }] },
        { id: "b", name: "B", secretIds: [], repositories: [{ path: "/home/box/work/site", mode: "rw" }] },
      ]),
    BundleConflictError
  );
  // Agreeing is fine, and the path is listed once.
  const agreed = unionBundles([
    { id: "a", name: "A", secretIds: [], repositories: [{ path: "/x", mode: "rw" }] },
    { id: "b", name: "B", secretIds: [], repositories: [{ path: "/x", mode: "rw" }, { path: "/y", mode: "ro" }] },
  ]);
  assert.deepEqual(agreed.repositories, [{ path: "/x", mode: "rw" }, { path: "/y", mode: "ro" }]);
});

test("a broken or missing file is no bundles, and a dangling attachment is reported not thrown", () => {
  const { store, path, cleanup } = tempStore();
  try {
    assert.equal(store.forBox(alpha), undefined);
    writeFileSync(path, "{not json");
    store.reload();
    assert.equal(store.forBox(alpha), undefined);
    store.save({ bundles: [{ id: "base", name: "Base", secretIds: [] }], defaults: ["base", "typo"] });
    assert.deepEqual(store.forBox(alpha)?.names, ["Base"]);
    assert.deepEqual(store.dangling(), ["typo"]);
  } finally {
    cleanup();
  }
});

test("migrating scopes is a plan: secrets travel, tools stay on the agent, chats are dropped, unknown boxes fail closed", () => {
  const { file, report } = planMigration(
    [
      { id: "vendor", name: "Vendor", tools: ["bash"], secretIds: ["VENDOR_KEY"], egressHosts: ["vendor.test"], filesRoot: "/home/box/work/vendor", chats: ["feishu:oc_1"] },
      { id: "orphan", name: "Nobody's", secretIds: [] },
    ],
    [
      { id: "a1", name: "Ada", scopeId: "vendor", box: alpha },
      { id: "a2", name: "Bob", scopeId: "vendor", box: undefined },
      { id: "a3", name: "Cy", scopeId: "missing", box: alpha },
      { id: "a4", name: "Di" },
    ]
  );
  const vendor = file.bundles.find(b => b.id === "vendor")!;
  assert.deepEqual(vendor.secretIds, ["VENDOR_KEY"]);
  assert.deepEqual(vendor.egressHosts, ["vendor.test"]);
  assert.deepEqual(vendor.repositories, [{ path: "/home/box/work/vendor", mode: "rw" }]);
  assert.equal("tools" in vendor, false, "tools are not a bundle field");
  assert.deepEqual(file.boxes, { "Alpha box": ["vendor"] }, "attached where Ada lives; Bob's box is unknown");
  const text = report.join("\n");
  assert.match(text, /tools \[bash\] stay on the agent/);
  assert.match(text, /chat bindings dropped .*feishu:oc_1/);
  assert.match(text, /Bob: box unknown; vendor NOT attached/);
  assert.match(text, /Cy: scope missing does not exist/);
  assert.ok(file.bundles.some(b => b.id === "orphan"), "an unattached scope still becomes a bundle");
});

test("a box's bundles travel as refs (ids, never values), and a person attaches an existing bundle idempotently — never one made from a name", () => {
  const { store, cleanup } = tempStore();
  try {
    store.save({
      bundles: [
        { id: "gh", name: "github", secretIds: ["GITHUB_TOKEN"], connectors: ["mcp:github"], repositories: [{ path: "/repo", mode: "ro" }] },
        { id: "notes", name: "notes", secretIds: [] },
      ],
      boxes: { [alpha.id]: ["gh"] },
    });
    assert.deepEqual(store.refsFor(alpha), [{ name: "github", needs: { connectors: ["mcp:github"], secretIds: ["GITHUB_TOKEN"], repositories: [{ path: "/repo", mode: "ro" }] } }]);
    assert.deepEqual(store.refsFor(beta), []);

    assert.equal(store.attach(beta, "notes"), true);
    assert.equal(store.attach(beta, "notes"), true, "binding twice is one attachment");
    assert.deepEqual(store.attachments().boxes[beta.id], ["notes"]);
    assert.equal(store.attach(beta, "github-from-a-template"), false, "a name is not a bundle");
    assert.deepEqual(store.forBox(beta)?.names, ["notes"]);
    // What the box may do is read from the store each time, so a detached bundle is gone at the next look.
    store.save({ bundles: store.list(), boxes: { [alpha.id]: ["gh"] } });
    assert.equal(store.forBox(beta), undefined);
  } finally {
    cleanup();
  }
});

test("a secret is granted to a box, and an agent's own scope is not a subject any more (INV-539)", () => {
  // docs/22 §3's second live violation: `RunOnHost` resolved a secret off the calling
  // agent's `scopeId`, so two agents in one box demonstrably differed in secret reach.
  // The subject is the box; a scope that used to grant it grants nothing until
  // `agentbox bundle migrate` has turned it into the box's bundle — fail-closed, because
  // the alternative is one agent quietly holding what its neighbour cannot.
  const { store, cleanup } = tempStore();
  try {
    store.save({
      bundles: [{ id: "vendor", name: "Vendor work", secretIds: ["VENDOR_KEY"] }],
      defaults: [],
      boxes: { "Alpha box": ["vendor"] },
    });
    assert.ok(store.grantsSecret(alpha, "VENDOR_KEY"), "the box's bundle grants it");
    assert.equal(store.grantsSecret(beta, "VENDOR_KEY"), false, "and grants it to that box only");
    // Whichever agent in Alpha asks, the answer is the same: there is no argument through
    // which two agents in one box could differ, which is the whole of the fix.
  } finally {
    cleanup();
  }
});
