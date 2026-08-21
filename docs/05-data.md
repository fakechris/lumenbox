# Data

There is no database. The data model is the filesystem, and that is a decision with real
consequences — the ones it buys are in §6, the ones it costs are in §7.

## 1. Where state lives

Three places, and which one a thing is in determines what destroys it.

| Location | Survives | Destroyed by |
| --- | --- | --- |
| **Host state dir** (`~/.agentbox`) or the `hostd` volume | container recreate, image upgrade | deleting it |
| **Box volumes** (`work`, `config`) | container recreate, image upgrade | `docker volume rm` |
| **Container layer** (everything else) | `docker stop`/`start` | `--recreate`, image upgrade |

The third row is why the first two exist. Recreating a container is what upgrading an image
means, and it takes the whole writable layer with it.

## 2. Orchestrator state

`~/.agentbox/` on the host, or `/home/hostd/.agentbox` on a volume, mode 700 in the
self-contained topology.

```
token                       box API bearer, 0600
ui-token                    web UI shared secret, 0600
config.json                 settings decided once
activity.jsonl              recent activity for the feed
agents/<agentId>/
  profile.json              identity and persona
  conversation.jsonl        the transcript
  memory.md                 legacy: imported once into memory.jsonl, then left alone
  memory.jsonl              what the agent remembers, one record per line
  plan.md                   the agent's plan; rendered into every system prompt
  todos.json                the agent's todo list, same
  box-owner                 this agent's claim on its desktop, 0600
```

### 2.1 `profile.json`

```jsonc
{
  "name": "Ada",                    // unique-ish label, ≤72 chars, whitespace collapsed
  "description": "…",               // becomes the persona in the system prompt, ≤2000 chars
  "title": "coordinator",           // optional subtitle
  "avatarColor": "#7aa2f7",         // optional
  "hidden": false,                  // removes it from listings, stays functional
  "displayIndex": 1,                // its desktop; stable for the agent's life
  "createdAt": "2026-08-19T…Z",
  "updatedAt": "2026-08-19T…Z"
}
```

Written atomically — temp file plus rename — because it is read on every prompt assembly and a
reader that catches a half-written file sees invalid JSON. A corrupt profile removes that agent
from listings rather than failing the roster.

`displayIndex` is allocated as the lowest free index, so a deleted agent's desktop is reused,
capped at 32. An agent created before the field existed is backfilled on first use rather than
defaulted to 1, which would silently share a desktop.

### 2.2 `conversation.jsonl`

Append-only, one JSON object per line, four shapes:

```jsonc
{ "role": "user",      "text": "…",        "at": "…" }   // what the person or the wake prompt said
{ "role": "assistant", "text": "…",        "at": "…" }   // prose only
{ "role": "assistant", "kind": "blocks",  "blocks": [ … ], "at": "…" }  // text + tool_use
{ "role": "user",      "kind": "results", "blocks": [ … ], "at": "…" }  // the matching tool_result
{ "role": "user",      "kind": "summary", "covers": 127, "text": "…", "at": "…" }  // stands in for the first 127
```

Invariants:

- A `results` entry immediately follows its `blocks` entry. Replay trims orphans at the edges,
  because a result with no call is a protocol error to the model.
- `blocks` are the model's own content blocks, not a rendering of them. That is the point:
  see [04-design.md](04-design.md) §6.
- Images are stripped from stored results and replaced with a note. A transcript would
  otherwise be mostly base64.
- An unparseable line is skipped, not fatal.
- A `summary` entry stands in for the first `covers` entries of the window it was written in.
  Assembly starts from the newest summary and sends the tail verbatim; everything it covers stays
  on the disk and stays readable by a person. **Compaction changes what is sent, never what is
  stored** — see §2.2.1.

Observed sizes: a few KB per light conversation, ~180KB after a day of heavy computer use. The file
still grows without bound; what is bounded is the request built from it (§2.2.1).

#### 2.2.1 Compaction

Past `AGENTBOX_COMPACT_AT_TOKENS` (default 60,000, estimated at four characters per token) the
entries before a cut point are summarised into one `summary` entry, which is appended to the
transcript and used from then on. `AGENTBOX_COMPACT_KEEP_TOKENS` (default 20,000) is the tail kept
verbatim, so recent work is never a paraphrase.

Invariants, both load-bearing:

- **The cut lands on a pair boundary.** A `blocks` entry and its `results` are one exchange to the
  API; a cut between them produces a request the API rejects. The chooser walks back until the
  entry before the cut ends an exchange, and gives up rather than cutting if it cannot.
- **A failed summarisation does not fail the turn.** It writes a `summary` entry saying the entries
  were dropped and why, and telling the model to treat what it cannot see as unknown rather than as
  not done. Loud, because silent trimming is the failure mode that produces an agent confidently
  redoing or contradicting its own work.

Measured on a real 166-entry transcript: 26,473 tokens became 1,672.

#### 2.2.2 Within one turn

Compaction above runs once, before a turn. It cannot help a turn that outgrows the window on its own,
and a computer-use turn does exactly that: one screenshot per round, up to `AGENTBOX_MAX_ROUNDS`
(400) of them, all still being sent on the last one.

Measured on eight real rounds against this box: the request was 71KB and an estimated 13,553 tokens,
of which **94% was images**. So the guard is about images and nothing else:

- **Before each request**, if the estimate exceeds the trigger, every screenshot except the newest is
  replaced by `[screenshot removed to fit the context window]`. An agent deciding where to click
  needs the screen as it is now; the screen thirty actions ago is a claim about the past that the
  text already records. On those eight rounds this was an 82% reduction.
- **Only the contents of tool results change**, so the `tool_use`/`tool_result` pairing the API
  requires cannot be broken by it. Verified: all eight results and their ids survived.
- **After a rejection**, the same shedding runs and the round is retried — images first, then all
  images when the provider's complaint is about image *count* rather than size, then the oldest
  oversized tool results. Bounded at `AGENTBOX_MAX_SHED_ATTEMPTS` (3), and when nothing further can
  be shed it fails with what is actually wrong rather than retrying identically.

**Prepared in advance, not on demand.** Compaction used to be synchronous: the first turn to cross
the trigger waited for a summary, measured at 30 seconds on a real 26,000-token history — a pause
landing at random from the user's point of view. There are now two thresholds. At 75% of the trigger
a summary starts *in the background* and the turn goes out uncompacted, because there is still room;
at the trigger it is adopted if ready and computed-and-waited-for if not. A speculative summary
records the window length it was computed from and is discarded if the window shortened underneath
it, since `covers` would then point at the wrong entries. Wasted work is acceptable; wrong work is
not.

The summarising call uses a cheaper model on the same credential where one is known
(`AGENTBOX_SUMMARY_PROVIDER` / `AGENTBOX_SUMMARY_MODEL` override it). It is a plain, tool-free,
text-in-text-out request, and paying the agent's own model for it is the most expensive way to do the
least interesting work. A provider with no cheaper model named falls back to the agent's own rather
than refusing: a deployment with one credential must still be able to compact.

Token estimation is 2.5 characters per token — not 4, which is roughly right for prose and badly
optimistic for JSON, shell output and CJK, and errs in the direction that fails to compact when
compaction was needed. Images are counted as a flat ~1,600 tokens each rather than by their base64
length, which is wrong in both directions at once. The trigger follows the model's real context
window when the provider reports one, so the same code is right for a 200k model and a 1M one.

### 2.2c `shared-memory/<agentId>.jsonl`

The team's memory. Same record shape, one file per writing agent, merged on read.

**Sharded because agents run concurrently**, and two appends to one file are not reliably atomic once
a line exceeds the pipe-buffer size. One writer per file removes the question; merging on read is
cheap. `via` is stamped from the filename rather than trusted from the record, so a shard cannot
attribute its contents to a different agent.

Beside the per-agent directories rather than inside one, so removing an agent does not remove what it
taught the team — that is the whole point of the tier. Under the same root so a custom root keeps an
installation's state together, which means the agent listing has to exclude it *by name*: it
previously survived only because reading an absent profile returns undefined, which worked and was an
accident rather than a rule.

Written by `RememberFact` with `scope: "team"`, and the default is `"self"` because the errors are not
symmetrical: a wrong `team` costs every agent prompt space forever, while a wrong `self` costs one
repeated question. Automatic extraction writes only to the agent's own tier, deliberately — an
unvouched-for note propagating to four agents' prompts multiplies the cost of a bad extraction by
four.

Rendered as its own section under a tighter budget (1,500 characters against 4,000). Smaller because
every agent writes to this tier, so it grows N times as fast, and a generous budget here would push
out an agent's own working knowledge. Each line carries who learned it and, when the box was told who
was driving, who it is about — without the latter, a fact learned from one person reads as being about
whoever asks next, which in a team is worse than not recording it.

### 2.2b `memory.jsonl`

Append-only, one record per line: `{ at, kind, text, source? }`.

This replaced a single markdown file that was pasted whole into every system prompt. That works for a
week and then becomes a second unbounded context — it only grows, nothing ages out, the same fact
accumulates in five phrasings, and eventually the memory costs more per request than the conversation.

**Deliberately not a retrieval engine**, and that is the load-bearing decision. Facts are short,
keyword-dense lines: the easy case. So there are records, a score, a budget, and lexical matching
where matching is needed — no embeddings, no index, no second database. `selectRelevant` is the one
seam, so semantic retrieval is a substitution rather than a rewrite if evidence ever calls for one.
The trigger for reconsidering is written down in §7.

Three kinds, each with an unambiguous source, which is what makes them usable:

| kind | written by | half-life | weight |
| --- | --- | --- | --- |
| `fact` | `RememberFact` — a deliberate act, so it is trusted | 365d | 1.0 |
| `note` | automatic extraction — nobody vouched for it | 30d | 0.5 |
| `episode` | condensed from several exchanges; stands in for facts that have aged out | 90d | 1.5 |

A separate "profile" tier next to a "recent" one was rejected: that classification has to come
from somewhere, and a tier nobody can populate correctly is worse than one list scored honestly.

What reaches the prompt is a **character budget, not a count** — fifty short facts and five long ones
cost the same, and one of those sets is worth more. Selection is by score; rendering is chronological,
because a model reading facts benefits from knowing which came after which. Omissions are stated
(`N older or weaker memories are not shown`) so an agent does not read a truncated list as everything
it knows.

Deduplication is applied **on read, not on write**: the file stays a faithful log of what was
believed when, and the view is deduplicated — which is why an over-eager merge is recoverable. A
later record wins, because writing something again is usually a correction; and an automatic note
never displaces the deliberate fact it repeats, which would otherwise restart the decay clock on
something already vouched for.

Extraction runs **after a turn and every third exchange**, on the cheap summariser profile, and is
allowed to find nothing — the sentinel is explicit and the prompt asks for it first. An extractor that
must produce output invents something, and a memory of the obvious is worse than none because it is
read on every future turn. Every fourth extraction condenses into an episode.

An existing `memory.md` is imported once, as `fact` records with their original dates honoured, and
the markdown file is left on disk. Losing someone's memory to upgrade the format would be the worst
possible way to introduce a feature about not losing things.

### 2.2a `plan.md` and `todos.json`

State the agent maintains with `SetPlan` and `SetTodos`, and **the only state a long task has that
compaction cannot touch.**

That immunity comes from placement, not from a mechanism. Both are rendered into the *volatile system
prompt tier* on every turn ([04-design.md](04-design.md)), so there is no path by which a summary
could lose them — they were never in the history a summary replaces. The alternative, re-rendering
them into each summary, would be a mechanism to maintain and to get wrong.

Written atomically, read defensively and independently: a `todos.json` someone edited into invalid
JSON must not stop the plan being shown, and neither must stop a turn. A lost list is recoverable —
the agent writes a new one — while a turn that will not start is not.

Absent renders as *nothing*, never as an empty container. A heading saying "here is the plan:" with
nothing under it tells a model that a plan exists and is empty, which reads as "there is no work to
do".

Bounded: 8,000 characters of plan, 40 todos of 200 characters. The plan is in every request from then
on, so length is paid for repeatedly; a refusal says to put detail in a file under `/home/box/work`
and point at it, because a refusal that does not name the alternative produces a retry of the same
thing.

One gap covered from the other side: the system prompt is built once per turn, so an update at round
5 is not in the prompt at round 300. The tools echo the whole new state in their result, which puts
it in the message array where in-turn pruning does not reach.

### 2.3 `activity.jsonl`

Append-only records of feed-worthy events, each with the time it happened. Bounded by
`activityLimit` (default 400): the file is compacted in place once it exceeds a few times that.
Copy-then-truncate rather than rename, because the writer holds it open.

Not a record of the run. The transcripts are. Deleting this file clears the feed.

### 2.4 `usage.jsonl`

Append-only, one record per model round:

```jsonc
{ "seq": 1, "at": "…Z", "agentId": "…", "agentName": "Ada",
  "provider": "MiniMax", "model": "MiniMax-M3", "round": 0,
  "inputTokens": 21752, "outputTokens": 27,
  "cacheReadTokens": 133, "cacheWriteTokens": 0 }
```

`seq` is monotonic and continues across a restart and across a torn last line, because the reader
is a collector that remembers an offset: one reading by timestamp either double-counts or skips,
depending on which way its clock is wrong. Compacted to its tail past 20,000 records, preserving
sequence numbers.

No prices. A record says tokens; what a token costs belongs to whoever bills and would be wrong in
a file nobody remembers to update.

### 2.5 `config.json`

```jsonc
{ "activityLimit": 400 }
```

Read once at startup, written with defaults on first start so the settings are discoverable in
an editor. Read defensively: a mistyped value falls back and says so, an out-of-range one is
clamped, unknown keys are ignored so a config from a later version still loads.

## 3. Box state

### 3.1 `work` volume — `/home/box/work`

The agents' output. Whatever they make, plus `recordings/*.mp4`. Owned by `box`.

**The only directory a person may browse from outside the box, and the only one that survives a
rebuild — deliberately the same set.** "You can download it" and "it will still be here tomorrow" are
then one rule rather than two.

`GET /api/files` lists it (with modification times, because "what did the agent just make" is the
question people have and alphabetical order answers a different one), `GET /api/file?path=…` serves a
file, and `POST /api/file` accepts one — the other direction, a person handing the agent a document.
All behind the UI's existing auth, and the upload requires the driving role: a viewer may read what
the agents made and may not add to it. `?download=1` switches `Content-Disposition` from `inline` to `attachment`, so a browser shows
what it can and saves what it cannot. Never cached: an agent rewrites its own output, and a stale copy
would be read as the current one.

Confinement is checked **twice, in two different ways**, because neither check alone is enough:

- The web server normalises the path and requires the `/home/box/work` prefix. This stops `..`, an
  absolute path elsewhere, and `/home/box/workfoo`. It cannot stop a symlink.
- The daemon resolves with `realpath` and requires the same prefix. This is what stops a symlink out
  of the tree — which an agent can create with one command.

Verified against a real box: `/etc/passwd`, the orchestrator's own token file, `..` traversal and a
sibling-prefix path are all refused by the first check; symlinks to both are refused by the second;
and an unauthenticated request gets 401. Reads are capped at 10MB because the body is base64 in JSON
— a third again on the wire — which covers reports, spreadsheets, logs and screenshots. Something
larger is a dataset, and the honest answer for a dataset is to archive it and say so.

### 3.1a `skills/` — `/home/box/work/skills/<slug>/SKILL.md`

Work an agent has done once and can do again. **A skill is a saved prompt the agent runs** — a
markdown file with `---` frontmatter (`name`, `description`, `scope`, `owner`) and optional scripts
beside it.

In the work volume rather than in orchestrator state, because that is the only location satisfying
all three things a skill has to be: writable by the agent with the tools it already has, readable and
editable by a person through the files view, and durable across a rebuild. The third argument settles
it alone — a skill with a helper script needs the script where `bash` can run it.

**The prompt carries an index, never the bodies**: names, descriptions and paths, and the agent reads
the one it picks. A dozen recipes in every request would cost more than the conversation, which is the
same reasoning that governs memory and compaction here.

Frontmatter is parsed with about ten lines rather than a YAML dependency. The failure mode of a real
parser is worse here: it rejects a file a person hand-edited slightly wrong, where this treats the
whole thing as a body and the skill still works under a name derived from its directory. A skill with
*no description* is the one case reported rather than ignored — the description is the only thing read
when choosing, so without one the skill exists and is never chosen.

A `schedule:` line in the frontmatter makes a skill an **automation** — no second object and no
second store; the only difference between a recipe and an automation is a line of frontmatter. Five
cron fields, `@every <n><unit>`, or `@hourly`/`@daily`/`@weekly`/`@monthly`. Deliberately a subset:
the parts left out (`MON`, `L`, `#`, seconds) vary between implementations, and a schedule meaning
something slightly different from what its author expected is worse than one that was refused.

Four answers the phrase "without anyone asking" forces, all of them in `schedule.ts`:

- **It spends money unwatched**, so a scheduled run goes through the same policy gate as any other
  turn. A box over budget stops firing rather than quietly draining, and the refusal is on the record.
- **Runs do not overlap.** An hourly job taking seventy minutes meets its own next fire; the second
  is skipped *and logged*, because a silent skip is indistinguishable from a schedule that stopped.
- **A missed window is not caught up.** Two days down: "the daily report" arguably wants two runs and
  "check hourly" emphatically does not want forty-eight, and cron cannot say which. Nothing is
  replayed. Silently catching up is the behaviour that produces a surprise bill.
- **The turn knows it was a timer.** An agent that believes someone is waiting asks questions nobody
  will answer and hurries, so the prompt says so and says where to leave its output.

Read at most every few seconds, and the load reports whether the directory was actually **read** as
distinct from being read and empty. Those mean opposite things: without the distinction a box
restarting replaces a good list with an empty one, and since the list is in the prompt, that reads as
"you have no skills" rather than "we could not check".

### 3.2 `config` volume — `/home/box/.config`

What the box logged into and how the desktop looks: browser profiles per display
(`box-chrome-<n>`), dconf, libfm, pcmanfm, plank, Thunar.

**Re-seeded from the image on every start.** A volume outlives the image it came from, so
without re-seeding a box created months ago keeps its old desktop config and a fix shipped in
the image never arrives. Only the files the image owns are overwritten; browser profiles are
left alone, since they are why the volume exists.

### 3.3 Ephemeral, in the container layer

`/tmp/xvfb-N.log`, `xfwm4-N.log`, `picom-N.log`, `plank-N.log`, `pcmanfm-N.log`,
`x11vnc-N.log`, `novnc-N.log`, `autocutsel-N.log` — rotated by copy-then-truncate past 2MB.
`/tmp/agentbox-crashes.jsonl` — crash records from PID 1. Session state for shell sessions.

Deliberately ephemeral: a fresh container should have fresh logs, and none of this is evidence
anyone needs after the box is gone.

## 4. In-memory only

Named because losing them is a design decision, not an oversight.

| State | Lost when | Consequence |
| --- | --- | --- |
| Desktop→owner bindings | boxd restarts | Rebound on the next ensure |
| Component restart history | boxd restarts | An abandoned component is retried |
| Crash aggregation counters | PID 1 restarts | Pending counts unflushed |
| In-flight turns | Orchestrator restarts | The turn is lost; its transcript keeps what completed |
| Recording state | boxd restarts | The file is playable up to near where it stopped |

The last row is the one that took work: a killed recorder used to leave an unplayable stub.

## 5. Identifiers

| Identifier | Form | Scope |
| --- | --- | --- |
| Agent id | UUID v4 | Directory name, stable for life |
| Display index | 1–32 | The box; one agent each |
| Box token | 32 hex | One box; the API bearer |
| UI token | 32 hex | One UI; whoever holds it drives everything |
| Owner token | 32 hex | One agent's desktop claim |
| Recording file | `<agent>-<ISO timestamp>.mp4` | Sanitised: no path separators survive |

## 6. Why the filesystem

- An agent can read a teammate's profile with the same shell it uses for everything else. No
  API, no schema migration, no second source of truth.
- A person can read and repair everything with an editor.
- Append-only transcripts cannot be corrupted by a concurrent writer, and a truncated last
  line costs one entry.
- No process to run, back up, or upgrade separately.

## 7. What it costs

Honestly, since these are the findings a review should raise:

- **Retrieval is lexical, and now has one exception.** Word overlap over short facts is the easy
  case, and a vector store would still be infrastructure bought for an unmeasured problem — that
  trigger stands: roughly 500 records where word overlap demonstrably misses something, with a
  specific example rather than an impression.

  What changed is narrower. When the character budget forces memories to be *dropped*, a cheap model
  call decides which ones survive, because "memories are being left out" is a measurement rather
  than an impression, and it is the only moment when the choice can be wrong. Below the budget
  nothing is dropped, nothing is chosen, and no call is made — which is almost always. The selector
  is an improvement to which memories are discarded and never a reason a turn does not happen: any
  failure, or an answer that cannot be read, falls back to the score.
- **Unbounded growth on disk, for the transcript only.** Requests are bounded by compaction
  (§2.2.1) and the transcript file still grows forever — deliberately, because the record is the
  product's provenance claim. Memory no longer shares that property: `memory.jsonl` was the one
  durable log that never compacted its own file (usage, policy, claims, the inbox and the turn
  ledger all rewrite their tail), which was an inconsistency rather than a decision — the *view*
  was always bounded, so nothing above the file noticed. Past a line threshold it is rewritten down
  to the live view dedupe already computes, original bytes and timestamps kept, so the view and the
  decay are untouched. The cost accepted matches every other log: "what was believed when" is only
  recoverable back to the last compaction. Shared shards compact together, never one at a time — a
  retraction in one agent's shard withdraws a fact in another's, and the rule that keeps every
  crash point safe is that a retraction is only dropped once nothing it could kill remains on disk.
- **No query.** "Which agent touched this file", "what happened on Tuesday" mean reading every
  file. Fine for one box, not for a fleet.
- **No transactions.** Atomic profile writes and append-only transcripts cover the realistic
  cases; a crash between appending a `blocks` entry and its `results` entry leaves an orphan,
  which replay tolerates but which is real.
- **No schema version.** Nothing in a transcript or profile says which version wrote it. A
  format change has to be backward-compatible by inspection, which is how a format change goes
  wrong quietly.
- **No backup.** Documented as a directory to copy ([06-deployment.md](06-deployment.md) §6);
  nothing does it.
- **Concurrent orchestrators are undefined.** Two writing one agent's transcript interleave
  entries. Nothing prevents it and nothing detects it.
