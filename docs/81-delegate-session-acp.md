<!-- doc: 81-delegate-session-acp
     title: Delegate as a session: what mcode's ACP actually does, and what enters the host
     family: decision
     status: current
     domain: delegate-session
     updated: 2026-10-20
-->

# Delegate as a session: what mcode's ACP actually does, and what enters the host

INV-1234, step one. Delegate today is one job per brief: `bash background: true`, a log, an
engine report at the end (docs/25). Nothing can reach a running delegation — not a correction,
not a permission answer, not a second brief on the same repository without a cold start.
`presets.ts` has said since docs/25 that a session protocol is the upgrade. This records what the
first candidate engine's session protocol measured as, and what of it the host will take.

Everything in §1 was run, not read: `mcode acp` 0.6.12 in the box image, driven by a 150-line
stdio JSON-RPC client, against a stub Anthropic-messages server on an `--internal` docker network
(no route anywhere else). The raw exchanges are in `research/2026-10-20-acp-spike/` (ignored, on
the maintainer's machine). Where the engine's source (minimax-code 9a93560) said something
different from what 0.6.12 did, the measured value is given and the difference named.

## 1. Measured

Transport: `mcode acp`, stdio, newline-delimited JSON-RPC 2.0, one client per process; stdout is
protocol only, the engine's own logging goes to stderr. No `--cwd`, `--config` or `--permission`
flag: the working directory is `session/new.cwd`, the profile is `config.yaml` in
`MINIMAX_DATA_DIR`, and the permission policy is the profile's `permissionMode` or
`session/set_config_option`.

| call | what happened |
|---|---|
| `initialize` | answers without any credential; `agentCapabilities.loadSession: true`, `sessionCapabilities {list, fork, resume, close}`, `promptCapabilities.image: **true**` (the source at 9a93560 says false — not tested with an image), `_meta['minimax-code/extensions']` lists the `mcode/session/*` methods |
| `session/new` with no profile in the data directory | `-32000 Authentication required: Run \`mcode login\``. The credential check is here, not at `initialize`. With a `custom_provider` profile, no login is needed |
| `session/new` | `{sessionId: "mvs_…", modes {default, plan}, configOptions [permissionMode, model, thinkingEffort]}`, then three `available_commands_update` notifications |
| `session/prompt` (text) | `session/update` stream: `session_info_update`, `mcode/session/delegation_update`, `agent_message_chunk` per word, two `usage_update` (`used: 59, size: 200000` — context occupancy, **not** per-turn tokens), then the response `{stopReason: "end_turn"}` |
| `mcode/session/steer` with no turn running | `-32602 Steering requires an admitted, active ACP prompt Turn for this Session.` |
| `mcode/session/steer` 4 s into a running turn | `{turnId, mode: "steered"}`; the same `clientRequestId` again → `mode: "duplicate"`. The stub saw no second model request: the steer is queued into the turn, and "steered" means accepted, not acted on |
| `session/cancel` (notification) during a turn | the pending `session/prompt` answered `{stopReason: "cancelled"}` within 80 ms; the stub logged "client went away mid-stream"; the process stayed up and the next `session/prompt` on the same session answered `end_turn` |
| `permissionMode: default` (Ask), model calls `bash echo …` | **no** `session/request_permission`: the deterministic rules allowed it; the tool ran (`tool_call` → `in_progress` → `completed`) |
| `permissionMode: default`, model calls `bash curl …` | `session/request_permission {sessionId, toolCall {toolCallId: "perm_…", title: "bash", name: "bash", kind: "execute", status: "pending", rawInput {command}}, options [allow-once / allow_once, allow-always / allow_always, deny / reject_once]}` — a request *from* the engine with its own `id`. Answered `{outcome: {outcome: "selected", optionId: "allow-once"}}` → `tool_call_update completed` with `rawOutput`, then `end_turn` |
| the same, never answered | the engine waited (15 s observed, no timeout in the source); `session/cancel` then resolved the prompt as `cancelled`, process still up |
| `permissionMode: bypassPermissions`, `bash curl …` | no request; the tool ran; `end_turn` |
| `session/list {cwd}` | every session with that `cwd`, newest first, with `title` (the first prompt) and `updatedAt` |
| `session/load` in a **new process**, same `sessionId`, same `cwd` | replays history as `user_message_chunk` / `agent_message_chunk`, answers `{modes, configOptions}`; a further `session/prompt` on it works |
| `session/load` with a different `cwd` | `-32602 Requested cwd does not match the persisted session workspace: /tmp.` |
| `session/load` of an unknown id | `-32002 Resource not found` |
| SIGTERM during a turn | process exits 0 within 200 ms; no `mcode` process left behind |
| provider unreachable (one-shot `exec`, docs/25) | the ACP equivalent is a JSON-RPC `internalError` on `session/prompt` (read, not run) |

What the stub saw across all runs: `POST /v1/messages/count_tokens` (answered 404, tolerated)
and `POST /v1/messages` with `x-api-key`. Nothing else, and nothing could have left the network.

Two defaults that would have been wrong silently, both confirmed on the wire:

- `permissionMode` defaults to `auto` ("smart"), which classifies in MiniMax's cloud. The
  profile must say `default` (Ask, so the question reaches the client) or `bypassPermissions`.
- `goal.verification` for a custom provider defaults to `none`; the profile says `subagent`.

## 2. What enters the host, and what does not

**Enters (step two of INV-1234, to be committed separately):**

1. **A session per delegation, for presets that speak ACP.** boxd keeps the `mcode acp`
   process and its stdio under the job id; the host speaks JSON-RPC to it through boxd. The
   job's log stays the record. Presets without ACP keep the one-shot path untouched —
   `presets.ts` changes the `run` line and nothing else, as it promised.
2. **Permission questions go to the policy gate.** `session/request_permission` becomes a
   host-side approval with the tool call as the thing being approved; the gate's answer maps
   `allow` → `allow-once`, `deny` → `deny`. `allow-always` is never sent: a standing grant
   inside an engine is a grant the host cannot see. The profile sets `permissionMode: default`.
   An unanswered question holds the turn open indefinitely (measured), so the host's consent
   wait (the same ten minutes the MCP face gives a person, `delegated-consent.ts`) ends with a
   deny to the engine and `session/cancel`, not with silence; the stale request is withdrawn.
3. **steer = `mcode/session/steer`, with the host's own idempotency key.** The reply
   `steered` is an acceptance, not an adoption; the host records it as "delivered to the
   engine" and nothing more (the constraint in INV-1234). `duplicate` is a no-op. With no turn
   running the engine refuses; the host then opens a new turn with the text instead, which is
   what a steer between turns means.
4. **cancel = `session/cancel`, then wait for the prompt's `cancelled`.** The process stays;
   the host decides whether to keep it (another brief for the same repository) or close the
   session. Outcome `aborted`, never `unknown`, because the engine said so.
5. **After a boxd restart: `session/load` with the same `sessionId` and the same `cwd`.** Both
   are stored on the delegation record at start. A mismatch or an unknown id is a definite
   failure reported as such — not retried, not replayed. The replayed history is not re-shown.
6. **Metering stays with the relay.** `usage_update` is context occupancy and session cost,
   not per-turn tokens; the relay's `delegate` rows (docs/25, model-relay.ts) remain the bill.

**Does not enter, and why:**

- `allow-always` (above). `session/fork` and `queue/*`: nothing in the host asks for them.
- `elicitation/create` (forms): the host's `ask` is a question to a person; mapping a form
  schema onto it is a feature of its own, and `request_permission` already carries the simple
  questionnaire case.
- Images in prompts: 0.6.12 advertises `image: true` where the source said false; untested, and
  a delegation brief is text. Said here so nobody relies on it.
- MCP servers in `session/new`: the MCP face (docs/33) can be lent this way, but the one-shot
  preset does not do it either; later, with the same per-run token discipline.
- A second ACP engine. Claude Code and pi have other session shapes (`--resume`, pi's
  `sendUserMessage`); INV-1256's table covers them. One engine first.

## 3. Step two's acceptance, written from the measurements

- scenario tests with a fake ACP engine (hermetic): open, prompt, steer accepted / duplicate /
  refused-idle, cancel → `cancelled`, a permission question → the gate → `allow-once` /
  `deny`, an unanswered question ended by the approval timeout → `cancelled`, boxd restart →
  `session/load` same cwd ok / different cwd fails definitely.
- the real box: one delegation, one steer mid-turn, one cancel; the profile with
  `permissionMode: default` and `goal.verification: subagent`; the data directory per
  session removed at close.
- `presets.ts` `run` for mcode gains the session form; the one-shot form stays for the three
  other presets and for mcode when the host asks for one-shot.
