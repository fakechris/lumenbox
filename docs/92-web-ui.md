<!-- doc: 92-web-ui
     title: The web UI's visual rules: type, spacing, components
     family: spec
     status: current
     domain: web-ui
     updated: 2026-11-12
-->
# The web UI's visual rules: type, spacing, components

The page is one stylesheet's worth of decisions. Colours, fonts, radii and motion were already
tokens at the top of `src/web/app-html.ts`. Type size and spacing were not: by 2026-11-03 the web
code used 21 font sizes, 12 gaps and 10 top margins, and the settings sections added after the
page each set their own (INV-1548). This page is the rule. `src/web/ui-style.ts` is the
stylesheet that implements it for the sections loaded beside the page.

## 1. Tokens

Use a token. If none fits, the design is asking for a new one: add it here first.

| Kind | Tokens | Where |
|---|---|---|
| Colour | `--bg` `--surface` `--surface-2` `--border` `--border-strong` `--text` `--text-soft` `--muted` `--accent` `--accent-2` `--success` `--warn` `--danger` (and their `-soft`) | app-html.ts, light and dark |
| Font | `--font-sans` (IBM Plex Sans) for prose and controls, `--font-mono` for code, ids, logs and typed values | app-html.ts |
| Radius | `--radius-input` 10 · `--radius-md` 12 · `--radius-card` 16 · `--radius-pill` | app-html.ts |
| **Type** | `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-body` 15 · `--fs-lg` 18 · `--fs-xl` 22 (px) | ui-style.ts |
| **Space** | `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 24 · `--sp-6` 32 (px) | ui-style.ts |

What each type size is for: `xs` for labels, step counters and logs; `sm` for notes and list rows;
`md` for controls and mono values; `body` for prose; `lg` for a section title; `xl` for a page
title. Space between related controls is `--sp-2`, between groups `--sp-3`, and around a panel
`--sp-4`.

## 2. Components

| Need | Use | Not |
|---|---|---|
| A labelled setting | `.field` › `label` + control + `.fieldnote` | a bare input with prose beside it |
| Controls in a line | `.ui-row` (wraps, `--sp-2` apart) | `display:flex;gap:…` written inline |
| Buttons that end a step | `.ui-actions` (a row with `--sp-3` above it); the way out goes last, pushed right with `.ui-push` | buttons scattered through the prose |
| A primary action | `.btn.accent`, one per view | two accented buttons side by side |
| A secondary action | `.btn` | |
| A quiet action, or one that only reveals more | `.ui-link`; destructive: `.ui-link.danger` | a full-width `.btn`, which reads as a heading |
| A dropdown | `select` inside `.field`: one look, a chevron with room beside it | the native look, with its arrow against the border |
| A group inside a section | `.ui-panel` | a hand-drawn border |
| A step in a guide | `.ui-step` (counter) + `.ui-title` | |
| Output that streams | `.ui-log` (mono, scrolls, keeps line breaks) | a `pre` styled inline |
| A list of items | `.ui-list-row` per item | |
| A width for a short value | `.ui-w-xs` 64 · `.ui-w-sm` 96 · `.ui-w-md` 200 · `.ui-w-lg` 320 · `.ui-w-full` | `width:` inline |
| Asking for one line of text | `askInline` (`src/web/inline-ask.ts`, `.ui-ask`) | `prompt()`, which the desktop app does not have |

## 3. Don't

- Don't write layout inline: no `font-size`, `margin`, `padding`, `gap` or `width` in a `style`
  attribute. `display:none` for something shown later is state, and is allowed.
  `src/web/ui-style.test.ts` holds the five settings scripts to zero.
- Don't invent a colour, a size or a radius. Use a token, or add one here.
- Don't make a control look like a heading, or a heading look like a control. That is how
  INV-1547 happened: a full-width button above an open wizard read as its title.
- Don't use `prompt()`, `alert()` for input, or anything else the desktop app does not
  implement.

## 4. Panel headers

`src/web/pane-header.ts` owns the shared `.paneheader` layout. A panel's available width,
not the outer window width, determines wrapping. Identity (`.lead`) and actions
(`.headactions`) each wrap within their own bounds; the groups also wrap onto separate rows.
Header height follows its content. Do not restore a fixed height or an unshrinkable action
group, and do not fix collisions by reducing font size or clipping controls.

Long identity text may ellipsize. Action labels and runtime usage remain readable by
wrapping. New controls, including those inserted after loading (configuration versions,
task links, running state and Stop), belong to one of the groups and obey the same rule.
Popovers anchor below the whole header and remain inside the panel's horizontal bounds.

Window overflow is insufficient evidence: two descendants can overlap without making the
document wider. Browser checks must assert that visible controls do not intersect and that
children remain inside their group. Exercise both languages, long identity/version/usage,
busy and idle states, narrow and wide panels, and enlarged text. Include keyboard activation
and popovers so wrapping does not merely make a broken control look correct.

## 5. First-use guidance and connection state

An installation with retained agent conversation history and a task at review or done has
reached the first-work milestone. Do not automatically reopen Set up when a box disconnects
or credentials change. Those are current availability problems, visible in box status and
Settings. Guide explicitly reopens the checklist; a used installation's offline box is
described as offline, with a manage-connection action. Closing is remembered per installation
in this browser and survives polling and reload. A different installation still receives its
own first-use guide.

## 6. Checking

- `node --experimental-transform-types --test src/web/ui-style.test.ts` counts inline layout in
  the settings scripts.
- A change to how a settings tab looks is checked the way INV-1548 was: every tab, light and
  dark, before and after, in a hidden Electron window.
- The main page's own 338 inline styles predate this. They move to classes when their section is
  next changed, not in one sweep.
- `npx playwright-core install chromium` then `npm run test:layout` runs an isolated production
  server with anonymous local state, no box and no provider calls. CI runs this browser gate
  separately from the hermetic unit suite. `UI_LAYOUT_BROWSER` can select an existing browser;
  `UI_LAYOUT_OUTPUT` selects the directory for geometry results and screenshots (default:
  ignored `research/ui-layout`). The check covers both panel headers and the first-use guide's
  offline/completed/dismissed states. New header controls must be included in its geometry set.

## User work reading

`host/work-reading.ts` owns the read contract for the original goal, current phase and reason,
provenance boundary, evidence, check impact and related work. Task list/search, detail, attention
and the current conversation consume that projection; they must not independently infer business
state from a reviewer name, a title pattern or the selected agent. A reviewer being configured is
not an active check. File/model checks never stand in for the user's acceptance.

Keep the existing palette and fonts. Main task views read work in the selected member and
conversation; search narrows that scope. No repeated member picker, New task form, status or
level controls belong in the reading view. Management stays explicitly disclosed. Ordinary peer
messages and host context are bounded, collapsed evidence beside the chat, not new user turns.
Questions, approvals and failures that need a decision remain directly visible. Card actions
carry an explicit surface reference and continue the host-recorded original work. Missing,
ended or superseded cards cannot create a new goal from their generated action text.

Unknown source/execution links stay unknown. Related objects use meaningful titles and links;
removed and inaccessible objects share a non-leaking explanation. Opening or refreshing a record
must clear stale content and mutation controls before a new authorization response. Full task
history and diagnostic wording remain disclosed separately from the latest submitted result.

Keep existing keyed 50-task/100-step initial pages and lazy step bodies. Updates to the reading
summary preserve open disclosures, focus and scroll. `scripts/work-reading-layout.mjs` uses an
isolated production server with 1600 user tasks and 2000 retained steps to exercise search,
links, large text, both languages and themes, missing objects and incremental events.

## Global work management

The global Work management entry is independent of the selected member and conversation.
My work opens the existing work list; executions, future entries, historical records and
explicit member pauses are separate views. Physical agent-turn counts, work-record counts
and known future-resource counts have different meanings. Zero turns never means all future
behavior is stopped. Offline or cached automation inventories retain an explicit boundary.

Read projections use stable resource identities from the bus, task/work roots, interrupted
turns, pending work, scheduler, external intake and delivery ledgers. They do not infer work
relationships from titles or timestamps. Legacy cards remain searchable; ended internal
archives require explicit inclusion. Pages contain at most 50 rows. Opening a reference uses
existing task details and their access/missing-record boundary.

An operator previews each selected action and scope before confirming. Whole-work cancellation
uses verified work roots. A rootless record does not authorize cancelling an entire collaboration.
A selected queued message, recovery attempt or callback stops only its named resource. Member
pauses affect every work item of those explicitly selected members, retain queues, and may resume.
Disabling an automation or external entry is durable and blocks future admission; already started
or queued execution requires a separate stop. Discarding a reply changes delivery, never acceptance.

The resource-revocation ledger records the entire explicit scope before asynchronous cleanup.
It stores revocations and operation receipts, not another task or execution state machine. Each
underlying authority checks its barrier on startup and before the relevant continuation/dispatch.
Results distinguish confirmed cleanup from requested/unconfirmed cleanup and external effects.
Unconfirmed operations remain visible after restart and retry only their original unfinished scope.
An unfinished member-pause reservation restores the real pause authority before inbox recovery;
a completed pause never overrides a later explicit resume.
Read/search/preview cannot execute a model, resend a reply, or mutate real work.

## The rebuilt page

2026-11-12 (INV-1825). Two pages serve one installation until the rebuilt one covers the classic
one: `/?ui=next` and `/?ui=classic` choose, the choice is remembered, and both read the same data.
Everything above this section describes the classic page; this section is the rule for the rebuilt
one. [docs/99](99-user-work.md) §6 owns *what* a person is shown; this owns how the page is laid out.

**The main line is a person's conversation with a named agent.** People remember whom they asked.
The page opens on the computers, the agents on the one selected, and the conversation with one of
them. That agent's unfinished work is pinned at the top of its conversation, and a result it
delivered is a card at the end of it, decided there. What cuts across
agents — everything that needs the person, all work — is one click away in the side column and is
never the landing. A first slice that opened on an inbox and a work list was wrong, and was seen to
be wrong on real data within the day.

**Nothing is lost by using it.** A link to one piece of work (`?task=`), to an agent's conversation
(`?agent=&conversation=`), opens there. A template link (`?import=`) opens the classic page, whose
dialog it is. The foot of the side column switches language and goes back to the classic page; the
work panel's full record is the classic task view for one look (`&once=1`), which does not change
the page the person chose. What the classic page still does and this one does not is listed on
INV-1825, and the default changes only when that list is empty or bridged.

**Automations are made and read here.** One row each: its name, what it does, when it next runs.
A press on the row shows how its recent runs ended; a routine is made by answering four things — a
name, what to do, who does it, what starts it — and can be run at once.
**A whole conversation has one quiet control.** In the header: find something said in it (only
what was said, never a step), take it away as Markdown, copy a link to it.

**A decision is finished where it is shown.** A draft waiting to be sent is approved, edited or
refused (with the reason the agent is told) on its inbox row; work is put off and found by its words
from the work view and its panel; something that went wrong is retried, taken on or dismissed from
the system view.

**The composer offers two things, when asked.** "/" opening a message lists the skills, and a
choice becomes the instruction to use it; "@" at a word lists the agents on this computer. Nothing
shows until one of the two is typed.
**The agent's desktop can be taken in hand.** Under its screen: take over (the box is told first, so
the agent's next write is refused rather than typed into the person's hands) and hand back, which is
when it learns from what was shown; record the desktop; send text to its clipboard and fetch what it
holds.

**Usage is a report, opened from the system view.** By day, by agent, by model and by piece of
work, tokens printed whole. Money appears only when every model in the window has a rate, and a
total that is only a floor says so.

**An agent's page holds its whole configuration.** Name, role and persona first; in folds, read when
opened: the model it runs on and the teams it is in, the files it reads every turn (one shown at a
time, saved on its own), and every saved version of its configuration, any of which can be gone back
to. Each tool is allowed, asked about first, or off, by group; a floor the organisation set shows as
the choice that is missing. The agent can be asked to draft a template of itself, which a person
downloads, publishes or takes down.

**A new agent starts with a name; the catalogue is one press away.** Under the blank form, folded:
the ready-made templates, the ones made here, the roles and crews, found by typing, each created on
the selected computer with one press; and a template somebody sent, as a file or pasted.

**Teams narrow the agent list, when there are any.** A team is a tag agents carry. With none, there
is no control; with some, one choice above the list shows a team, the agents in none, or everyone,
and is remembered; an admin renames a team for everybody in it. The conversation picker reads
thirty conversations at a time and offers the earlier ones.

**The work panel holds the uncommon things too, folded.** What a piece of work waits on and what
waits on it, each a press away; a fold to set its status, its level and what it waits on by hand,
and to propose what it found as the organisation's knowledge; and, under diagnostics, what the
policy gate decided at each step.

**What has been happening is in the system view, folded.** The agents' recent activity, a line each;
and, for an admin, the audit record of commands and windows on a computer, which keeps reading while
it is open, hides what the system's own probes ran unless asked, and says when the record may be
incomplete.

**An admin manages everything that runs from one fold.** In the system view: what is executing,
what is set to start, what ended, and the agents, with stop, pause, disable and discard. A press
does nothing by itself: the server says what the action covers and what it cannot know, in words,
and the second press does it once.

**What an agent learned from being shown is reviewed before it is used.** A fold in the system view
lists its drafts: the skill it wrote, its question if it has one (an answer makes a new draft), a
trial on its own cases where it carries an operation, then publish or refuse; a published skill's
versions can be gone back to.

**A file is looked at where it is listed.** In the screen pane's files, a press shows a picture or a
text file in place, with the way to open it in a tab or download it; a kind that cannot be shown
says so.

**Settings open pane by pane, in place.** Every pane is the rebuilt page's own and opens inside the
settings view with a way back: the model (provider, key, model, pictures, summaries, web search, the
providers to fall back to, the accounts resting, the rules every agent is given, the small model
that makes judgements); the computers (this box's image and updating it, its CPU ceiling, starting
it over, commands on the person's own machine, attaching another computer, quotas, nodes, what the
host process uses); the doors (chat channels, the people waiting to be let in, connected services);
the team (people and roles, invitations, scopes, the secrets lent to agents, each agent's ceilings,
team memory waiting for a person, outside tool servers); what is a person's own (what the agents
know about them, their tokens, their standing approvals); memory (each agent's lines, corrected or
withdrawn, what waits to become the organisation's knowledge and what it already holds);
supervision (the watchdog, the supervising model, its runs); and guests. In the desktop app two more
are listed, asked of the app's shell rather than of a server: what this machine is for, and the
organisations it is connected to; the column of installations at the window's edge is the same
module the classic page uses. A key or a secret is typed, saved and never shown again; a token or
an invitation is shown once.

**What a person typed survives a redraw.** The view is rebuilt whenever something changes. A field
the person touched is found again by its label and given its value, caret and focus back, and a fold
they opened stays open, until the view changes or a save goes through.

**Three levels, everywhere.**

| Level | Where | Holds |
|---|---|---|
| Default | The thread, a row, a pin | What was said; one state word and one sentence of reason |
| Detail | A fold opened in place, the work panel's overview, the screen pane, an agent's page | The agent's steps, the plan, the result, progress with where each number came from, its screen and files |
| Diagnostics | The work panel's second tab | Raw step input and output, usage, identifiers, export |

A default surface carries nothing from the third level and offers the second by a single control.
Measured on the fixture, the classic first screen had 56 controls; the rebuilt conversation has 18.
A new control on a default surface has to be something a person decides or needs to find.

**What an agent asks is answered where it asked.** A question, a consent, a secret, a desktop handed
over, a card it drew: each is a card in that agent's conversation, and a question or an approval is
also a row in the inbox with its buttons on the row. Nothing that passed between agents is shown as
a message: it is one folded line.

**A read that failed is not an empty answer.** A list that could not be read says so. "Nothing went
wrong" is only said when the server said it.

**Files.** One module per surface under `src/web/next-*-ui.ts`, each exporting its script as a string;
`next-logic-ui.ts` holds the few decisions the page makes, as plain functions shipped as their own
source so the test runs what the page runs. Every word comes from `src/i18n/ui-next.ts`. Nothing of the classic
page is framed: a surface is built here or it is not here.

**Checking.** `next-page-ui.test.ts` fills the page in both languages, parses every inline script, and
checks that every looked-up id exists; a function with a regular expression or a wire format in it is
run from the page's own source. Before a change to the page ships, it is looked at in a browser on an
isolated fixture, wide and narrow, light and dark. `scripts/ui-next-layout.mjs` (part of
`npm run test:layout`, so of CI) holds the geometry in both languages at both widths: nothing wider
than the window, the result card and the composer in their column, card buttons not overlapping or
cut, the work panel on screen, a way back on a narrow screen.
