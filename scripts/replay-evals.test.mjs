/** The replay script with nothing to replay says so and exits 0 (INV-1474); with no agent named it says how to call it. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./replay-evals.mjs", import.meta.url));

test("no cases: a quiet exit, before any provider is touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "replay-evals-"));
  try {
    const run = spawnSync(process.execPath, ["--experimental-transform-types", script, "Ada", "--dir", dir], { encoding: "utf8", env: { ...process.env, AGENTBOX_HOME: dir } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /No eval cases for Ada/);
    const usage = spawnSync(process.execPath, ["--experimental-transform-types", script], { encoding: "utf8", env: { ...process.env, AGENTBOX_HOME: dir } });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /Usage: replay-evals\.mjs <agent>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
