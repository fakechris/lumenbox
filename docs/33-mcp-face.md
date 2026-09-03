# 33 — The box gets an MCP face: a per-job route on the host, never a credential in the box

**Status: design for hostile review, 2026-09-03 (R29, docs/11 "needed" #2).** Written after reading
how WorkBuddy and QwenWork solved the same problem (`research/2026-09-02-coordination-mcp-memory.md`
§二) and what this tree already has. Not built. Per docs/13 it goes to review with its rejected
alternatives, its blast radius and a standing instruction to break it.

## 0. The problem, and what already exists

MCP servers are host child processes over stdio (`src/host/mcp.ts`, `McpManager`), which is why a
credential never enters the box. The consequence: **nothing running inside the box has an external
tool** — a delegated engine (`Delegate` → `opencode` / `claude` in the box, `presets.ts`) ships
instructions with no ground truth to check them against. docs/11 R29.

What is already in the tree, and is reused rather than re-invented:

- **An MCP server that speaks the wire.** `src/web/mcp-server.ts` answers `initialize`,
  `tools/list`, `tools/call` as stateless JSON-RPC over `POST /mcp`, bearer-authenticated, with
  declared read-only annotations. It exposes *installation* tools to a person's MCP client today
  (the side door). Claude Code's `type: "http"` and opencode's `type: "remote"` servers consume
  exactly this shape.
- **A way for the box to reach the host.** The egress relay is reached as
  `host.docker.internal:8790` from the Docker box (docs/06 §, `docker.ts:534`); Docker Desktop
  resolves that name to the host's loopback, and a Linux engine gets it from `--add-host
  host.docker.internal:host-gateway`. The web server listens on `127.0.0.1:7777`; the same name
  reaches it.
- **A gate every tool call passes.** `dispatchTool` runs `policy.check({kind: "tool"})` before
  anything; `needsReview` classifies the binding class for auto-review; `[conduct]` and the usage
  ledger record what ran.
- **A preset's environment.** `delegateEnv(preset)` hands the engine the model relay's URL and
  token and nothing else of ours; `box.startJob(command, {cwd, env})` starts it.

Two products converged on the shape (research §二): WorkBuddy's daemon runs a loopback MCP host
with one authenticated reverse proxy *per connector* and hands the agent only a loopback URL, a
per-route token and a fingerprint; QwenWork's host runs an "MCP Adaptor" the CLI reaches over a
loopback socket, and in VM mode a stdio shim forwards JSON-RPC over vsock tagged with the session.
Neither lets the sandbox hold a vendor credential; both scope what a session may reach.

## 1. The design

**One route per delegated job.** When `Delegate` starts an engine with `tools` named, the host
mints a *route*: `{ key, token, agentId, conversation, workId, jobId, allowed, createdAt,
expiresAt }`. `key` is 16 random bytes (hex, in the path), `token` 32 random bytes (bearer,
compared in constant time). The route lives in the web-server process, in memory, and expires
after 12 hours or when the delegating agent's `Jobs` check sees the job finished, whichever comes
first. A host restart forgets every route: the engine's next call gets 401 and its run fails
loudly, which is what a restart already does to a job's parent turn.

**The endpoint.** `POST /mcp/r/<key>` on the web server — `handleMcpRequest` generalised to take
its path and its tool list from the route: `tools/list` returns exactly `allowed` (resolved
against `McpManager.tools()` at call time, so a server that came up late is visible and one that
died is not); `tools/call` runs, in order, the route check (key found, token matches, not
expired), the allow-list check, `policy.check({kind: "tool", agentId, tool})` with the
*delegating agent's* identity, then `McpManager.call`. The result is the tool's text, clamped to
the same limit a direct call gets. Body cap 1 MiB, as the side door has.

**What the engine is given.** A preset gains its sixth face, `mcpFace(url, tokenVar)`: the files
and environment that make *this* engine talk to a remote MCP server. Claude Code: a
`.mcp.json` in the job's working directory with `{"mcpServers": {"lumenbox": {"type": "http",
"url": …, "headers": {"Authorization": "Bearer ${LUMENBOX_MCP_TOKEN}"}}}}` — Claude Code expands
`${VAR}` in `.mcp.json` — and `--strict-mcp-config` on the command line so only ours is loaded.
opencode: an `opencode.json` in the working directory with `{"mcp": {"lumenbox": {"type":
"remote", "url": …, "headers": {"Authorization": "Bearer {env:LUMENBOX_MCP_TOKEN}"}}}}` — opencode
expands `{env:VAR}`. The token travels as `LUMENBOX_MCP_TOKEN` in the job's environment, never on
the command line (where `ps` shows it) and never in the file. The URL is
`${AGENTBOX_MCP_FACE_URL ?? "http://host.docker.internal:<web port>"}/mcp/r/<key>`.

**What the delegating agent says.** `Delegate` takes `tools?: string[]` — MCP tool names
(`server__tool`) or a server wildcard (`server__*`). Absent or empty: no face, today's behaviour.
Named: the route offers exactly those and nothing else. The tool description tells the agent to
name only what the brief needs. There is no "all MCP tools" option: the context-budget lesson
from WorkBuddy's `Defer` + `ToolSearch` and Kimi's confirm-before-call is that an unscoped list
is the failure, and the scoping decision belongs to the turn that can read the brief.

**Who may see what.** The route's `allowed` is intersected with what the *delegating agent*
itself may call: an agent whose own tool list withholds `jira__create` cannot lend it to an
engine. Same rule as fork children (docs/32 §2): a child never has more than its parent.

**Record.** Every `tools/call` through a route appends one line to
`~/.agentbox/delegate-calls.jsonl`: `{at, routeKey, agentId, workId, jobId, tool, inputBytes,
ok, ms}` (never the arguments — they may carry what the tool returned last time), writes a
`[mcp-face]` web-log line, and emits a `delegate_call` turn event for the UI feed. **Deliberately
not a transcript entry**: the delegating agent did not make the call, and a `blocks` entry would
replay into its next request as if it had. The audit ledger is the record; the transcript stays
the agent's own account. (Question for the review, §5.)

**Boxes this covers.** The Docker box, via `host.docker.internal`. An attached box (the Grok VM
over the tailnet) cannot reach the host's loopback; `Delegate` on such a box answers that MCP
tools are not reachable from it and starts without the face. The reverse tunnel or stdio shim
(QwenWork's `mcp-vsock-proxy`) is slice two.

## 2. Alternatives rejected

- **Run MCP servers inside the box.** Puts the credential in the box, which is the one thing the
  whole MCP design exists to prevent (docs/10 S-1, `mcp.ts` header).
- **Put the MCP endpoint on the control plane's model relay** (`src/relay/server.ts`, port
  8788). It holds vendor keys and per-box tokens, but it has no `McpManager`, no policy gate, no
  agent identity and no audit; it would have to grow all four or forward to the web server
  anyway.
- **One long-lived token per box** (like the model relay's). Scopes by box, not by job: every
  engine in the box would reach every tool any brief ever needed. Per-job routes are what both
  products do (WorkBuddy's `SessionConnectorScope`, per-route tokens).
- **Offer every MCP tool and let the engine choose.** Context budget and the confirm-before-call
  default argue against it, and the engine cannot read the brief's intent better than the turn
  that wrote it.
- **A general reverse proxy to the MCP servers' own HTTP endpoints.** Our servers are stdio
  children; there is no upstream to proxy to. The host *is* the MCP server for the engine.

## 3. Blast radius

| where | what changes | migratable later? |
|---|---|---|
| `src/web/mcp-server.ts` | `handleMcpRequest` takes `{path, tools, principalFor}`; a second caller | yes |
| `src/web/server.ts` | `/mcp/r/<key>` mounted before the UI gate, like `/mcp`; route registry lives with the orchestrator | yes |
| `src/host/mcp-face.ts` (new) | route minting, expiry, the audit ledger, the allow-list intersection | new |
| `src/host/presets.ts` | `mcpFace` on each preset; `--strict-mcp-config` for claude | the face is per engine; changing it changes what the engine loads, nothing stored |
| `src/host/tools.ts` `Delegate` | `tools` input; writes the face's files with `box.writeFile` before `startJob`; passes `LUMENBOX_MCP_TOKEN` | yes |
| `src/box/docker.ts` | `--add-host host.docker.internal:host-gateway` unconditionally (today only with the egress relay) | needs `box up --recreate` once |
| `docs/25`, `docs/10` | the face documented; S-1 gains "and the MCP face keeps it so" | — |

Nothing is written to disk that a later change cannot ignore: routes are in memory, the audit
ledger is append-only and read by nothing yet.

## 4. Break it — the standing instruction

Enumerate and answer, with the concrete input:

- The token leaks (engine prints its env; `ps` in the box; a log). What can the holder do, for
  how long? — `allowed` tools of one route, until expiry (12 h) or job end. Not the model key,
  not other routes, not the side door.
- The key leaks without the token (it is in a URL in a config file). — Nothing: the bearer is
  required; the key only selects the route.
- Guessing: 16-byte key, 32-byte token, constant-time compare. — Not a path.
- The engine calls a tool not in `allowed`, or `server__*` for a server added after the route
  was minted. — Refused; a wildcard resolves against the live tool list, so a server that came
  up after minting *is* visible under its wildcard: is that the right rule? (§5)
- Two delegates from one agent, or from two agents, at once. — Two routes; nothing shared.
- The host restarts mid-job. — Routes gone; the engine's calls 401; the job fails; the parent
  turn was already interrupted and resumed with "the outcome is unknown".
- The job ends but the route lives on for hours. — Anything still holding the token in the box
  can call `allowed` tools until expiry. Revoked on the next `Jobs` check; is 12 h the right
  ceiling, or should a route die with the job's process (which the host cannot see today —
  docs/32 §3)? (§5)
- A tool call runs for minutes (a slow MCP server). — Plain POST, the server's own timeout;
  `McpManager.call` has none today. The engine's client will time out first. Should the route
  impose one?
- The engine asks `tools/list` every call. — Cheap; the list is resolved from memory.
- A 2 MiB argument. — Refused at 1 MiB, like the side door.
- The delegating agent's standing approvals (`PolicyGate` session/standing) are consulted for
  a call the agent did not make. — Yes, by design: the engine acts *for* that agent under that
  agent's grants. Is that acceptable, or should route calls ignore standing approvals and refuse
  anything that would have needed one? (§5)
- The audit file grows without bound. — Append-only; compaction like the others; read by
  nothing yet.
- An attached box. — No face; said in the Delegate answer.

## 5. Questions for the review

1. Audit ledger versus transcript entry for a route's calls — the design says ledger; argue the
   other side.
2. Wildcards resolving against the live list — a server that comes up later becomes visible.
   Snapshot at mint instead?
3. Route lifetime: 12 h ceiling + revoke on the next `Jobs` check. Shorter default? Tie to the
   job's exit once docs/32's boxd exit files exist?
4. Standing approvals: honoured for route calls (engine acts as the agent) or ignored (route
   calls must never need one)?
5. Should the fork fence's rule "a child never has more than its parent" also mean a route
   cannot be minted from a fork conversation? (Proposed: yes — `Delegate` is already withheld
   from forks.)

## 6. Order, size, tests

1. `mcp-face.ts` + `handleMcpRequest` path/tools generalisation + `/mcp/r/<key>` + audit. Tests:
   a route answers `tools/list` with exactly `allowed`; a wrong token is 401 and a missing route
   404; a call outside `allowed` is refused before the policy gate; a refused policy is a tool
   error with the reason; expiry; the audit line shape; the intersection with the agent's own
   list. S–M.
2. Presets' `mcpFace` + `Delegate.tools` + files written before `startJob` + env; `docker.ts`
   add-host. Tests: the files' contents per preset; the command line carries no token; a box of
   kind `attached` gets no face and the answer says so. S.
3. Live: delegate to `opencode` in the Docker box with `tools: ["<server>__<tool>"]` and watch the
   audit line appear. Then docs/25 and docs/10.
