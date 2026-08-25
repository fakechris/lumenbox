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

**R2 — Deploy a version tag, never `:latest`.** `:latest` is overwritten in place, which
means there is nothing to roll back to. Build `agentbox/box:<version>`, move `:latest` to
point at it if you like, but recreate against the version tag so the previous one is still
on disk when the new one turns out to be wrong.

**R3 — Refuse to run on a version mismatch.** boxd and the orchestrator are separate
binaries speaking a private HTTP protocol, and they are upgraded independently. Today
`health()` returns a version and **nothing compares it**, so a box running ahead of its
host is undefined behaviour that presents as unrelated failures. A handshake that refuses
loudly is worth more than any amount of care during the upgrade itself.

**R4 — Back up the volumes, not just the host state.** The existing backup covers
`~/.agentbox` on the reasoning that the box is disposable and its work directory is on a
volume. That is true of `docker rm` and false of `docker volume rm`, a bad migration, and
a disk. The config volume is not scratch either — it is where people's logged-in browser
sessions live, and on a working box it is the larger of the two.

**R5 — Say what is about to be lost.** The prompt tells agents to put durable work under
`/home/box/work`, and an agent that wrote a report to its home directory did not read that
sentence. Before recreating, list files modified recently outside the two volumes. This is
the difference between silent loss and a warning somebody can act on.

**R6 — Nobody's box is upgraded without them being told.** A box serves more than one
person once a channel is bound to it. Upgrading closes their tabs and interrupts whatever
they were watching. Upgrading is an admin action — the same tier that owns the provider,
the roster and the channels — and the people connected get told before, not after.

**R7 — Verify after, and roll back on failure.** A health check is necessary and not
sufficient: boxd answering says nothing about whether the desktop came up or the browser
can be driven. Do one real action — a snapshot of a known page is a good one, since it
exercises the display, the browser, and the debugging port together — and if it fails,
recreate against the previous version tag.

**R8 — Re-seeding overwrites image-owned config.** The entrypoint copies the image's
desktop launchers and file-manager settings over the config volume on every start, so a
fix shipped in the image actually arrives. The other side of that: a person's changes to
those specific files are reverted silently. Everything else in the volume, browser profiles
included, is deliberately left alone.

## 4. What is missing before this is safe unattended

Ordered by (risk × impact) ÷ effort, the same lens as the roadmap.

1. **A version handshake (R3).** Small, and the only item here that turns a class of
   confusing failures into one clear message. Nothing exists today.
2. **A preflight check (R1, R5).** Refuse on running jobs; list stray files outside the
   volumes. Turns two kinds of silent loss into a refusal and a warning.
3. **Version-tagged images (R2).** Mostly a build and release convention, but there is no
   rollback at all without it.
4. **Volume backup (R4).** Extend the existing backup to snapshot the two box volumes.
5. **Notice and consent (R6).** Depends on the channel adapters already being able to
   reach the people bound to a box, which they can.

Until 1 and 2 exist, an upgrade is an attended operation: a person runs it, watches it, and
has the previous image still on disk.
