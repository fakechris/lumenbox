# 36 — Connector doors: the SaaS integrations a third-party template names, on by credential

**Status: built, 2026-09-06.** `src/host/mcp-connectors.ts` (the catalog, env gating, merge,
`connectorSatisfied`), `src/host/mcp.ts` `RemoteMcpServer` (Streamable HTTP — the transport
seam that file always named), `orchestrator.ts` `mcpServersFrom` (doors merge under
config.json), `web/server.ts` template-import `connected` (per-slug satisfaction). Tests:
`src/host/mcp-connectors.test.ts` — 8, green, against a real HTTP MCP stub and real env
gating. The demand it serves: the Grok marketplace ports (`research/grokbot/marketplace-sync/`)
carry `connectors: ["mcp:notion", …]`, and before this those names resolved to nothing.

## 0. The shape

A **door** is one SaaS integration as one MCP server, gated on one credential environment
variable. `LINEAR_API_KEY` set → the `mcp:linear` door is live and Linear's official hosted
server answers with the operator's bearer; unset → the door is off, and the import flow says
`mcp:linear is not connected here`, which is true, instead of running a server that fails on
every call. Seven doors: **notion, slack, linear, google (one server satisfying both
`mcp:gmail` and `mcp:google-calendar`), figma, x**.

Precedence is one rule: **config.json's `mcpServers` wins by name.** The doors merge *under*
the operator's entries (`mergeServers`), so overriding a default spec (say, Slack's official
self-hosted image instead of the catalog's community default) is one config edit, and
deleting a credential is the off switch. `reloadMcp` (R36) re-merges on every config reload,
so both levers apply without a restart.

The import flow asks per slug, not per server: `connectorSatisfied(connector, serverNames)`
is true when a configured server's name matches directly (`mcp:notion` or bare `notion`) or
when a live door's `provides` covers the slug. Satisfied connectors join `browser` and the
channels in `connected`; the rest stay pending and the setup turn asks the person — which is
the same rail the Grok ports were designed around (docs/29 §5).

## 1. The transport

`McpServerConfig` gained `url` + `headers` beside `command`/`args`/`env`; exactly one of
`command` and `url`. `RemoteMcpServer` is the stdio child's twin at the `ToolServer` seam:
same `initialize → notifications/initialized → tools/list` handshake, `tools/call` with the
same text-only content bridge, same lazy start, same never-throw-to-callers, same
`startPromise` reset so a down server retries on a later turn. Differences the wire forces:

- the session travels in the `Mcp-Session-Id` response header, captured on `initialize` and
  echoed thereafter; a `404` drops the session once so the next call re-initializes;
- replies arrive as one JSON document *or* an `text/event-stream` of `data:` lines — both
  parsers end at the same `result`;
- a notification (`notifications/initialized`) expects `202` and resolves to nothing;
- `stop()` is `DELETE` with the session header, best-effort, five-second timeout.

`sameServer` compares url and headers beside command/args/env, so a reload restarts a remote
server only when its endpoint or credential actually changed. `setVirtual` refuses to
displace a remote server exactly as it does a stdio one.

## 2. The doors (defaults as of 2026-09-06, each overridable)

| Door | Credential | Default server | Upstream |
| --- | --- | --- | --- |
| `mcp:notion` | `NOTION_API_KEY` | `npx @notionhq/notion-mcp-server` (token in `OPENAPI_MQS_HEADERS`) | official, stdio |
| `mcp:slack` | `SLACK_BOT_TOKEN` | `npx slack-mcp-server` | community; official self-host image is the documented override |
| `mcp:linear` | `LINEAR_API_KEY` | `https://mcp.linear.app/mcp`, `Authorization: Bearer` | official, Streamable HTTP |
| `mcp:google` | `GOOGLE_OAUTH_REFRESH_TOKEN` (+ client id/secret) | `npx @alanxchen/google-workspace-mcp` | community, stdio; covers `mcp:gmail` + `mcp:google-calendar` |
| `mcp:figma` | `FIGMA_API_KEY` | `npx figma-developer-mcp --stdio` | community (Framelink); Figma's own server needs the desktop app |
| `mcp:x` | `X_API_BEARER_TOKEN` | `npx @enescinar/twitter-mcp` | community; no official server exists — best-effort, browser door is the fallback |

Two honest notes baked into the catalog: Notion's hosted MCP is OAuth-only (a headless box
cannot complete the dance — the official stdio server with an integration token is the
supported path), and `expandEnv` leaves an unknown `${VAR}` *visible* rather than silently
empty, so a half-configured door fails loudly at startup, not mysteriously at call time.

## 3. What this does not do

- No OAuth browser flows: every door is credential-variable based by construction.
- No per-door tool allowlists beyond what scopes and agent profiles already do — an MCP
  server's tools remain ordinary tools under the same gates (mcp.ts header, unchanged).
- No marketplace UI: the doors are infra, not a gallery (that is docs/29 Stage C, still open).
