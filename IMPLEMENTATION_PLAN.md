# Implementation plan — ShowUI (INV-1269, docs/79)

Branch `feat/inv-1269-showui`, worktree `agentbox-showui`. Each stage ships green on its own
(`npm run check`). The previous plan (2026-09-02 delta) is complete; see docs/11 for its record.

## Stage 1: Host — tool, catalog, validation, ledger
**Goal**: `ShowUI` exists; the host validates input against the lumenbox A2UI catalog with the
real `MessageProcessor`; a `SurfaceLedger` keeps the latest message list per surface; the
`showUI` context hook is wired like `askUser`.
**Success Criteria**: `src/host/show-ui.test.ts` — catalog-outside component rejected with the
reason; unknown property rejected; dangling child rejected; first call yields
createSurface+updateComponents, second call only updateComponents, close yields deleteSurface;
ledger latest-line-wins and `closed` drops the surface. ShowUI listed in PERSON_FACING_TOOLS,
DESK_TOOLS, ALL_TOOLS, TEMPLATE_SETUP_TOOLS, side-effects, activity phrase. `npm run check` green.
**Status**: Complete (2026-10-19)

## Stage 2: Web — vendor bundle, surface item, replay, action
**Goal**: `vendor/a2ui.js` built by `scripts/build-vendor.mjs` and served at `/vendor/a2ui.js`;
the page shows a `surface` item via `<a2ui-surface>`, updates it in place on a second event,
replays it from the transcript, and posts actions as `[Action "name" on card id: {...}]`.
**Success Criteria**: `app-html.test.ts` covers the surface item markup and update path;
`transcript.test.ts` covers ShowUI tool_use → `surface` on the display tool; vendor route test;
`npm run check` green; manual: a card renders in the running web (main checkout, ask first).
**Status**: Complete (2026-10-19) — verified in a real browser on a static harness: the bundle loads, ten components, a TextField + ChoicePicker + Button card renders, and the press yields `[Action "pick" on card plan: {"plan":["b"],"name":"Chris"}]`; the running web is still to be checked at Stage 4.

## Stage 3: Channels — Feishu card, text fallback, action callback
**Goal**: Feishu adapter translates the catalog subset to an interactive card; button press comes
back as the action message; DingTalk/Telegram get the text rendering; the manager routes via a
`/act` continuation; restart redraws from the ledger are not required (post-once, like questions).
**Success Criteria**: `feishu.test.ts` fixture for a Text+Button+ChoicePicker surface; callback
test yields the action text; `manager.test.ts` `/act` parsing; `strings`/i18n entries; green.
**Status**: Not Started

## Stage 4: Scenario, prompt, docs, live check
**Goal**: scenario harness stub `ShowUI:delivered`, a scenario test fake-engine → ShowUI → action
→ next turn sees it; conduct text says when to use ShowUI instead of Markdown; docs/79 and
INDEX final; NOTICE entry; `release:check`; one real-box run (web click + Feishu click) in a
handoff note.
**Success Criteria**: all of the above; INV-1269 acceptance items 1–5 ticked with evidence.
**Status**: Not Started
