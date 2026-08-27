/**
 * Tests for the upload confinement.
 *
 * Upload is reachable by anyone holding a UI token, so an unconfined write is worse than an
 * unconfined read. The confinement checked the destination's *parent* with realpath and then wrote
 * to the original name — and `writeFile` follows a symlink, so a name inside the work directory
 * that already pointed outside it was a way straight through: leave `work/report.pdf` pointing at a
 * browser profile file and the next upload rewrites the profile, with the parent check passing
 * because the parent really is inside the root.
 *
 * The root is read from the environment at import time, so it is set before the module loads.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "agentbox-work-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "agentbox-outside-"));
process.env.AGENTBOX_WORK_DIR = ROOT;

const { uploadFile } = await import("./fs-service.ts");

const base64 = (text: string) => Buffer.from(text).toString("base64");

test("an upload lands where it says it does", async () => {
  const result = await uploadFile({ path: join(ROOT, "notes.txt"), base64: base64("hello") });
  assert.equal(result.size, 5);
  assert.equal(readFileSync(join(ROOT, "notes.txt"), "utf8"), "hello");
});

test("an upload will not write through a link that leaves the work directory", async () => {
  const secret = join(OUTSIDE, "profile.db");
  writeFileSync(secret, "original");
  symlinkSync(secret, join(ROOT, "report.pdf"));

  await assert.rejects(
    uploadFile({ path: join(ROOT, "report.pdf"), base64: base64("overwritten") }),
    /outside/
  );
  assert.equal(readFileSync(secret, "utf8"), "original", "the file outside is untouched");
});

test("a link that stays inside the work directory is followed, because that is normal", async () => {
  mkdirSync(join(ROOT, "drafts"), { recursive: true });
  const real = join(ROOT, "drafts", "v2.txt");
  writeFileSync(real, "old");
  symlinkSync(real, join(ROOT, "latest.txt"));

  await uploadFile({ path: join(ROOT, "latest.txt"), base64: base64("new") });
  assert.equal(readFileSync(real, "utf8"), "new");
});

test("a dangling link is refused rather than quietly creating the file it points at", async () => {
  symlinkSync(join(OUTSIDE, "does-not-exist"), join(ROOT, "dangling.txt"));
  await assert.rejects(
    uploadFile({ path: join(ROOT, "dangling.txt"), base64: base64("x") }),
    /does not exist/
  );
});

test("a path outside the root is refused on its parent, as before", async () => {
  await assert.rejects(
    uploadFile({ path: join(OUTSIDE, "elsewhere.txt"), base64: base64("x") }),
    /outside/
  );
});

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

test("an upload arrives whole or not at all, and a link's target stays a link's target", async () => {
  // A crash mid-write used to leave a torn file under the final name, which looks
  // delivered to every later reader. The bytes now land under a .part name and take the
  // final name in one rename; afterwards nothing partial is left behind.
  await uploadFile({ path: join(ROOT, "whole.txt"), base64: base64("all of it") });
  assert.equal(readFileSync(join(ROOT, "whole.txt"), "utf8"), "all of it");
  const leftovers = readdirSync(ROOT).filter(name => name.endsWith(".part"));
  assert.deepEqual(leftovers, [], "no partial files may survive a completed upload");

  // Writing through an in-tree link must update the *target*, exactly as the direct
  // write did — an atomic rename onto the link itself would replace the link with a
  // plain file, which is a different edit than the one asked for.
  writeFileSync(join(ROOT, "target.txt"), "old");
  symlinkSync(join(ROOT, "target.txt"), join(ROOT, "alias.txt"));
  await uploadFile({ path: join(ROOT, "alias.txt"), base64: base64("through the link") });
  assert.equal(readFileSync(join(ROOT, "target.txt"), "utf8"), "through the link");
  assert.ok(lstatSync(join(ROOT, "alias.txt")).isSymbolicLink(), "the link must survive");
});
