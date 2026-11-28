<!-- doc: 93-skills
     title: Skills: the SKILL.md contract, where skills live, and how a skill becomes a routine
     family: spec
     status: current
     domain: skills
     updated: 2026-11-28
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
  anywhere outside the box. On a host box (the person's own machine) the work volume is the
  box's work directory, so the skills are at `<work>/skills/<slug>/SKILL.md`: every host-side
  reader and writer (seeding, the index, templates, the skill-file checks) asks
  `skillsDir(box)` in `src/host/box-paths.ts`, never the literal path (INV-1719).
- **The slug is the directory name**, and the skill's id. A directory without a readable
  `SKILL.md` is a directory, not a broken skill. Every other *file* in the directory is a
  helper, named in the index so the agent knows it is there to be run.
- **Further roots.** `skillRoots` in config names more directories inside the box, searched
  after `SKILLS_DIR` in order. A slug found in an earlier root wins, and the shadowed one is
  reported as a problem rather than resolved silently.
- **The organisation's skills** are a second root on an organisation's boxes, with no setting:
  §1a.
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

## 1a. The organisation's skills (INV-2222, docs/109 §6)

A skill lives in one box, so a tool every member needs was one import per box. On an
organisation installation an Admin publishes a skill once, to the server, and the server places
it in every box. A personal installation has none of this: no library, no directory, no second root.

- **The library is on the server**: `<home>/org-skills/<slug>/v<n>/` and the ledger
  `org-skills.jsonl` (docs/05 §2.2h, `src/host/org-skills.ts`). Published from a folder the Admin
  uploads, a skill of a template document, or a skill in a box the Admin may enter; publishing a
  name again is an update, a new version; withdrawing removes it from every box.
- **What is refused at publish**: everything a box's own skill is refused for at load, and
  four things because every box will carry it — a description over 400 characters (a box's own
  is merely cut), anything credential-shaped in any file or a value the vault holds (docs/15),
  `scope: agent`, and a `schedule:` or `trigger:`: a routine is switched on by its person (docs/29),
  not started in every box by a publish.
- **In a box** it is at `<work>/.lumenbox/org-skills/<slug>/` (`orgSkillsDir(box)`), beside the
  box's own skills directory and not in it. It is a projection: the server writes it and reads it
  only to compare. A box is synced when it connects, when the library changes, and on a sweep
  every thirty seconds for whatever those missed; a box that is down is synced when it comes back
  (`src/host/org-skill-sync.ts`).
- **Read-only means this.** The box's daemon runs as the box's user, who is also the agent's
  shell and has `sudo` in the image, so nothing the host writes there is beyond that user's
  reach. Three things hold instead: every file and directory is left without write bits, so a
  write is refused until somebody `chmod`s it on purpose; an agent's `write_file` and `edit_file`
  to that directory are refused by the host; and whatever was changed anyway is written over at
  the next sync and shown to the Admins as drift, path by path.
- **A name both have — the one rule:** *a skill the organisation marked required is read and the
  box's own of that name is not; any other organisation skill gives way to the box's own.* Either
  way the index line of the one that is read says which it is and that the other is not used,
  and the skills page lists the shadowed one as a problem.
- **The index.** Organisation skills are in the same index, within the same 13,500 characters.
  When it does not all fit, required organisation skills are described first, then the box's
  own and the shipped ones, then the other organisation skills — which are therefore the first
  to become a bare name. The shipped descriptions are the ones the skill evals measured and a
  box's own are what its agents wrote for their work; a publish to everybody does not push one
  of those out, and "required" is the Admin saying this one is worth it. Measured 2026-11-28 on
  a fresh box: 42 shipped skills take 10,974 of the 13,500; ten organisation skills with
  descriptions averaging 132 characters add 2,364 bytes to the prompt and all 52 are still
  described (13,144 used); at fourteen, three of the organisation's that are not required are
  named only and all 42 shipped keep their description. With no organisation skill the index is
  byte for byte what it was (the prompt ratchet's ceilings did not move).
- **A member offers a skill of their own** from a box they may enter (`POST /api/org-skills/offer`,
  a driver or an Admin). It waits, held: placed in no box and read by no agent. The Admins see its
  files, what the publish checks say of them now and the warnings of §2a, and approve — published as
  that Admin's own act, exactly as offered — or decline with a reason the member is given. What a
  publish refuses is refused at the offer, so a credential never waits on the server's disk.
- **The sweep, at size.** Every minute each connected box is looked at: a box that was current is
  asked for one file, `.placed.json`, and compared with the library — one request, nothing hashed in
  the box. A box that was not current, that just connected, or every box after the library changed,
  is read back whole, which is where drift is found. Eight boxes at a time, a minute each at most: a
  slow or dead box is marked behind with the reason and holds up nobody. Measured 2026-11-28 at 300
  boxes over loopback HTTP through the real box client: an unchanged sweep is 300 requests, ~55 ms,
  17 KB sent and 334 KB received; a full check of every box with ten skills is 19,200 requests in
  ~3.9 s.

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
| `when_idle` | `run`: the routine keeps its schedule when nobody has written to the box for days (a weekly report). `pause`: it stops with the rest and resumes when a person writes (docs/04 §14, INV-741). | `pause`. | Any other word. |
| `mode` | `off`, `observe` or `auto`: how a routine may act (§4). | `auto`. | Any other word — "observe" misspelt must not mean "run". |
| `authored_by` | Who wrote it, when an agent did. Provenance, not a permission; turns on the authoring hints. | — | — |
| `because` | Why it exists, in the author's words. Shown wherever the routine is listed. | — | — |
| `allowed-tools` | The tools the skill needs, comma- or space-separated, optionally in `[…]`. Claude Code names map through `engine-tools.ts`; `mcp__server__tool` is our `server__tool`. When the skill runs unattended, the turn is offered only tools the agent already had **and** the skill named — a narrowing, never a grant. A turn a person drives is not narrowed. | No narrowing. | — (an unknown name is reported in a note and contributes nothing). |
| `connectors` | The connectors the skill's work needs, comma- or space-separated: an OAuth connection (`github`, kept in the vault as `oauth:github`) or an MCP door / configured server (`mcp:notion`). Read before a run, a task or a template's setup starts (`credential-coverage.ts`, INV-1666): a routine missing one is skipped and paused with `missing_credentials`, a task waits with a "before this can start" card. A statement, never a grant. | Nothing is checked. | — |
| `secrets` | The vault secret ids its host commands name (`RunOnHost`'s `secrets`), same list form. Checked the same way: the secret must exist and a live grant (or the box's bundle) must cover the agent. | Nothing is checked. | — |
| `install` | A shell line, run in the skill's own directory, that installs the tool the skill needs into the box's kept volumes (§2a). Kept as written: quotes and `#` are the shell's. | — | Without `installed`. |
| `installed` | A shell line that exits 0 once the tool is installed (§2a). | — | Without `install`. |
| `sign_in` | The name of what the person signs in to themselves, e.g. `DingTalk` (§2a). | — | Without `sign_in_start` and `signed_in`. |
| `sign_in_start` | A shell line that starts the sign-in and prints its link or code for the person (§2a). | — | Without `sign_in`. |
| `signed_in` | A shell line that exits 0 once the person has signed in (§2a). | — | Without `sign_in`. |

Advice that never refuses (`authoringHints`, shown for a skill with `authored_by`): a
description that says what but not when, and an unattended skill whose body points at "the
above" — a run sees none of the conversation it was written in.

`skill.yaml` beside `SKILL.md` is a separate, optional contract on which parts of a skill an
agent may rewrite (`skill-contract.ts`); a skill without it is unaffected.

## 2a. A tool to install and a sign-in only the person can do (INV-2222, docs/109 §5)

The image does not carry every tool an organisation uses. A skill that needs one says so with the
five keys above: two shell lines for the tool (`install`, `installed`) and a name and two shell lines
for the sign-in (`sign_in`, `sign_in_start`, `signed_in`). Each line is run in the skill's own
directory with `LUMENBOX_WORK` exported as the box's work directory — `/home/box/work` on the
image, the box's own on a host box — so one skill names a kept place on every kind of box.

- **What survives an image update** is the work volume and `~/.config` (docs/12 §1; both are
  volumes in `src/box/docker.ts` and in the Kubernetes pod, `src/control/kube-box.ts`). A host box
  has only its work directory. An install goes under `$LUMENBOX_WORK` (`$LUMENBOX_WORK/.tools/` by
  convention), and so do the tool's credentials, or `~/.config`.
- **Checked at publish, not refused.** An install line, or the script it runs, that uses `sudo`, a
  system package manager, a global npm or a pip install with no target, a system directory, or a
  place in the home directory that is neither `work` nor `.config` is published with a warning the
  Admin sees (`setupWarnings`, `src/host/org-skill-setup.ts`). A line of shell cannot be read for
  certain, so it is never a refusal.
- **Nothing runs in a box until its person agrees** (decided 2026-11-28). A personal box holds its
  member's own sign-ins, and an Admin cannot enter it; a required skill whose lines ran there by
  themselves would be an Admin's code over everybody's credentials. So, per box and per skill, the
  host keeps a consent to one *digest of the lines* (`install`, `installed`, `sign_in`,
  `sign_in_start`, `signed_in`). A new version whose lines changed needs a new yes; one that changed
  only its text does not. Before a yes, neither the host's checks nor the agent runs any of it.
- **Who answers.** For a personal box, its owner and nobody else — an Admin included. For a box
  several people share, an Admin who may enter it: their yes is the organisation's own decision
  there. The answer is the person's own message `agree <slug>` / `decline <slug>` (also `同意` /
  `拒绝`) — read from the message as admitted, with its authenticated principal; a synthetic message,
  a routine's, an agent's or anybody else's is not an answer — or the buttons on Settings → Mine,
  which show the exact lines, who published which version, and where it stands.
- **Asked once per version.** Until an answer, the box's skills index shows what the skill would
  run, who published which version, and how to answer, and says nothing of it runs before that.
  Once a turn a person opened has carried the question, it is not asked again for those lines; the
  person can answer later in Settings → Mine. A no is remembered and nothing more is done about it;
  the Admin's page counts who agreed and who waits, and names who declined.
- **What is owed, and said once.** After a yes — at once, in the turn that said it, and after every
  sync — the host runs that skill's `installed` and `signed_in` there. What is not done is added to
  that box's index with the exact lines to run, until a turn a person opened has carried it; then it
  is not said again in that box, done or not.
- **The record.** `org-skill-setup.jsonl`: each yes and no (who, box, skill, version, digest, by
  chat or page), each question asked and each set-up told. `agentbox audit export` carries a box's.
- **Who does what.** The agent runs an install. A sign-in is the person's act: the agent starts it
  and gives the person the link or code it prints, or hands over the desktop, and never asks for or
  types a password (docs/15). The index says that in the sentence that introduces what is owed.
- **Delegated engines** read the box's own skills directory (each engine's skills directory is a
  link to it, in the image). So each organisation skill is also linked into it as
  `<skills>/<slug>` → `../.lumenbox/org-skills/<slug>`, wherever the box has no skill of that name,
  and the links go when the skill is withdrawn. An engine reads it through the link and cannot
  write it: the modes are the target's. LumenBox's own loader lists directories, not links, so it
  meets each skill once, where it really is.
- Only an organisation's required skills ask, and are offered, this way. A box's own skill may carry the same
  keys; they document it, and nothing is run for it.

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
