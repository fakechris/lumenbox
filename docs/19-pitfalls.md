# Pitfalls: remembering how things went wrong

Status: **design, small enough to build without review** — it adds a memory kind and one
writer, changes no identifier, no persisted format's meaning, and nothing a test asserts
is correct. Written down anyway because the failure mode it risks (a registry filling with
noise) is the one the memory module already rejected a tier for.

## 1. What is missing

`memory.jsonl` holds facts, notes and episodes: **what is true**. Nothing holds **what
went wrong and why**, and that is where this system's expensive knowledge actually is.

Measured over the last month of this repo's own history, the things worth knowing were
almost all failures:

- a stuck modal holds the X11 input grab, so synthetic clicks are swallowed *and still
  report success*;
- a Feishu file message carries `text: ""`, so "drop the folder, then say what you want"
  is always two messages;
- `root_id` before `chat_type` splits a p2p conversation in half;
- per-container Docker networks do not isolate on Docker 29/OrbStack, however widely they
  are believed to.

Every one of those cost real time to learn, and **not one is in any agent's memory**. They
are in a roadmap and in review documents, which agents do not read. The next agent to meet
the same wall meets it new.

The idea is borrowed and named: Antigravity's Teamwork distils verifier findings into an
"answer-agnostic pitfall registry" that outlives the attempt that produced it, and keeps
refuted routes with their objections attached rather than discarding them.

## 2. The rule this must not break

`memory.ts` states its own governing constraint, and it is the reason a "profile" tier was
rejected: *a tier nobody can populate correctly is worse than one list scored honestly*.
Each existing kind has an **unambiguous source** — `fact` is an agent's deliberate
`RememberFact`, `note` is automatic extraction, `episode` is a condensation of several.

So a `pitfall` kind is only admissible if it also has an unambiguous source. It cannot be
"whenever something feels like a lesson"; that is the rejected tier wearing a new name.

## 3. Where a pitfall comes from

Four events the **harness observes**, not judgements it makes. Same discipline as R32's
bookkeeping-tool split (a static list, fixed at build time) and the named-file check (a
path comparison, not an opinion):

| Event | Where it is already detected | Why it is a pitfall |
| --- | --- | --- |
| A turn gave up in a loop | `detectLoop` → `stuck` event (turn.ts) | The agent repeated itself until stopped: something about the approach did not work and it could not see it |
| An agent parked a task on `blocked` with a note | `blockedAnnouncement` already distinguishes agent-chosen from channel-failure landings | The agent hit something it could name and could not pass |
| An audit sent work back | audit reply moves the task to `doing` with findings | An independent reader found the work wrong in a specific way |
| The review gate coerced a self-acceptance | `TaskStore.update`'s `coerced` path | The agent believed it was done and the rule disagreed |

Nothing else writes pitfalls. In particular a tool error does not: tools fail constantly
and recoverably, and a registry of `ENOENT` teaches nothing.

## 4. Answer-agnostic, or not written at all

The Teamwork word is the load-bearing one. A pitfall that says *"抓取竞品价格要先登录后台"*
is a fact about one task. The useful form is *"a site that returns 200 with an empty table
may be showing a logged-out page — check for the login wall before parsing"*.

Distillation is one call on the cheap profile, at the moment the event fires, with the
sentinel discipline the extractor already uses: **it is allowed to find nothing**. The
prompt asks for the sentence a stranger attempting something similar would need, and for
`NONE` when the lesson does not survive removing this task's specifics. An extractor that
must produce output invents, and an invented pitfall is read on every future turn.

Billed like every other aside — `kind: "memory"` in the usage ledger, with the principal
of the work that produced it (see `payerOf`).

## 5. Decay and retraction

`pitfall` joins the existing scoring table:

- **Half-life: 365 days**, like `fact`. The X11 grab is true until X11 changes.
- **Weight: 1.2.** Above a `fact` and below an `episode`: a pitfall is worth more per line
  than a preference, because it is about to be walked into, and less than a summary that
  stands in for many facts.

Some pitfalls stop being true — the grab one became far less costly the day `close_window`
shipped. That is what `retraction` is for and it already works: `RememberFact` with
`replaces` writes one. No new mechanism, and deliberately no automatic expiry: a system
that quietly forgets a hazard because nothing hit it lately is the failure this exists to
prevent.

## 6. What this does not fix, stated plainly

The four sources above are all things that happen to **agents inside the box**. The
pitfalls listed in §1 were learned by an agent working *on* this repo, through a person,
and would not have been captured by any of them: nobody's task went to `blocked` when the
Docker isolation claim failed — a person tested it and the claim was corrected in a
commit message.

So this catches the box agents' repeated walls, which is worth having and is not the whole
of the problem. Carrying development-time lessons into agent memory is a separate question
(the repo's own docs are the store, and nothing reads them into a prompt), and it is not
answered here rather than being answered badly.

## 7. Build order

1. `pitfall` in `MemoryKind`, with its half-life and weight; the recall renderer already
   prints `[kind]` next to anything that is not a `fact`.
2. `distilPitfall` beside the extractor: one cheap call, `NONE` respected, principal
   carried.
3. Wire the four sources. Each is a place that already has the failure in hand; none needs
   a new detector.
4. Tests: the distiller returns nothing for a task-specific note; a pitfall outranks a
   same-age note in recall; a retraction removes one; a tool error writes none.
