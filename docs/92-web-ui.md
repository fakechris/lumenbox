<!-- doc: 92-web-ui
     title: The web UI's visual rules: type, spacing, components
     family: spec
     status: current
     domain: web-ui
     updated: 2026-11-11
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
