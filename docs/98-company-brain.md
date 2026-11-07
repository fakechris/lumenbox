<!-- doc: 98-company-brain
     title: The organisation's knowledge: four layers, one item shape, written by promotion
     family: decision
     status: current
     updated: 2026-11-07
-->
# The organisation's knowledge: four layers, one item shape, written by promotion

Status: **decided by Chris, 2026-11-07 (INV-1718, milestone INV-1714).** This record changes no
code and no store. It inventories every place LumenBox keeps knowledge (§2, at `origin/main`
`a2f9ae1`), says what the organisation's knowledge is and how it relates to the stores that
exist (§3–§8), says what happens to each store (§9), records Chris's answers to the questions
the research left open (§10), and lists the implementation items to propose under INV-1714
(§11). The external study behind it is the research item INV-1717; its notes stay outside the
repository, and only what it decided is written here.

## 0. The decision, in eight sentences

1. **The organisation's knowledge is not a new store; it is one item shape and one scope model
   over the stores we already have.** LumenBox already keeps evidence (transcripts, tasks,
   routine runs, deliverables), items (memory records, person entries, public knowledge) and
   always-read instructions (rules, installation instructions, standing files). What is missing
   is a common item shape, a scope on every item, and a defined order between layers.
2. **Four layers and three orthogonal stores.** L0 rules (Admin), L1 organisation, L2 box, L3
   agent; beside them P the person record, G public to guests, and E evidence (§3).
3. **Scope is a field on every item, checked against the asker before ranking, and an unknown
   scope is invisible.** A box's scope is its `members` (`mayEnterBox`, docs/22 §2). There is
   no department type: a department is a box with members.
4. **Being readable and being recalled are two different things.** Every item says whether
   agents may recall it on their own (`surface: recall`) or only read it when someone cites it
   (`surface: cite-only`).
5. **Nothing reaches L1 by extraction.** L1 is written only by promoting an existing item or a
   finished outcome, from a member's turn or by an Admin; the promotion waits for review, and
   review is always on. The agent-set `audience: "everyone"` is retired; a record that carried it
   falls back to the box it was written in.
6. **Correction appends; it never edits in place or deletes.** Any reader can unverify an L1
   item; its owner re-verifies, supersedes or retracts it. An item goes stale when its review
   date passes or when its evidence changes state.
7. **On a conflict about the organisation, verified L1 outranks L2, and L2 outranks L3; about
   the person, the person's own lines outrank learned ones.** The prompt shows the conflict as
   two dated lines with their sources. It never merges them silently.
8. **A personal installation never writes the organisation's knowledge, and a guest turn reads
   only G** (docs/95 §5, docs/96 §0, docs/97 §0).

## 1. Why: what the inventory shows

The inventory in §2 has four findings that drive the design.

- **The de-facto organisation layer is the least governed path in the system.** An agent that
  calls `RememberFact` with `scope: "team"` and `audience: "everyone"` promotes a line to every
  box of the installation (`src/host/tools.ts:1696-1704`, `:5320`; read filter
  `src/agents/registry.ts:1257`). Team memory review would hold it, but review is off unless an
  Admin turns it on (`src/host/team-memory-review.ts:23-26`). When it is on, the review queue
  shows the text and the writer but not the audience (`src/web/team-memory-review-routes.ts:20-29`),
  so an Admin approves an installation-wide line without being told it is one.
- **A second installation-wide store has no review at all.** `NoteSiteLearning` appends to
  `~/.agentbox/learnings/<host>.md` (`src/host/learnings.ts:11-13`, `:22-24`;
  `src/host/tools.ts:1923`, `:3936-3945`), and every agent in every box reads that file when it
  opens the site (`src/host/tools.ts:4215`). The research item did not list this store.
- **An Admin-written organisation layer already exists, and it is plain text.** The
  installation's `~/.agentbox/instructions.md` and each box's bundle instructions go into every
  prompt (`src/host/place.ts:1-12`, `:20`, `:31-33`; `src/host/bundles.ts:20`;
  `src/host/prompt.ts:861`). That is L0's "how we work", already shipped, without an owner or a
  review date. The research item did not list this store either.
- **Evidence is rich but not linked.** A memory record cites `from: <conversation>@<time>`
  (`src/host/memory.ts:73-79`), and nothing says "this rests on task t12, INV-1581 or commit X".
  So no item can go stale when its evidence changes.

The research item compared ten outside approaches. What it decided, without naming anyone:
products that work at organisation scale keep evidence, items and instructions apart; they check
visibility per item at query time and fail closed; they split "may be read" from "may be
surfaced"; they give every shared item an accountable owner, a review date and a visible
verified state; they supersede rather than delete; and the ones that let a model update or
delete shared memory moved back to append-only. We take all six. We do not mirror outside
systems' access lists as the core, mine activity into a person profile, let a model own a
shared wiki, add a graph database, judge freshness by the calendar alone, concatenate layers
without an order, or count anonymous votes (§12 says why for each).

## 2. The inventory, at `origin/main` `a2f9ae1`

Every place LumenBox keeps something an agent or a person later relies on as knowledge. Paths
under `~` mean the installation's home (`~/.agentbox`); "every turn" means the store is rendered
into the system prompt; "recall" means it is ranked against the turn by `rankRelated`
(`src/host/memory-relevance.ts:103`).

| # | Store | Location | Writer | Reader | Lifecycle | Review | Visibility | file:line |
|---|---|---|---|---|---|---|---|---|
| 1 | Agent memory (`fact`, `note`, `episode`, `pitfall`, `retraction`) | `agents/<id>/memory.jsonl`; read-only mirror in the box `/home/box/work/memory` | the agent (`RememberFact` scope self); the extractor every 3 exchanges; the harness for pitfalls; a template's setup turn | that agent, every turn (budget 4,000 chars) and `Recall` | append-only; half-life per kind; retraction and source withdrawal; maintenance pass (model proposes, code verifies) | write-time judge and guard; never a person | the agent | `src/agents/registry.ts:103`, `:1131`; `src/host/memory.ts:44-90`, `:100`, `:108`, `:116`, `:126-147`, `:1066`; `src/host/remember.ts:60`, `:304`, `:545`; `src/host/pitfalls.ts:1-24`; `src/host/memory-maintenance.ts:1-12`; `src/host/memory-judge.ts:1-8`; `src/host/memory-guard.ts:1-7`; `src/host/prompt.ts:1052` |
| 2 | Standing files (`AGENTS.md`, `SOUL.md`, `USER.md`, `HEARTBEAT.md`) | host copy canonical, box mirror `/home/box/work/standing/<agent id>` | the person and the agent | that agent, every turn | edit in place, ≤8 KiB each; a change nobody in the turn made is shown once as a diff | none | the agent | `src/host/standing.ts:1-24`, `:32`, `:36`; `src/host/prompt.ts:1123` |
| 3 | Agent plan and todos | `agents/<id>/plan.md`, `todos.json` | the agent | that agent, every turn | edit in place | none | the agent | `src/agents/registry.ts:119-120`; `src/host/prompt.ts:1036` |
| 4 | Team memory (the shared tier, INV-424, INV-1581) | `agents/shared-memory/<writer id>.jsonl`, one shard per writer | an agent with `RememberFact` scope team; an Admin through Settings → Memory | every agent of the writer's box, every turn (budget 1,500 chars) and `Recall`; with `audience: "everyone"`, every agent of the installation | as (1); Admin withdraw and edit append tombstones | held for an Admin only when `teamMemoryReview` is on (off by default); the decision is a record | `box` stamped by the registry; `audience: "everyone"` set by the writing agent; a record with no `box` (older than INV-424) is visible everywhere | `src/agents/registry.ts:105-117`, `:1249-1258`, `:1298-1312`; `src/host/memory.ts:57-72`, `:87-89`, `:448`; `src/host/tools.ts:1696-1704`, `:5244`, `:5320-5331`; `src/host/team-memory-review.ts:1-31`, `:56-72`; `src/host/memory-admin.ts:1-7`, `:233-244`; `src/host/prompt.ts:1106-1110` |
| 5 | Person record (INV-1653) | `~/people.jsonl`, one entry per field line | the person (Settings → Mine); an agent's memory the judge kept, absorbed per driver; a sensing routine | every agent of the installation, for that principal, every turn | retract; `expiresAt`; person outranks agent outranks routine | memory judge on agent lines | per principal | `src/host/person.ts:1-13`, `:24`, `:36-48`, `:115-160`; `src/host/orchestrator.ts:317`, `:993`; `src/web/person-routes.ts:23`; `src/host/prompt.ts:1122` |
| 6 | Public to guests: knowledge collections (INV-1708, INV-1713) | `~/guests.jsonl` | an Admin only | guest turns of agents that ticked the collection, through `SearchPublicKnowledge` and `ReadPublicKnowledge` | Admin adds, edits, removes; guest answers reviewed, optionally held | Admin-authored | per collection × agent; public to guests | `src/host/guests.ts:1-25`, `:52`, `:143`, `:256-266`; `src/host/guest-turn.ts:46`, `:51` |
| 7 | Site learnings | `~/learnings/<host>.md`, one file per website | any agent (`NoteSiteLearning`); a template import | any agent of any box, when it opens that site | append-only, ≤400 chars a note, last 12 shown; secrets refused | none | the whole installation | `src/host/learnings.ts:1-24`, `:40-42`, `:73`, `:95`; `src/host/tools.ts:1923`, `:3936-3945`, `:4215`; `src/host/template.ts:452-461` |
| 8 | Installation and box instructions | `~/instructions.md`; each bundle's `instructions` on the box | the operator (an Admin, or the Owner) | every agent, every turn (≤6,000 chars) | edit in place | none | installation; box | `src/host/place.ts:1-33`; `src/host/bundles.ts:20`, `:53`; `src/host/prompt.ts:861` |
| 9 | Operator rules | `~/rules/*.md`, one file a rule | an Admin | the policy gate before any model; reviewer reads the body | edit in place; audited by rule id | Admin-authored | installation; optional `principal:` | `src/host/rules.ts:1-25`, `:77-78` |
| 10 | Skills | `/home/box/work/skills/<slug>/SKILL.md` in the box (a native environment keeps them under its own work directory); host-published versions in `~/skill-history` (git), drafts in `~/skills-drafts` | any agent of the box; starter skills shipped; teaching drafts a person publishes | agents of that box: index ≤13,500 chars every turn, body on demand | edit in the box; host publishes are commits with tags, rollback republishes | teaching drafts: a person publishes; agent edits: none, authorship recorded | the box | `src/host/skills.ts:1`, `:12-16`, `:40`; `src/host/skill-history.ts:1-13`; `src/host/teach-drafts.ts:1`; `src/host/skill-provenance.ts:1-14`; `src/host/orchestrator.ts:414`, `:951`; `src/host/prompt.ts:1074` |
| 11 | Agent templates | `.lumenbox-template.json` (`lumenbox-template/1`), `~/templates/<agent id>`, import log `~/template-imports.jsonl` | the exporting agent, scrubbed | the importing agent writes its own skills, memories and site learnings | a template is a file; imports logged | secret prefilter; names refused | portable | `src/host/template.ts:1-12`, `:31`; `src/host/orchestrator.ts:1543`, `:1717`, `:1785` |
| 12 | Catalog | shipped in code | maintainers | New agent → catalog | release | PR review | every installation | `src/host/catalog.ts:164`, `:260` |
| 13 | Transcripts and compaction summaries | `agents/<id>/conversation.jsonl` and one file per conversation | the turn engine | that agent (`ReadHistory`); Audit tab; memory `from` cites them | compaction adds a summary entry; old epochs kept | none | the box | `src/agents/registry.ts:55`, `:323-326`; `src/host/compaction.ts:15`, `:139`; `src/host/tools.ts:1569` |
| 14 | Tasks and their deliverables | `~/tasks.jsonl` (latest snapshot per id, bounded history); `deliverables/<task id>/<sha256>` | agents and people | the board, the person, MCP `task_status` / `fetch_deliverable` | replay-and-compact; aging; deliverables written once | a named reviewer accepts | the box, by membership | `src/host/tasks.ts:1-22`, `:42`, `:146`; `src/host/task-deliverables.ts:1-12`; `src/host/tools.ts:4073` |
| 15 | Receipts (why a decision was made) | `~/receipts.jsonl` | the board and the server at decision points | people asking "why" later | append-only | none | installation | `src/host/receipts.ts:1-24`, `:49`; `src/host/orchestrator.ts:428`; `src/host/tasks.ts:731` |
| 16 | Routine runs, results and commitments | `~/schedules.jsonl`, `~/routine-results.jsonl`, `~/commitments.jsonl` | the scheduler; the routine's turn | Automations tab; the next run of the same routine | append-only; a routine that keeps failing is held | done is not accepted | the box | `src/host/schedule.ts:183`; `src/host/routine-runs.ts:1-21`; `src/host/routine-resolve.ts:1-20`, `:225`; `src/host/commitments.ts:1-17`; `src/host/orchestrator.ts:416-418`, `:2516` |
| 17 | Evaluation material and reviewer findings | `~/evals`, learning material `tasks/<id>.json` + `index.jsonl`; `~/verifications.jsonl` | evaluation runs; reviewers | teaching turns; the review gate | append-only | a person publishes what teaching proposes | installation | `src/host/learning-material.ts:1-14`; `src/host/orchestrator.ts:315`, `:2341`; `src/host/review-dispatch.ts:74` |
| 18 | Involute work graph | external server | people and agents | agents only when @-mentioned (`agent_inbox` → claim → turn → answer), each with its own credential | state machine; amendments; `supersededBy` | the human commit gate | per team on the server | `src/host/involute-inbox.ts:1-20`, `:217`; `src/config.ts:173-175` |
| 19 | Design record and manual | `docs/`, `docs/manual/` in git | maintainers | people; agents do not read them at run time (the app links the manual) | git; supersession is a header field | PR review | public | `src/web/manual-link.ts:1-3`; `scripts/docs-lint.mjs:45` |

What the table does not include, on purpose: credentials and the vault (not knowledge, never
recalled), usage and audit ledgers (records of what happened, read by people), connectors
(another system's knowledge, read live through its own access check), and the files agents write
in the box's work volume (their work, reachable as a deliverable or by a path someone cites).

## 3. The layers

```
            every turn                     search / recall              written by                      gate
L0 rules    rules/, instructions.md        —                            Admin                           Admin-authored
L1 org      pinned "how we work" items     organisation knowledge       promotion, or an Admin          owner + review, always on   
L2 box      bundle instructions,           team memory                  agents of the box               team memory review (optional)
            skills index
L3 agent    standing files, plan           own memory, pitfalls         the agent, extractor, harness   judge + guard
 P person   the person record, per principal — read by every agent for that person
 G guests   knowledge collections — Admin-authored, read only in guest turns
 E evidence transcripts, tasks, deliverables, receipts, routine runs, Involute items, commits — linked, never recalled
```

- **L0 rules** is what an Admin decides in advance and the system enforces or always shows: the
  rules (9) and the installation's instructions (8). It has no review because its writer is the
  authority. It gains an owner and a review date only when it is promoted into L1 as an item.
- **L1 organisation** is what the organisation knows and stands behind: a small number of
  **pinned** items read every turn ("how we work", in a budget of its own) and a larger set of
  searchable items an agent recalls. Every L1 item has an owner and a verified state.
- **L2 box** is what a box's agents learned together: today's team memory (4) with its `box`
  stamp, the box's bundle instructions and skills. Its readers are the box's members' agents.
- **L3 agent** is what one agent learned for its own work: memory (1), standing files (2), plan
  (3). It is never reviewed by a person and never leaves the agent except by promotion.
- **P, the person record (5),** is about one person and read for that person in every box. It
  is not an organisation layer: it has its own precedence (the person's own lines first) and
  its own correction (the person retracts).
- **G, public to guests (6),** is the organisation's public face. It is written only by an
  Admin and read only in guest turns. No L1 item becomes public to guests by itself; an Admin
  may copy one in, which is a new G entry.
- **E, evidence,** is what happened. It is immutable or append-only, it is cited by items and
  it is never recalled as knowledge.

The milestone's words map as follows: *personal* is L3 and P; *team* is L2 (the code's "team
tier"; the glossary's **team** is an agent label, so the record says box); *organisation* is
L0 and L1; *public* is G.

## 4. One item shape

L1 and L2 items are memory records. The record is extended, not forked
(`src/host/memory.ts:44-90`); L3 records simply leave the new fields absent.

| Field | Meaning | Today |
|---|---|---|
| `scope` | `agent` · `box:<id>` · `org`; G keeps its own ledger and is never a scope here | `box` and `audience` |
| `surface` | `recall` (agents may surface it on their own) · `cite-only` (read only when cited by id) | — |
| `owner` | the principal accountable for the item (§10 question 2) | — |
| `evidence[]` | typed references: `task:t12`, `inv:INV-1581`, `commit:<sha>`, `doc:docs/98`, `conversation@time`, `receipt:<id>` | `from` (conversation only) |
| `validFrom` / `validUntil` | when the statement is true in the world | expiry read from text by maintenance |
| `supersedes` | the item this one replaces | `replaces` text match, retraction |
| `verifiedBy` / `verifiedAt` / `reviewBy` | who stands behind it, when, and when it must be looked at again | `review.by` on a team decision |
| `held` / `review` | as today | as today |

## 5. Writing: who may write what, and what must come with it

| Layer | Who writes | How | Review | Provenance required |
|---|---|---|---|---|
| L0 | an Admin (on a personal installation, the Owner) | the rules file, the instructions file | none: the writer is the authority | the audit line |
| L1 | a member, in a turn inside the organisation, or an Admin | **promotion** of an existing L2/L3 item, a finished task, a research outcome, a receipt; or an Admin's own item | **always on**, by the item's owner or an Admin; no setting turns it off | at least one `evidence` reference; the promoter; the approver as `verifiedBy` |
| L2 | an agent of the box | `RememberFact` scope team, with `audience` removed | team memory review, optional as INV-1581 decided | `via`, `from`, `box` as today |
| L3 | the agent, the extractor, the harness | as today | judge + guard, never a person | as today |
| P | the person, a judged agent line, a sensing routine | as today | memory judge | `source` |
| G | an Admin | Settings → Team → Guests | Admin-authored | `by` |

Rules:

1. **Extraction never writes above L3.** It already does not (`src/host/remember.ts:304`,
   `:545`, `:586`, `:646` write only the agent's own tier); this becomes a stated invariant.
2. **An agent may propose a promotion; it may not complete one.** A `Promote` act creates a held
   L1 item naming its source and evidence. The writer is told it waits. Nobody recalls it until
   it is approved.
3. **The review shows what it widens.** A pending item shows its scope and its readers ("every
   agent of this installation", "the 4 members of box sales") before the approve button.
4. **INV-1581 stands for L2 and is revised for L1:** L2 review stays an installation option, off
   by default; L1 review is always on, and an Admin cannot turn it off (§10 question 4).

## 6. Reading: admission, surface and the guest turn

1. **Scope before ranking.** A turn's candidates are the items whose scope admits the turn's
   principal: `agent` = this agent; `box:<id>` = the principal passes `mayEnterBox` for that box
   (`src/box/membership.ts:27-31`); `org` = any member of the installation. An unknown scope, a
   box that no longer exists or a scope the reader cannot evaluate admits nobody. Then one
   ranker, `rankRelated`, orders what is left.
2. **A caller-less turn** (a routine, a restart) reads as its creating principal, revalidated as
   docs/22 §2 says; a creator who left reads no L1 or L2 item.
3. **Surface.** `recall` items enter recall and the pinned budget; `cite-only` items are read
   only by id (a link, a citation, an `evidence` reference). A stale or unverified L1 item drops
   to `cite-only` until its owner re-verifies it.
4. **Budgets.** Pinned L1 has its own small budget beside the team budget
   (`SHARED_CHAR_BUDGET`, `src/host/memory.ts:448`). An answer built on an L1 item cites its id.
5. **Involute is cited, not searched.** An item may cite `inv:INV-n`, and the host reads that
   item's state for staleness. An agent in a member turn has no Involute search; it reaches
   Involute only through today's @-mention path (`src/host/involute-inbox.ts:1-20`).
6. **The guest turn reads only G**, unchanged (docs/97 §0 sentence 5). No L1 item is a G entry;
   the guest turn's import list does not grow.
7. **Department.** A department is a box whose `members` lists its people. Until bind writes box
   membership for every channel, an enumerated set degrades to `everyone` (docs/22 §2), and a
   department item's label must say so, as the box label does (docs/22 §5).

## 7. Provenance, correction, expiry and conflict

- **Provenance.** Every L1 item carries `evidence[]` and its promoter and approver. An L1 item
  with no evidence may be written only by an Admin, and the page shows it as "Admin's word".
- **Correction verbs.** *Unverify* (anyone who can read the item, with a reason: it drops to
  `cite-only` and its owner is told); *supersede* (a new item names the old one in `supersedes`;
  the old one gets `validUntil`); *retract* (the owner or an Admin; a retraction record, as
  memory has now, `src/host/memory.ts:93-100`). No verb edits in place or deletes; the log is
  the history.
- **Expiry has two triggers.** `reviewBy` passes; or an `evidence` reference changes state (an
  Involute item superseded or canceled, a task reopened or dropped, a commit reverted, a cited
  document superseded). A stale item stays readable with its age and leaves recall.
- **Conflict.** About the organisation: verified L1 > L2 > L3. About the person: the person's
  own lines > learned (`src/host/person.ts:133`). When two items disagree the prompt shows both,
  dated, with their sources, under one heading that says they disagree. Nothing is merged
  silently, and the maintenance pass may propose a supersession but never apply one to L1.

## 8. The boundary with personal installations

- A personal installation has no L1. Its L0 is its Owner's rules and instructions; its L2 and L3
  are the Owner's. Nothing in it is ever written into an organisation's L1 or L2, by any path.
- An organisation's knowledge is never copied into a personal installation. A personal agent
  reaches organisation work only through the organisation's side door (docs/95 §5), as the
  person's Principal there, and the side door's ten tools do not include reading L1.
- Promotion crosses only from a member's turn **inside** the organisation. A machine that runs
  both installations (docs/96 "personal + organisation") keeps two homes; no store is shared.

## 9. Migration: what happens to each store

| # | Store | Decision | How |
|---|---|---|---|
| 1 | Agent memory | keep (L3) | new fields absent; unchanged |
| 2 | Standing files | keep (L3) | unchanged |
| 3 | Plan and todos | keep (L3) | unchanged |
| 4 | Team memory | keep as L2; **retire `audience: "everyone"`** | the tool loses the field, and the read filter stops honouring it: an existing `everyone` record falls back to the box it was written in, which its `box` stamp already names. No candidate list: the records are historical (§10 question 5). Records with no `box`, older than INV-424, stay as they are |
| 5 | Person record | keep (P) | unchanged |
| 6 | Knowledge collections | keep (G) | unchanged |
| 7 | Site learnings | **new notes into L2** | a new note is visible to its box by default; the existing files stay as they are; how a note is shared across boxes is left to a later study (§10 question 6) |
| 8 | Installation / box instructions | keep (L0 / L2 pinned) | an Admin may cut a paragraph into a pinned L1 item to give it an owner and a review date |
| 9 | Rules | keep (L0) | unchanged |
| 10 | Skills | keep (L2) | unchanged |
| 11 | Templates | keep | a template still never carries `everyone`, person or L1 items |
| 12 | Catalog | keep | unchanged |
| 13–17 | Transcripts, tasks, deliverables, receipts, routine runs, evaluation material | keep as E | items link to them by `evidence`; nothing is recalled from them |
| 18 | Involute | keep as E | an `inv:` reference; state read for staleness (§10 question 3) |
| 19 | Design record and manual | stays out of product knowledge | an Admin may pin a manual page into L1 by reference |

## 10. The open questions, as Chris decided them (2026-11-07)

1. **Where L1 lives: its own ledger,** `~/.agentbox/org-knowledge.jsonl`, beside `people.jsonl`
   and `guests.jsonl`, with the extended memory record as its line. Not in `shared-memory/`: that
   directory is sharded by writing agent so that one writer owns each file
   (`src/agents/registry.ts:105-117`), and an L1 item's writer is a person's approval, not an
   agent. The registry keeps owning box membership; the L1 ledger asks it and does not copy it.
   docs/05 gains the file's row when it is built.
2. **The owner of an item an agent writes is the member who drove the turn** that proposed the
   promotion; for a routine, its creating principal (docs/22 §2). The approver is recorded as
   `verifiedBy`, and may be a different person.
3. **Involute is evidence, never a search.** An item may cite `inv:INV-n`, and the host reads that
   item's state for staleness, with the Involute credential the installation already configures
   (`src/config.ts:173-175`). Agents in member turns get no Involute search; today's @-mention
   path is unchanged.
4. **An Admin cannot turn L1 review off.** L2 review stays the installation option INV-1581 made.
5. **Existing `audience: "everyone"` records are historical.** When the field is retired, each
   falls back to the box it was written in. There is no promotion-candidate list for them.
6. **Site learnings: new notes are visible to their box by default; existing files stay as they
   are.** How a site learning is shared across boxes is left to a later study.

## 11. Implementation items, to propose under INV-1714

Not proposed yet. Each would be an ISSUE under INV-1714.

1. **Extend the memory record** — `scope`, `surface`, `owner`, `evidence[]`, `validFrom` /
   `validUntil`, `supersedes`, `verifiedBy` / `verifiedAt` / `reviewBy`; L3 records unchanged; one
   admission check before `rankRelated`.
2. **The organisation knowledge ledger** — `~/.agentbox/org-knowledge.jsonl`, its replay, a docs/05
   row, and the read path into the prompt with a pinned budget and citations by id.
3. **Promotion** — a held `Promote` tool for agents and an Admin's promote action on a memory,
   task or receipt; owner = the member who drove the turn (a routine: its creator), approver as
   `verifiedBy`; review always on; the review page shows scope and readers.
4. **Retire `audience: "everyone"`** — the tool loses the field and the read filter stops
   honouring it, so existing records fall back to the box they were written in.
5. **Correction verbs** — unverify, supersede, retract on L1 items, in Settings → Memory and as
   tools; `cite-only` on unverify.
6. **Staleness** — `reviewBy` reminders to owners, and a check that marks an item stale when a
   cited task, Involute item (by `inv:` id, read with the installation's credential) or document
   changes state.
7. **Visible conflict** — the prompt renders disagreeing items across layers as one dated pair
   with sources; maintenance may propose a supersession, never apply it to L1.
8. **Site learnings by box** — a new `NoteSiteLearning` note is visible to its box by default;
   existing files untouched; sharing across boxes waits for a later study.
9. **A scenario** — an agent proposes a fact for the whole organisation, a second agent cannot
   read it until an Admin approves, an unverify drops it from recall, and a guest turn never
   sees it (`src/host/scenario.ts`).

## 12. Against the existing records, and what we do not do

- **docs/22** owns admission; this record adds no gate, only says that knowledge scope uses
  `mayEnterBox`. No department type is added.
- **docs/24** is the memory decision; its tiers (own, team) are L3 and L2 here, unchanged.
- **INV-1581** stands for L2; L1 review is always on (§5 rule 4).
- **docs/95, docs/96** — §8 restates their boundary for knowledge; nothing crosses it.
- **docs/97** — the guest turn reads only G; nothing here adds a tool or a data source to it.

What we do not do, and why:

- **Mirror outside systems' access lists as the core.** Our knowledge is mostly written inside
  the product. An outside source can come later as evidence with its own access check.
- **Build a person profile from passive activity.** The person record is written by the person,
  judged agent lines and named routines, and it can be retracted.
- **Let a model own or rewrite shared knowledge.** One wrong statement would become everyone's
  belief; append-only with an attributed supersession is the safe shape.
- **Add a graph database or extract entities automatically.** Our scale does not need it, and
  automatically extracted shared entities cannot be reviewed. Typed `evidence` links give the
  graph.
- **Judge freshness by the calendar alone.** It misses a change in the evidence.
- **Concatenate layers without an order.** An organisation fact needs a defined winner.
- **Count anonymous votes.** In a small team one click would decide; a correction is signed.
