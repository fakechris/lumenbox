<!-- doc: 103-acceptance-stories
     title: Acceptance stories: the user-goal checks a release is walked through
     family: guide
     status: current
     updated: 2026-11-24
-->
# Acceptance stories: the user-goal checks a release is walked through

`npm test` proves the parts hold; docs/86 proves a new person can install the published
artifact. Neither proves that a person with a goal reaches it. The stories here are the ones
the 0.4.7 acceptance passes (personal A1–A8, organisation B1–B7, and the UX audit) walked by
hand, kept because each one found something no test had. They are rerun on a release
candidate, on synthetic data, by somebody who did not build the feature.

What a run produces — recordings, screenshots, the results table — stays outside the
repository. What it finds becomes an issue; what an issue fixes becomes a test (the
**Automated** line of each story names the ones that exist), and a conduct failure becomes a
scenario (docs/43).

## How a story is walked

1. **Goal and role only.** The tester gets "I want a summary of this page I can check", not
   the menu path. Look first, then the manual; mark a story finished only after reading the
   manual "with the manual".
2. **Count by goal.** Every pointer activation counts one (menus, retries, misses), keyboard
   actions are counted apart, and so is every moment of "where am I / where did my chat, task
   or box go" — with the words thought and how many steps it took to get back.
3. **Every screen, every state.** Empty, loading, error, signed out and offline are part of the
   story, not extras: each one says what happened and offers the next step. An expired login
   leads to Sign in, never only to Retry or a raw JSON body.
4. **Narrow too.** Each surface the story touches is opened once at 390 CSS px: nothing the step
   needs is truncated or off screen.
5. **Evidence apart from verdict.** Each story ends Pass, Fail, Blocked, Not covered or
   Spec unclear, with time, action count and the evidence. A recording with a failed step is
   not a pass.
6. **Severity by what a person can do:** P1 cannot finish, or sees someone else's data, or
   loses data; P2 finishes only by asking an admin, redoing, or getting lost repeatedly; P3
   finishes with extra steps; P4 wording and spacing.

**Isolation.** A fresh `HOME` and `AGENTBOX_HOME` (or a fresh macOS account), a dedicated
Docker engine, a throwaway kind cluster for track B (`kubectl config current-context` checked
before every apply). Never an existing installation, box or volume. Keys come from the
environment and are never typed into a recording, a file or a result. Fixtures are synthetic:
`https://example.com` ("Example Domain"), the tags `LB-PERSONAL-47`, `ORG-SHARED-47`,
`ALICE-ONLY-47`, `BOB-ONLY-47`.

**Models.** Each story's first step is Settings → Model → Test the connection, then a short
real turn, recording which model actually answered. A provider failure (401/403/404/400,
quota) is recorded as itself; silently switching provider to get a green light is not a pass.

## Track A: one person, their own machine

### A1 · Install, choose the machine, connect a model
Goal: from download to an assistant that can work. Open the app (recover from Gatekeeper from
what the screen says), choose Personal machine, find the first-run card again later, set the
model, start the box, wait out a cold image.
**Pass when** each credential or Docker failure names its cause and next step, a cold pull is
told apart from a failure, and the default model of each preset passes Test the connection.
**Found here:** the OpenAI preset's own models failed with HTTP 400 on `max_tokens`.
**Automated:** `src/host/openai-wire.test.ts`, `src/web/model-settings.test.ts`,
`src/web/setup-connectivity.test.ts`; the install itself is docs/86.

### A2 · A first deliverable, not a greeting
Goal: a two-point summary of example.com, as a downloadable file with the page title and URL.
**Pass when** the file downloads, the task, its evidence and the file belong to the same
request, and no surface says the task failed while its deliverable is there.
**Found here:** "Tasks update failed" beside a good deliverable; the new view names the place
All work, not Tasks → Deliverables.
**Automated:** `src/web/task-export.test.ts`, `src/web/task-focus.test.ts`.

### A3 · I take over the screen
Goal: check the browser myself without fighting the agent. Desktop → Take over, browse, ask
the agent to act meanwhile, hand back.
**Pass when** "You are driving" and Hand it back are visible, the agent's input is refused
while the person drives (`USER_IN_CONTROL`) and says so in the chat, control returns to the
named member without a reload, and the instructions fit at 390 px.
**Found here:** the driving instructions truncated at 400 px.
**Automated:** `src/boxd/display-ownership.test.ts`, `src/host/tools.test.ts`.

### A4 · Two agents on one box
Goal: a brief with an independent second check. The coordinator asks another member to open
the page itself and review.
**Pass when** the second identity, desktop and output are distinct and the review really
happened; the person can get back to the first chat from the other member's record.
**Automated:** `src/host/scenario.test.ts` (delegation episodes).

### A5 · Send it back, then accept
Goal: accept only what can be checked. Open the task from the chat, from Team tasks and from
All work; send it back with a reason; accept the revision.
**Pass when** it is one task in every place, sending back produces a revision, accepting ends
in a done state, and an accepted task is still findable.
**Found here:** revisions came back but the task could not reach an accepted state.

### A6 · Make it a skill, a memory and a routine
Goal: stop explaining the format each time. `/` inserts a skill without running it; save the
flow as a skill draft; keep a memory; schedule it; Run now.
**Pass when** draft, enabled skill, memory and routine are told apart, the schedule shows its
time zone and member, and Run now produces a real turn with its own duration and tokens.
**Found here:** Run now and a due run showed Done with 0 s, 0 tokens and no turn.
**Automated:** `src/host/routine-start.test.ts`, `src/host/schedule.test.ts`,
`src/web/automations.test.ts` (INV-2153).

### A7 · The same assistant from Feishu or DingTalk
Goal: reach the member from a test chat. Add the channel, bind the member, group rule "only
when addressed".
**Pass when** a plain group message and a mention get different results, the app's channel
status matches the platform's, and a silent bot can be told apart as unbound, disconnected or
folded into a thread.
**Automated:** `src/channels/*-contract.test.ts`, `src/channels/manager.test.ts`.

### A8 · Restart, and upgrade from the previous release
Goal: no reconfiguration. Quit and reopen the app (closing the window is not a restart),
restart the Docker engine, then upgrade a previous-release installation with `agentbox backup`
taken first.
**Pass when** chats, tasks, files, memories and model settings survive both, and the person
can tell whether the app, the box or both were updated.
**Automated:** `src/box/box-update.test.ts`, `src/host/upgrade.test.ts`.

### Across track A (the UX audit)
Each of these is a check on every release, because each was a real loss:
- a draft typed for one agent is not sent to the next one picked (INV-2106);
- a send that failed offline does not look sent or working (INV-2107);
- a rejected model key says why and links to the fix, not only "Stuck" (INV-2108);
- a reset confirmation says in full what is kept and what must be redone (INV-2109);
- copyable values (the OAuth callback URL) are shown whole (INV-2110);
- an offline computer is in one state, not "starting" and "unable to start" at once (INV-2111);
- a form whose target is unavailable says so before it is filled in (INV-2112).

**Automated:** `src/web/next-page-ui.test.ts` (2106–2108). The rest are checked by hand.

## Track B: three people, one Organisation Server

One organisation, three browser profiles (admin, Alice as driver, Bob as viewer then driver),
personal boxes on Kubernetes beside the shared box.

### B1 · Install the server, found the organisation, invite, set quotas
**Pass when** the Kubernetes server's log and pages speak of Kubernetes (no Docker advice),
the provider whose key exists is offered, the bootstrap page says where the code is and how
to get past "configure a channel first", and each invite reaches its person.
**Automated:** `src/web/personal-boxes.test.ts`, `src/web/sign-in.test.ts`.

### B2 · Alice signs in and finishes a private brief
**Pass when** Alice finds Create personal box in the view she lands in, sees why it is
disabled at quota, gets a box with a readable name that the server can reach, and is offered
no installation-wide settings a driver may not change.

### B3 · Bob reviews, then becomes a driver
**Pass when** a viewer is told before typing that viewers watch, not drive (the server's 403
reaches the screen), finished work appears without a reload, and promotion is announced.
**Automated:** `src/web/roles.test.ts`.

### B4 · Private stays private, shared is shared
**Pass when** neither private box, task, memory or activity is visible to the other person or
the admin's lists, a shared task an agent promises to share appears on the other person's
board, and a reload keeps the box the person was in.

### B5 · The admin finds a problem and a limit
**Pass when** every personal box appears on the admin's Computers page with owner, state and
age, a full cluster quota is named as the reason a box did not start, and quota and holding
are shown beside the person.
**Automated:** `src/web/personal-boxes.test.ts`.

### B6 · Remove Bob without interrupting Alice
**Pass when** removal is confirmed and undoable for one's own row, it takes effect on Bob's
open tab at once while Alice's agent keeps working, Bob sees "you no longer have access",
not raw JSON, and his personal box is kept, transferred or deleted by a stated choice.
**Automated:** `src/web/personal-boxes.test.ts`.

### B7 · Restart and update the cluster
**Pass when** a rollout restart keeps everybody signed in (a stable UI token), the token is
never printed in a log, and boxes, people and tasks survive; an image update is told apart
for existing and new boxes.

## Keeping this page true

A story leaves this page only when the product no longer has the goal. A story whose
**Found here** is fixed keeps the check and gains an **Automated** entry; one that is still
open says so in its issue, not here.
