/**
 * A git token reaches git and nothing else (INV-1408). The helper is exercised through git's own
 * `credential fill` / `credential reject`, which run the configured helpers exactly as a fetch
 * would — the protocol, the host filter and the erase — without a network or a TLS server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareGitCredentials } from "./git-credential.ts";
import { isGhCommand, resolveHostSecrets } from "./host-secrets.ts";
import { Vault } from "./vault.ts";

const TOKEN = "ghp_test_value_never_in_env_0123456789";

const gitHere = spawnSync("git", ["--version"]).status === 0;

function fill(env: Record<string, string>, request: string): string {
  const run = spawnSync("git", ["credential", "fill"], { input: request, encoding: "utf8", env: { ...process.env, ...env, HOME: mkdtempSync(join(tmpdir(), "nohome-")) } });
  return `${run.stdout}${run.stderr}`;
}

test("the helper answers https to the named hosts with the token, and nothing to anything else", { skip: !gitHere && "git is not on this machine" }, () => {
  const prepared = prepareGitCredentials([{ id: "GITHUB_TOKEN", value: TOKEN, hosts: [] }, { id: "GHE_TOKEN", value: "ghe_other", hosts: ["git.example.com"] }]);
  try {
    assert.equal(prepared.env.GIT_CONFIG_COUNT, "3", "a reset entry, then one helper per credential");
    assert.equal(prepared.env.GIT_CONFIG_VALUE_0, "", "the person's own helpers are not consulted for an agent's command");
    assert.ok(!Object.values(prepared.env).some(value => value.includes(TOKEN)), "the token is in no variable");
    assert.match(fill(prepared.env, "protocol=https\nhost=github.com\n\n"), new RegExp(`password=${TOKEN}`), "github.com is the default host");
    assert.match(fill(prepared.env, "protocol=https\nhost=git.example.com\n\n"), /password=ghe_other/);
    assert.doesNotMatch(fill(prepared.env, "protocol=https\nhost=gitlab.com\n\n"), /password=/, "another host gets nothing");
    assert.doesNotMatch(fill(prepared.env, "protocol=http\nhost=github.com\n\n"), /password=/, "plain http gets nothing");
    // git telling the helper the credential was refused is noted, so the result can say so.
    spawnSync("git", ["credential", "reject"], { input: `protocol=https\nhost=github.com\nusername=x-access-token\npassword=${TOKEN}\n\n`, env: { ...process.env, ...prepared.env } });
    const dir = prepared.dir;
    assert.ok(existsSync(join(dir, "token-0")));
    const { erased } = prepared.finish();
    assert.deepEqual(erased, ["github.com"]);
    assert.ok(!existsSync(dir), "the directory, tokens included, is gone when the run ends");
  } finally {
    rmSync(prepared.dir, { recursive: true, force: true });
  }
});

test("a secret marked git stays out of the command's environment; gh alone gets it as GH_TOKEN; others go in as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "hostsecrets-"));
  try {
    const vault = new Vault(join(dir, "vault.json"), join(dir, "audit.jsonl"));
    vault.setSecret({ id: "GITHUB_TOKEN", value: TOKEN, grants: [{ holder: "agent:a1" }], kind: "git" });
    vault.setSecret({ id: "NPM_TOKEN", value: "npm_plain", grants: [{ holder: "agent:a1" }] });
    vault.setSecret({ id: "OTHER_TOKEN", value: "not-yours", grants: [] });
    assert.equal(vault.kindOf("GITHUB_TOKEN"), "git");
    assert.equal(vault.list().find(secret => secret.id === "GITHUB_TOKEN")?.kind, "git", "the kind is visible without the value");
    const caller = { agentId: "a1", agentName: "Ada", scopeGrants: () => false };

    const build = resolveHostSecrets(vault, ["GITHUB_TOKEN", "NPM_TOKEN", "OTHER_TOKEN"], "npm run build && git push", caller);
    try {
      assert.deepEqual(build.refused, ["OTHER_TOKEN"]);
      assert.deepEqual(build.inEnvironment, ["NPM_TOKEN"]);
      assert.deepEqual(build.toGit, ["GITHUB_TOKEN"]);
      assert.equal(build.env.NPM_TOKEN, "npm_plain");
      assert.ok(!Object.values(build.env).includes(TOKEN), "the git token is in no environment variable");
      assert.equal(build.env.GIT_CONFIG_COUNT, "2");
      assert.equal(readFileSync(build.env.GIT_CONFIG_VALUE_1!, "utf8").includes("github.com"), true, "the helper answers github.com, the default");
    } finally {
      build.finish();
    }
    assert.ok(!existsSync(build.env.GIT_CONFIG_VALUE_1!), "the helper and token are gone after the run");

    const gh = resolveHostSecrets(vault, ["GITHUB_TOKEN"], "gh pr create --fill", caller);
    try {
      assert.equal(gh.env.GH_TOKEN, TOKEN, "gh is the process the token is for");
      assert.equal(gh.env.GITHUB_TOKEN, undefined);
      assert.deepEqual(gh.inEnvironment, ["GITHUB_TOKEN (as GH_TOKEN, for gh)"]);
    } finally {
      gh.finish();
    }
    assert.ok(isGhCommand("gh auth status") && isGhCommand("  gh") && !isGhCommand("ghost") && !isGhCommand("npm test && gh pr view"), "gh only when the command is gh itself");

    vault.setSecret({ id: "GITHUB_TOKEN", kind: null });
    assert.equal(vault.kindOf("GITHUB_TOKEN"), undefined, "null clears the kind; the value stays");
    const plain = resolveHostSecrets(vault, ["GITHUB_TOKEN"], "git push", caller);
    assert.equal(plain.env.GITHUB_TOKEN, TOKEN, "without the kind, the old path: into the environment");
    plain.finish();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
