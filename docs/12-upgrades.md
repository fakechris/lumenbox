<!-- doc: 12-upgrades
     title: Upgrading somebody's box
     family: guide
     status: current
     updated: 2026-11-02
-->
# Upgrading somebody's box

An upgrade here is not a package update. The image is rebuilt and the container is
**destroyed and recreated** — that is what `box up --recreate` does, and it is the only
path that actually delivers a new image. Everything in the container that is not on a
volume goes with it.

This is the right design: the system layer stays disposable on purpose, so a rebuilt image
really does deliver a fresh box rather than a box with a decade of drift in it. The cost
is that upgrading is a destructive operation, and it has to be treated as one.

## 1. What survives, verified

Three named volumes, which survive `docker rm` and the image being replaced:

| Volume | Mount | What is in it |
| --- | --- | --- |
| `<box>-work` | `/home/box/work` | What the agents made |
| `<box>-config` | `/home/box/.config` | **Browser profiles and logins** |
| `<box>-hostd` | `/home/hostd/.agentbox` | Orchestrator state, `--with-host` only |

Host-side state — `~/.agentbox` on the operator's machine: transcripts, agent profiles,
principals, policy log, scopes — is not in the container at all and is untouched by any of
this. It has its own backup (`src/host/backup.ts`).

The UI token is persisted at `~/.agentbox/ui-token` so a recreate does not invalidate a
tab somebody has open. **The published boxd port is not persisted** — Docker assigns a new
one each time, so nothing may hold that URL across an upgrade.

Everything else goes: running background jobs, shell working directories, open browser
tabs, and any file an agent wrote outside `work` and `.config`.

## 2. Two commands that look alike and are not

- `box down` then `box up` — `docker stop` then `docker start` on **the same container**.
  Processes die; the filesystem survives; **the image does not change**. This is a restart,
  not an upgrade, and mistaking it for one is easy: it reports success and delivers the old
  image.
- `box up --recreate` (or `box down --rm` then `box up`) — the container is destroyed and
  rebuilt from the current image. This is the upgrade.

## 3. Rules

**R1 — Never upgrade with work in flight.** Check `/jobs` for running jobs and the
orchestrator for turns in progress. A background job is killed with no record beyond its
log file, and a turn interrupted mid-way leaves a ledger entry that will be retried against
a box that is no longer the one it started on. Drain first, or refuse and say what is
running.

**R2 — Never leave yourself without the image you replaced.** `docker build -t …:latest`
overwrites the tag in place, and the image it replaced survives only as an untagged layer
until the next `docker image prune` — which is to say until the moment somebody is tidying
up because something is wrong. `npm run build:image` writes four tags: a content hash
naming what was built, `fakechris/lumenbox:<package version>` (the tag a release pulls),
`:latest`, and `:previous` moved to whatever `:latest` used to be. The hash stays because
the image changes on every edit to a Dockerfile or a bundled daemon, not only when the
package version does.

**R3 — Refuse to run on a version mismatch.** boxd and the orchestrator are separate
binaries speaking a private HTTP protocol, and they are upgraded independently. `BOXD_PROTOCOL`
is compared when the host connects and a mismatch is refused, naming which half is behind.
Before that existed, `health()` returned a version hardcoded to `"0.1.0"` that nothing
compared, and a box running behind its host presented as unrelated failures in whichever
route had moved.

**R4 — An update does not touch the volumes; a backup is on request.** Recreating replaces
the container and leaves `work` and `.config` where they are, so an update copies nothing by
default (2026-11-02: the copy of a working box's browser profiles took minutes and protected
against a step that does not touch them). `--backup` on the CLI, or *back up the box's files
first* in Settings, copies both volumes into a dated directory under `~/.agentbox/backups`
first and stops if the copy fails. What the volumes are not safe from is the rest: the host-side backup
covers `~/.agentbox` on the reasoning that the box is disposable and its work is on a
volume; that is true of `docker rm` and false of `docker volume rm`, a bad migration, and
a disk. The config volume is not scratch either — it holds people's logged-in browser
sessions, and on a working box it is by far the larger of the two.

**R5 — Say what is about to be lost.** The prompt tells agents to put durable work under
`/home/box/work`, and an agent that wrote a report to its home directory did not read that
sentence. `box up --recreate` lists files the box wrote outside the two volumes and
refuses unless `--yes` is given. "Wrote" is measured against `/etc/lumenbox/sealed`, which
the Dockerfile touches as its last step, so nothing the image shipped can be listed; an
image older than the seal falls back to "changed in the last 30 days". Pruning matters as much as finding: the first version also
listed the image's own files and the desktop launchers, and the two files that actually
mattered were lost in the middle of it.

**R6 — Nobody's box is upgraded without them being told.** A box serves more than one
person once a channel is bound to it. Upgrading closes their tabs and interrupts whatever
they were watching. Upgrading is an admin action — the same tier that owns the provider,
the roster and the channels — and the people connected get told before, not after.

**R7 — Verify after, and roll back on failure.** A health check is necessary and nowhere
near sufficient, and this is not theoretical: an image whose `box-chrome` pointed at a
nonexistent binary still printed `box ready: display :1` and still passed health. So
`box up --recreate` opens a known page and checks it rendered, which exercises the desktop,
the browser and the debugging port together, and recreates from the image the box ran before —
by its image id, read before the update, not by a tag that a later build may have moved —
when it does not. The page is a `data:` URL, not a website — a verification that reaches the network
turns every passing blip into a rollback, which is a more destructive failure than the one
it guards against. `agentbox box rollback` does the same by hand, for a box that breaks
later rather than during an upgrade.

**R8 — Re-seeding overwrites image-owned config.** The entrypoint copies the image's
desktop launchers and file-manager settings over the config volume on every start, so a
fix shipped in the image actually arrives. The other side of that: a person's changes to
those specific files are reverted silently. Everything else in the volume, browser profiles
included, is deliberately left alone.

## 4. The flow: who is asked, and when nobody is

### There is no owner, and there should not be one

The roster has three roles — `viewer`, `driver`, `admin` — and no notion of an owner.
That is the right shape and worth keeping. An owner is a single point of absence: they go
on holiday, change phone, leave the company, and the box can no longer be upgraded by
anybody. Authority to upgrade belongs to the **admin** tier, the same tier that already
owns the provider, the roster and the channel bindings.

Where "which admin" needs an answer, the answer is **all of them, first reply wins**.
Asking one nominated admin reintroduces the single point of absence; asking all of them
and requiring consensus reintroduces it once for each of them. A notice goes to every
admin, whoever answers first decides, and the others are told what was decided and by
whom.

### The decision is about cost, not preference

Neither "always unattended" nor "always ask" is right, and choosing between them globally
is the wrong axis. What decides is what the upgrade costs *at that moment*:

| Situation | What happens |
| --- | --- |
| Preflight quiet, nobody connected, no protocol change | Upgrade unattended, report afterwards |
| Preflight quiet, but people are connected and watching | Announce, short countdown, anyone may postpone |
| Preflight found running jobs or stray files | Ask an admin, with the findings; never automatic |
| Protocol version changes | Ask an admin; a client may need upgrading with it |
| The box is already refusing to serve (failed handshake, broken desktop) | Upgrade is the repair; proceed and say so |

The last row is why `preflight` never throws: a box too broken to inspect is often a box
somebody is upgrading in order to fix, and a check that blocks the repair is worse than no
check.

The principle is the one the approval gate already uses: act when it costs nobody
anything, ask when a person would want to have been asked.

### Quiet hours

"Convenient" is a local-time question, and the scheduler already expresses that — digests
are configured as an hour in each chat's own local time. An upgrade window is the same
shape: a preferred hour, per installation, with the upgrade waiting for it unless the box
is already failing. A box that has been waiting for its window for a week should say so
rather than waiting forever.

### The sequence

1. **Notice** a new image is available.
2. **Preflight** — running jobs, stray files, whether the box answers at all.
3. **Decide** — the table above.
4. **Announce** to whoever is connected, with a way to postpone.
5. **Back up** the volumes. This is the last reversible moment.
6. **Recreate** against a version tag, not `:latest`.
7. **Verify** — health, then one real action. A snapshot of a known page is the right one:
   it exercises the display, the browser and the debugging port together, where a health
   check exercises only boxd.
8. **Roll back** to the previous tag if verification fails.
9. **Report** what was lost — jobs killed, tabs closed — to the people who were told in
   step 4, and to whoever decided in step 3.

Step 5 is optional (R4). Steps 2, 5, 6, 7 and 8 are one function, `applyUpdate` in
`src/box/box-update.ts`, which `box up --recreate`, `box upgrade` and Settings → Boxes all
run; `src/box/preflight.ts` holds the check before and the verification after. Steps 1 and 4
are the web server's ten-minute check. Step 9 — reporting what
was lost, afterwards, to the people who were told — is still design.

Step 3, **deciding**, is split across the two halves on purpose, and the split is the
interesting part. `decideUpgrade` decides everything that can be decided from the
situation. What it cannot decide is whether a person accepts losing what the preflight
found, so it answers `ask` — and the answer comes back through `upgrade-consent.ts`:

- The server's timer holds what it just asked about (the image, and a fingerprint of the
  findings the person is reading).
- An admin replying `upgrade` in the chat writes a consent record naming both.
- The next `agentbox box upgrade` matches its own situation against that record and passes
  `approved` to `decideUpgrade`, which then stops asking.

A consent is deliberately narrow. It names one image, because approving 0.31 says nothing
about 0.32; it names what the person was shown would be lost, so a day's work that appeared
since invalidates it rather than riding along on yesterday's yes; and it goes stale after a
day. It also authorises only the *loss* — the rules about interrupting connected people and
about the quiet window still run underneath, because nobody spoke to those.

`agentbox box upgrade` still decides this way. The app's own path (§6) is simpler: the
person who presses *Apply update*, or replies `upgrade`, has decided.

## 5. What is missing before this is safe unattended

Ordered by (risk × impact) ÷ effort, the same lens as the roadmap.

All eight rules are implemented.

- `npm run build:image` builds and keeps the image it replaced as `:previous`.
- `agentbox box upgrade` is the whole sequence, and is safe to put on a timer: it notices
  whether a new image exists, inspects the box, decides, and either upgrades or explains
  what it is waiting for. It backs up both volumes before the destructive step, verifies
  the box that came back, and rolls back if it does not work.
- `agentbox box up --recreate` is the same destructive step without the deciding, for when
  a person has already decided.
- `agentbox box rollback` goes back a version by hand.
- The web server notices an available update and tells every admin, once per image. Since
  INV-1538 it also performs one, when an admin asks (§6). The earlier ruling — the server
  never recreates the box — was there to keep one copy of the destructive sequence, the one
  with the rollback in it. That copy is now a function both sides call, so the reason is
  kept and the restriction is not.
- Anything the notice offers must be wired before it is offered. The first version ended
  `Reply "upgrade" to go ahead` with no handler for the word anywhere. Replying was answered
  by silence, somebody reasonably concluded the bot could act on the box, and the next
  message in the chat asked the agent to back up the four files the notice had listed —
  which were the image's own reference docs, which an upgrade recreates verbatim
  (2026-09-15). `UPGRADE_WORD` is named once and a test asserts the channel manager parses
  it, so the message and the handler cannot drift apart again.

### Where the judgement lives

`decideUpgrade` in `src/host/upgrade.ts` is a pure function of the situation, separate from
everything that performs an upgrade. That separation is the point: the interesting cases
are a half-broken box with two people watching at three in the morning, and those cannot be
arranged in a test any other way.

Its rule order matters. Safety is decided before convenience — a broken box is not repaired
by waiting for 4am, and work that would be destroyed is not made expendable by everyone
being asleep.

### What is left

Postponing is a design, not code: the announcement says to reply "wait", and nothing yet
listens for it. `ANNOUNCE_MINUTES` is likewise a number nothing counts down. Both belong
with the multi-person work, because both are really questions about how a bot holds a
conversation with a room rather than with a person.

## 6. The product path: Settings → Boxes → Apply update (INV-1538)

The box is updated the way an app is, not by a procedure an operator runs. The image is the
app's, the person's data is on volumes, and an update swaps the first under the second:

| Kept | Replaced |
| --- | --- |
| `work` volume — what agents made | the container and everything outside the volumes |
| `.config` volume — browser logins | the image: `fakechris/lumenbox:<app version>` |
| `~/.agentbox` on the host — chats, team, memory | |

- **Noticing.** Every ten minutes the server compares the box's image with the one this app
  expects — the reference and the image id, so a rebuilt image under the same tag counts.
  When they differ, admins get one message per image and an item on the "needs you" list.
- **Applying.** Settings → Boxes shows both images and *Apply update*. By default it waits for
  turns and background jobs to finish (up to two hours; the page says what it is waiting
  for), pulls the image if it is not on this machine, recreates, checks the box drives a
  browser, and goes back to the previous image id if it does not. The progress shows on the
  page. Replying `upgrade` in a chat does the same thing.
- **No backup by default** (R4); one checkbox asks for it.
- **Reset is a separate act.** *Reset the box…* deletes the container and the `work` and
  `.config` volumes and starts a new box. That loses what agents made and every login, so
  the request has to name the box. An update never does this.

Verified 2026-11-02 on a throwaway box: an update from 0.3.10 to an image built from this
branch waited 30 s for a 20 s job, kept a file in `work` and one in `.config`, and dropped a
file written in the home directory. The pre-check on the new image listed only a file the box
wrote. An update to an image with the browser removed failed verification and came back on
the previous image id, with `work` intact.
