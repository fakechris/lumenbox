/**
 * The version line's three sources, in order. The packaged stamp exists because a user's
 * /Applications sits nowhere near a .git directory — 0.3.1 shipped "unknown" there and the
 * page's own answer to "which code is this" was no answer (INV-876).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBuildInfo } from "./build-info.ts";

test("the packaged buildCommit stamps the answer on a machine with no git", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-buildinfo-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version: "0.3.1", buildCommit: "1b5152c" })
    );
    const info = readBuildInfo(dir, {});
    assert.deepEqual(info, { version: "0.3.1", commit: "1b5152c" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AGENTBOX_BUILD pins it over the packaged stamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-buildinfo-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.3.1", buildCommit: "1b5152c" }));
    assert.equal(readBuildInfo(dir, { AGENTBOX_BUILD: "deadbee" }).commit, "deadbee");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no stamp and no git is said plainly, not invented", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-buildinfo-"));
  try {
    const info = readBuildInfo(dir, {});
    assert.equal(info.version, "0.0.0");
    assert.equal(info.commit, "unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
