/**
 * Connector doors: the SaaS integrations a third-party bot template may name, wired
 * the one way a headless box can honor — an MCP server per vendor, credential in the
 * environment, nothing interactive.
 *
 * Why a catalog: templates from anywhere (the Grok ports first of all) carry
 * `connectors: ["mcp:notion", …]`. Before this file those names resolved to nothing and
 * every import asked for a connector nobody could configure without hand-editing
 * config.json. Now a door turns on when its credential variable is set — the operator
 * exports `LINEAR_API_KEY` and every template that needs Linear sees it as connected —
 * and config.json's `mcpServers` remains the authority: an entry there with the same
 * name overrides the door's default spec, so an operator who prefers the official
 * self-hosted server to the catalog's default changes one file, not code.
 *
 * Honesty per door: the `upstream` line names who publishes the server (official or
 * community) and the `note` says what to watch. Defaults are the best-known headless
 * spec on 2026-09-06; any of them may be overridden without touching this file.
 */

import type { McpServerConfig } from "./mcp.ts";

export interface ConnectorDoor {
  /** The connector slug templates name: `mcp:<slug>`. Also the MCP server's name. */
  slug: string;
  title: string;
  /** One line for the settings surface and the import's "what is this" answer. */
  summary: string;
  /** The environment variable that turns the door on. Set it and the door is live. */
  credential: string;
  /** The template connectors this door satisfies — one server may stand for several slugs. */
  provides: readonly string[];
  /** The server spec once the credential is present; `${VAR}` expands from the environment. */
  spec: Omit<McpServerConfig, "name">;
  /** Where the credential comes from, in the words an operator needs. */
  setup: string;
  upstream: string;
  note?: string;
}

export const CONNECTOR_DOORS: readonly ConnectorDoor[] = [
  {
    slug: "notion",
    title: "Notion",
    summary: "Search, read, create and update Notion pages and databases.",
    credential: "NOTION_API_KEY",
    provides: ["mcp:notion"],
    spec: {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { OPENAPI_MQS_HEADERS: "x-api-key: ${NOTION_API_KEY}", NOTION_API_KEY: "${NOTION_API_KEY}" },
    },
    setup: "notion.so/profile/integrations → new internal integration → copy the secret (ntn_…), then grant it the pages it should reach.",
    upstream: "official (makenotion/notion-mcp-server, stdio)",
    note: "Notion's hosted mcp.notion.com is OAuth-only, which a headless box cannot complete; the official stdio server with an integration token is the supported path.",
  },
  {
    slug: "slack",
    title: "Slack",
    summary: "Read channels and threads, search, post and react as the bot's Slack app.",
    credential: "SLACK_BOT_TOKEN",
    provides: ["mcp:slack"],
    spec: {
      command: "npx",
      args: ["-y", "slack-mcp-server"],
      env: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" },
    },
    setup: "api.slack.com/apps → create app → bot token scopes (channels:history, chat:write, search:read, reactions:write) → install → copy the xoxb-… token.",
    upstream: "community (npm slack-mcp-server)",
    note: "Slack's official server is a self-hosted image (slackapi/slack-mcp-server); override this entry in config.json to use it — same name, your spec.",
  },
  {
    slug: "linear",
    title: "Linear",
    summary: "Issues, projects, cycles: search, create, update, comment.",
    credential: "LINEAR_API_KEY",
    provides: ["mcp:linear"],
    spec: {
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
    },
    setup: "linear.app/settings/api → personal API key (lin_api_…). Linear's official server accepts it as a bearer token directly.",
    upstream: "official (mcp.linear.app/mcp, Streamable HTTP)",
  },
  {
    slug: "google",
    title: "Google (Gmail + Calendar)",
    summary: "Gmail search/read/send and Calendar events, under one OAuth grant.",
    credential: "GOOGLE_OAUTH_REFRESH_TOKEN",
    provides: ["mcp:gmail", "mcp:google-calendar"],
    spec: {
      command: "npx",
      args: ["-y", "@alanxchen/google-workspace-mcp"],
      env: {
        GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID}",
        GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET}",
        GOOGLE_REFRESH_TOKEN: "${GOOGLE_OAUTH_REFRESH_TOKEN}",
      },
    },
    setup: "Google Cloud console → OAuth client (desktop) with Gmail and Calendar scopes → mint a refresh token once → set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN.",
    upstream: "community (@alanxchen/google-workspace-mcp, stdio)",
    note: "Google's official Calendar MCP is remote but OAuth-browser-only today; a refresh token through a community stdio server is the headless path. One server covers both template slugs.",
  },
  {
    slug: "figma",
    title: "Figma",
    summary: "Read Figma files, frames and design data through the REST API.",
    credential: "FIGMA_API_KEY",
    provides: ["mcp:figma"],
    spec: {
      command: "npx",
      args: ["-y", "figma-developer-mcp", "--stdio", "--figma-api-key=${FIGMA_API_KEY}"],
    },
    setup: "figma.com → settings → personal access tokens (figd_…).",
    upstream: "community (Framelink figma-developer-mcp, stdio)",
    note: "Figma's own Dev Mode MCP server needs the desktop app running; the API-key server is what a box can run.",
  },
  {
    slug: "x",
    title: "X (Twitter)",
    summary: "Post, search and read timelines through the X API.",
    credential: "X_API_BEARER_TOKEN",
    provides: ["mcp:x"],
    spec: {
      command: "npx",
      args: ["-y", "@enescinar/twitter-mcp"],
      env: { TWITTER_API_KEY: "${X_API_BEARER_TOKEN}" },
    },
    setup: "developer.x.com → project → app → bearer token. Read-only scope is the safe grant; posting needs a write-scoped app.",
    upstream: "community (@enescinar/twitter-mcp, stdio)",
    note: "There is no official X MCP server; treat this door as best-effort and prefer the browser connector for anything that must not break when the API tier changes.",
  },
];

/** `${VAR}` in any string value, from the given environment; a missing variable becomes empty. */
export function expandEnv(text: string, env: NodeJS.ProcessEnv): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (whole, name: string) => {
    const value = env[name];
    return value !== undefined && value !== "" ? value : whole;
  });
}

export function doorBySlug(slug: string): ConnectorDoor | undefined {
  return CONNECTOR_DOORS.find(door => door.slug === slug);
}

export interface DoorsState {
  /** One config per live door, named `mcp:<slug>`. */
  configs: McpServerConfig[];
  /** Per door: on (credential present) or off, for the log and the settings surface. */
  doors: { slug: string; title: string; on: boolean; provides: readonly string[]; note?: string }[];
}

/**
 * Which doors the environment turns on, as server configs.
 *
 * A door whose credential is absent produces no config and stays off — the honest state:
 * the import flow will say `mcp:notion is not connected here`, which is true, rather than
 * starting a server that fails on every call.
 */
export function doorServers(env: NodeJS.ProcessEnv = process.env): DoorsState {
  const configs: McpServerConfig[] = [];
  const doors: DoorsState["doors"] = [];
  for (const door of CONNECTOR_DOORS) {
    const on = (env[door.credential] ?? "").trim() !== "";
    doors.push({ slug: door.slug, title: door.title, on, provides: door.provides, note: door.note });
    if (!on) continue;
    const config: McpServerConfig = { name: `mcp:${door.slug}` };
    if (door.spec.url !== undefined) {
      config.url = expandEnv(door.spec.url, env);
      config.headers = Object.fromEntries(Object.entries(door.spec.headers ?? {}).map(([key, value]) => [key, expandEnv(value, env)]));
    } else {
      config.command = expandEnv(door.spec.command ?? "", env);
      config.args = (door.spec.args ?? []).map(arg => expandEnv(arg, env));
      config.env = Object.fromEntries(Object.entries(door.spec.env ?? {}).map(([key, value]) => [key, expandEnv(value, env)]));
    }
    configs.push(config);
  }
  return { configs, doors };
}

/**
 * Merges the doors under config.json's `mcpServers`: an operator's entry with the same
 * name wins outright, so overriding a default is one edit and deleting a credential is
 * the off switch. Order is doors first, then the config's own entries.
 */
export function mergeServers(
  fromConfig: readonly { name: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }[],
  env: NodeJS.ProcessEnv = process.env
): McpServerConfig[] {
  const { configs } = doorServers(env);
  const merged = [...configs];
  for (const entry of fromConfig) {
    const at = merged.findIndex(server => server.name === entry.name);
    const config: McpServerConfig = { name: entry.name, command: entry.command, args: entry.args, env: entry.env, url: entry.url, headers: entry.headers };
    if (at >= 0) merged[at] = config;
    else merged.push(config);
  }
  return merged;
}

/**
 * Whether a template's connector slug is satisfied by the running servers.
 *
 * Direct: a server named `mcp:<slug>` (or bare `<slug>`) is configured. Indirect: a door
 * is on whose server covers the slug (`mcp:google` answers for `mcp:gmail`). This is the
 * answer the import flow asks for each connector a template names.
 */
export function connectorSatisfied(slug: string, serverNames: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const names = new Set(serverNames);
  if (names.has(slug) || names.has(slug.replace(/^mcp:/, ""))) return true;
  for (const door of CONNECTOR_DOORS) {
    if (door.provides.includes(slug) && (env[door.credential] ?? "").trim() !== "") return true;
  }
  return false;
}
