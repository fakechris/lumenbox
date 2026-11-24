/** Invitation codes survive a restart, as hashes only, and still work once (INV-2082). */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { InviteStore } from "./invite-store.ts";

test("a code made before a restart works once after it; expired codes are dropped; the file never holds a code", () => {
  const dir = mkdtempSync(join(tmpdir(), "invites-"));
  try {
    const path = join(dir, "invites.json"), now = Date.now();
    const before = new InviteStore(path);
    before.set("K7QX2M", { role: "driver", note: "Ada, finance", expiresAt: now + 7 * 24 * 60 * 60_000 });
    before.set("P9RT4W", { role: "viewer", principalId: "web:bob", expiresAt: now + 60_000 });
    before.set("H3JN8C", { role: "admin", expiresAt: now + 60_000 });
    assert.equal(before.list().find(invite => invite.note === "Ada, finance")?.code, "K7QX2M", "the process that made a code can show it");

    const raw = readFileSync(path, "utf8");
    for (const code of ["K7QX2M", "P9RT4W", "H3JN8C"]) assert.ok(!raw.includes(code), "a code is never written");
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const after = new InviteStore(path, () => {}, now + 2 * 60_000); // the restart, two minutes on
    assert.deepEqual(after.get("K7QX2M"), { role: "driver", note: "Ada, finance", expiresAt: now + 7 * 24 * 60 * 60_000 });
    assert.equal(after.get("P9RT4W"), undefined, "expired while the server was down: dropped on load");
    assert.equal(after.get("H3JN8C"), undefined);
    assert.deepEqual(after.list().map(invite => invite.code), [undefined], "made before the restart: listed, never shown");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).invites.length, 1, "the drop is saved");

    // Redeeming deletes it, and the deletion survives the next restart: still once.
    assert.equal(after.delete("K7QX2M"), true);
    assert.equal(after.get("K7QX2M"), undefined);
    assert.equal(new InviteStore(path).get("K7QX2M"), undefined);
    assert.equal(new InviteStore(path).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a person's codes go with them; an unreadable file is kept, not overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "invites-"));
  try {
    const path = join(dir, "invites.json");
    const store = new InviteStore(path);
    store.set("AAAAAA", { role: "viewer", principalId: "p1", expiresAt: Date.now() + 60_000 });
    store.set("BBBBBB", { role: "viewer", principalId: "p2", expiresAt: Date.now() + 60_000 });
    store.dropWhere(invite => invite.principalId === "p1");
    const reloaded = new InviteStore(path);
    assert.equal(reloaded.get("AAAAAA"), undefined);
    assert.equal(reloaded.get("BBBBBB")?.principalId, "p2");

    writeFileSync(path, "{ torn");
    const warnings: string[] = [];
    const torn = new InviteStore(path, line => warnings.push(line));
    assert.equal(warnings.length, 1);
    torn.set("CCCCCC", { role: "driver", expiresAt: Date.now() + 60_000 });
    assert.equal(torn.get("CCCCCC")?.role, "driver", "a code made now still works");
    assert.equal(readFileSync(path, "utf8"), "{ torn", "and the evidence is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
