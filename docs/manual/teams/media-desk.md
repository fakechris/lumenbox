<!-- doc: media-desk
     title: Media desk: one source, three forms
     family: manual
     status: current
     covers: crew:media-desk
     audience: user
     updated: 2026-11-06
-->
# Media desk: one source, three forms

A design you can copy for content work: one source becomes a long article, a Xiaohongshu note
and a short-video script, each written by the agent whose form it is.

## Architecture

The `media-desk` crew (内容小队 in the app) adds three agents from the catalog. Each owns one form
and hands the others' forms on instead of shortening its own.

| Role | Agent | What it writes | What it touches | What it does not do |
|---|---|---|---|---|
| Long form | Jian (主笔) | Articles, briefs and explainers a person reads to the end on a phone | Files, the browser, web search, Feishu docs | Notes or scripts |
| Notes | He (种草) | Xiaohongshu notes: title, cover line, body and a few variants | Files, the browser, web search, Feishu docs | Claim to have used what it has not |
| Scripts | Jing (编剧) | Spoken short-video scripts: hook, body, one ask | Files only; no browser | Footage, voice-over, view counts |

```
source (link, notes, file) ──▶ Jian ── article.md ──┬──▶ He   ── note + variants
                                                    └──▶ Jing ── script with pauses
                     all three land under /home/box/work; you publish
```

## Core design

### Prompt

Each persona is written in Chinese and re-read on every turn (`src/host/catalog-data/experts/`).
Each one names the forms that belong to its colleagues, so the same source is not cut down three
times by one agent. All three refuse invented sources, invented first-hand use and promised
reach.

### Tools and permissions

- Jian and He have the desk tools plus the web: the box browser, `WebFetch`, `WebSearch` and
  `ReadFeishuDoc`.
- Jing has the desk tools only; a script is written from the article, not from the web.
- Nothing in the crew posts anywhere. Posting to an outside service goes through a connector,
  and you set it to ask me in Configure → Tools.

### Skills

Jian reads `khazix-writer`, `humanizer` and `wechat-longform`. He reads `xiaohongshu-note`,
`marketing-skills`, `humanizer` and `content-repurposer`. Jing reads `short-video-script`,
`content-repurposer` and `humanizer`. All of them ship with every box.

### Memory

Each agent keeps its own memory of your style and your readers. The drafts are files under
`/home/box/work`, so a colleague reads the article there rather than from a chat message.

### Credentials

None to start. `WebSearch` needs one search key (Keenable, Brave or Tavily) in Settings → Model;
without it, the agents search through the box browser. A site that needs an account must be
signed in on that agent's desktop: take it over and sign in yourself.

## Configuration: minimal and daily

| | Minimal | Daily |
|---|---|---|
| Agents | Jian, He and Jing, as the crew adds them | The same three, on the `media-desk` team |
| Input | One link or file per request | A routine that collects sources each morning (Automations → *+ New*) |
| Search | The box browser | A search key in Settings → Model |
| Hand-off | You ask He and Jing after Jian finishes | Jian is told to hand the article on; the division of work shows the chain |
| Channel | The app only | A Feishu group with Jian as the default agent |
| Publishing | You copy the files out | Still you; see *Outside the box* |

## Running cost

**Basis:** not measured yet. This installation's records hold the crew's set-up turns only. On
2026-09-08 (model MiniMax-M3), Jian's took 4.0 s and Jing's 3.7 s; He was never installed. Their
usage rows were compacted after 48 hours, so no token count survives. No run of the crew on one
source is on record, so this page gives no figure.

To measure it: install the crew on a box with a model key, set `AGENTBOX_USAGE_RETAIN_HOURS`
longer than the run, and give Jian one source with "article, then note and script". Record
`agentbox usage --task tN` for the task, the wall-clock time from its history, and the model and
rates in effect that day. A cost per *accepted* piece also needs your verdict on each of the
three files ([docs/75](../../75-cost-per-accepted-task.md)).

## Build the minimal version

### In the app

1. Press `+` beside *Agents*. Under *From catalog*, press `内容小队`, then *Create these 3 in
   <box>*.
2. Open Configure on each member and type `media-desk` under *Teams*. The crew does not set the
   team by itself yet.
3. Pick Jian, paste the source and say who reads it.
4. When the article is in the box, ask He for a note and Jing for a script from it.
5. Open the task: *Deliverables* lists each file with *Download*.

### In a chat

1. In Settings → Channels, set the group's default agent to Jian.
2. Send the source in the group. Send `@He` and `@Jing` messages for the other two forms.
3. The files arrive in the chat with the replies. Send `看板` to see the task.

### From the command line

```
agentbox agents                              # Jian, He and Jing after the install
agentbox chat Jian "把这篇链接写成一篇公众号长文：……"
agentbox usage --task t12                    # what the piece cost, once it has turns
```

## Run monitoring

- **The sidebar:** `Running` while an agent writes, and `Waiting for you: …` when it asks for
  material or an approval.
- **The Tasks tab:** each request is one task. A task that went `review` waits for your verdict.
  "turn ended; not closed because …" means nobody has checked the result yet.
- **Stuck:** a turn that ends `incomplete` hit the per-turn limit. That happens on web pages that
  load forever. A "flagged for a person" line in the task history means no change for an hour.
- **The task card:** *Deliverables* (a `.pdf` that is not a PDF is refused and must be made
  again), the *Gate* line, and *Division of work* if Jian splits the job.

## Outside the box

- Publishing: the WeChat official account, the Xiaohongshu account and the video account are
  yours. The crew writes; a person posts.
- The facts: the agents mark what they could not confirm, and you decide whether that is enough.
- Rights to images and quotes you add.
- A Feishu or DingTalk app registered in that platform's console, if the crew works in a group.

## Extensions

- Add a morning routine that collects sources for Jian, and keep it in observe for a week first.
- Add `xi` (分析师) when a piece rests on numbers.
- Stamp a ready-made template from the shelf for a channel the crew does not cover.
- Save a tuned Jian as a template so another box starts with your style.

## The run this page is based on

- No cost run exists yet; see *Running cost* for what was found and what would measure it.
- The set-up turns cited above are in this installation's `turns.jsonl` (2026-09-08, `how: done`).
- The install path is the one reproduced for the [ship crew](ship.md) in an empty home. The same
  `POST /api/catalog/install` adds this crew; it was not reproduced separately.
- Design: [docs/94](../../94-catalog.md) (the catalog).
