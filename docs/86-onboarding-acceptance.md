<!-- doc: 86-onboarding-acceptance
     title: Onboarding acceptance: a new user's first run on the published release
     family: guide
     status: current
     updated: 2026-10-31
-->
# Onboarding acceptance: a new user's first run on the published release

Releases have broken for new people on the first run, where no suite looked: installers
without their dependencies (0.3.0), an app published before its image tag, an image with no
engines (0.3.7). `release:check` sees the artifacts and the smoke test sees the image; neither
sees a person download the DMG, open it, type a key, press Start the box and wait for the
first answer. `scripts/onboarding-e2e.mjs` does that, on the published artifacts, on a Mac
that is not the build machine, and writes a report a person can read (INV-1447).

This page is the runbook for the agent that runs it.

## What it checks

| step | passes when |
|---|---|
| preflight | macOS; ports free; no run dir or container of that name; the key variable set; ≥ 8 GB free. Records whether `fakechris/lumenbox:<version>` is already on the machine — if it is, the run is not a first pull and the report says so |
| download | the DMG from the GitHub release matches the release's `SHA256SUMS` |
| install | the app copied out of the DMG passes `codesign --verify --deep --strict` and its packaged `package.json` says the version asked for |
| gatekeeper opens a downloaded copy | the dmg and the installed app both pass `xcrun stapler validate` and `spctl --assess`: notarized, with the ticket stapled so they open offline too. Releases through 0.3.8 were not notarized and fail here; `--allow-unnotarized` turns the step into a note for checking them. A failure here does not stop the rest of the walk |
| nodocker: app starts | the app, launched with a Docker socket that does not exist, serves its page and opens its window |
| nodocker: Settings says what to do | `/api/state` diagnoses `no-engine` and Settings → Boxes tells the person to start Docker Desktop or OrbStack |
| full: first launch shows the set-up card | a fresh home has no key and no box, and the set-up card is on screen |
| full: key saved in Settings | the provider chosen and the key typed into Settings → Model, Save pressed, and `/api/setup` counts the key |
| full: Start the box | Start the box pressed in Settings → Boxes, and the box connects within `--box-timeout-min` (default 40). The time includes the image pull when the image was not cached |
| full: green dot | the sidebar box dot turns ok |
| full: first message answered | a message sent from the chat box gets a non-empty assistant reply within `--reply-timeout-min` (default 6) |
| nothing else touched | every container that existed before the run has the same id and start time after it |

Each step is photographed to `<run-dir>/shots/`. The full phase stops at its first failure;
the steps after it depend on it.

## Isolation: what it never touches

The app gets its own `AGENTBOX_HOME`, `--user-data-dir`, port (default 7796; 7777 is
refused), DevTools port (default 9341) and box container `lumenbox-onboard-<stamp>` with its
own `-work`/`-config` volumes and `-net` network. Box ports are ephemeral. Its environment is
built from nothing — `HOME`, `USER`, `PATH`, locale — so no provider key, `DOCKER_HOST` or
`AGENTBOX_*` from your shell reaches it, the way a person's first launch has none. The key is
read from the variable `--key-env` names, typed into Settings, cleared from the field after
saving, and never logged or written anywhere but the run's own `config.json`.

The fresh home's box list labels its own box `agentbox-box` (the default name) even though
the container is `lumenbox-onboard-<stamp>`; the label is cosmetic, the connection goes to the
run's container. Do not be alarmed by it in the screenshots.

On the macmini specifically, these belong to other people and must stay as they are: the app
on port 7777, the container `agentbox-box`, the `lumen-pod` containers, and
`~/workspace/lumenbox`. The last step checks the containers; if it fails, stop and report.

## Running it

On the Mac under test, from a checkout of this repository at or after the release (the script
needs only Node 22+, `curl`, `hdiutil`, `codesign`; the app is the published one, not the
checkout):

```sh
git fetch origin && git checkout origin/main
export MINIMAX_API_KEY=…          # or any provider's key; never echo it
node scripts/onboarding-e2e.mjs --version 0.3.8 --key-env MINIMAX_API_KEY --provider minimax
```

Docker Desktop or OrbStack must be running for the full phase (the nodocker phase hides it
from the app on its own). Run only `--phases nodocker` on a machine without Docker.
`--dmg FILE` skips the download and checks a local DMG against the published sums instead.
`--allow-unnotarized` is for releases from before notarization (0.3.8 and earlier).
Expect 10–40 minutes, most of it the first pull.

Exit 0 is PASS, 1 is a failed step, 2 is a script error. The report is
`<run-dir>/report.md` (default run dir `~/lumenbox-onboarding/<version>-<stamp>/`), beside
`report.json`, `manifest.json`, the screenshots, each phase's `app.log` and `full/box-start.log`.

## Reporting

Report against the release's Involute item: PASS or FAIL with the failed steps, the machine
(the report's first line), whether the pull was a first pull, the Start-the-box time, and the
screenshots of any failed step attached. A failure is a release defect until shown otherwise:
the first question is whether a person would have hit it, not whether the script is wrong.

## Cleaning up

Nothing is deleted by a run. To see what a run created:

```sh
node scripts/onboarding-e2e.mjs --cleanup ~/lumenbox-onboarding/<run>
```

That prints the container, volumes and network and removes nothing. After a person has read
the list and said yes, run it again with `--yes`. The image is removed only with
`--remove-image`, and never if it was on the machine before the run. The run directory is
kept until the report is filed; delete it by hand afterwards.
