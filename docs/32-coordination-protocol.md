# 32 — Coordination as protocol, slice one: a fork ledger that survives restarts, and fenced children

**Status: v2 after hostile review, 2026-09-03 — built the same day (`feat/r30-ledger`).**
`src/host/pending-work.ts` (four events, fsync'd `prepared`, the startup sweep), `inbox.drop`,
`bus.sendFromUser`/`deliverSystem` returning the admission seq, `TurnLedger.endIn` and the
`fork/*` skip, `ToolContext.workId`, `outcome.commit` committed by the engine after the results
entry, `FORK_WITHHELD_TOOLS` + `buildTools(…, fork)` + the dispatch refusal + `FORK_PROMPT_LINE`,
no MCP for forks; `server.ts` sweeps before recovery. §3's deferrals stand.

**Second review, on the implementation (Codex, same day): seven P1s, all fixed.** The sweep no
longer trusts the ledger for *what* to cancel — every unstarted admission in `fork/*` is dropped
and every interrupted `fork/*` turn ended, ledger or no ledger (`bus.dropAdmissionsWhere`,
`TurnLedger.endWhere`), which closes the crash between inbox admission and the `admitted` line;
a late result no longer rewrites `admitted`, and both the late note and the dropped note carry
`[fork <id>]` so a restart sees one already queued and commits `late` instead of telling the
parent twice; the parent is told *before* the record is settled, and a note that cannot be
admitted leaves the record open; `inbox.drop` counts only sequences that were pending, so a
sweep cannot trip a compaction that deletes live work; an unreadable ledger is logged loudly
(the cancellation does not depend on it); `RunOnHost` and `computer` joined the withheld set and
a fork's tool context carries no host runner and no MCP client, so a forged call for either is
"unknown tool".

**Stated limits, by the same review:** `committed` after the results entry is call ordering,
not fsync ordering — only `prepared` is fsync'd; transcript and inbox appends are not, and a
crash between them can leave `committed` on disk with the results entry lost. That is R30's
"`appendLine` fsync everywhere" item, unchanged. And there is no single-writer lock: two hosts
over one home would sweep each other's forks, the same unsupported configuration `TurnLedger`
already names. v1 (a `begin`/`settle` ledger for forks
and delegates, fenced children, fail-closed leases) went to Codex for the docs/13 review and was
rejected on twelve findings, all verified against the tree. What survived is narrower and
honest about what it does not fence. The evidence behind the choices is
`research/2026-09-02-coordination-mcp-memory.md` §一.

## 0. What the review found, and what it changed

| v1 said | What the tree does | v2 |
|---|---|---|
| `begin` before the side effect, `settle` after | A fork message is admitted to the durable inbox at `sendFromUser`; a crash after that makes startup *replay* the message while the ledger would call it dropped — one fork, two authorities | Four states, and the ledger is the authority for `fork/*` at startup: it cancels the inbox item and the interrupted turn before either recovery path runs |
| Delegate records a job id before starting the job | boxd mints the id inside `startJob` and returns it afterwards (`job-service.ts:24`); the host cannot record what it does not have; boxd's job table is in memory | Delegate is out of this slice. It needs a client-supplied job id and a persisted exit status in boxd (an image rebuild) — slice two |
| "Nothing is re-run automatically" | `resumeInterrupted` resumes every interrupted conversation, `fork/*` included | Fork conversations are never resumed across a restart; their ledger record ends `dropped`, the parent is told |
| Settle `done` inside the Fork tool | The parent's tool result is appended to the transcript only after `dispatchTool` returns; a crash in between records done for findings nobody received | `committed` is written by the turn engine after the results entry is on disk; the tool returns the ids to commit |
| Late results retried up to eight times | The inbox has `admitted` and `started`, no attempt counter; a failed turn is not retried from the inbox by design | No cap. A late result is `committed` the moment the inbox admits it durably; what happens after is the inbox's existing contract |
| Ledger "like TurnLedger" | TurnLedger swallows append failures and `appendLine` never fsyncs — fail-open by construction | `prepared` is written with fsync and a failed write refuses to start the fork |
| "Its only outward channel is its return value" | MCP tools are concatenated after `buildTools`; `bash` can curl; `OtherThreads` shows fork siblings by prefix | MCP tools stripped for forks; `OtherThreads` stripped; a dispatch-level refusal so a forged call cannot slip past the list. `bash` stays and is named as the hole it is: egress is R4's, not a tool list's |
| Leases keyed by `(agent, about)`, "every write guarded" | The bus runs one agent concurrently in several conversations, so two turns share that key; `about` is free text; `bash`, Delegate and MCP write without a claim | Leases are out of this slice. Slice two, with a resource model (task ids first) and a lease bound to `(turnId, resource)` |
| `workId` on the record | `workId` is local to `runTurn`; `ToolContext` carries `turnId` only | `workId` added to `ToolContext` |

## 1. The fork ledger

**File:** `~/.agentbox/pending-work.jsonl`. Append-only, replayed, compacted when nothing is open.

**States**, one line each, keyed by a host-minted `id`:

```jsonc
{ "event": "prepared",  "id": "pw-…", "agentId": "…", "workId": "…", "turnId": "…",
  "parent": "<conversation>", "child": "fork/<parent>-<stamp>-<n>", "brief": "<first 120 chars>",
  "at": "…", "build": { "version": "…", "commit": "…" } }
{ "event": "admitted",  "id": "pw-…", "inboxSeq": 123 }
{ "event": "committed", "id": "pw-…", "how": "done" | "failed" | "late", "at": "…" }
{ "event": "dropped",   "id": "pw-…", "why": "restart" | "unrecorded", "at": "…" }
```

- `prepared` is written **before** `sendFromUser`, with `fsync`. If the append throws, the fork is
  not started and the tool answers "could not record the fork, so it was not started" — the one
  place in the codebase where bookkeeping is allowed to stop work, because the whole point is a
  record that exists before the effect.
- `admitted` carries the inbox sequence `sendFromUser` now returns, so the record can find its
  own message in the inbox later.
- `committed` is written by `turn.ts`, not by the Fork tool: after the round's `results` entry is
  appended to the parent's transcript (the durable delivery), for every id the tool outcome
  listed in `outcome.commit`. `how` is `done` or `failed` per fork. A fork that lands late (the
  join was cut short by steering, docs/31) is committed `late` right after `deliverSystem`
  returns the inbox sequence of the note it queued — admitted durably is delivered, by the
  inbox's own contract.
- `dropped` is written by the startup sweep.

**Startup order** (`server.ts` after `connectBox`): pending-work sweep, then `bus.recover()`,
then `resumeInterrupted()`. The sweep, for each open record:

1. `inbox.drop(seq)` for its `admitted` sequence — a new inbox event, treated by `pending()` like
   `started`: the message is not replayed.
2. `turns.endIn(child)` — every interrupted TurnLedger record in the child conversation is ended
   `dropped-fork`, so `resumeInterrupted` never sees it. `interrupted()` also skips `fork/*` as a
   belt to that brace.
3. Append `dropped`.
4. `deliverSystem` to the parent conversation: *"Fork N (brief…) was dropped by a restart before
   its findings reached you. Its last words: <last assistant text of the child, 300 chars, or
   'nothing yet'>. Anything it did is an attempt, not a result."* No path — the model cannot
   read host paths — and no automatic re-run.

A record with `prepared` and no `admitted` (the crash landed between the two appends) is
`dropped` with `why: "unrecorded"`; the message was never admitted, so nothing runs.

## 2. Fenced children

A conversation under `FORK_PREFIX` is built with `buildTools(…, { fork: true })`, which
withholds `SendToAgent`, `CreateAgent`, `UpdateAgent`, `Tasks`, `ClaimWork`, `RememberFact`,
`PackTemplate`, `Delegate`, `Fork`, `AskUser`, `OtherThreads`. In `turn.ts` the MCP tool list is
not concatenated for forks. `dispatchTool` refuses any of those names when
`context.conversation` is a fork, whatever the model was offered — the list is the offer, the
refusal is the fence. The child's system block gets one line: *you are a fork; your findings go
back as your final message; you cannot message anyone, change the board, or remember for the
team.*

Kept: every read except `OtherThreads`, `bash`, files, the browser, `SetPlan`/`SetTodos`,
`Recall`/`ReadHistory`. The desktop was never offered outside the main conversation.

**Stated, not solved:** `bash` reaches the network. A fork that wants to page someone can curl a
webhook. The fence is over *our* channels — the ones that create records, wake agents and write
memory — and the network is a scope's egress policy (R4, declared, unenforced). Written here so
nobody reads "fenced" as "sandboxed".

## 3. Out of this slice, with the precondition each is waiting on

- **Delegate in the ledger — done in slice two (2026-09-03).** boxd accepts a caller-minted
  `job_id` (`job-` + 8–32 hex; the same id twice returns the running job), writes `<id>.exit`
  beside the log atomically on process end, and at start reads the jobs directory back: an exit
  file lists as exited with its code, a log with no exit file lists `interrupted`. The host mints
  the id, writes `prepared {kind: "delegate", child: <jobId>}` before the box hears of it,
  `admitted` after the start, and settles wherever it sees the job end — the `Jobs` tool, the MCP
  face's lease renewal, or the startup sweep, which asks `box.jobs()`: running stays open, exited
  commits done/failed, interrupted or gone is dropped with a note carrying the log's path.
  Leases remain deferred.
- **Leases that fail closed** — needs a resource model first. Proposed: task ids (the board already
  has them), a lease bound to `(turnId, taskId)` and checked on every `Tasks` write; file paths
  later, with the honest note that `bash` and MCP writes cannot be fenced by a claim. `claims.ts`
  must also refuse to grant when its record cannot be written.
- **Terminal states for forks beyond done/failed, the submission gate, `appendLine` fsync
  everywhere** — R30's remaining list, unchanged.

## 4. Order, size, tests

1. `pending-work.ts` (ledger, fsync, sweep) + `bus.sendFromUser` returning the seq +
   `inbox.drop` + `turns.endIn` + `ToolContext.workId` + `outcome.commit` and the commit hook
   in `turn.ts` + Fork writing the four events. Tests: prepared precedes admission on disk; a
   failed prepared write leaves no message in the bus; a second orchestrator over the same home
   after a simulated crash drops the fork, cancels the inbox item, ends the child's turn record,
   and the parent's inbox holds the note with the child's last words; committed is absent until
   the results entry exists; a late result is committed with the inbox seq. M.
2. The fence: `buildTools({fork})`, no MCP for forks, the dispatch refusal, the prompt line.
   Tests: the list; a forged `SendToAgent` in a fork gets the refusal text and sends nothing;
   `OtherThreads` is absent. S.

Both land on `main` alone.

## 5. Review questions, answered

- *Partial transcript of a dropped fork:* the fact, the child conversation id and its last
  assistant text, inline; no path (unreadable from the box), no automatic re-run.
- *`RememberFact` in a fork:* stripped. A slice's conclusion is the parent's to reconcile.
- *Lease identity:* bound to `turnId` and a resource key, never `(agent, about)` — deferred with
  the leases themselves.
