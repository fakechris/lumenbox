<!-- doc: 05-data
     title: Data
     family: spec
     status: current
     domain: storage
     updated: 2026-09-22
-->
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
auto-review.jsonl           one verdict per reviewed tool call (auto-review.ts; shadow or enforce)
skill-provenance.jsonl      which agent the host saw write each skill (skill-provenance.ts)
hooks.json                  lifecycle hooks in Claude Code's dialect (hooks.ts); read on mtime
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

Two fields ride on entries and are for whoever reconstructs what happened, never for the
model: `causedBy` (the ids of the messages that opened or steered the turn — the same ids
`messages.jsonl` and the inbox carry) and `turnId` (the id `turns.jsonl` records for the turn
that wrote the line, on every entry a turn writes; absent on the compaction summary and on
entries from before INV-613).


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
cost the same, and one of those sets is worth more. Relevance admits records first, then score
and a strict body budget select among only those admitted; rendering is chronological,
because a model reading facts benefits from knowing which came after which. Omissions are stated
(`N older or weaker memories are not shown`) so an agent does not read a truncated list as everything
it knows. The index may contain only admitted records omitted from the body, never records rejected
by relevance. Excluded counts are separate from budget omissions; an empty projection does not mean
the agent has no stored memories. Low-level `recall` still supports score-only storage/evaluation
views; prompt assembly must use `chooseRelevant` or the conservative `recallRelevant` fallback.

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

### 2.3a `messages.jsonl`

Every message a person sent through a door, kept once, as sent, for good (`src/channels/messages.ts`,
INV-613). One line per admitted message: `schema: lumenbox.message/v1`, `id` (minted at the door — the
id the inbox record and the transcript's `causedBy` then carry), `channel`, `channelMessageId` (the
wire's own id, e.g. Feishu's `om_…`), `chatKey`, `threadKey`, `identity`, `senderLabel`,
`conversationKey` (the thread if any, else the chat — `conversationIdFor` turns it into the
transcript's conversation name), `receivedAt`, `text` (whole, before the inbox's 8,000-character
clamp), `textChars`, `files[] {name, bytes}`.

Why a fifth ledger: at the time, `ingress.jsonl`, `inbox.jsonl`, `turns.jsonl` and
`deliveries.jsonl` all emptied themselves once nothing was pending — right for a queue and wrong
for a record — and the transcript joins several messages into one prompt. Two of those four are
now declared records and archive instead (§2.4.1); the other two are queues and still empty. This
file never compacts at all. Refused messages are not in it (ingress says they were refused); it is
not scanned for secrets on the way in — the audit export redacts on the way out — because a record
that edits what a person said is not a record of what they said.

#### 2.4.1 Every ledger says what kind of thing it is

Twelve files here compact, and until INV-634 none of them said which of four things it was, so
each `compact()` was written by copying whichever neighbour was open. Each now declares
`export const LEDGER_KIND` (`src/host/jsonl.ts`) and an architecture guard fails the build on a
thirteenth that does not.

| kind | what compaction may do | files |
|---|---|---|
| `record` | move a line to an archive, never lose one | `ingress.jsonl`, `turns.jsonl` |
| `queue` | drop what is settled; that was its job | `inbox.jsonl`, `deliveries.jsonl` |
| `state` | keep one line per key; older ones are noise | `conversations`, `sent-roots`, `cards`, `claims`, `tasks` |
| `feed` | let old lines fall off the back | `usage.jsonl`, `activity`, `policy` |

A `record` archives to `<name>.<yyyy-mm>.jsonl` beside itself, append-only and never compacted in
turn. Two things had been quietly losing history. The catch-up sweep asks whether a message was
already decided before replaying it, and after a compaction the answer for every older message was
no, so a vendor replaying a week-old message would have been answered twice. And `turns.jsonl` is
the only record of what a turn cost, how long it ran, which model and prompt produced it and how it
ended; after five thousand turns all of it went, including the month an audit export was asking
about. The archives are read on demand — `Ingress.list({ archived: true })`, `decidedAlready`, and
the audit export — so ordinary reads stay as cheap as they were.

`policy` is labelled `feed` with a note rather than a verdict: a grant given once and used once is
an audit fact, and past twenty thousand events it goes. Standing grants are re-stated on compaction
precisely because losing those would change behaviour, which is the argument for calling the rest a
record too. Left as it is on purpose, flagged so the next person deciding it is deciding.

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

### 2.6 `fetched/`

What the host read on the web for an agent, kept (`src/host/fetched.ts`, INV-629; the X part
`src/host/x-post.ts`, INV-628). The tool result an agent sees is cut to `DURABLE_RESULT_CHARS`
in the transcript (docs/24), so without this the text an agent cited was gone by the time
anyone asked what it had been verified against.

- `fetched/<yyyy-mm>/<sha8-of-url>-<fetched_at>.md` — one file per `WebFetch`: a frontmatter
  (`schema: lumenbox.fetched/v1`, `url`, `final_url`, `title`, `fetched_at`, `content_type`,
  `bytes`, `text_chars`, `clipped`, `completeness`, `prose_blocks`, `links`, `sha256` of the
  body, and `author` / `published` / `site_name` when the page declared them in JSON-LD, Open
  Graph or `<meta>`, then `agent_id`, `agent`, `conversation`) over the **whole** extracted
  text, not the 40,000-character slice the model was shown. Never overwritten: the instant is
  in the name. The last three are the same measurement the tool result leads with (§2.6.1),
  so the file and the transcript can be compared without re-reading the body.
- `fetched/x/<id>/` — a post on X: the raw answer (`fxtwitter-v2.json`, or `syndication.json`
  on fallback) beside `post.md`, markdown whose frontmatter names `completeness`, `fetcher`,
  the author, the date, the thread ids and both sha256s. A second fetch of the same id
  overwrites with the newer answer.

#### 2.6.1 The line every read leads with

Six tools read something into a turn — `WebFetch`, `WebSearch`, `ReadFeishuDoc`, `read_file`,
`ReadHistory`, `browser_read` — and each writes the same first line (`src/host/read-outcome.ts`,
INV-632):

```
[read: clipped — 40,000 of 61,606 chars, 57 prose blocks, 576 links; open it with browser_open]
```

First, not last, because the transcript keeps a result's **head**: the old end-of-result
notices were the first thing the cut removed. `completeness` is one of `full`, `clipped`,
`blocked`, `unavailable`, `summary` — `clipped` means we cut it, `summary` means search
results rather than a document. It reports counts and never grades them; the measurement that
killed the grading idea is docs/69 §2.4, kept as a test over three real pages.

The tool result ends with a pointer that **describes its own target** (INV-659):

```
[full page kept: /…/fetched/2026-09/1a2b3c4d-20260922T100000Z.md — 61,606 chars, sha256 <64 hex>, kept 2026-09-22T10:00:00.000Z]
```

Same shape as the box's spill pointer, and `storableResult` carries it across the
transcript's cut. The digest is out here rather than only inside the file because the file
is pruned at ninety days and the digest used to be pruned with it: the record held a path
to something that no longer existed and could not say what had been there. Now an expired
artefact degrades from "here it is" to "this is what it was". One regex reads either
pointer (`KEPT_POINTER_PATTERN`), the path is still the first token after the marker, and
the line never contains a `]`, because three consumers already depend on both of those.

**Which turn read what (INV-665).** The `end` record in `turns.jsonl` carries `evidence`:
the pointers this turn produced, as they were written. The link only went one way before —
a kept file names the turn that read it, so file to turn resolved, and nothing answered
turn to files except walking every month of the store filtering on a field. It lives in
`turns.jsonl` rather than a new ledger because that file is a `record` since INV-634: it
archives instead of emptying, which is what an edge between a turn and its evidence needs.

Two things use the edge. The quote gate runs over a turn's own sources before the answer
is delivered. And the retention pass keeps a file a live turn still points at, past its
age: `referencedKeptPaths()` reads the live ledger, and a retention floor that only moves
one way is CMIS's rule for the same reason.

`verifyKept()` re-reads the kept files and checks each body against its own frontmatter
digest; `verifyPointer()` does the same for one pointer and distinguishes `verified`,
`mismatched` and `missing`. The audit export runs the first on the way out and puts
`verified` / `mismatched` / the failing paths in the manifest under `evidence`, because an
export that carries a quietly corrupted page out as evidence is worse than one that
carries nothing. Kept for
`AGENTBOX_FETCHED_RETENTION_DAYS` days (default 90, at most 3650): a prune runs on the way
past a fetch or a kept result, at most once an hour, over both directories at once, and
logs one line when it removed anything. The audit
export (docs/50 J4) takes the files inside its window, redacted, listed under `fetched` in
the manifest apart from the ledgers. `AGENTBOX_FXTWITTER_BASE` and
`AGENTBOX_X_SYNDICATION_BASE` point the X reader at a self-hosted FxEmbed or a mirror.

## 3. Box state

### 2.7 `results/`

Whatever a tool said, kept by whoever cut it (`src/host/results.ts`, INV-633).

A tool result is trimmed to `DURABLE_RESULT_CHARS` before the transcript stores it
(`storableResult`, docs/24). Three producers thought to spill on their own — the box for
shell output, `WebFetch` for a page, the X reader for a post — and every other tool's
overflow was gone the moment the turn ended: a long `browser_read`, a long document, a
file read, anything an MCP server returns. Asking each producer to remember is asking for
the same defect once per tool, so now the cut keeps what it cuts.

- `results/<yyyy-mm>/<turnId>-<toolUseId>.txt` — one file per call that was too long, with
  a frontmatter (`schema: lumenbox.result/v1`, `tool`, `tool_use_id`, `turn_id`, `at`,
  `text_chars`, `is_error` when the call failed, `sha256` of the body, `agent_id`, `agent`,
  `conversation`) over the whole result. Keyed by turn and call rather than by a digest, so
  two calls that returned the same bytes stay two records.
- Not written when the result already carries a pointer of its own, and not written for a
  result the tool asked to record differently (`ToolOutcome.recordAs`, a vault secret): the
  secret was the reason for withholding it.
- A failure to write is said in place of the pointer and never thrown. A turn is not lost
  over a full disk.

The pointer is the same self-describing shape as a kept page's, written with the box's own
phrase, so `storableResult`, `extractAnchors` and the system prompt all already know it.

**Getting it back (`ReadKept`, INV-661).** The path is on the host, outside the box, so an
agent cannot reach it with `read_file` — that is right for an audit trail, and it was the
one place this design took the lossy side of the rule that you may only remove something
from context if it can be got back. So the way back is host-mediated: the agent names a
*call it made*, never a file. Ownership is checked against the agent and the conversation,
and a result belonging to someone else answers exactly as one that does not exist, because
telling the two apart would be a way to ask what calls another agent has made. A result
read back is still subject to the limit that cut it, and comes back under the same
first-line contract as any other read. A withheld result cannot be read back because it was
never written; the guarantee comes from the write path, not from a check on the way out.

The record of a read-back is the tool call itself. It is a call like any other, so it lands
in the transcript with its result and is kept whole if it is long, under the same rules as
everything else — a second ledger line would be a second record of one event. What that
does not catch, said plainly: an agent working through many call ids to see which exist
would look like ordinary use, and nothing counts those. The path is
on the host, outside the box, so an agent cannot read it back with `read_file` — the same
as a kept page. It is for the person who asks later what a call actually returned. Same
retention as `fetched/`, taken by the same pass; the audit export carries the files inside
its window, redacted, listed under `results` in the manifest.

Both stores declare `KEPT_KIND = "feed"` (`src/host/fetched.ts`), honestly: they prune, and
a `record` may not. That is only defensible because the pointer keeps the digest. What is
deliberately not built, so nobody assumes it: retention keyed to the work the evidence
supported rather than to when it was read. Evidence almost always wants the former, and we
have no link from an artefact to the work that cited it. That link is the prerequisite.

### 2.8 `digest/<runKey>/package/`

One day, assembled from what is already kept (`src/host/day-package/`, INV-669). The
material half of the daily research digest: no prose, no vault, no network. `agentbox day
<YYYY-MM-DD> [--chat <chatKey>]`.

- `manifest.json` — the window as a local day with its UTC offset, every message (whole,
  as sent, with its attachments listed), every turn (model, build, how it ended), every
  source read (url, completeness, digest, which turn read it), every reply, and `gaps`.
- `sources/<sha8>.md` — the body of each kept source, redacted. A source the retention has
  already taken keeps its row with `state: expired` and loses only its body, which is what
  the self-describing pointer (§2.6) was for.
- `turns/<turnId>/reply.md` — what the agent finally said.
- `READY` — a generation timestamp on a comment line, then the sha256 of every other file.
  Written last, so its absence is how an unfinished package is told from a thin day.

Two properties do the work.

**Deterministic.** Every hashed file, the manifest included, is a pure function of the
day's material; the generation instant lives in `READY` rather than in the manifest so it
cannot poison that. Two runs over an unchanged day give identical hashes, which makes "did
anything about this day change" two numbers compared rather than a diff read. WACZ splits
its datapackage from its digest for the same reason.

**`gaps` is the honest part.** A day assembled from a host running an older build is
missing whole categories of material and looks exactly like a quiet day. Measured on this
installation on 2026-09-23: the host was 43 commits behind, so `results/` was empty and no
turn carried its evidence. So every degradation is named with its reason and the commit it
saw — `No turn recorded what it read … the host on this day ran a build before INV-665
(saw cc71f82)` — and a reader who sees an empty section can tell "nothing happened" from
"we could not know". Messages fall back from `messages.jsonl` to the transcript the same
way, and say so.


**Checking it: `agentbox digest validate <runKey>`.** Whether `draft.md` stands up
mechanically: citations resolve against the package, a sentence citing the agent's own turn
carries something else too, the short version is short, and **the digest is not the list it
was asked not to be**.

That last rule asks its question two ways, because the obvious way is easy to slip past.
**By citation, which needs no threshold**: a list has one section per message, section *k*
citing message *k* and nothing else. Exact, and rewording the headings does not touch it.
**By heading, approximately**: a section named after a message is named after it even when
the naming was paraphrased. Measured, reworded headings score 0.61 to 0.71 against the
messages they were named after, so the heading test alone is a threshold fight against
whoever is rewording and the citation test carries what it misses. A *run* of consecutive
sections rather than a count, because a day with one big thing in it legitimately gets one
section about one message. What a synthesis may not do is march.

No semantic judgement. That ceiling is 77% balanced accuracy on the public leaderboard,
with 0.4B and 405B models both inside 71.8 to 77.4, and a judgement wrong one time in four
cannot gate delivery (docs/71 §2). Semantics are for the gold days and a person's eye.
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

  Personal and shared memory are screened for relevance even when everything fits. Empty selection
  means no memories, and a subset never refills spare space with rejected records. With no query,
  none are injected. Selector failure/unavailability falls back only to lexically related `fact`
  records after resolving retractions, not automatic notes or episodes and not a scored default.
  This is conservative: lexical recall can miss relevant facts and `fact` is not proof of truth.
  Non-empty memory now costs a selection call per tier per turn when a selector is configured;
  projections remain fixed through continuations. No vector store or provider change is implied.

  The turn ledger's optional `memoryProjection` records separate personal/shared selection methods,
  SHA-256 record identifiers for body/index candidates, and relevance exclusion counts. It stores
  no additional memory text; hashes are diagnostic identifiers, not secret anonymisation. Old ledger
  records without this field remain readable. This manifests memory projection only, not every
  possible context source. Explicit Recall/history/mirror access remains available in normal turns;
  this relevance filter is not a clean-session isolation boundary.
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

## 8. The mirror in the box (2026-09-02)

`memory.jsonl` stays the record of truth on the host. Since 2026-09-02 every change to it, and
every box connect, also writes a read-only projection into the box at
`/home/box/work/memory/<agent-slug>/profile.md` (facts and pitfalls, live view, retractions
applied, newest first) and `log/YYYY-MM.md` (notes and episodes by month). The header of every
file says it is a mirror; `RememberFact` is the only way memory changes. A write the box refuses
is a `[memory-mirror]` log line and nothing else — the host record is unaffected, and the file
is rewritten on the next change or connect. Unchanged files are not rewritten.
