# Adversarial review: the obligation ledger (2026-08-26)

Second hostile review of the design in [docs/16](../16-long-work.md), run under the
practice in [docs/13](../13-design-review.md): a persisted format goes to review before it
is built, and the reviewer's job is to find the sequence that makes it wrong, not to
approve it.

Verdict: five fatal, five major, and ten false claims about our own code. The design was
replaced rather than repaired. Six of the ten false claims were spot-checked against the
source before docs/16 was rewritten, and all six were the reviewer's.

Kept in full, unedited, because a design that fails twice in the same place is evidence
about the place.

---

## 1. THE LEDGER CANNOT ATTRIBUTE COST TO A TASK — fatal

SEQUENCE:

1. Task `t46` is created and worked by parent turn `T1`.
2. `T1` performs several model rounds, opens fork obligation `O1`, and child turn `T2` performs more rounds.
3. Usage rows for both turns contain `agentId`, timestamp, model, round, and tokens.
4. `O1` contains `parentTurnId=T1`, but neither the parent nor child usage rows contain `T1`, `T2`, `O1`, a conversation, or `t46`.
5. A second task for the same agent runs nearby in time.
6. The monthly R31 query cannot assign any usage row to either task except by guessing from timestamps.

DESIGN SAYS:

The obligation graph is “the missing id that ties a task to its turns to their tokens,” enabling task drill-down and median cost by obligation kind (`docs/11-roadmap.md:371-393`; `docs/16-long-work.md:158-169`).

ACTUALLY HAPPENS:

`UsageRecord` has no `turnId`, `conversation`, `taskId`, `obligationId`, or `kind` (`src/host/usage.ts:29-49`). The write site supplies none (`src/host/turn.ts:1433-1445`). Task updates can carry a sparse `TaskChange.run` (`src/host/tasks.ts:46-55`; `src/host/tools.ts:2297-2302,2316-2327`), but task creation carries no run and a task may span many turns (`src/host/tasks.ts:118-149`). The proposed obligation/settlement schema contains no task or cost field at all (`docs/16-long-work.md:98-102`). Adding an ID only to the obligation file changes none of those rows.

VERDICT:

must-be-replaced. Termination may keep an obligation ID, but R31 needs a separate stable `workId`/`taskRunId` propagated onto every usage, transcript, task-change, and artifact event. `obligationId` should identify a child edge, not substitute for the root task execution.

## 2. `childConversationId` COLLAPSES DIFFERENT EXECUTIONS INTO ONE NODE — fatal

SEQUENCE:

1. Parent turns `PA` and `PB` each call `SendToAgent` for agent C.
2. Obligations `OA` and `OB` both name C’s main conversation as `childConversationId`.
3. `AgentBus.send()` internally creates message IDs `MA` and `MB`; neither parent can place those IDs in its write-ahead obligation.
4. C drains both same-lane messages into one turn.
5. That turn may satisfy one request, both, or neither, then emit one answer.
6. Replay sees two obligations pointing to the same conversation and cannot decide which obligation the turn settled or how its cost should be divided.

DESIGN SAYS:

One work graph records every producer and supplies the causal edges needed for termination and reporting (`docs/16-long-work.md:72-81,122-132`).

ACTUALLY HAPPENS:

`sendFromUser` creates the message UUID internally and returns `void` (`src/agents/bus.ts:343-360`); `SendToAgent` similarly receives only prose from `bus.send()` (`src/host/tools.ts:2085-2105`). The bus batches every message of the selected lane and conversation (`src/agents/bus.ts:369-389`). The transcript does preserve the actual message IDs in `causedBy` (`src/host/turn.ts:992-1001`), but the proposed obligation does not store them. Background bash and Delegate are worse: they create `job_id`, not a child conversation (`src/host/tools.ts:1364-1376,1485-1501`), and the schema has no job identifier.

VERDICT:

must-be-replaced. The persisted identity needs a preallocated `dispatchId` shared by obligation, inbox admission, transcript cause, child attempt, and usage. It also needs a typed target—message ID, child turn ID, or job ID—not a universal `childConversationId`.

## 3. NO SETTLEMENT WRITER CAN CLOSE THE SUCCESS/CRASH WINDOW — fatal

SEQUENCE:

1. A fork child executes its work and persists its tool results.
2. It writes its final assistant answer to its transcript.
3. **CRASH HERE:** after the final transcript append but before `runTurn` calls `finish("done")` and before the parent’s awaited `runExclusive()` resolves.
4. The child’s output is durable, the parent process and Promise are gone, and no settlement exists.
5. Restart sees an interrupted child turn and a running obligation.
6. It cannot safely write `succeeded`: the transcript is free prose, and no atomic record binds that answer to the obligation. Retrying can duplicate effects; abandoning loses completed work.

DESIGN SAYS:

Settlement is an enforced node output, idempotently written by obligation ID (`docs/16-long-work.md:92-120`).

ACTUALLY HAPPENS:

Tool traffic is appended at `src/host/turn.ts:1613-1630`; a final answer is appended at `src/host/turn.ts:1508-1519`; only later does the outer loop call `finish("done")` (`src/host/turn.ts:1098-1146`). The Fork parent does not regain control until `runExclusive` resolves (`src/host/tools.ts:1427-1444`). If the parent writes settlement, it dies in this window. If the child writes it, transcript and settlement remain two non-atomic appends—and the current inbound message does not carry an obligation ID. `rescue.ts` only repairs board tasks; it does not reconcile forks or settlements (`src/host/rescue.ts:37-50,78-94`).

VERDICT:

must-be-replaced. The lifecycle needs an authoritative attempt-commit record containing the obligation ID, child attempt ID, structured result/artifact references, and outcome. Writing success separately from the durable result cannot prove success across this crash.

## 4. WRITE-BEFORE-DISPATCH DOES NOT MAKE THE CLAIMED STATES DISTINGUISHABLE — fatal

SEQUENCE:

1. Parent turn writes obligation `O` for child conversation C.
2. `sendFromUser` admits message M.
3. `runExclusive` drains M and records it `started`; if the inbox is over its threshold, this immediately compacts admission and start history away.
4. **CRASH HERE:** during `ensureDesktop` or skill refresh, before `runTurn` is called.
5. No child transcript exists and no child `TurnLedger.begin` exists.
6. Restart sees exactly the same usable state as a crash between steps 1 and 2: obligation O, no pending inbox message, no child turn.

DESIGN SAYS:

An obligation with no child conversation is distinguishable and can be settled `abandoned` (`docs/16-long-work.md:104-110`).

ACTUALLY HAPPENS:

There is a syntactic write point: Fork computes C before calling `sendFromUser` (`src/host/tools.ts:1420-1433`). But the bus marks the inbox item started before invoking the turn runner (`src/agents/bus.ts:483-500`), and orchestrator setup occurs before `runTurn` (`src/host/orchestrator.ts:471-497`). `TurnLedger.begin` is much later (`src/host/turn.ts:1083-1096`). Inbox compaction erases all history when no admission remains (`src/agents/inbox.ts:111-118,180-187`). The obligation also lacks M’s ID, so it cannot reconcile against raw inbox records. Worse, current durable admission fails open: an inbox append failure is warned about and dispatch continues (`src/agents/inbox.ts:125-139`; `src/agents/bus.ts:321-327`). `appendLine` issues no `fsync`, so host-power-loss durability is not established (`src/host/jsonl.ts:44-47`).

VERDICT:

repairable only by preallocating one dispatch ID, requiring the obligation append to succeed before dispatch, admitting idempotently under that same ID, recording a dispatch transition, and refusing the effect if any mandatory write fails. The current five-field schema cannot implement that protocol.

## 5. `parentTurnId` IS AN ATTEMPT ID, NOT A DURABLE GRAPH SPINE — fatal

SEQUENCE:

1. Parent turn `T1` opens obligation O and crashes.
2. Startup recovery writes `end(T1, "resumed")`.
3. It puts `{id:T1, attempt:n}` in the process-local `resuming` map and begins enqueueing a resume.
4. **CRASH HERE:** before resumed turn `T2` writes its begin record.
5. Next restart sees T1 as ended and no T2; the parent is never resumed.
6. O remains attached to dead attempt T1 forever.
7. Even without the second crash, T2 receives a new UUID, so an exact `parentTurnId=T2` gate sees none of T1’s obligations.

DESIGN SAYS:

`parentTurnId` supplies the durable parent edge needed by the graph (`docs/16-long-work.md:98-110`).

ACTUALLY HAPPENS:

Every `runTurn` creates a fresh UUID (`src/host/turn.ts:816-824`). Recovery closes the old turn before the replacement exists and keeps the handoff only in memory (`src/host/orchestrator.ts:172-179,571-586`). `resumeOf` is stored in the raw begin record, but `interrupted()` discards it from its returned representation (`src/host/resume.ts:50-63,75-85,143-159`). Completed turn history is eventually compacted to an empty file (`src/host/resume.ts:129-133,201-208`). Transcript entries carry message IDs, not turn IDs (`src/host/turn.ts:454-476`).

VERDICT:

must-be-replaced. Keep `turnId` as an attempt identifier, but add a stable `rootWorkId` that survives every resume and appears on obligations, transcripts, usage, tasks, and artifacts.

## 6. DETACHED IS A MODEL OPINION DISGUISED AS A PROOF — major

SEQUENCE:

1. The model starts a background build whose output the final answer requires.
2. If the harness classifies all background work as detached, the parent finishes immediately and answers from stale or incomplete artifacts.
3. The model instead starts a development server intended to run indefinitely.
4. If the harness classifies all background work as non-detached, the obligation never settles and the parent can never finish.
5. Asking the model to choose merely moves the correctness decision into an unverified boolean.
6. A plain bash command can bypass the explicit flag entirely by escaping its process group; `RunOnHost` accepts arbitrary `/bin/sh -lc` commands that can do the same.

DESIGN SAYS:

Every producer opens an obligation or is explicitly detached, and detached is the only work a parent may finish without (`docs/16-long-work.md:122-125`).

ACTUALLY HAPPENS:

The bash schema exposes only `background`, not dependency or detachment semantics (`src/host/tools.ts:357-390`). Delegate has no such field at all (`src/host/tools.ts:423-453`). The obligation schema has no `detached` field (`docs/16-long-work.md:98-102`). Ordinary shell commands are raw bash (`src/boxd/shell-service.ts:315-354`), and the repository has a test proving a detached descendant can escape the process group and keep running (`src/boxd/shell-service.test.ts:180-203`). `RunOnHost` likewise runs arbitrary shell text (`src/host/host-runner.ts:97-125`). The harness cannot enumerate all producers while those escape hatches exist.

VERDICT:

must-be-replaced as a “provable” property. A typed `joinPolicy` can record declared intent, but proof requires harness-owned execution primitives and prohibition or containment of untracked process creation. Otherwise detached remains advisory.

## 7. PERMANENT `failed` REINTRODUCES THE PREVIOUS LIVELOCK — major

SEQUENCE:

1. Child attempt A deterministically fails.
2. Settlement becomes `failed`, which the design defines as unresolved.
3. The completion gate refuses the parent’s final answer.
4. Parent retries; attempt B fails identically.
5. The failed obligation still blocks completion, and no mandatory retry limit, resolver, or authority changes it to a terminal resolution.
6. A new turn or restart repeats the same cycle.

DESIGN SAYS:

The parent may retry, proceed without the child, or report the failure, but may not finish over `failed` (`docs/16-long-work.md:112-117`).

ACTUALLY HAPPENS:

Those actions do not define a state transition. `abandoned` exists in the enum, but the schema says neither who may write it nor what evidence authorizes it. If the model chooses, termination again depends on model opinion. Current round/continuation limits only stop one execution (`src/host/progress.ts:137-144`; `src/host/turn.ts:1666-1725`); they do not resolve a persisted failed obligation. The default spend ceiling is also `undefined` (`src/host/policy.test.ts:152-160`).

VERDICT:

repairable by separating attempt outcome from obligation resolution: `attempt_failed` must be followed by either a bounded retry with a new attempt ID or an explicit `waived/abandoned/accepted_incomplete` decision from a named authority. The retry and wall/spend limits must themselves be durable.

## 8. LAST-WRITE-WINS IS NOT IDEMPOTENCE — major

SEQUENCE:

1. A restart reconciler reads obligation O and sees no settlement.
2. The child finishes and appends `succeeded`.
3. The stale reconciler, acting on its earlier observation, appends `unknown`.
4. Replay chooses the later record.
5. A durably successful child is now unresolved. Reversing the race allows a late child to overwrite a deliberate abandonment.

DESIGN SAYS:

Settlement is idempotent because it is keyed by ID and last write wins (`docs/16-long-work.md:119-120`).

ACTUALLY HAPPENS:

Appending the same fact twice is idempotent; allowing different facts to overwrite each other is not. Parent and child work can overlap because turns in different conversations run concurrently (`src/agents/bus.ts:157-175`). The schema has no attempt number, expected version, writer authority, or legal transition table. Existing last-write-wins code illustrates exactly the semantics being proposed: replay blindly replaces the prior value (`src/channels/conversations.ts:41-49`).

VERDICT:

repairable with attempt-scoped events, a single authorized outcome writer or compare-and-set version, and monotonic transitions. `succeeded` must not regress to `unknown` or `failed` because a stale observer appended later.

## 9. THE “ENFORCED OUT” IS STILL FREE TEXT — major

SEQUENCE:

1. Parent requires a child result shaped as `{supplierIds, citations}`.
2. Child writes an essay or “done” instead.
3. Settlement records `state:"succeeded", note:"looks good"`.
4. The gate sees success and permits completion.
5. Downstream aggregation has neither the required fields nor artifact/version evidence, so wrong still looks complete.

DESIGN SAYS:

Free text is rejected, and the settlement is the node’s enforced `OUT` (`docs/16-long-work.md:83-96`).

ACTUALLY HAPPENS:

The proposed settlement contains only `id`, `state`, `at`, and free-text `note` (`docs/16-long-work.md:98-102`). `kind` has no enum, version, or schema registry. Current Fork demonstrates the unchanged behavior: it concatenates every assistant prose entry and returns that text (`src/host/tools.ts:1434-1455`). No proposed field carries structured output, artifact references, validation result, or output-schema version.

VERDICT:

must-be-replaced. Each versioned kind needs an enforced input/output schema, structured result or artifact references with digests, and machine-readable failure codes. `note` may remain diagnostic prose but cannot be the node output.

## 10. ONE FILE CANNOT SERVE TERMINATION AND MONTH-LONG ANALYTICS — major

SEQUENCE:

1. The ledger accumulates thousands of settled obligations over several months.
2. Compaction keeps only the open set, as termination requires.
3. R31 asks where last month’s cost went; all successful historical edges are gone.
4. If compaction instead retains every settlement, termination startup must replay an ever-growing analytics history to recover a small open set.
5. Existing source ledgers independently discard the rows needed for the historical join anyway.

DESIGN SAYS:

One append-only ledger serves both the current completion gate and historical cost estimation/drill-down (`docs/16-long-work.md:136-169,241-249`).

ACTUALLY HAPPENS:

Operational ledgers compact to current state: ingress keeps unresolved messages (`src/channels/ingress.ts:151-161`), deliveries keep pending debt (`src/host/deliveries.ts:107-119`), and conversations keep one current mapping (`src/channels/conversations.ts:70-80`). Turn history is erased when nothing is open (`src/host/resume.ts:129-133,201-208`). Tasks discard closed work after 30 days (`src/host/tasks.ts:73-77,279-300`). Usage keeps a count tail plus only 48 hours (`src/host/usage.ts:64-79,250-275`). R31 explicitly asks an administrative, month-scale view (`docs/11-roadmap.md:395-410`).

VERDICT:

must-be-replaced as one retention policy. Keep a compact operational open-obligation index for termination and a separate immutable/exported event stream for analytics. They may share IDs and originate from the same events, but they cannot share destructive retention.

## FALSE ASSERTIONS IN docs/16

- “`Usage` ledger — every call’s tokens, attributed to a principal” and “`usage.jsonl` records every call against a principal.” False. `principal` is optional (`src/host/usage.ts:29-49`), and scheduled/agent-driven rounds omit it (`src/host/turn.ts:1433-1438`). Summarization, memory selection, extraction, and episode calls are not written to `UsageLog` at all (`src/host/turn.ts:574-585`; `src/host/orchestrator.ts:622-629`; `src/host/remember.ts:155-163`).

- “We have the history for that: 562 calls with kinds and token counts.” False. `UsageRecord` has no `kind` field (`src/host/usage.ts:29-49`); the write site supplies none (`src/host/turn.ts:1433-1445`).

- “The estimate and the actual go in the same ledger.” False. The proposed records contain neither an estimate nor actual tokens, cost, task ID, or usage-row key (`docs/16-long-work.md:98-102`).

- “A settlement record is a node’s `OUT`, enforced.” False. The only output-like field is untyped free-text `note`, directly contradicting the claimed rejection of free text (`docs/16-long-work.md:83-102`).

- “A restart can see an obligation whose conversation never began and settle it `abandoned`.” False. After inbox `started` and compaction but before orchestrator setup reaches `runTurn`, dispatch-started and never-dispatched both reduce to obligation-only recovery state (`src/agents/inbox.ts:111-118,180-187`; `src/agents/bus.ts:483-500`; `src/host/orchestrator.ts:471-497`).

- “Every producer of work opens one … or is explicitly declared detached.” False. Neither the proposed schema nor current bash/Delegate tool inputs encode detachment (`docs/16-long-work.md:98-102`; `src/host/tools.ts:357-453`), and ordinary bash/RunOnHost commands can spawn untracked descendants (`src/boxd/shell-service.test.ts:180-203`; `src/host/host-runner.ts:105-125`).

- “`bash --background` and `Delegate` … outlive everybody.” False as managed work. Job state exists only in `JobService`’s process-local `Map`; list/get/wait cannot recover a job after boxd restarts (`src/boxd/job-service.ts:42-45,119-129,150-153`).

- “`detectLoop`: four consecutive rounds of one repeated call.” Not exactly. It requires one distinct signature and no empty rounds, but does not require one call per round; two identical calls in each round still satisfy it (`src/host/progress.ts:91-103`).

- “The observation is already running” for the “heaviest single turn.” False for that requested metric. Usage has no turn ID, and `round` restarts at zero for every continuation (`src/host/usage.ts:29-49`; `src/host/turn.ts:1159-1168`).

- “One append-only ledger” is a durable work graph answering finish, cost, and stuck. False. `parentTurnId` changes on resume, its lineage handoff is process-local, completed turn records compact away, and transcripts do not carry turn IDs (`src/host/turn.ts:816-824`; `src/host/orchestrator.ts:571-586`; `src/host/resume.ts:201-208`; `src/host/turn.ts:454-476`).

## WHAT SURVIVES

- Keep write-ahead ordering: create a durable obligation before admitting the effect.
- Keep immutable obligation IDs, but share the same preallocated dispatch ID across inbox, child attempt, transcript, and usage.
- Keep distinct `succeeded`, `failed`, `unknown`, and `abandoned` meanings; separate attempt outcome from obligation resolution.
- Keep append-only events and torn-tail separation from `appendLine`.
- Keep explicit detachment as a declared contract, without claiming the harness inferred dependency.
- Keep the gate condition—idle plus no unresolved non-detached obligations—only after reliable registration, settlement, and resume lineage exist.
- Keep the hard persistent descendant/time/spend budget as the unconditional stop.
- Keep Fork’s verified one-level structure, unique child conversations, and breadth cap; do not mistake those for a universal work graph.

