# 33 — The box gets an MCP face: a per-job route on the host, never a credential in the box

**Status: v2 after hostile review, 2026-09-03 (R29, docs/11 "needed" #2) — built the same day
(`feat/mcp-face`).** `src/host/mcp-face.ts` (routes, lease, audit, `expandRequested`,
`faceBaseUrl`), `policy.ts` `delegated`, `mcp-server.ts` `path`/`serverName`, `/mcp/r/<key>` in
`server.ts` with the five-minute renewal, presets' `mcpFace`, `Delegate.tools`, `docker.ts`
always maps `host.docker.internal`, `reloadMcp` revokes every route. §7 item 3 ran the same day: Ada delegated to a stand-in engine in the Docker box with
`tools: ["stub__echo"]` against a stub stdio server on the host; the engine read the config
file, reached `http://host.docker.internal:7777/mcp/r/<key>` with the token from its
environment, got `tools/list` = exactly `stub__echo` (annotated destructive), a successful
`tools/call`, "No tool named stub__boom" for a tool not lent, and 401 for a wrong bearer; the
audit line carried the job id, the work id and the result digest. Remaining: the VM shim (slice
two) and a real engine in the image (opencode/claude are not in the current image). v1 went to
Codex and was rejected on fourteen findings, all verified against the tree and the two engines'
current documentation. §0a records what changed. The research behind the shape is
`research/2026-09-02-coordination-mcp-memory.md` §二.

## 0a. What the review changed

| v1 said | What is true | v2 |
|---|---|---|
| the route carries the job id | boxd mints the id while spawning (`job-service.ts:63`) | mint → write files → `startJob` → bind the id; a route with no job yet is valid (its agent, conversation and work are bound); `startJob` failing revokes it |
| `host.docker.internal:<port>` reaches the web server | true on Docker Desktop (the egress relay proves it); false on a Linux engine for a `127.0.0.1` listener; wrong in self-contained mode, where the orchestrator is *inside* the container on `0.0.0.0:7777` (`entrypoint.sh:197`) | the face URL is topology-aware: self-contained (`AGENTBOX_BOXD_URL` is loopback) → `http://127.0.0.1:7777`; otherwise `AGENTBOX_MCP_FACE_URL`, default `http://host.docker.internal:<port>`; a Linux engine needs the operator to bind the web server to the bridge address, said in docs/06 |
| a `.mcp.json` / `opencode.json` in the working directory | two jobs in one repository overwrite each other's; a tracked project config is clobbered; Claude's `--strict-mcp-config` only restricts to servers given by `--mcp-config` | one file per route under `~/.lumenbox/mcp/<key>.json`; Claude: `--mcp-config <file> --strict-mcp-config`; opencode: `OPENCODE_CONFIG=<file>` (its global config still merges — stated) |
| "the same gate every tool call passes" | a direct call also runs auto-review and PreToolUse/PostToolUse hooks; PolicyGate is default-allow and only asks for configured tools | route calls run the PreToolUse/PostToolUse hooks too; auto-review's binding class does not name MCP tools for direct calls either, so parity holds; what the gate cannot see (a generic HTTP tool pointed at `127.0.0.1`) is stated as the delegating agent's choice of `tools`, not the route's |
| intersect with "the agent's own list" | a turn's MCP set is the profile ∩ scope ∩ the chat's bound scope (`turn.ts:1311-1330`) | `Delegate` receives the turn's already-computed `allowedMcp` names and intersects with those, never a recomputation |
| wildcards resolve against the live list | `mcp reload` hot-swaps a server; a route minted for `github__*` would gain `delete_repo` the moment the operator adds it; a failed server keeps its stale tool list | wildcards expand to exact names at mint (a wildcard matching nothing fails the mint); every route is revoked on `McpManager.reload` |
| the ledger never records arguments | `PolicyGate.check` persists `describeRequest`, which includes the input | route calls present `delegated: {jobId}` on the request: the policy log records the tool and byte count, not the input, and **no standing or session approval is consulted** — a call that would need one is refused |
| 12 h ceiling, revoke on the next `Jobs` check | a model action nobody guarantees | a 30-minute lease renewed by the host itself while `box.jobs()` still lists the job as running; an absolute ceiling of 12 h; gone with the job |
| `McpManager.call` has no timeout; results are clamped | it has 120 s; a direct result is not clamped in-round | route results clamped at 200 000 characters; the engine's client timeout must exceed 120 s (documented per face) |
| 404 for an unknown route, 401 for a bad token | a route-state oracle | one 401 for unknown, expired and wrong-token alike; exact path regex; body cap; four calls in flight per route |
| annotations | `McpTool` carries none | every route tool is annotated destructive/open-world: unknown external tools are not read-only by assumption |
| "two routes; nothing shared" | every job runs as the `box` uid; another process in the box can read a job's environment | stated as a limit (§4): the box is one trust boundary (docs/03); a token's blast radius is one route's tools for one lease |

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
mints a *route*: `{ key, token, agentId, agentName, conversation, workId, jobId?, allowed,
createdAt, leaseUntil, ceiling }`. `key` is 16 random bytes (hex, in the path), `token` 32 random
bytes (bearer, constant-time compare). Order: mint → write the face's file → `startJob` → bind
`jobId`; a failed start revokes the route. Routes live in the web-server process, in memory. A
route holds a **30-minute lease** the host renews every five minutes while `box.jobs()` lists its
job as running, under a 12-hour ceiling; a job that is gone, or a host restart, ends it. The
engine's next call then gets 401 and its run fails loudly, which is what a restart already does to
a job's parent turn. `McpManager.reload` revokes every route.

**The endpoint.** `POST /mcp/r/<key>`, matched by `^/mcp/r/[0-9a-f]{32}$` and nothing looser, on
the web server — `handleMcpRequest` generalised to take its path and its tool list from the route.
Unknown, expired and wrong-token routes all answer the same 401. `tools/list` returns exactly the
route's `allowed` names (expanded at mint; a name whose server is no longer up is listed and fails
on call, as it would for the agent). `tools/call` runs, in order: the route check; the allow-list;
`policy.check({kind: "tool", agentId, tool, input, delegated: {jobId}})` — the delegating agent's
identity, no approval reuse, input logged as a byte count; the `PreToolUse` hook; `McpManager.call`
(its own 120 s timeout); the `PostToolUse` hook. The result is the tool's text clamped at 200 000
characters. Body cap 1 MiB; at most four calls in flight per route.

**What the engine is given.** A preset gains its sixth face, `mcpFace(url, tokenVar, path)`: the
file, the environment and the command-line fragment that make *this* engine talk to one remote
MCP server and no other of ours. The file is `~/.lumenbox/mcp/<key>.json` in the box, one per
route, never in a repository. Claude Code: `{"mcpServers": {"lumenbox": {"type": "http", "url": …,
"headers": {"Authorization": "Bearer ${LUMENBOX_MCP_TOKEN}"}}}}` — it expands `${VAR}` in MCP
config — and `--mcp-config <file> --strict-mcp-config` on the command line, which is what makes
the file the only source (verified against the current CLI reference). opencode: `{"mcp":
{"lumenbox": {"type": "remote", "url": …, "headers": {"Authorization": "Bearer
{env:LUMENBOX_MCP_TOKEN}"}, "oauth": false}}}` with `OPENCODE_CONFIG=<file>` — it expands
`{env:VAR}`; its global config still merges, so an operator's own MCP entries in the box would
load beside ours (our image ships none; stated). The token travels as `LUMENBOX_MCP_TOKEN` in the
job's environment, never on the command line and never in the file. The URL: self-contained boxes
(the orchestrator inside the container, `AGENTBOX_BOXD_URL` on loopback) use
`http://127.0.0.1:<port>`; otherwise `AGENTBOX_MCP_FACE_URL`, default
`http://host.docker.internal:<port>` — right on Docker Desktop, where the name reaches the host's
loopback (the egress relay depends on the same fact); a Linux engine needs the web server bound to
the bridge address and the variable set, said in docs/06.

**What the delegating agent says.** `Delegate` takes `tools?: string[]` — MCP tool names
(`server__tool`) or a server wildcard (`server__*`). Absent or empty: no face, today's behaviour.
Named: the route offers exactly those and nothing else. The tool description tells the agent to
name only what the brief needs. There is no "all MCP tools" option: the context-budget lesson
from WorkBuddy's `Defer` + `ToolSearch` and Kimi's confirm-before-call is that an unscoped list
is the failure, and the scoping decision belongs to the turn that can read the brief.

**Who may see what.** The route's `allowed` is the request intersected with the turn's own
effective MCP set — the profile ∩ its scope ∩ the chat's bound scope, exactly the list the turn
computed for itself — passed into `Delegate` as names, never recomputed. An agent whose turn
withholds `jira__create` cannot lend it. A fork conversation cannot mint a route at all
(`Delegate` is withheld from forks and the minting code refuses `fork/*` again). Same rule as
docs/32 §2: a child never has more than its parent.

**Record.** Every `tools/call` through a route appends one line to
`~/.agentbox/delegate-calls.jsonl`: `{at, routeKey, agentId, workId, jobId, tool, inputBytes,
resultBytes, resultSha256, ok, ms}` — never the arguments or the result (either may carry what a
tool returned last time), but a digest of the result so a later dispute can be settled against
what the engine saw. The policy log records the same call as `delegated`, tool and byte count. A
`[mcp-face]` web-log line and a `delegate_call` turn event feed the UI. **Not a transcript entry**:
the delegating agent did not make the call, and a `blocks` entry would replay into its next
request as if it had. The review agreed, and asked for the digest.

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

## 4. Limits stated, not solved

- **The token is readable by any process in the box.** Every job runs as the `box` uid; `/proc`
  shows a sibling's environment. The box is one trust boundary (docs/03) and several agents
  share it; a stolen token buys one route's `allowed` tools for one lease. Per-agent uids in the
  box would be the fix and are a separate item.
- **Argument-level authority is not the route's.** A generic HTTP MCP tool pointed at
  `127.0.0.1` or a metadata address reaches from the host, for the engine as for the agent. The
  route offers what the delegating agent chose to name; naming such a tool is the choice, and
  egress policy (R4) is the answer, not a route rule.
- **opencode's face is not exclusive**; Claude's is.
- **Routes do not survive a host restart** and are not shared between hosts — the same
  single-writer assumption every ledger here makes.

## 5. Break it — the standing instruction

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

## 6. The review's answers, adopted

1. Ledger, plus a result digest, and not a transcript entry.
2. Snapshot at mint; revoke every route on `McpManager.reload`.
3. A short lease the host renews from `box.jobs()`, under a ceiling; tied to the job's exit
   file once docs/32's boxd change exists.
4. No approval reuse: a route call that would need one is refused.
5. Yes: no route from a fork conversation, checked again at minting.

## 7. Order, size, tests

1. `mcp-face.ts` (routes, lease, audit, the intersection, wildcard expansion) +
   `handleMcpRequest` path/tools generalisation + `/mcp/r/<key>` + `policy` `delegated` +
   hooks around the call + revoke on reload. Tests: `tools/list` is exactly `allowed`; unknown,
   expired and wrong-token routes answer one 401; a call outside `allowed` is refused before the
   gate; a `delegated` request that would need approval is refused and logged without input; a
   wildcard expands at mint and a wildcard matching nothing fails the mint; a fork conversation
   cannot mint; reload revokes; the lease lapses when `jobs()` stops listing the job; the audit
   line shape with the digest; the result clamp; four in flight. M.
2. Presets' `mcpFace` + `Delegate.tools` + the file written before `startJob` + env + the
   command-line fragment + `jobId` bound after start + revoke on a failed start; `docker.ts`
   add-host unconditionally. Tests: the file and fragment per preset; the command line carries
   no token; a self-contained box gets the loopback URL; an attached box gets no face and the
   answer says so. S.
3. Live: delegate to `opencode` in the Docker box with one named tool and watch the audit line
   and the lease renew. Then docs/25, docs/06 (the Linux bind note) and docs/10.
