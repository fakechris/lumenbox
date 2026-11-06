<!-- doc: 53-connector-doors
     title: Connector doors: the SaaS integrations a third-party template names, on by credential
     family: decision
     status: current
     updated: 2026-11-06
-->
# 53 — Connector doors: the SaaS integrations a third-party template names, on by credential

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

- No OAuth browser flows *for the MCP doors*: every door above is credential-variable
  based by construction. OAuth lives one level down, in §4.
- No per-door tool allowlists beyond what scopes and agent profiles already do — an MCP
  server's tools remain ordinary tools under the same gates (mcp.ts header, unchanged).
- No marketplace UI: the doors are infra, not a gallery (that is docs/29 Stage C, still open).

## 4. The OAuth gate (INV-422, 2026-09-11)

`src/host/oauth.ts` `OAuthGate`, over the vault. Two dances, both finished on the host:

- **authorization code** — an admin starts it in Settings → Connected services
  (`POST /api/connectors/begin` → the provider's page), the provider sends the browser back
  to `GET /oauth/callback`, the host exchanges the code and lands the tokens in the vault as
  the secret `oauth:<provider>`. GitHub is the first door.
- **client credentials** — an app id and secret mint a tenant token (`POST /api/connectors/connect`);
  the host re-mints it when it lapses. Feishu's `tenant_access_token` is the first door.

The vault `Secret` gained `oauth` (provider, kind, expiry, refresh token, client id and
secret); the view a route returns keeps provider and expiry and drops the rest. `Vault.oauthOf`
is for the gate only; `Vault.covers` decides what to offer without an audit line.

The agent side is one tool, `connector_request` (connector, method, path, body). It is offered
only when a live grant covers the agent — the box's bundles (INV-420) or the secret's own
grants — and never to a fork. The host calls `bearerFor`, which refreshes a token inside its
last minute before handing it out, then attaches the bearer and scrubs the token from the
reply even if the endpoint echoes its own headers. A write (anything but GET) is reviewed
as "changes something under the person's authorization". Transcripts, logs and recordings
never carry the token: it exists in `vault.json` (0600) and in one request header.

What this still does not do: the MCP doors of §2 do not read the gate — a `mcp:github`
door driven by an OAuth token is a follow-up, once one is wanted; and providers beyond
GitHub and Feishu are a catalog entry each in `OAUTH_PROVIDERS`.

## 5. Asked before work starts (INV-1666, 2026-11-06)

The import flow's "connected / pending" was the only place anything asked what was missing; a
task or a routine started blind and met the gap halfway through, as an agent's "needs a secret"
card — for a routine at night, a run that sat waiting until morning. `credentialCoverage`
(`src/host/credential-coverage.ts`) is the same question asked before every start, and the
answer is the one this document already gives: a connector is satisfied by a configured server
or a live door (`connectorSatisfied`) or by the OAuth secret `oauth:<provider>` with a live grant
to the agent; a vault secret by existing with a grant (or the box's bundle) covering the agent.

What is needed is read from statements only: the agent's tool list (`mcp:<slug>__…`), its box's
bundles (`refsFor(...).needs`), and the `connectors:` / `secrets:` frontmatter of the skills it
carries (its own agent-scoped ones and those its bundles name, docs/93 §2) — plus, for a routine,
the routine itself, and for an import, the template's skills. Three starts ask it:

- **a task** — from the Tasks panel or a chat. Missing means the board row goes to blocked with
  `waitingOn: credentials: …`, the thread shows a "before this can start" card with a button to
  the settings tab that fixes each item, a chat hears the same list, and the model is not called.
  The vault's change listener re-asks; when it is covered the same task opens and, from a chat,
  starts (`src/host/credential-waits.ts`).
- **a routine** — the scheduler's `precheck`: skipped with `missing_credentials` and held, through
  the run history's own `skip` / `hold` (INV-1665). A person resumes it from the attention list.
- **an import** — the new agent's setup still runs; the card says what the imported work lacks.

Expiring (the agent's only grant, or a token the host cannot re-mint, ends within three days) is
shown and does not stop work. Settings → Team → Secrets says who needs each secret, and Remove
asks first when somebody does. Nothing here requests a credential or changes an OAuth flow.
