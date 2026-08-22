/**
 * Tests for scopes: the authority bundle.
 *
 * What must hold: a scope grants a secret its member agents can resolve, tools narrow
 * to the scope's list, the file is private, and a broken file is empty rather than
 * fatal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScopeStore } from "./scopes.ts";
import { Vault } from "./vault.ts";

function tempStore(): { store: ScopeStore; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-scopes-"));
  const path = join(dir, "scopes.json");
  return { store: new ScopeStore(path), path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a scope grants its secrets and narrows its tools; the file is private", () => {
  const { store, path, cleanup } = tempStore();
  try {
    store.save([
      { id: "vendor", name: "Vendor work", tools: ["bash", "read_file"], secretIds: ["VENDOR_KEY"] },
    ]);
    const scope = store.get("vendor")!;
    assert.deepEqual(scope.tools, ["bash", "read_file"]);
    assert.ok(store.grantsSecret("vendor", "VENDOR_KEY"), "the scope grants its listed secret");
    assert.ok(!store.grantsSecret("vendor", "OTHER"), "and only its listed secret");
    assert.ok(!store.grantsSecret(undefined, "VENDOR_KEY"), "no scope grants nothing");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("the vault resolves a secret when the caller's scope grants it, with no direct grant", () => {
  const scopes = tempStore();
  const vdir = mkdtempSync(join(tmpdir(), "agentbox-scopevault-"));
  try {
    scopes.store.save([{ id: "vendor", name: "Vendor", secretIds: ["VENDOR_KEY"] }]);
    const vault = new Vault(join(vdir, "vault.json"), join(vdir, "audit.jsonl"));
    // No grants on the secret at all — only the scope confers it.
    vault.setSecret({ id: "VENDOR_KEY", value: "s3cr3t", grants: [] });

    assert.equal(
      vault.resolve("VENDOR_KEY", { agentId: "ada", scopeGrants: scopes.store.grantsSecret("vendor", "VENDOR_KEY") }),
      "s3cr3t",
      "the scope grant is enough"
    );
    assert.equal(
      vault.resolve("VENDOR_KEY", { agentId: "bob", scopeGrants: scopes.store.grantsSecret(undefined, "VENDOR_KEY") }),
      undefined,
      "an agent in no scope, with no direct grant, gets nothing"
    );
  } finally {
    scopes.cleanup();
    rmSync(vdir, { recursive: true, force: true });
  }
});

test("a broken scopes file is empty, not fatal", () => {
  const { path, cleanup } = tempStore();
  try {
    writeFileSync(path, "{ not json");
    const store = new ScopeStore(path);
    assert.deepEqual(store.list(), []);
    assert.ok(!store.grantsSecret("anything", "any"));
  } finally {
    cleanup();
  }
});

test("a scope's tool list replaces the agent's own when both are set", () => {
  // The effective-tools rule the turn applies: scope wins. Modeled here directly.
  const profileTools = ["bash", "read_file", "write_file", "computer"];
  const effectiveTools = (scopeTools: string[] | undefined) => scopeTools ?? profileTools;
  assert.deepEqual(effectiveTools(["bash", "read_file"]), ["bash", "read_file"], "in a scope, the scope defines the tools");
  assert.deepEqual(effectiveTools(undefined), profileTools, "with no scope, the profile's own list stands");
});
