/** Side-door tokens survive a restart, as hashes only (INV-1520). */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpTokenStore } from "./mcp-tokens.ts";

test("a token issued before a restart is still accepted after it; the file holds its hash, never the secret, and is 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
  try {
    const path = join(dir, "mcp-tokens.json");
    const before = new McpTokenStore(path);
    const minted = before.mint("feishu:ou_chris", "watchdog");
    assert.match(minted.token, /^lmbx_[0-9a-f]{48}$/);
    const after = new McpTokenStore(path); // the restart
    assert.equal(after.principalFor(minted.token), "feishu:ou_chris");
    assert.equal(after.principalFor(`${minted.token}x`), undefined, "a different token is not it");
    assert.equal(after.principalFor(""), undefined);
    assert.equal(after.principalFor(undefined), undefined);
    const raw = readFileSync(path, "utf8");
    assert.ok(!raw.includes(minted.token), "the secret is never written");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(after.list(), [{ principalId: "feishu:ou_chris", label: "watchdog", createdAt: minted.createdAt }], "listed without secret or hash");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a revocation holds across a restart, and only what the rule allows is revoked", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
  try {
    const path = join(dir, "mcp-tokens.json");
    const store = new McpTokenStore(path);
    const mine = store.mint("p1", "ide", new Date("2026-11-02T10:00:00Z"));
    const theirs = store.mint("p2", "ide", new Date("2026-11-02T11:00:00Z"));
    assert.equal(store.revoke(theirs.createdAt, entry => entry.principalId === "p1"), false, "not mine to revoke");
    assert.equal(store.revoke(mine.createdAt, entry => entry.principalId === "p1"), true);
    const after = new McpTokenStore(path);
    assert.equal(after.principalFor(mine.token), undefined, "revoked stays revoked");
    assert.equal(after.principalFor(theirs.token), "p2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable file accepts no token and is not overwritten, and the reason is said", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
  try {
    const path = join(dir, "mcp-tokens.json");
    writeFileSync(path, "{ not json");
    const warned: string[] = [];
    const store = new McpTokenStore(path, line => warned.push(line));
    assert.match(warned[0] ?? "", /unreadable/);
    store.mint("p1", "x");
    assert.equal(readFileSync(path, "utf8"), "{ not json", "the evidence is kept");
    assert.equal(new McpTokenStore(undefined).principalFor("lmbx_x"), undefined, "memory only works too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
