/**
 * Tests for the credential vault.
 *
 * The claims that matter are the safety ones: a value never leaves through a read
 * path, a resolve is refused unless a live grant covers the caller, an expired grant
 * is dead, and every resolution — allowed or refused — leaves an audit line.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "./vault.ts";

function tempVault(): { vault: Vault; path: string; audit: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-vault-"));
  const path = join(dir, "vault.json");
  const audit = join(dir, "audit.jsonl");
  return { vault: new Vault(path, audit), path, audit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a value never leaves through list; the file is private", () => {
  const { vault, path, cleanup } = tempVault();
  try {
    vault.setSecret({ id: "GITHUB_TOKEN", description: "push token", value: "ghp_secret", grants: [] });
    const listed = vault.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, "GITHUB_TOKEN");
    assert.ok(!("value" in listed[0]!), "no value on a view");
    assert.ok(!JSON.stringify(listed).includes("ghp_secret"), "the value never leaves list()");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("resolve honours grants by agent, principal and wildcard; refuses otherwise", () => {
  const { vault, cleanup } = tempVault();
  try {
    vault.setSecret({
      id: "S1",
      value: "v1",
      grants: [{ holder: "agent:ada" }],
    });
    assert.equal(vault.resolve("S1", { agentId: "ada" }), "v1", "granted to this agent");
    assert.equal(vault.resolve("S1", { agentId: "bob" }), undefined, "not this one");

    vault.setSecret({ id: "S2", value: "v2", grants: [{ holder: "principal:chris" }] });
    assert.equal(
      vault.resolve("S2", { agentId: "anyone", principalId: "chris" }),
      "v2",
      "any agent Chris drives"
    );
    assert.equal(vault.resolve("S2", { agentId: "anyone", principalId: "sam" }), undefined);

    vault.setSecret({ id: "S3", value: "v3", grants: [{ holder: "*" }] });
    assert.equal(vault.resolve("S3", { agentId: "whoever" }), "v3", "everyone");

    assert.equal(vault.resolve("S1", { agentId: "ada" }, new Date()), "v1");
    // An unknown secret and a refused one are the same answer.
    assert.equal(vault.resolve("nope", { agentId: "ada" }), undefined);
  } finally {
    cleanup();
  }
});

test("an expired grant is dead; an unreadable expiry is treated as expired", () => {
  const { vault, cleanup } = tempVault();
  try {
    const past = "2020-01-01T00:00:00Z";
    const future = "2999-01-01T00:00:00Z";
    vault.setSecret({ id: "S", value: "v", grants: [{ holder: "*", expiresAt: past }] });
    assert.equal(vault.resolve("S", { agentId: "a" }), undefined, "expired");

    vault.setSecret({ id: "S", value: "v", grants: [{ holder: "*", expiresAt: future }] });
    assert.equal(vault.resolve("S", { agentId: "a" }), "v", "still live");

    vault.setSecret({ id: "S", value: "v", grants: [{ holder: "*", expiresAt: "not a date" }] });
    assert.equal(vault.resolve("S", { agentId: "a" }), undefined, "a garbage expiry is not a licence");
  } finally {
    cleanup();
  }
});

test("editing a description keeps the value without re-pasting it", () => {
  const { vault, cleanup } = tempVault();
  try {
    vault.setSecret({ id: "K", description: "first", value: "the-secret", grants: [{ holder: "*" }] });
    vault.setSecret({ id: "K", description: "renamed" }); // no value this time
    assert.equal(vault.resolve("K", { agentId: "a" }), "the-secret", "value survived the edit");
    assert.equal(vault.list()[0]!.description, "renamed");
  } finally {
    cleanup();
  }
});

test("every resolution — allowed or refused — leaves an audit line", () => {
  const { vault, audit, cleanup } = tempVault();
  try {
    vault.setSecret({ id: "S", value: "v", grants: [{ holder: "agent:ada" }] });
    vault.resolve("S", { agentId: "ada", agentName: "Ada", principalId: "chris" });
    vault.resolve("S", { agentId: "bob", agentName: "Bob" });

    const lines = readFileSync(audit, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.secretId, "S");
    assert.equal(lines[0]!.allowed, true);
    assert.equal(lines[0]!.principalId, "chris");
    assert.equal(lines[1]!.allowed, false, "the refusal is audited too");
    assert.equal(statSync(audit).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("a reload sees another writer's secret; a broken file is an empty vault", () => {
  const { vault, path, audit, cleanup } = tempVault();
  try {
    vault.setSecret({ id: "S", value: "v", grants: [{ holder: "*" }] });
    const other = new Vault(path, audit);
    assert.equal(other.resolve("S", { agentId: "a" }), "v", "second instance reads the file");

    writeFileSync(path, "{ broken");
    const broken = new Vault(path, audit);
    assert.equal(broken.resolve("S", { agentId: "a" }), undefined, "broken = empty = refuse");
  } finally {
    cleanup();
  }
});
