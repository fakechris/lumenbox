/**
 * The LumenBox skill pack (INV-1668): `agentbox skill install` puts the packaged SKILL.md where
 * each client reads it and prints an MCP entry with a placeholder, never a token; and the
 * tools SKILL.md teaches are exactly the tools the side door serves.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mcpServerTools } from "../web/mcp-tools.ts";
import { cmdSkill, packagedSkillPath, skillTarget, TOKEN_PLACEHOLDER } from "./skill-pack.ts";

test("install lands the packaged SKILL.md for Claude Code and Codex, and prints no token", async t => {
  const home = mkdtempSync(join(tmpdir(), "agentbox-skill-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // A token in the environment, as a person who already configured the bridge has: it must not leak.
  const sentinel = "lbx-sentinel-token-7f3a9c";
  const before = process.env.AGENTBOX_MCP_TOKEN;
  process.env.AGENTBOX_MCP_TOKEN = sentinel;
  t.after(() => {
    if (before === undefined) delete process.env.AGENTBOX_MCP_TOKEN;
    else process.env.AGENTBOX_MCP_TOKEN = before;
  });
  const printed: string[] = [];
  const deps = { out: (line: string) => printed.push(line), err: (line: string) => printed.push(line), home, codexHome: join(home, "codex-elsewhere") };
  assert.equal(cmdSkill(["install", "--claude", "--codex"], deps), 0);

  const packaged = readFileSync(packagedSkillPath(), "utf8");
  const claude = skillTarget("claude", deps);
  const codex = skillTarget("codex", deps);
  assert.equal(claude, join(home, ".claude", "skills", "lumenbox", "SKILL.md"));
  assert.equal(codex, join(home, "codex-elsewhere", "skills", "lumenbox", "SKILL.md"), "CODEX_HOME is honoured");
  assert.equal(readFileSync(claude, "utf8"), packaged);
  assert.equal(readFileSync(codex, "utf8"), packaged);
  const output = printed.join("\n");
  assert.ok(output.includes("claude mcp add lumenbox") && output.includes("[mcp_servers.lumenbox]"), "both clients' entries");
  assert.ok(output.includes(TOKEN_PLACEHOLDER), "the token is a placeholder");
  for (const text of [output, readFileSync(claude, "utf8")]) assert.ok(!text.includes(sentinel), "no token, from the environment or anywhere");

  assert.equal(cmdSkill(["install", "--cursor"], deps), 1, "only the two clients");
});

test("SKILL.md teaches exactly the tools the side door serves", () => {
  const skill = readFileSync(packagedSkillPath(), "utf8");
  const taught = [...skill.matchAll(/^### `([a-z_]+)`$/gm)].map(match => match[1]!);
  // Every optional part of the door switched on, as server.ts builds it.
  const served = mcpServerTools({
    registry: {} as never,
    orchestrator: { tasks: {} } as never,
    principals: { resolve: (id: string) => ({ name: id }) },
    workDir: "/work",
    log: () => {},
    listen: () => () => {},
    mayDrive: () => true,
    changeFeed: {} as never,
    mayReadTask: () => true,
  }).map(tool => tool.name);
  assert.deepEqual([...taught].sort(), [...served].sort(), "a tool on the door and not in SKILL.md, or the other way round");
});
