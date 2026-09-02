# Bot templates: the bot packs itself, the new bot installs itself

Status: **design, second version, 2026-09-02.** v1 (same day) put a checkbox picker and a
host-side apply at the centre and was rejected in review: "the bot packs itself and the
new bot installs itself *is* the essence; a person cannot do that selection, and 'we have
no skill-write tool' is not a reason — agents already write skill files with `write_file`."
v2 is that correction. Written against the tree at `d547dac` and the source-level study of
Grok Bot 0.30's template sharing
(`research/grokbot/versions/0.30.0/BOT_TEMPLATE_SHARING.md`, with the served
`export-bot-template` skill and a live import captured from Chris's box). This is R21 from
[docs/11](11-roadmap.md); it revises R21's "never its memories" in §3.

## Status, 2026-09-02

Stages 1 and 2 shipped the same day, on `feat/bot-templates`:

- **Format and rails** — `src/host/template.ts`: `parseTemplate` (the §1 boundary field by
  field, the secret prefilter over every string via `secret-scan.ts`, `gettingStarted` must
  name a skill), `generaliseRoutine` (`deliver:`/`chat:`/`agent:`/`timezone:` and body chat
  keys → `{placeholders}` + "Ask the importing user for:"), `packTemplate` (from the live
  files; a bot's `body` replaces only the markdown below the frontmatter; an `about` record
  refuses), `renderRecipe`, `templateSetupCue`, `reconcile`, `stampTemplateWrite`.
- **`paused: true`** — one frontmatter key (`skills.ts`); the tick and the listener skip it,
  `runNow` refuses it, `status()` reports it; `POST /api/schedules/resume|pause` is the line,
  and resume refuses while a `{placeholder}` is left.
- **The setup turn** — `Orchestrator.importTemplate`: profile-only create with
  `importedFrom`, recipe as `~/work/templates/<slug>/recipe.md` + `.json` in the box, the
  cue on the background lane with the agent flagged `templateSetup`; during that turn
  `write_file`/`edit_file` into a skill dir are stamped (`authored_by: template:<id>`, routines
  forced `paused: true`) and `RememberFact` records carry `source: template:<id>` and no
  `about`; `TEMPLATE_CUE` lands on `reviewInputFor`'s untrusted side; reconcile writes
  `~/.agentbox/template-imports.jsonl` and the `template_import` event, and corrects any
  routine that still came in unpaused. Provenance is true: the ledger shows the new bot as
  the writer (test).
- **Export** — the served `export-template` starter skill and the `PackTemplate` tool
  (offered only when the host has somewhere to stage); staged versions live in
  `~/.agentbox/templates/<agentId>/v<N>.json` with a stable id minted on the first stage.
- **Surface** — `POST /api/templates/import`, `POST /api/templates/share` (sends the
  sentence), `GET /api/templates/mine`, `GET /api/templates/download`; the agent dialog
  (paste/upload to import; "Ask it to draft a template" + Download latest in Configure);
  the automations row shows paused and switches it; `agentbox template import|share|download`.
- **Not yet**: the share card as a transcript card (the staged version shows in Configure
  and the feed instead), withholding outbound tools during the setup turn, the control-plane
  link (§6 Stage B), the catalog as templates (§9 Stage 3), a cheaper model for the setup
  turn. 1035 tests green; the floor moved to 1030.

Measured on the way: with the fake model the whole import — create, place the recipe, the
setup turn writing two skills and one memory, reconcile — is one turn and under a second;
against a real model it is one turn of transcription, which is the argument for §10's last
question.

## 0. The shape

**Export is a conversation with the bot.** The person says "make a template of yourself"
(a button sends that sentence). The bot reads its own memory, skills, routines and
connectors, decides what is workflow and what is this person's private life, rewrites what
needs generalising, and calls one tool, `PackTemplate`, with the whole recipe. The host
validates, refuses what must never travel, generalises routine ids mechanically, stages a
private version, and shows a share card. Publishing is the person's click.

**Import is the new bot's first job.** The host creates the agent from the profile only,
drops the recipe into the box as a file, and gives the new bot a first turn that says: your
template is here, install it — write the skills, save the memories, create the routines
paused — then ask the person for what is still missing, then say hello. The host watches
that turn, stamps what it wrote as template-origin, keeps the routines paused until a
person resumes them, and reconciles the recipe against what landed.

Why this and not a deterministic picker-plus-apply: selection and scrubbing are judgment
("send Meg the Monday plan" → "send your staffing lead the Monday plan"), and a bot that
wrote its own skills on day one knows them the way one that had files copied in does not —
Chris's live import shows the new bot rewriting an imported skill to a different engine two
messages later. The host's job is rails, not hands.

What we reuse: `write_file`/`edit_file` (how skills are authored today, `skills.ts:26-29`),
`RememberFact`, `Recall`, the memory mirror files (`~/work/memory/<agent>/profile.md`),
`SkillProvenance` (which will attribute the new bot's writes to it *for free*),
`firstRunCue` (`prompt.ts:868`), the starter-skills mechanism for served instructions,
`composeSkillFile`, the catalog, and the control plane's SQLite.

## 1. The boundary: what may travel, what never does

The bot chooses; the host enforces this table. Every refusal names the item.

| May travel | Never travels | Enforced how |
| --- | --- | --- |
| `name`, `title`, `description`, `avatarColor`, `tools` as a tier (`desk`/`web`/`code`) or list | `displayIndex`, `boxId`, `ownerUserId`, `scopeId`, `visibility`, `provider`, `model` | schema has no field for them |
| memory **facts** and **pitfalls**, in the bot's rewritten words | `episode`, `note`, any record with `about` (a person), `shared-memory/` shards | host matches each passed text against records; an `about` record's text (or a ≥60-char substring of it) refuses |
| skills the bot names, as whole directories (`SKILL.md` + text helpers ≤256 KiB each) | another agent's `scope: agent` skill; `authored_by`/`because`/`owner` lines; binaries | host packs from the **live files**, using the bot's text only as the rewritten body |
| routines the bot names, `schedule:`/`trigger:`/`match:` kept, `agent:`/`deliver:`/`chat:`/`timezone:` replaced by placeholders | literal chat keys, agent names, `lastRun` | mechanical generalisation §4.3 |
| connector **names** (`feishu`, `dingtalk`, `browser`, `mcp:<server>`) | `channels.json`, env credentials, MCP configs, `vault.json`, `scopes.json`, `box-owner` | no code path reads them |
| `gettingStarted.skill` | — | must name a skill in the recipe |

Plus the secret prefilter (§4.4) over every string. A hit stops the export.

## 2. The format

```jsonc
{
  "format": "lumenbox-template/1",
  "profile": { "name": "下载专家", "title": "下载专家",
               "description": "把 YouTube、B 站、播客转成可读中文稿…",     // storefront line, ≤ 3 sentences
               "avatarColor": "brown", "tools": "web" },
  "memory":   [ { "kind": "fact", "text": "…", "at": "2026-09-01" } ],
  "skills":   [ { "slug": "transcribe", "name": "音视频转写", "description": "…",
                  "files": { "SKILL.md": "---\nname: …", "scripts/dl.sh": "…" } } ],
  "routines": [ { "slug": "weekly-digest", "name": "…", "description": "…",
                  "files": { "SKILL.md": "---\nname: …\nschedule: 0 9 * * 1\ntimezone: {timezone}\ndeliver: {feishu_chat}\nagent: {self}\n---\n…" },
                  "fillIns": [ { "id": "timezone", "label": "Timezone" },
                               { "id": "feishu_chat", "label": "Feishu chat to deliver to" } ] } ],
  "connectors": [ "feishu" ],
  "gettingStarted": { "skill": "setup-guide" },
  "meta": { "createdAt": "…", "createdBy": "kin" }
}
```

One document, text only, ≤ 2 MiB, helpers inline. A tarball was rejected: a JSON pastes
into a chat and diffs in a review. Skills and routines are the same object with one
frontmatter line between them, as on disk. Memory entries are typed records so the importer
side can stamp and decay them like any other. `format` is the only version field.

## 3. Memory travels: conventions, never history, never people

R21 said "never its memories". The live import disproved it: "下载专家"'s single memory
(where the key is read from, that there is no plugin for the service, to follow the setup
guide instead of pasting a secret) *is* the template's operating knowledge and belongs in
no skill. Grok's served skill says the same in one line: "Memories: job or convention facts
only, original wording except what you took out."

So: the bot reads `~/work/memory/<self>/profile.md` (facts and pitfalls, already rendered
without episodes) and passes the ones that are workflow, rewritten where a name or a repo
sits inside a convention. The host refuses anything whose text matches a record carrying
`about`, and never lists episodes or notes to begin with. On import every record is
stamped `source: "template:<id>"`, so `Recall` and the mirror answer "where did this come
from", and `agentbox template forget <id>` retracts the lot.

## 4. Export

### 4.1 The served skill and the tool

**`export-template`** is a starter skill (`starter-skills.ts`), served by the host into
`/home/box/work/skills/export-template/`, so its wording ships with the host and can
change without a client release — the same reason Grok serves theirs from the server. It
is only seeded when sharing is enabled (`AGENTBOX_TEMPLATES=1` for now). Its body,
adapted from Grok's with our paths:

1. *Read, in order, with a one-line update after each:* memory (`Recall`, or the mirror
   `profile.md`; skip episodes and notes; never user-memory or another agent's files),
   skills (`ls ~/work/skills`, read the job text of each, not the raw file), routines (the
   skills with `schedule:`/`trigger:`), connectors (what this conversation and the kept
   routines used). Do not paste contents or a draft.
2. *Choose.* Audience is one question (public or team); include is another (workflow vs
   this person's private life). Leave out secrets, credentials, people's names, private
   links, trade secrets; when a sensitive bit is one part of a useful item, take out the bit
   and keep the item. Don't say "scrub".
3. *Call* `PackTemplate` once, after one line of what is kept vs left out. The description
   is a storefront line. The person edits nothing on the card; they tell you, you call again.

**`PackTemplate`** is a host tool registered only when the skill is seeded:

```
PackTemplate({
  profile: { name, title, description, tools?: "desk"|"web"|"code"|string[] },
  memory:  [{ kind: "fact"|"pitfall", text, at? }],
  skills:  [{ slug, body?: string, description?: string }],     // body = rewritten job text, optional
  routines:[{ slug, body?: string, description?: string }],
  connectors: string[],
  gettingStarted?: { skill: slug },
  visibility: "public" | "team"
})
```

The host packs **from the live directory** of each named slug: helpers copied, frontmatter
rewritten (§4.2), the bot's `body` — if given — replacing only the markdown body below the
frontmatter. A slug that does not exist, a `scope: agent` skill owned by someone else, and
a `body` that starts with `---` (a raw file copy) are dropped and named in the result. Then
§4.3 and §4.4 run, the document is staged as a private version, and a **share card** is
emitted into the transcript and the web header: name, description, counts, the dropped
items, the fill-ins, and Publish / Download / Discard. The tool's text result to the bot is
"Staged version N; it is not public until the person confirms." A bot cannot publish.

### 4.2 Packing a skill

Keep `name`, `description`, `scope: global`, `schedule`, `timezone`, `trigger`, `match`.
Drop `owner`, `authored_by`, `because`. `agent`, `deliver`, `chat` become placeholders.
`composeSkillFile` (`skills.ts:425`, today only tests call it) is extended with those keys
and used as the serializer, so the written file is one the parser round-trips.

### 4.3 Routines: placeholders and fill-ins

Grok's `generalizeTrigger()`, on our two trigger kinds:

| Line | Becomes | Fill-in |
| --- | --- | --- |
| `deliver: feishu:oc_…` / `dingtalk:…` | `deliver: {feishu_chat}` / `{dingtalk_chat}` | "Feishu chat to deliver to" |
| `chat: feishu:oc_…` | `chat: {feishu_chat}` | same id, one question |
| `agent: Bob` | `agent: {self}` | none — resolved to the new bot |
| `timezone: Asia/Shanghai` | `timezone: {timezone}` | "Timezone" (only with `schedule:`) |
| body text with a chat key, `@Name` of a roster agent, `oc_`/`cid` ids | the same placeholder | same |

The fill-in list is appended to the routine body as "Ask the importing user for:" so the
new bot sees it without parsing JSON. A routine with no recognisable trigger is dropped and
named.

### 4.4 The secret prefilter

Every string in the document: `sk-`, `lmbx_`, `xoxb-`, `ghp_`, `AKIA`, `-----BEGIN`,
`Bearer `, `password=`, `KEY|TOKEN|SECRET` followed by `=`/`:` and 16+ non-space chars. A hit
refuses the export with the file and line named, and the bot is told to take it out and
call again. It is a floor; the guarantee is §1 (nothing reads the secret stores).

### 4.5 Entry points

Web header → "Share as template" sends the bot `Create a template of yourself that I can
share.` (`Update the shared template of yourself.` once one exists) on the normal lane, so
the person watches the reads and the card arrive in chat. Chat works without the button.
The card is the only place Publish lives.

## 5. Import: the new bot's first job

### 5.1 What the host does

`POST /api/templates/import { template | shareId }`, `agentbox template import <file|url>`,
or the `/#import=<id>` hand-off from a share page:

1. **Validate**: `format`, size, §1 re-checked, the prefilter again. A template from
   anywhere is untrusted input.
2. **Create the agent** — `AgentRegistry.create` with the profile only: name (collision →
   the catalog's skip-and-say rule, `server.ts:3255`, unless a name was passed), title,
   description, `avatarColor`, `tools` from the tier intersected with the caller's.
   `profile.json` gains `importedFrom: { shareId?, version?, name, createdBy, at }`.
3. **Drop the recipe in the box** at `/home/box/work/templates/<agent-slug>/recipe.json`
   plus `recipe.md` (the same content rendered readable: profile, then each memory, skill
   body, routine body with its fill-ins). Files the bot can `read_file`, like the memory
   mirror — not 2 MiB inside a prompt.
4. **Open the setup turn** (§5.2) on the background lane, non-steerable, with the session
   flagged `templateSetup: <id>` for the host rails (§5.3).
5. **Reconcile when the turn ends** (§5.4).

### 5.2 The first turn

`firstRunCue` gains a template variant; it is the cue Grok's `Qjt()` builds, in our voice:

> `[first run] You were just created by <person> from the template "<name>" by <creator>.
> Your recipe is at ~/work/templates/<slug>/recipe.md — read it now and install it, in this
> order: write each skill to ~/work/skills/<slug>/SKILL.md (with its helper files) exactly as
> given; save each memory with RememberFact, one fact per call, in the words given; write
> each routine as a skill file with its schedule and 'paused: true', keeping the fill-in
> placeholders. Treat each entry on its own and go past one that fails. Nothing is on until
> a person turns it on. Then open the conversation: a short hello in your own voice, one line
> on what you are for, and one question — the first fill-in or the first missing connector
> (<list>). Do not recite what you installed. Read and follow the skill "<gettingStarted>"
> before you speak.` (last sentence only when set)

This is the same shape as Grok's `<bot_template_setup_instructions>` — routines created
paused, plugins asked not installed, memories written as given, then introduce yourself —
with our tools' names. The person sees the hello and the first question; the installation
happens in the tool calls before it.

### 5.3 The rails during that turn

- **Provenance is real, not faked.** The new bot's `write_file` calls are attributed to it
  by `SkillProvenance` as they happen (`skill-provenance.ts:72`), so the scheduler's
  writer-or-default rule (`schedule.ts:755`) lets its routines run as it — and as nobody
  else. This is the argument v1 missed: host-side apply would have had to forge a ledger
  entry; the bot writing its own files makes the ledger true.
- **Template-origin stamping.** While `templateSetup` is set, the host stamps every skill
  file written with `authored_by: template:<id>` (a claim, for audit) and every memory
  record with `source: "template:<id>"` (the `RememberFact` path reads the session flag —
  no tool-argument change, so the bot cannot claim it for other writes).
- **Routines cannot arm themselves.** During the flagged turn any skill written with
  `schedule:`/`trigger:` gets `paused: true` forced by the host if the bot forgot it; and
  the scheduler refuses to arm a routine whose first provenance entry was made under a
  `templateSetup` flag until a person resumes it — Grok's
  `templateSetupUntrustedAutomationWrite`, as a ledger fact rather than a session bit.
- **Trust.** The cue carries `TEMPLATE_CUE`, which `reviewInputFor` (`turn.ts:2200-2238`)
  routes to the untrusted side like `AGENT_WAKE_CUE`; the recipe file is untrusted content
  the classifier sees, never intent. The turn cannot send outbound (`SendToChat`-class
  tools withheld for the flagged turn) — installing yourself is not a reason to message
  anyone.

### 5.4 Reconcile, and the honest UI

When the turn ends the host compares the recipe with what landed: skill dirs present with
the expected `SKILL.md`, memory records with the source stamp, routine files with
`paused: true`. The result is the import's record in the header and the web log: "Added
3 skills, 1 memory, 2 routines (paused)" or "Added 下载专家, but not all of its skills:
论文下载" with a **Retry** that sends a follow-up cue naming only the missing items. This
is the answer to the failure Grok's UI has three strings for: the same failure, plus the
list and the retry.

### 5.5 Resuming a routine

The bot asks for a fill-in, the person answers, the bot edits the frontmatter itself
(`edit_file` on a file it wrote) and says "shall I turn it on?"; the person says yes in chat
or clicks Resume on the automations row (`POST /api/schedules/resume {slug}`, new, clears
`paused:`). A routine with an unresolved `{placeholder}` stays paused even when resumed,
with the missing label in `status()`. `paused:` is one frontmatter key, honoured by
`SkillScheduler` and reported by `status()` — no second store.

## 6. Share: a file, then a link, then a shelf

**Stage A — the file.** The share card's Download gives `<slug>.lumenbox-template.json`;
import accepts a path, an upload or a URL. This alone satisfies R21 with no server. The
catalog joins the format: `catalog-data/experts/*.md` + skill lists become templates,
`GET /api/catalog` serves them, and installing one is §5 — the new expert installs itself
too, so it knows its skills the same way an imported bot does. (`CreateAgent from: <slug>`
mid-turn keeps the current host-side seeding: a bot creating a teammate is not the moment
for a second setup conversation.)

**Stage B — the control-plane link.** `src/control/` has the database and the public
hostname. Two tables:

```
templates(share_id PK 21-char, tenant_id, owner_user_id, source_agent_id,
          name, description, avatar_color, visibility 'public'|'tenant',
          published bool, active_version int, created_at, updated_at)
template_versions(share_id, version, document BLOB ≤2MiB, name, description, created_at,
                  PK(share_id, version))
```

`POST /api/templates` (box token) upserts by `source_agent_id` and appends an **inactive**
version; `…/publish {version}` activates it (first publish and replace are one call; an
older version may be activated — rollback); `DELETE` is hard and frees the source
binding so the next export mints a new id; visibility lives on the parent and versions
inherit it. Grok's model verbatim, because the reasons hold: immutable versions make "the
shared bot was updated, review again" a version compare; a hard delete kills a link now.

The gateway serves `GET /t/<shareId>`: name, description, avatar, creator display name,
the third-party notice, "Add to lumenbox" → the person's box at `/#import=<id>`, which
fetches `GET /api/templates/<id>/document` (authenticated) and runs §5. The page never
carries the document, owner ids or emails. `visibility: tenant` is "team only" with the
entity we have (`store.ts:61`).

**Stage C — the shelf.** A query over public published templates with an owner-only
`featured` flag. Last on purpose: a gallery before a second installation exists is
designing for an audience of zero, and the catalog already is the first-party shelf.

## 7. Surface

| Surface | Route / command | Notes |
| --- | --- | --- |
| tool | `PackTemplate` | registered only with the served skill; result is a staged version + card |
| box | `POST /api/templates/stage` (internal, from the tool) · `GET /api/templates/mine` · `POST …/publish` · `…/visibility` · `…/delete` · `GET …/<id>/download` | card actions |
| box | `POST /api/templates/import {template \| shareId, name?}` | §5.1; returns `{agentId}` at once, the reconcile record arrives on `/api/events` |
| box | `POST /api/schedules/resume {slug}` · `pause` | `paused:` frontmatter |
| control | `POST /api/templates` · `…/<id>/publish` · `…/<id>/visibility` · `DELETE …/<id>` · `GET …/<id>/document` · `GET /t/<id>` | writes need the box token; `/t/` is public |
| CLI | `agentbox template export <agent>` (sends the sentence, waits for the card, prints the path) · `import <file\|url> [--name]` · `forget <shareId>` | `forget` retracts the memories and pauses the routines; skills stay |

`profile.json` gains `templateShareId` (this agent has a template; header shows Update /
Unpublish / Delete) and `importedFrom`.

## 8. Against Grok Bot

| Grok Bot 0.30 | Here | Difference, and why |
| --- | --- | --- |
| Served skill + `create_bot_share_json`; bot passes prose, host packs | Served starter skill + `PackTemplate`; bot passes slugs and optional rewritten bodies, host packs from live files | Same design. Ours packs helpers and refuses invented skills by construction |
| Memory: bot hand-picks prose lines; host does not read `memory/` | Same, and the host additionally refuses anything matching an `about` record | Our records carry the discriminator theirs must infer |
| Import: server copies name+avatar; recipe rides inside the first user message; bot installs with `update_state` | Same; recipe is a file in the box; bot installs with `write_file` + `RememberFact` | A file is what our mirror already taught the bot to read; provenance becomes true for free |
| Routines `enabled=false`, bot asks in plain text | `paused: true`, host-forced during the turn, scheduler refuses to self-arm | Same behaviour, one frontmatter key, plus a rail the bot cannot skip |
| Plugins: marketplace ids, one widget, `InstallPlugin` | Connector names only; the bot raises them | Our doors are operator-configured (`config.ts:86`) |
| Three UI strings for partial install | Reconcile + Retry with the missing list | Same failure, named |
| First publish from the desktop only; bot publish behind a consent card | Publish only from the card; no bot publish tool | Smaller surface until there is a reason |
| Blob in S3 | Document in control-plane SQLite; a file when serverless | No object store needed at 2 MiB |
| `grokbot://` deep link | `/t/<id>` → `/#import=` | Our client is a web page |

Adopted unchanged: the version model, hard delete, visibility on the parent, placeholder
generalisation with "Ask the importing user for", `gettingStarted.skill`, the storefront
description, "don't say scrub", the read-then-update-then-one-call conversation shape.

## 9. Stages

**Stage 1 — format and the import turn.** `src/host/template.ts` (schema, prefilter,
generalisation, `recipe.md` renderer, reconcile); `paused:` in `skills.ts` + `schedule.ts`;
`TEMPLATE_CUE` on the untrusted side; the session flag and its three rails; `POST
/api/templates/import` from a file; the CLI import. Criteria: a fixture recipe imported into
a fresh `AGENTBOX_HOME` with the fake model produces the skills, memories with the source
stamp, routines paused — driven by the model's tool calls, not by the host; a routine
written in the flagged turn without `paused:` gets it; a `write_file` in that turn is
attributed to the new agent (provenance test); reconcile names a skill the fake model
skipped; the cue lands untrusted in `reviewInputFor`.

**Stage 2 — export.** `export-template` starter skill, `PackTemplate`, the share card,
Download. Criteria: with the fake model calling the tool, a non-existent slug is dropped
and named; an `about` record's text refuses; a `sk-` line refuses with the line; a routine
with `deliver:` comes back with `{feishu_chat}` and its fill-in; round trip through Stage 1
reproduces the skills byte-identical below the frontmatter.

**Stage 3 — catalog as templates.** Catalog rows served in the format; web install runs
the setup turn; `CreateAgent from:` keeps host seeding. Criteria: existing catalog tests
pass; a web-installed expert's first message is a hello plus one question.

**Stage 4 — share links.** Control-plane tables and routes, `GET /t/<id>`, the hand-off,
header actions. Criteria: publish → page renders; delete → 404 at once; re-export appends
version 2 inactive; import with a stale version returns "updated, review again".

Not in any stage: the gallery (§6 C), avatar images (we have none), plugin installation,
updates pushed to importers (a template is a copy), a bot-side publish tool.

## 10. Open questions, with the answer I would take

- **The exported bot's own `scope: agent` skills?** They travel as `scope: global` and the
  new bot writes them as its own. Another agent's never do.
- **Tier or list for `tools`?** Tier when the agent's set is one; list otherwise. Tool
  names drift; tiers are the catalog's stable words.
- **`createdBy`?** The gateway-asserted `userId`, else the installation owner's name from
  config, else omitted. Never an email.
- **Should the setup turn run on a cheaper model?** Probably yes — it is transcription, not
  judgment — but measure a real one first (Chris's took under a minute on Grok).
