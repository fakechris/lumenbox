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
import { existsSync, readFileSync, rmSync } from "node:fs";
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
    assert.match(written, /^[0-9a-f]{32}$/);
  } finally {
    rmSync(OWNER_FILE, { force: true });
  }
});
