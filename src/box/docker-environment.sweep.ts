/** Real CLI subprocess probes run with the other process sweeps, away from the parallel suite. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerEnvironment } from "./docker.ts";

test("dockerEnvironment separates a missing install from a stopped engine", async () => {
  // A fake `docker` on PATH, three ways: absent, present-and-failing, present-and-happy.
  // These are the three things a fresh machine can be, and the settings page has one
  // sentence for each (INV-855) — a test pins the mapping, because the easy refactor is
  // folding them back into one boolean and one jargon error.
  const empty = mkdtempSync(join(tmpdir(), "agentbox-nodocker-"));
  const bin = mkdtempSync(join(tmpdir(), "agentbox-fakedocker-"));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = empty;
    const missing = await dockerEnvironment(2_000);
    assert.equal(missing.state, "no-binary");
    assert.match(missing.detail, /PATH/);

    const failing = join(bin, "docker");
    writeFileSync(failing, "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const stopped = await dockerEnvironment(2_000);
    assert.equal(stopped.state, "no-engine");
    assert.match(stopped.detail, /Cannot connect/);

    writeFileSync(failing, "#!/bin/sh\necho 27.0.1\n", { mode: 0o755 });
    const ok = await dockerEnvironment(2_000);
    assert.equal(ok.state, "ok");
    assert.match(ok.detail, /27\.0\.1/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(empty, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
