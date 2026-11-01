/** The box helper's walk, tested in its own language: docker/box/test_box_ax.py on a fake tree, never the bus (INV-1481). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("box-ax reads what it can, names what it left, and drills one subtree (python unittest)", t => {
  const script = fileURLToPath(new URL("../../docker/box/test_box_ax.py", import.meta.url));
  const run = spawnSync("python3", ["-B", script], { encoding: "utf8", timeout: 30_000 });
  if (run.error !== undefined && (run.error as NodeJS.ErrnoException).code === "ENOENT") {
    t.skip("python3 is not on this machine; the box image has it");
    return;
  }
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /Ran \d+ tests[\s\S]*OK/);
});
