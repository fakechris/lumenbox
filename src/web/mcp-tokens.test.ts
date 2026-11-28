/** Side-door tokens survive a restart, as hashes only (INV-1520). */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Principals } from "../host/principals.ts";
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

test("a token from a sign-in is whoever holds the sign-in now, never the roster id it also names (INV-2074)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
  try {
    const principals = new Principals(join(dir, "principals.json"));
    // Alice joined by invite, so her roster id is her first sign-in; Carol likewise.
    principals.save([
      { id: "feishu:ou_a", name: "Alice", role: "driver", identities: ["feishu:ou_a", "web:alice2"] },
      { id: "feishu:ou_x", name: "Carol", role: "admin", identities: ["feishu:ou_x"] },
      { id: "p_bob", name: "Bob", role: "viewer", identities: ["web:bob"] },
    ]);
    const store = new McpTokenStore(undefined);
    const alice = store.mint("feishu:ou_a", "ide");
    const linked = store.mint("web:alice2", "ide");
    const forBob = store.mint("p_bob", "ide", new Date(), "person");
    assert.equal(store.personFor(linked.token, principals), "feishu:ou_a", "a linked sign-in acts as its person");
    assert.equal(store.personFor(forBob.token, principals), "p_bob", "minted for a roster id: that person");

    principals.save([
      { id: "feishu:ou_a", name: "Alice", role: "driver", identities: ["web:alice2"] },
      { id: "feishu:ou_x", name: "Carol", role: "admin", identities: [] },
      { id: "p_bob", name: "Bob", role: "viewer", identities: ["web:bob", "feishu:ou_x"] },
    ]);
    assert.equal(store.personFor(alice.token, principals), undefined, "the sign-in was removed; the token went with it");
    assert.equal(store.personFor(linked.token, principals), "feishu:ou_a");
    assert.equal(store.personFor(store.mint("feishu:ou_x", "ide").token, principals), "p_bob", "Carol's old sign-in, now Bob's, is Bob");
    // Work stored under Carol's roster id stays Carol's, though Bob now holds the sign-in it also names.
    assert.equal(principals.personOf("feishu:ou_x")?.id, "feishu:ou_x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a client API token is kept apart from the side door's: hashed, prefixed, expiring, its use noted once a minute, and ended with its person (INV-2213)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-tokens-"));
  try {
    const path = join(dir, "mcp-tokens.json");
    const records: Record<string, unknown>[] = [];
    const store = new McpTokenStore(path, () => {}, record => records.push(record as unknown as Record<string, unknown>));
    const now = new Date("2026-11-28T10:00:30Z");
    const personal = store.mintClient({ kind: "personal", principalId: "dee", label: "script", scopes: ["work:read", "work:read"], expiresAt: new Date("2026-12-28T10:00:00Z"), by: "dee", now });
    const side = store.mint("dee", "ide");
    assert.match(personal.token, /^lbxp_[0-9a-f]{48}$/);
    assert.deepEqual(personal.credential.scopes, ["work:read"], "a scope once");
    assert.equal(store.principalFor(personal.token), undefined, "the side door does not take a client token");
    assert.deepEqual(store.clientFor(side.token), { refused: "invalid" }, "and the client API does not take the side door's");
    assert.deepEqual(store.list().map(entry => entry.label), ["ide"], "the side door lists only its own");
    // A restart keeps it, as a hash; the moment its time is over it is refused as expired, not as unknown.
    const after = new McpTokenStore(path, () => {}, record => records.push(record as unknown as Record<string, unknown>));
    assert.ok(!readFileSync(path, "utf8").includes(personal.token));
    assert.equal("credential" in after.clientFor(personal.token, now) ? "ok" : "refused", "ok");
    assert.deepEqual(after.clientFor(personal.token, new Date("2026-12-28T10:00:00Z")), { refused: "expired" });
    // Last use to the minute: a second use in the same minute writes nothing.
    assert.equal(after.touch(personal.credential.id, now), "2026-11-28T10:00:00.000Z");
    const written = readFileSync(path, "utf8");
    after.touch(personal.credential.id, new Date("2026-11-28T10:00:59Z"));
    assert.equal(readFileSync(path, "utf8"), written, "not rewritten within the minute");
    assert.equal(after.listClient()[0]?.lastUsedAt, "2026-11-28T10:00:00.000Z");
    // A person who left takes their client tokens with them, each on the record as what it was.
    assert.equal(after.revokeFor(["dee"]), 2);
    assert.deepEqual(after.clientFor(personal.token, now), { refused: "invalid" });
    assert.deepEqual(records.filter(record => record.event === "revoked").map(record => [record.kind, record.reason]).sort(), [["personal", "access-ended"], ["side-door", "access-ended"]]);
    assert.ok(records.every(record => !JSON.stringify(record).includes(personal.token) && !JSON.stringify(record).includes(side.token)), "never a secret on the record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
