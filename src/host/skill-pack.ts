/**
 * `agentbox skill install [--claude] [--codex]` (INV-1668): the LumenBox skill for a coding agent.
 *
 * The side door (`agentbox mcp`, docs/33 §8) had a contract and an implementation and no way in
 * for somebody sitting in Claude Code or Codex: nothing told their agent when to hand work to
 * LumenBox, which tool does what, or that "assigned" is not "started". `skills/lumenbox/SKILL.md`
 * says that, and ships in the package; this copies it to where each client reads personal
 * skills and prints the MCP entry to add. It never touches the client's MCP configuration and
 * never sees a token: the entry carries a placeholder, and the person pastes their own from
 * Settings → Mine.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "lumenbox";
/** What the printed entry says where the token goes. */
export const TOKEN_PLACEHOLDER = "<your token from Settings → Mine>";
const DEFAULT_MCP_URL = "http://127.0.0.1:7777/mcp";

/**
 * The packaged SKILL.md: `skills/lumenbox/SKILL.md` at the package root. Searched upwards from
 * this module because it runs both from `src/host/` and bundled into `dist/cli.js`.
 */
export function packagedSkillPath(from = dirname(fileURLToPath(import.meta.url))): string {
  let dir = from;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "skills", SKILL_NAME, "SKILL.md");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error(`The packaged skills/${SKILL_NAME}/SKILL.md was not found above ${from}; the install is incomplete.`);
}

export interface SkillDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  home: string;
  /** CLAUDE_CONFIG_DIR, when the person moved Claude Code's home. */
  claudeDir?: string | undefined;
  /** CODEX_HOME, when the person moved Codex's home. */
  codexHome?: string | undefined;
  /** AGENTBOX_MCP_URL, when the installation is not on this machine's port 7777. */
  mcpUrl?: string | undefined;
  /** The SKILL.md to install; the packaged one by default. */
  source?: string;
}

export type SkillClient = "claude" | "codex";

/** Where each client reads a personal skill. */
export function skillTarget(client: SkillClient, deps: Pick<SkillDeps, "home" | "claudeDir" | "codexHome">): string {
  const base = client === "claude" ? deps.claudeDir || join(deps.home, ".claude") : deps.codexHome || join(deps.home, ".codex");
  return join(base, "skills", SKILL_NAME, "SKILL.md");
}

/** The MCP entry to add, as each client takes it. The token is a placeholder, always. */
export function mcpSnippet(client: SkillClient, mcpUrl: string | undefined): string[] {
  const url = mcpUrl || DEFAULT_MCP_URL;
  const urlEnv = url === DEFAULT_MCP_URL ? "" : ` --env AGENTBOX_MCP_URL=${url}`;
  if (client === "claude") {
    const env: Record<string, string> = { AGENTBOX_MCP_TOKEN: TOKEN_PLACEHOLDER, ...(url === DEFAULT_MCP_URL ? {} : { AGENTBOX_MCP_URL: url }) };
    return [
      "Add the side door to Claude Code — either run:",
      `  claude mcp add lumenbox --scope user --env AGENTBOX_MCP_TOKEN='${TOKEN_PLACEHOLDER}'${urlEnv} -- agentbox mcp`,
      "or put this in .mcp.json (or ~/.claude.json) under mcpServers:",
      ...JSON.stringify({ mcpServers: { lumenbox: { command: "agentbox", args: ["mcp"], env } } }, null, 2).split("\n").map(line => `  ${line}`),
    ];
  }
  return [
    "Add the side door to Codex — either run:",
    `  codex mcp add lumenbox --env AGENTBOX_MCP_TOKEN='${TOKEN_PLACEHOLDER}'${urlEnv} -- agentbox mcp`,
    "or put this in config.toml in your Codex home (~/.codex, or CODEX_HOME):",
    "  [mcp_servers.lumenbox]",
    '  command = "agentbox"',
    '  args = ["mcp"]',
    `  env = { AGENTBOX_MCP_TOKEN = "${TOKEN_PLACEHOLDER}"${url === DEFAULT_MCP_URL ? "" : `, AGENTBOX_MCP_URL = "${url}"`} }`,
  ];
}

export function cmdSkill(args: readonly string[], deps: SkillDeps): number {
  const [sub, ...flags] = args;
  const unknown = flags.filter(flag => flag !== "--claude" && flag !== "--codex");
  if (sub !== "install" || unknown.length > 0) {
    deps.err("Usage: agentbox skill install [--claude] [--codex]   (Claude Code when neither is given)");
    return 1;
  }
  const clients: SkillClient[] = [...(flags.includes("--claude") || !flags.includes("--codex") ? (["claude"] as const) : []), ...(flags.includes("--codex") ? (["codex"] as const) : [])];
  const text = readFileSync(deps.source ?? packagedSkillPath(), "utf8");
  for (const client of clients) {
    const target = skillTarget(client, deps);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    deps.out(`Installed the ${SKILL_NAME} skill for ${client === "claude" ? "Claude Code" : "Codex"}: ${target}`);
    for (const line of mcpSnippet(client, deps.mcpUrl)) deps.out(line);
    deps.out("");
  }
  deps.out("Issue the token in the LumenBox app: Settings → Mine → Your MCP tokens. It is shown once; paste it in place of the placeholder.");
  deps.out("`agentbox web` must be running for the tools to answer. Restart the client to load the skill.");
  return 0;
}
