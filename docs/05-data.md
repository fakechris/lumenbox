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
  memory.md                 long-term notes the agent maintains
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

The agents' output. Whatever they make, plus `recordings/*.mp4`. Owned by `box`. This is the
volume a person browses in the file manager.

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

- **Unbounded growth on disk.** Requests are now bounded by compaction (§2.2.1), but the files are
  not: a transcript grows forever and nothing rotates or archives it. That is deliberate — the
  record is the product's provenance claim — and it means disk is the eventual limit, which
  `box-doctor` reports and nothing enforces.
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
