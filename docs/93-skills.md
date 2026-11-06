<!-- doc: 93-skills
     title: Skills: the SKILL.md contract, where skills live, and how a skill becomes a routine
     family: spec
     status: current
     domain: skills
     updated: 2026-11-05
-->
# Skills: the SKILL.md contract, where skills live, and how a skill becomes a routine

This is the one home of what a skill is. The parser is `src/host/skills.ts`; the scheduler,
listener and webhook runner are `src/host/schedule.ts`; the starters are
`src/host/starter-skills.ts`. Where this page and the code disagree, the code is right and
this page is the bug. The field table in §2 is checked against the parser by
`src/host/architecture-guard.test.ts`.

## 1. What a skill is

**A skill is a saved prompt the agent runs**: a markdown file saying how to do something,
optionally with scripts and assets beside it. It is not a plugin, a DSL or a workflow graph.

- **Where it lives.** `/home/box/work/skills/<slug>/SKILL.md`, in the box's work volume
  (`SKILLS_DIR`). That is the one place that is writable by the agent with the tools it already
  has (`write_file`, `bash`), readable and editable by a person through the files view, and
  durable across a rebuild. A helper script has to be where `bash` can run it, which rules out
  anywhere outside the box.
- **The slug is the directory name**, and the skill's id. A directory without a readable
  `SKILL.md` is a directory, not a broken skill. Every other *file* in the directory is a
  helper, named in the index so the agent knows it is there to be run.
- **Further roots.** `skillRoots` in config names more directories inside the box, searched
  after `SKILLS_DIR` in order. A slug found in an earlier root wins, and the shadowed one is
  reported as a problem rather than resolved silently.
- **Bodies are not in the prompt.** Each agent's prompt carries an index: name, a folded
  description, the path and the helpers, plus when the skill runs by itself. The agent reads
  the body it wants with `read_file`. There is no `UseSkill` tool, deliberately.
  Limits: a description longer than 400 characters (`MAX_DESCRIPTION_CHARS`) is cut, with a
  note; the index line keeps at most 240 (`INDEX_DESCRIPTION_CHARS`, the "when" and "not
  for" sentences first); the whole index takes at most 13,500 (`SKILL_INDEX_CHARS`), and past
  that the rest are named by slug only. docs/05 §3.1a has the measurements behind the numbers.
- **Who sees it.** `scope: global` reaches every agent in the box; `scope: agent` reaches only
  its `owner`.
- **What is refused at load.** A skill that names the host's own records
  (`control-surfaces.ts`) is not loaded, whoever wrote it. A skill whose body is empty, or with
  no description, or with a frontmatter value that cannot be read (table below) is not loaded
  either. Every refusal and every note is returned as `problems` by `GET /api/skills` — said,
  never swallowed.

## 2. The SKILL.md contract

```
---
name: Weekly report
description: Use when someone asks for the weekly numbers; reads the sheet and writes a summary.
schedule: "0 9 * * 1"
timezone: Asia/Shanghai
agent: Ada
deliver: feishu:oc_…
mode: observe
authored_by: Ada
because: they asked for this three Mondays running
---
1. Open ~/work/data/weekly.csv …
```

**The frontmatter is not YAML.** It is `key: value` lines between two `---` lines. Keys are
case-insensitive; a key not in the table is ignored, not rejected (hub packages carry
`license`, `homepage` and others). A value in quotes is exactly its quoted span; an unquoted
value loses an inline ` # comment`. A value of `|`, `|-`, `>` or `>-` folds the indented lines
that follow into one line, as hub packages write `description`. A file without frontmatter is
all body, and the skill is named after its directory — but without a description it is
refused, because the description is the only thing read when choosing a skill.

| key | meaning | absent | refused when |
|---|---|---|---|
| `name` | Shown in the index and the automations list. | The slug, hyphens as spaces. | — |
| `description` | When the skill applies, in a sentence or two. Start with "Use when…". | **Required.** | Missing or empty. Over 400 characters is cut with a note, not refused. |
| `scope` | `global` or `agent`. | `global`. Any value but `agent` is `global`. | — |
| `owner` | With `scope: agent`, the agent it belongs to. | Ignored without `scope: agent`. | — |
| `schedule` | Five cron fields (`*`, numbers, lists, ranges, `*/n`), `@every 30m` (minute floor), `@at <ISO instant>` (once), or `@hourly` `@daily` `@midnight` `@weekly` `@monthly`. | No timer. | Not one of those forms (`schedule-time.ts`). |
| `timezone` | IANA zone the schedule's times are read in (`America/New_York`, not `ET`). | The host's clock. | Unknown zone, or set without a `schedule`. |
| `agent` | Which agent a run wakes. | The box's coordinator (the agent listed first). | — |
| `deliver` | The chat a run reports to, as a chatKey (`feishu:oc_…`). | No chat hears the run. | Set without a `schedule` or `trigger: webhook`. |
| `deliver_when` | `always`: every run is delivered. `changed`: a result identical to the last, or a run with nothing to say, stays on the results ledger. | `changed`. | Any other word. |
| `trigger` | `message` (a listener) or `webhook` (a URL, docs/44). | Not triggered. | Any other word. |
| `match` | With `trigger: message`, a `/regex/flags` or a phrase matched case-insensitively. Fires once per matching message from a person and replies where it was said. | — | Missing with `trigger: message`; set without it; set with `trigger: webhook`; an invalid regex. |
| `chat` | With `trigger: message`, the one chatKey (or its threads) to listen in. | Every chat. | — (ignored without a listener). |
| `paused` | `true`: off until a person turns it on. | Not paused. Only the exact word `true` pauses. | — |
| `mode` | `off`, `observe` or `auto`: how a routine may act (§4). | `auto`. | Any other word — "observe" misspelt must not mean "run". |
| `authored_by` | Who wrote it, when an agent did. Provenance, not a permission; turns on the authoring hints. | — | — |
| `because` | Why it exists, in the author's words. Shown wherever the routine is listed. | — | — |
| `allowed-tools` | The tools the skill needs, comma- or space-separated, optionally in `[…]`. Claude Code names map through `engine-tools.ts`; `mcp__server__tool` is our `server__tool`. When the skill runs unattended, the turn is offered only tools the agent already had **and** the skill named — a narrowing, never a grant. A turn a person drives is not narrowed. | No narrowing. | — (an unknown name is reported in a note and contributes nothing). |

Advice that never refuses (`authoringHints`, shown for a skill with `authored_by`): a
description that says what but not when, and an unattended skill whose body points at "the
above" — a run sees none of the conversation it was written in.

`skill.yaml` beside `SKILL.md` is a separate, optional contract on which parts of a skill an
agent may rewrite (`skill-contract.ts`); a skill without it is unaffected.

## 3. Where skills come from

All three end up as the same thing: a directory under `SKILLS_DIR`. Nothing is installed by
a second mechanism.

1. **Shipped with LumenBox.** The *starters* (`STARTERS` in `starter-skills.ts`, listed with
   their evals by `starterSkillsWithEvals()`) are ours. The *hub packages*
   (`src/host/catalog-data/skills/*/SKILL.md`, listed by `hubSkillSlugs()`) are standard
   skill-hub packages copied as-is, with provenance in `catalog-data/SOURCE.md` and in each
   package's own frontmatter. Both are seeded into every box, once per skill, with
   `SKILLS_DIR/.seeded` recording what was offered and a digest of which version. A person who
   deleted a shipped skill deleted it; a starter we have fixed replaces the old copy only if
   nobody edited it, and an edited copy is left alone and said so. Hub packages are offered once
   and never updated. `export-template` is seeded only where template sharing is on.
2. **Written here.** An agent writes one with `write_file` the moment it works something out,
   and a person edits one in the files view. A demonstration a person recorded becomes a
   teaching draft that a person publishes (docs/56).
3. **Brought in.** `agentbox skills import <dir>` reads `SKILL.md` folders from another agent
   host or a recording tool; each becomes a teaching draft, never an installed skill, with the
   frontmatter reduced to ours (`skill-import.ts`). A template's skills are written by the
   importing bot on its setup turn (docs/29).

## 4. Skills and routines

**A routine is a skill with a `schedule:` or a `trigger:`.** No second object and no second
store: the difference between a recipe and an automation is a line of frontmatter. All of
them are listed in the web app's Automations tab, and their runs go through the ordinary turn:
the routine's agent, the policy gate, the budget, the same records. Runs of one routine never
overlap (a fire that finds the last still going is skipped and logged), and a missed window is
not caught up. A run is told it was started by a timer, a message or a webhook, not by a person.

Two switches, for two different reasons:

- **`paused: true`** is the person's switch. A routine that arrived from a template starts
  paused — the host writes the line if the importing bot forgot it — and the agent does not
  remove it. The tick, the listener and the webhook all skip a paused routine, and "Run now"
  refuses it. The Automations row turns it on (`POST /api/schedules/resume|pause`); resume
  refuses while a `{placeholder}` from the template is still in the file.
- **`mode`** is how far a routine is trusted to act (INV-1458). `off` is never evaluated.
  `observe` records "would have run as …" at every trigger — schedule, listener match, webhook
  call — on the run history and `policy.jsonl`, and runs nothing and tells no chat. `auto`
  runs. Agents write `mode: observe` on every routine they create, so it can be watched for a
  few days before `auto`; the Automations row switches it (`POST /api/schedules/mode`). "Run
  now" is a person's explicit act and runs in any mode.

What a webhook URL is and how its secret is kept is docs/44; the secret is never in the skill
file, because skill files travel. What may and may not travel with a routine in a template —
and which of its values become `{placeholders}` — is docs/29.
