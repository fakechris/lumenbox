/** A box token never becomes text: not in docker's argv, not in a failed run's error (INV-1560). */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docker } from "./docker.ts";
import { redactSecretAssignments, secretsOutOfArgs } from "./secret-env.ts";

const TOKEN = "f3dd28f5d86ddc329b27f0d54a797e7e72abfa8e8db8ebcfd8ae69fd1abc6520";

test("secret --env values leave the argv and travel as environment; ordinary ones stay", () => {
  const { args, env } = secretsOutOfArgs(["run", "--env", `BOXD_TOKEN=${TOKEN}`, "--env", "DISPLAY_WIDTH=1280", "-e", "OPENAI_API_KEY=sk-x", "img"]);
  assert.deepEqual(args, ["run", "--env", "BOXD_TOKEN", "--env", "DISPLAY_WIDTH=1280", "-e", "OPENAI_API_KEY", "img"]);
  assert.deepEqual(env, { BOXD_TOKEN: TOKEN, OPENAI_API_KEY: "sk-x" });
  assert.equal(redactSecretAssignments(`x BOXD_TOKEN=${TOKEN} DISPLAY_WIDTH=1280`), "x BOXD_TOKEN=*** DISPLAY_WIDTH=1280");
});

test("a docker run that fails says why without the token, and docker still receives it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentbox-secret-env-"));
  const previousPath = process.env.PATH;
  try {
    // Fails the worst way: echoing its whole command line back on stderr.
    writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$@" > "${dir}/argv"\necho "$BOXD_TOKEN" > "${dir}/env"\necho "docker: bad flag in $*" >&2\nexit 125\n`);
    chmodSync(join(dir, "docker"), 0o755);
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    const error = await docker(["run", "--detach", "--env", `BOXD_TOKEN=${TOKEN}`, "img"]).then(() => undefined, (e: unknown) => e as Error);
    assert.ok(error, "the run failed");
    assert.doesNotMatch(error.message, new RegExp(TOKEN), "not in the error a person or a page sees");
    assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8"), new RegExp(TOKEN), "not on the command line (ps)");
    assert.equal(readFileSync(join(dir, "env"), "utf8").trim(), TOKEN, "the box still gets its token");
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
