/**
 * Tests for a desktop keeping its owner across a boxd restart.
 *
 * The X servers, the window manager and everything an agent opened are separate processes. They
 * survive boxd being restarted in place and are reattached to rather than recreated — but ownership
 * lived only in the daemon's memory, so the first agent to name a desktop after a restart adopted a
 * colleague's live screen, with their browser and their session on it, and locked the original out.
 *
 * A desktop that is already in the manager's map is used throughout, which is what lets these run
 * without an X server: the claim is bookkeeping, and bookkeeping is the part on test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DisplayManager, DisplayOwnershipError } from "./displays.ts";

/** High enough that it cannot collide with a desktop a developer is actually running. */
const INDEX = 31;
const OWNER_FILE = `/tmp/agentbox-display-${INDEX}.owner`;

/** A manager with a live but unclaimed desktop already in its map. */
function withDesktop(): DisplayManager {
  const manager = new DisplayManager(() => {});
  const desktops = (manager as unknown as { desktops: Map<number, unknown> }).desktops;
  desktops.set(INDEX, { index: INDEX, display: `:${INDEX}`, owner: undefined });
  return manager;
}

test("an unclaimed desktop is free for whoever asks first", () => {
  rmSync(OWNER_FILE, { force: true });
  const manager = new DisplayManager(() => {});
  // No record and nothing in memory: a fresh container. Refusing here would mean no agent could
  // ever take a desktop at all.
  manager.assertOwner(INDEX, "anyone");
  manager.assertOwner(INDEX, undefined);
});

test("a claim survives a restart, and locks out everyone but its owner", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    assert.ok(existsSync(OWNER_FILE), "the claim is on disk, not only in this process");

    // A fresh daemon over the same still-running desktop: nothing in its map.
    const successor = new DisplayManager(() => {});
    assert.throws(
      () => successor.assertOwner(INDEX, "token-for-rex"),
      DisplayOwnershipError,
      "a colleague must not adopt a desktop that is still someone else's"
    );
    successor.assertOwner(INDEX, "token-for-ada"); // and the real owner still gets in
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("what is written down is a hash, never the owner's token", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    const written = readFileSync(OWNER_FILE, "utf8");
    // The agent has a shell as this same uid and can read this file. Storing the token would hand
    // it a colleague's desktop credential, which is a worse problem than the one being fixed.
    assert.ok(!written.includes("token-for-ada"));
    const record = JSON.parse(written) as { hash: string; at: number };
    assert.match(record.hash, /^[0-9a-f]{32}$/);
    assert.ok(record.at > 0, "and when it was last touched, which is what makes it a lease");
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});


test("a claim nobody has touched lapses, so a dead agent does not park a desktop forever", async () => {
  // A claim with no expiry is a lock, and a lock held by an agent that no longer exists is a
  // desktop nobody can ever use again — one failure turned into a permanent one, fixable only by
  // recreating the container. Found by running two agents against a box that had been up for a
  // day: both were refused their own desktops by owners that no longer existed.
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");

    // Rewrite the claim as though it were made long ago; the owner has not touched it since.
    const stale = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { hash: string; at: number };
    writeFileSync(OWNER_FILE, JSON.stringify({ ...stale, at: Date.now() - 31 * 60_000 }));

    const successor = new DisplayManager(() => {});
    successor.assertOwner(INDEX, "token-for-rex");
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("an owner that is still working keeps its desktop", async () => {
  rmSync(OWNER_FILE, { force: true });
  try {
    const manager = withDesktop();
    await manager.ensure(INDEX, "token-for-ada");
    const first = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { at: number };

    // Every screenshot and every click goes through assertOwner, so working renews the lease.
    await new Promise(resolve => setTimeout(resolve, 5));
    manager.assertOwner(INDEX, "token-for-ada");
    const renewed = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { at: number };
    assert.ok(renewed.at >= first.at, "using it moves the clock");

    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "token-for-rex"),
      DisplayOwnershipError
    );
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("an unreadable or legacy lease is refused, not treated as a free desktop", () => {
  // The safer half of the two-states fix. A file we cannot parse — a torn write, or the old
  // bare-hash format — might be a live owner whose write was interrupted, so it must not read as an
  // unclaimed desktop and be handed to the next agent. This is fail-closed on purpose; atomic
  // writes mean a torn file does not happen in practice.
  rmSync(OWNER_FILE, { force: true });
  try {
    writeFileSync(OWNER_FILE, "0123456789abcdef0123456789abcdef");
    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "somebody-else"),
      DisplayOwnershipError
    );
    // An empty file — a torn rename target — is likewise not "free".
    writeFileSync(OWNER_FILE, "");
    assert.throws(
      () => new DisplayManager(() => {}).assertOwner(INDEX, "somebody-else"),
      DisplayOwnershipError
    );
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});

test("the lease is written atomically, leaving no partial file", async () => {
  // Temp-plus-rename, so a reader never sees a half-written claim — the hole that let a torn write
  // read as an unclaimed desktop.
  rmSync(OWNER_FILE, { force: true });
  try {
    await withDesktop().ensure(INDEX, "token-for-ada");
    const record = JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { hash: string; at: number };
    assert.match(record.hash, /^[0-9a-f]{32}$/);
    // No leftover temp file beside it.
    const dir = OWNER_FILE.slice(0, OWNER_FILE.lastIndexOf("/"));
    const leftovers = readdirSync(dir).filter(
      name => name.startsWith("agentbox-display-") && name.includes(".tmp")
    );
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});
