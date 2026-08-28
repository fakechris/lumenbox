# Adversarial review: the standard of completion (2026-08-29)

## 1. THE CLAIMED SOURCE OF TRUTH IS NOT THE PERSON'S WHOLE REQUEST

Severity: **fatal**

SEQUENCE:

1. A person sends `@Ada 整理这些报表` followed by 4,200 characters of constraints. The
   requirement not to deduplicate invoice rows is in the final 150 characters.
2. **OBSERVED CODE:** channel routing removes `@Ada` and trims the remainder before
   `runTask` receives it.
3. **OBSERVED CODE:** `runTask` passes that parsed text as `description`, and the web
   `board.open` adapter passes it to `TaskStore.create`.
4. **OBSERVED CODE:** `TaskStore.create` trims the description and persists only its first
   4,000 characters.
5. **HYPOTHESIS UNDER THE DESIGN:** the reviewer authors the pre-work standard from that
   persisted description. The no-deduplication requirement no longer exists in the only
   source the design permits it to read.
6. The assignee deduplicates, every named check passes, and the standard makes the wrong
   delivery look complete.

DESIGN SAYS:

The person's whole message is stored as `Task.description`, so the raw request is available
at task-open time and is “the only honest source for a standard.”

ACTUALLY HAPPENS:

The four required code claims resolve as follows:

- **(a) REFUTED AS WRITTEN — “the person's whole message is stored as
  `Task.description`.”** `runTask` does pass its parsed `text` to `board.open`, and
  `board.open` passes that value to `TaskStore.create`; persistence then executes
  `trim().slice(0, 4000)`. Addressing is also removed before `runTask`. What exists is a
  normalized, at-most-4,000-character request body, not the whole inbound message.
- **(b) CONFIRMED FOR THE CHANNEL `board.open` PATH — “a reviewer is named at task
  creation when one exists.”** The implemented definition of reviewer is specifically the
  first non-assignee agent whose `profile.title` matches `/review/i`; that id is supplied to
  `TaskStore.create`. This is not a general reviewer role and does not apply to the web or
  agent `Tasks create` paths unless their callers explicitly supply a reviewer.
- **(c) CONFIRMED NARROWLY — “the review gate is the single enforced rule in
  `tasks.ts`.”** `TaskStore.update` contains exactly the documented policy gate: an assignee's
  attempted `done` is coerced to `review` when a different reviewer is named. The predicate
  is narrower than “only the requester can accept,” addressed in finding 2.
- **(d) CONFIRMED — “the audit prompt's ordering is backwards.”** The prompt tells the
  reviewer to use `ReadHistory` first and only afterwards says to re-derive acceptance
  constraints. The original request is appended at the end of the prompt. Following the
  requested order puts the assignee's work into the review conversation before the model
  performs the re-derivation.

The adjacent claim that an audit agent exists and is automatically woken is also
**CONFIRMED**: a task entering `review` with a resolvable `reviewerId` causes
`maybeAudit` to call that reviewer with `buildAuditPrompt`.

VERDICT:

The load-bearing source claim is false. Temporal independence cannot protect requirements
that were discarded before standard authoring. A completion design cannot call this field
the raw or whole request unless it either removes the loss or explicitly represents that
the request is truncated and therefore cannot support an exhaustive standard.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:59-71`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:500-504`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:946-990`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1278-1296`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:797-829`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:133-163`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:221-233`
- `/Users/chris/source/research/grokbot/agentbox/src/host/audit.ts:61-98`
- `/Users/chris/source/research/grokbot/agentbox/src/host/orchestrator.ts:319-344`

## 2. `done` IS NOT THE REQUESTER'S WORD

Severity: **fatal**

SEQUENCE:

1. Chris opens task `t42` in a shared chat. Ada is the assignee and Vera is the reviewer.
2. Ada finishes; the task lands in `review`.
3. Dana, another authorized person in the same conversation, sends `可以`.
4. **OBSERVED CODE:** `lastTask` is keyed by conversation, not requester. The channel
   manager passes Dana's identity to `board.accept` for `t42`.
5. **OBSERVED CODE:** `board.accept` resolves Dana's principal and requests `done` without
   comparing Dana to `task.requester` or `task.reviewerId`.
6. **OBSERVED CODE:** `TaskStore.update` refuses only an assignee's self-acceptance. Dana is
   not the assignee, so `t42` becomes `done`.

DESIGN SAYS:

Attempt 2's acceptance half “shipped and works”: `done` is the requester's word, an assignee
cannot self-accept, and the new standard will inform rather than replace that human verdict.

ACTUALLY HAPPENS:

The acceptance verbs are **CONFIRMED** live, and self-acceptance is **CONFIRMED** refused
when a reviewer is named. The stronger authority claim is **REFUTED**. Neither the chat
acceptance path nor the general web update path positively identifies the requester. The
web route likewise attributes an update to the logged-in caller but permits that caller to
request `done` for any task. With no named reviewer, even the assignee is allowed to finish
its own task.

The audit prompt asks a reviewer to leave work in `review`, but that is prose, not the gate:
`TaskStore.update` would also permit the named reviewer or any unrelated non-assignee to
move it to `done`.

VERDICT:

The human backstop on which the new proposal explicitly relies is not enforced. This is not
a side issue: a green checklist followed by an unrelated person's `可以` can close the task
while both the requester and the real acceptance question remain untouched.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:38-53`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:249-252`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:968-978`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1029-1036`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1278-1297`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:838-848`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:2128-2159`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:221-233`

## 3. PRE-AUTHORING MOVES THE OPINION; IT DOES NOT DEFINE `cover`

Severity: **fatal**

SEQUENCE:

1. The request is “merge the three Q3 report folders into one workbook.” The source files
   contain twelve behaviorally material cases: mixed date formats, formulas, duplicate
   invoice ids, hidden rows, corrupt workbooks, and 27 rows the parser cannot read.
2. Before seeing the files or implementation, the reviewer model writes the document's four
   example checks.
3. The assignee produces one openable workbook, includes a worksheet and a retained-row
   count for each folder, filters on a date column, and includes an empty “unparsed rows”
   sheet. It silently dropped the 27 rows before computing its counts.
4. **HYPOTHESIS:** the audit model inspects only the output artifact. An empty exception
   sheet is observationally identical to “there were no parse failures” unless the reviewer
   independently surveys or reprocesses the sources.
5. It returns four green per-check verdicts. Every verdict is locally defensible against the
   named checklist, while the workbook is wrong.
6. The requester sees a stronger-looking certificate than before and accepts.

DESIGN SAYS:

Putting the standard before the work changes the terminal question from an opinion (“does
this look done?”) into a comparison (“does it satisfy these named checks?”), thereby
escaping the failure that killed the obligation ledger.

ACTUALLY HAPPENS:

Pre-authoring does remove one anchoring path: the initial list cannot literally be rewritten
around an artifact that did not yet exist. It does not supply the missing definition of
coverage.

The authoring model still decides which implications of the request become checks. Missing
checks remain invisible. The checking model still decides what evidence satisfies natural
language such as “every folder is represented” or “unparsed rows are listed.” The example's
check 3 is not checkable from the artifact alone: a zero-row exception sheet cannot prove
that the source produced zero exceptions. Thus the design moves model opinion into two
earlier-looking steps and calls the second one comparison.

This reproduces the exact prior failure. Attempt 1's free-text settlement could say
`succeeded, note: looks good`; attempt 3 can say `check 3: passed, evidence: exception sheet
empty`. Neither statement binds the verdict to an independent source fact.

VERDICT:

The reframing is not a new completion proof. It is a useful anti-anchoring technique wrapped
around the same undefined `cover` relation. The timing change survives as planning hygiene;
the claim that it escapes self-certification does not.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:29-49`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:75-98`
- `/Users/chris/source/research/grokbot/agentbox/docs/16-long-work.md:222-253`
- `/Users/chris/source/research/grokbot/agentbox/docs/reviews/2026-08-26-obligation-ledger.md:201-221`

## 4. THE VISIBLE-STANDARD INVERSION RECREATES THE TARGETING EFFECT

Severity: **fatal**

SEQUENCE:

1. The person's real outcome has twelve material dimensions, but the one-call author emits
   four checks.
2. The four checks are shown to the assignee as the definition of completion.
3. The assignee allocates effort to those four observable targets and stops when all four
   pass. The other eight dimensions are not failed; they are absent.
4. The reviewer verifies the same four checks. There is no hidden procedure, reference
   output, source survey, or differential loop to sample outside the visible list.
5. The system reports four of four rather than four of twelve, making sparse coverage look
   total.

DESIGN SAYS:

Factory's hidden cases are samples, while this proposal's checks “are the requirements
themselves”; hiding requirements would be perverse, so the implementer should see the list
but be forbidden to edit it.

ACTUALLY HAPPENS:

The premise is asserted rather than established. A model-generated list from an ambiguous
request is a hypothesis about the requirements. Until an authority or oracle establishes
that it is exhaustive, it is exactly a sparse representation of a larger behavior space.
Visibility then makes that representation the target, just as Factory's visible samples
became the target.

Showing genuine, authoritative requirements is sound. Calling this model's finite list the
requirements themselves is not. Hiding an independent verification procedure could retain
some evaluator independence, but this design explicitly declines the procedure and the
campaign that would make it meaningful.

VERDICT:

The unresolved question in section 4 resolves against the design: **the targeting effect
does apply to visible requirements when the list is not independently proven exhaustive.**
The visible list may guide implementation, but it cannot serve as the denominator for a
completion claim.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:11-27`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:100-115`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:126-142`

## 5. “MAY BE ADDED TO, NEVER WEAKENED” HAS NEITHER A STATE MODEL NOR AN ENFORCER

Severity: **fatal**

SEQUENCE:

1. Reviewer Vera authors standard version 1 with check 3: “include all four quarters.”
2. The requester later narrows the task to Q3, or Vera discovers that check 3 was an
   invention unsupported by the request.
3. If the system refuses removal, correct work can never pass. If it replaces version 1
   with version 2, the active obligation was weakened. If it merely appends “only Q3,” the
   active standard is contradictory.
4. A naive implementation puts a mutable `standard` field on the latest task snapshot.
   Compaction preserves the newest snapshot, not the semantic reason an older check stopped
   applying.
5. A task-log append then fails. **OBSERVED CODE:** the in-memory update continues and the
   failure is only warned. After restart, the supposedly versioned standard can regress to
   the last durable snapshot.

DESIGN SAYS:

The standard is stored on the task, versioned, add-only, and protected from the assignee by
the same enforcement shape as the review gate.

ACTUALLY HAPPENS:

There is currently no standard field on `Task`, no standard event on `TaskChange`, and no
standard input in the `Tasks` tool. `TaskStore.update` supports mutable title, description,
assignee, reviewer, note, and status; its only actor-sensitive transition is the review
gate. Task history is capped at 30, while the JSONL compactor rewrites one latest snapshot
per retained task.

The assignee's `Tasks` tool **can be made to refuse edits**: `dispatchTool` knows
`context.agent.id`, and passes it as `by` to `TaskStore.update`. That is enough to enforce an
actor rule centrally. It is not enough to enforce this proposed invariant if the check lives
only in tool dispatch, because the web and channel paths call the store directly.

A concrete storage/enforcement shape would have to be one of:

- immutable standard-version records embedded in the task snapshot, including stable check
  ids, author, time, predecessor, and which version is active; or
- a separate append-only standard log, with the task holding the current version id.

The store—not the `Tasks` case—must authorize transitions for every caller. Legitimate scope
change requires immutable history plus authorized supersession; “the active set only grows”
is not a valid rule for a task whose requester can change their mind. Persistence of this
load-bearing artifact also cannot use the current fail-open bookkeeping semantics.

VERDICT:

The current dispatch shape makes actor refusal buildable, but the document has not designed
what is being refused. Append-only history, an active contract, correction of a wrong check,
and legitimate scope reduction are four different properties. Treating them as one
monotonic list is the same state collapse that the earlier reviews rejected.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:89-109`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:149-164`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:46-86`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:133-163`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:200-277`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:280-291`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:321-342`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tools.ts:888-943`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tools.ts:2360-2448`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:2128-2159`

## 6. ONE CALL FROM THE REQUEST ALONE CAN CHECK SHAPE, NOT SEMANTIC COMPLETENESS

Severity: **fatal**

SEQUENCE:

1. A person wordlessly drops twelve spreadsheets and then says `把这些表合并一下`.
2. **OBSERVED CODE:** the board description deliberately contains only the person's words;
   paths for the handed files are added only to the assignee's prompt.
3. **HYPOTHESIS UNDER THE DESIGN:** the reviewer receives the task description alone. It
   cannot know that there are twelve files, that two are `.xls`, that one has four sheets,
   or that three columns use different units.
4. The one-call author writes “one output workbook,” “all files included,” “headers aligned,”
   and “no rows lost.” Those sentences sound specific but contain no independent inventory,
   binding, or recomputation procedure.
5. The assignee emits an openable workbook from ten files. The output looks internally
   coherent, and the artifact-only reviewer declares every sentence passed.

DESIGN SAYS:

The proposal adopts Factory's ordering for one extra reviewer-profile call, but not its
reference survey, hundreds of weighted cases, validator loop, cost, or oracle.

ACTUALLY HAPPENS:

The claimed causal transfer is unsupported. Factory's measured system changed both timing
and the amount and source of independent evidence. Removing the reference program, source
survey, weighted cases, and validation loop does not leave the same standard at one
fourteenth the cost; it leaves a checklist inferred from less information.

One call can produce measurable checks for explicit surface facts: a named path exists, a
file opens, a required column is present. It cannot establish that implied behavior is
complete or that values are correct without source-grounded tests or an oracle. Therefore
the standard is not literally “a checklist that always passes,” but it can always pass while
the unrepresented outcome is wrong. That is the dangerous case because the pass is honest
relative to its own denominator.

VERDICT:

One extra call is enough for an advisory preflight checklist. It is not enough for the
artifact “everything else is judged against.” The no-oracle concession limits the system to
explicit, independently measurable claims; it does not merely lower confidence in a general
completion verdict.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:11-27`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:75-98`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:126-142`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1260-1266`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1410-1420`

## 7. A ONE-LINE REQUEST MUST BE ALLOWED TO HAVE NO STANDARD

Severity: **major**

SEQUENCE:

1. The request is exactly `把这些表合并一下`.
2. The reviewer is forbidden to inspect the files, transcript, or person intent and must
   author from that sentence alone.
3. It either emits generic checks that any plausible workbook passes, invents choices about
   deduplication and headers, or refuses to claim it has a standard.
4. If it emits generic checks, the assignee targets them and the UI presents false coverage.
   If it invents checks, the assignee performs unwanted work. If it refuses without a typed
   task state, the assignee either starts anyway or the task appears stuck.

DESIGN SAYS:

Section 6 asks whether four vacuous checks or refusal is worse and whether a task may have no
standard, but takes no position.

ACTUALLY HAPPENS:

Refusal is safer than a vacuous green certificate. The correct verdict for this input is
`standard unavailable: clarification or source inspection required`, not a fabricated list.
That is not a corner case; the document says one-line requests and installations without
oracles are ordinary.

The person's later ability to edit is not a repair for pre-work correctness. By the
document's own scenario, they may not read the list until delivery. Storing a field on the
task also does not make it visible in the channel: the current channel board projection
contains id, assignee, title, and an optional URL, not description or future standard text.

VERDICT:

The design must admit “no defensible standard” as a first-class, non-green state and decide
whether that blocks work or requests clarification. As written it has no safe outcome for a
normal input, so section 6's first question resolves against buildability.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:138-152`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/board-view.ts:66-92`
- `/Users/chris/source/research/grokbot/agentbox/src/web/app-html.ts:2801-2826`

## 8. WITH NO REVIEWER, THE STANDARD IS SKIPPED AND SELF-CERTIFICATION RETURNS

Severity: **major**

SEQUENCE:

1. An installation has one general-purpose agent and no agent whose title contains
   `review`.
2. A channel request creates a task without `reviewerId`.
3. No pre-work standard call runs under the document's stated rule, because the rule applies
   only to a task with a reviewer.
4. The assignee's turn returns.
5. **OBSERVED CODE:** `turnFinished` requests `done` as the assignee; the review-gate
   predicate requires a named reviewer, so the task becomes `done`.
6. **OBSERVED CODE:** `maybeAudit` exits immediately for a task without `reviewerId`.

DESIGN SAYS:

Most installations and most tasks have no reviewer, and section 6 asks whether their
standard is skipped, self-authored, or made mandatory.

ACTUALLY HAPPENS:

Under the stated design and current runtime it is skipped. Self-authoring would reproduce
the exact worker-signs-certificate trap. Making a reviewer mandatory is a materially
different installation and availability contract, not a quiet implementation detail.

The web and agent task-creation paths also do not discover a reviewer automatically. They
only persist one when their callers explicitly supply `reviewerId`.

VERDICT:

For no-reviewer installations, this proposal is not a completion gate at all. It is valid to
scope a feature to reviewer-equipped teams, but it is false to present that scoped feature as
solving completion for the system whose ordinary deployment lacks the prerequisite.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:132-136`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:153-155`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:810-828`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:2101-2119`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tools.ts:2386-2406`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:191-233`
- `/Users/chris/source/research/grokbot/agentbox/src/host/orchestrator.ts:319-327`

## 9. STEERING MAKES MONOTONIC REQUIREMENTS WRONG

Severity: **fatal**

SEQUENCE:

1. The original request asks for all 2025 reports, and standard version 1 requires all four
   quarters.
2. Mid-task, the requester says `只要 Q3`.
3. **OBSERVED CODE:** while the task is running, the channel manager sends that text directly
   to the running agent as steering. It does not update `Task.description`, create a task
   history event, or notify the reviewer.
4. The assignee correctly produces Q3 only.
5. If the original standard remains active, the audit must reject correct work for missing
   Q1, Q2, and Q4. If the reviewer deletes those checks, the implementation violates “never
   weakened.” If it appends “only Q3,” the active standard contains incompatible checks.

DESIGN SAYS:

The standard may be added to but never weakened; section 6 asks who updates it after a
person redirects the work.

ACTUALLY HAPPENS:

No current path updates the task contract when steering happens. More importantly, no
append-only active requirement set can represent legitimate subtraction. The immutable
thing should be the amendment history, not the union of every requirement ever stated.

A viable model would need a positively identified authority to create a new active contract
version that supersedes the old one while preserving both versions for audit. That is a
contract-amendment protocol; it is not “add checks.” The document does not say whether the
requester, reviewer, or assignee initiates it, what happens while the new standard is being
authored, or which version an in-flight audit uses.

VERDICT:

Section 6's steering question resolves decisively: **the append-only property is wrong for
the active standard.** Without authorized supersession and an effective-version rule, normal
steering makes either the work or the invariant impossible.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:95-98`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:156-164`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:949-965`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:46-80`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:200-277`

## 10. “BEFORE THE WORK” HAS NO SERIALIZATION OR FAILURE PROTOCOL

Severity: **fatal**

SEQUENCE:

1. A channel task is synchronously created and its id returned.
2. The proposed implementation starts an asynchronous reviewer-model call to author the
   standard.
3. **OBSERVED CODE:** the current `board.open` interface is synchronous, and `runTask`
   proceeds from `board.open` to the assignee's `ask` call. `TaskStore.create` also does not
   notify the `onChange` listeners used by auto-audit.
4. **HYPOTHESIS UNDER A FIRE-AND-FORGET IMPLEMENTATION:** the assignee begins before the
   standard lands. A slow or failed authoring call recreates the post-start timing the design
   claims to eliminate.
5. **HYPOTHESIS UNDER A BLOCKING IMPLEMENTATION:** the process crashes after task creation
   but before standard persistence. Restart sees an ordinary open task with no typed
   distinction between `standardizing`, `standardization_failed`, and “legacy/no standard.”
6. A retry can generate a different list or duplicate checks because the document defines no
   generation id, idempotency key, authoritative attempt, or failure policy.
7. A task created through the web API or the agent `Tasks` tool bypasses the channel
   `board.open` closure entirely.

DESIGN SAYS:

One extra call at task open authors the standard before any implementation exists.

ACTUALLY HAPPENS:

The timing is the design's load-bearing safety property, but the proposal contains no state
machine that establishes it across asynchronous calls, failures, restarts, or all three task
creation paths. There is no existing hook at `TaskStore.create`: listeners run after
`update`, not after creation. Putting the call only in channel `board.open` misses web and
agent-created tasks; putting it in a fire-and-forget listener does not order it before work.

The design also omits what happens if the standard cannot be durably written. The current
task log intentionally fails open because it is bookkeeping; a standard “everything else is
judged against” cannot inherit that choice without making post-restart verdicts depend on
which snapshot survived.

VERDICT:

This is not buildable as a before-work invariant until task admission has explicit states,
one idempotent standardization attempt, a durable ready version, a policy for failure/no
reviewer, and one gate that prevents assignee dispatch before the chosen state. The omitted
transaction is not implementation detail; it is the timing claim.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:43-49`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:73-80`
- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:119-136`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:390-405`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1278-1297`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/manager.ts:1409-1420`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:95-105`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:133-163`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:272-291`
- `/Users/chris/source/research/grokbot/agentbox/src/web/server.ts:2101-2119`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tools.ts:2386-2406`

## 11. STORING THE STANDARD DOES NOT SHOW IT TO EITHER CONSUMER

Severity: **major**

SEQUENCE:

1. A standard is successfully stored on task `t42`.
2. **OBSERVED CODE:** the assignee's rebuilt prompt renders each live task through
   `describeTask`, which contains id, status, assignee, title, and reviewer—but no
   description and no future standard. `Tasks list` uses the same renderer.
3. **OBSERVED CODE:** the channel board projection shown to the requester contains id,
   assignee, title, and optional URL—but no description, history, or standard.
4. The assignee works from the original conversation rather than the supposedly
   load-bearing list. A requester without a usable web URL does not see the list before
   acceptance.
5. The task carries the standard on disk, but neither actor whose behavior it is supposed to
   change has received it.

DESIGN SAYS:

The implementer is shown the standard, and the person can see and correct it because it is
stored on the task.

ACTUALLY HAPPENS:

Storage and delivery are different boundaries. The current agent prompt and `Tasks list`
deliberately render compact board rows. The web task detail does show description and
history, so it is a plausible future surface, but that does not deliver the standard to a
channel requester or inject it into the assignee's working prompt. Both consumers require
explicit render and delivery changes, including a decision about whether the requester sees
and confirms the list before implementation begins.

VERDICT:

The design entirely omits its read paths. “Visible” is not a property of a task field. Until
the assignee prompt, audit prompt, web detail, and channel/card behavior name the same active
version, different actors can judge different standards while every stored record looks
correct.

Evidence with file:line:

- `/Users/chris/source/research/grokbot/agentbox/docs/20-completion-standard.md:97-109`
- `/Users/chris/source/research/grokbot/agentbox/src/host/prompt.ts:537-551`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tasks.ts:350-355`
- `/Users/chris/source/research/grokbot/agentbox/src/host/tools.ts:2377-2384`
- `/Users/chris/source/research/grokbot/agentbox/src/channels/board-view.ts:66-92`
- `/Users/chris/source/research/grokbot/agentbox/src/web/app-html.ts:2801-2826`

## OVERALL VERDICT: REJECT

This is not the fourth implementation of a completion gate waiting to be coded. It is the
third failed judgement model with one real improvement: authoring before implementation
reduces post-hoc anchoring. That improvement is worth keeping as an advisory planning
artifact. It does not make the list exhaustive, make natural-language checks objective,
bind verdicts to source facts, or enforce requester acceptance.

The design also fails its own buildability claim: the source request is truncated; the
requester is not positively identified at acceptance; no-reviewer tasks bypass the whole
mechanism; legitimate steering contradicts monotonic checks; append-only/versioned storage
has no state model; and no transaction orders an asynchronous standardization call before
assignee work across every creation path.

A wrong build here will produce exactly the output docs/13 says to reject: a green,
versioned, per-check record whose wrongness looks like stronger evidence of correctness.

### The three most important questions the document failed to ask

1. **What independent evidence makes the authored list exhaustive, and what typed outcome
   is recorded when no such evidence exists?** Without an answer, “four of four” has no
   meaningful denominator.
2. **Who is positively authorized to author, amend, supersede, and accept which standard
   version?** The answer must cover requester identity, reviewer failure, wrong checks,
   legitimate scope reduction, unrelated actors, and concurrent steering.
3. **What durable admission protocol proves one active standard version existed before any
   assignee work began?** The answer must span channel, web, and `Tasks create`; retries,
   crashes, and write failure; and delivery of that exact version to assignee, reviewer, and
   requester.
