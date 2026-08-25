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
up because something is wrong. `npm run build:image` writes three tags: a content tag
naming what was built, `:latest`, and `:previous` moved to whatever `:latest` used to be.
The content tag is a hash of the build directory rather than the package version, because
the version changes on release and the image changes on every edit to a Dockerfile or a
bundled daemon.

**R3 — Refuse to run on a version mismatch.** boxd and the orchestrator are separate
binaries speaking a private HTTP protocol, and they are upgraded independently. `BOXD_PROTOCOL`
is compared when the host connects and a mismatch is refused, naming which half is behind.
Before that existed, `health()` returned a version hardcoded to `"0.1.0"` that nothing
compared, and a box running behind its host presented as unrelated failures in whichever
route had moved.

**R4 — Back up the volumes, not just the host state.** `box up --recreate` copies both
box volumes into a dated directory under the backup root before it destroys anything, and
stops if the copy fails — the next step is the irreversible one. The host-side backup
covers `~/.agentbox` on the reasoning that the box is disposable and its work is on a
volume; that is true of `docker rm` and false of `docker volume rm`, a bad migration, and
a disk. The config volume is not scratch either — it holds people's logged-in browser
sessions, and on a working box it is by far the larger of the two.

**R5 — Say what is about to be lost.** The prompt tells agents to put durable work under
`/home/box/work`, and an agent that wrote a report to its home directory did not read that
sentence. `box up --recreate` lists recently-changed files outside the two volumes and
refuses unless `--yes` is given. Pruning matters as much as finding: the first version also
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
the browser and the debugging port together, and recreates from `:previous` when it does
not. The page is a `data:` URL, not a website — a verification that reaches the network
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

Steps 2, 5, 6, 7 and 8 exist in code and run on `box up --recreate`:
`src/box/preflight.ts` for the check before and the verification after,
`BoxManager.backupVolumes` for the copy, `scripts/build-image.mjs` for the tags that make
step 8 possible. Steps 1, 3, 4 and 9 — noticing, deciding, announcing and reporting — are
design, and are what the multi-person work will need to supply.

## 5. What is missing before this is safe unattended

Ordered by (risk × impact) ÷ effort, the same lens as the roadmap.

All eight rules are implemented for the operator-driven path. `npm run build:image`
followed by `agentbox box up --recreate` refuses if anything would be lost, backs up both
volumes, upgrades, checks the box that came back, and puts the previous image back if it
does not work.

What is left is the part that involves other people rather than the machine:

1. **Notice and consent (R6).** The channel adapters can already reach the people bound to
   a box, so this is a matter of deciding the wording, the countdown, and how postponing
   works — not of new plumbing.
2. **A quiet-hours window.** Follows the digest scheduling that already exists.
3. **Noticing that a new image exists at all** (step 1 of the sequence). Today a person
   decides to upgrade; nothing offers.

So an upgrade is still **initiated** by a person, and is now safe to *complete* without
one watching: the destructive step refuses when it would destroy something, the data is
copied first, and a broken image undoes itself.
