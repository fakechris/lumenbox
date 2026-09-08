# The chat area: what a person can do with a message

Status: **design + first slice, 2026-09-08.** Chris: "the chat in the middle has no copy or
share; design the whole chat area properly, with Codex's app and Grok Bot as references."

The chat column is where a person spends most of their time and it had exactly two verbs:
type and scroll. A message could not be copied without selecting it by hand, a thread
could not be shared, a code block could not be lifted, and "where was I" had no answer.
Below: every object in the column, what a person can do to it, and where the control
sits. First slice built the same day; the rest is staged.

## 0. References, and what is taken from each

- **Grok Bot**: per-message hover actions at the right edge (react, reply, more), cards
  inline at the point they happened (consent, secret, computer hand-over), the `NEW`
  divider at the first unread message, the footer "Messaged → Involute Ops", "N messages
  with M Bots". Taken: the hover toolbar and its position, the NEW divider, inline cards
  (staged).
- **Codex app**: copy on every message and on every code block, "worked for 40s" folded
  reasoning, a thread-level Share, diffs rendered as diffs. Taken: copy everywhere, thread
  share as Markdown, code-block copy. Our folded steps already do the "worked for" part.

## 1. Objects in the column

| object | what it is | verbs |
|---|---|---|
| message (you / agent) | one bubble with who and when | copy text, copy as Markdown, quote into composer, copy link; a person's own message: resend |
| step (folded round) | narration + the calls under it | fold/unfold (exists), copy the narration |
| tool row | one call and its result | open/close (exists), copy result |
| card (consent, question, secret, computer, task) | something waiting on the person | answer it; today in the strip above the chat, staged to appear inline where it happened |
| teammate note | a message from or to another agent | open (exists) |
| divider | a day boundary, or NEW since last visit | none; orientation |
| thread | the whole conversation | share: copy as Markdown, download `.md`, copy link; switch (exists); fold all (exists) |
| composer | where you type | send, newline, `/` skills (exist); quote lands here |

## 2. The message toolbar

At the right edge of every message, faint until hovered (so a screenshot still shows it):

```
                                            ⧉ copy  M↓ md  ❝ quote  🔗 link
```

- **copy** — the plain text, as rendered (no Markdown syntax).
- **md** — the Markdown source, for pasting into a doc.
- **quote** — puts `> first lines…` into the composer with the cursor after it. This is
  how you answer a specific point without retyping it.
- **link** — copies a URL that opens this page on this agent, this thread, scrolled to
  this message (`?agent=…&conversation=…&m=<index>`). Inside the app it is a permalink;
  pasted into Feishu it opens the web page on that machine.
- **resend** (your own messages only) — puts the text back into the composer.

No emoji reactions: a reaction on an agent's message means nothing to the agent; a reply
does.

## 3. Code blocks

Every `<pre>` gets a copy button top-right on hover. Copies the raw code, not the
highlighted HTML.

## 4. Dividers

- A **day divider** ("Tuesday 8 Sep") between messages on different days.
- A **NEW** divider above the first message that arrived after the last time this thread
  was open on this browser (localStorage, per agent and thread). It appears once per
  visit and is gone on the next.
- A **jump to latest** pill at the bottom when scrolled up, with the count of messages
  that arrived since.

## 5. The thread

`Share ▾` in the header, beside fold steps:

- **Copy as Markdown** — the whole thread as `**You** (09:12): …` / `**Ada** (09:13): …`,
  steps as `<details>`-free plain lines ("— ran bash: npm test"), cards omitted.
- **Download .md** — the same, as a file named `<agent>-<thread>-<date>.md`.
- **Copy link** — this thread.

Nothing here publishes anything: a link opens this machine's page, a file stays on disk.

## 6. Staged, not built

- Inline cards at the point they happened (consent, question, secret, computer) with
  their answered state preserved in the thread, instead of the strip above.
- Search within the thread.
- Diff rendering for `edit_file` tool rows.
- "Worked for N s · 4 calls" summary line on a folded step.

## 7. Built in the first slice (2026-09-08)

§2 toolbar (copy, md, quote, link, resend), §3 code-block copy, §4 day and NEW dividers
and jump-to-latest, §5 Share menu with copy/download/link, permalinks that open the agent,
thread and message. Verified on screen with `scripts/ui-shot.mjs`.
