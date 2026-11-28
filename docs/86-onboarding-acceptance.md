<!-- doc: 86-onboarding-acceptance
     title: Onboarding acceptance: a new user's first run on the published release
     family: guide
     status: current
     updated: 2026-11-28
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
| full: Start the box | Start pressed on the notice above the agent list, and the box connects within `--box-timeout-min` (default 40). The time includes the image pull when the image was not cached |
| full: green dot | the notice that the box is not running goes away (the rebuilt page has no dot: a computer that is up says nothing) |
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
`--dmg FILE` skips the download and checks a local DMG against the published sums instead;
with `--sums FILE` it is checked against a local `SHA256SUMS`, which is how a candidate is
walked before it is published. A new machine is first asked what it is for: the script answers
"personal", as a person setting up their own computer does.
`--allow-unnotarized` is for releases from before notarization (0.3.8 and earlier).
Expect 10–40 minutes, most of it the first pull.

Exit 0 is PASS, 1 is a failed step, 2 is a script error. The report is
`<run-dir>/report.md` (default run dir `~/lumenbox-onboarding/<version>-<stamp>/`), beside
`report.json`, `manifest.json`, the screenshots, each phase's `app.log` and `full/box-start.log`.

## Upgrade mode: the previous release, used, then the candidate on its data

`--upgrade-from <previous>` walks an upgrade instead of a first run (INV-2209). Before
publishing, on the release machine, with the candidate dmg and the sums about to be published:

```sh
node scripts/onboarding-e2e.mjs --version 0.4.12 --dmg dist-app/LumenBox-0.4.12-arm64.dmg \
  --sums /tmp/candidate-SHA256SUMS --upgrade-from 0.4.11 --downgrade-check \
  --key-env MINIMAX_API_KEY --provider minimax
```

A candidate may carry the published version's number (a rebuild with a new home format): then
`--dmg` is required, since an upgrade from a release to itself is no upgrade. Both DMGs are
fetched and checked first; the previous one is installed in `<run-dir>/previous/`, the candidate
in `<run-dir>/`. A previous release whose GitHub page carries no DMG (0.4.10 and 0.4.11 were
published without assets) is given as a local build of its tag with `--from-dmg FILE --from-sums
FILE`, checked the same way. Both apps share `<run-dir>/upgrade/home` and `<run-dir>/upgrade/user-data` and
the run's one box container and volumes, as one person's machine does across an upgrade.

| step | passes when |
|---|---|
| previous: download / install / gatekeeper | as for a first run, for the previous release from GitHub |
| previous: first launch … first message answered | the first-run steps above, on the previous app |
| previous: a second agent | `POST /api/agents` makes one |
| previous: a conversation of three turns, one with a tool call | three messages to it through `POST /api/prompt`, each answered; the first asks it to keep a code word with `RememberFact` |
| previous: a memory | the agent's memory (`/api/memory/agent`) holds the code word |
| previous: a routine (a skill with schedule:) | `POST /api/automations` writes one (paused, so it never fires) and `/api/schedules` lists it |
| previous: a task | `POST /api/tasks` makes one |
| previous: a file in each box volume | the code word written to `/home/box/work/` (the work volume) and to `/home/box/.config/box-chrome-0/` (the config volume, where the browser profiles live), inside the run's own container |
| previous: what it shows, read through the API | the previous app itself shows all of it — so a miss later is the upgrade's |
| upgrade: the candidate opens the previous home | the candidate's server answers on the same home and its window opens |
| upgrade: FORMAT and format-migrations.jsonl say what the migrations did | `FORMAT` is the highest format the candidate ships; the ledger kept every line the previous app wrote and gained one per format, in order, by the candidate's version; a line with a backup names a copy that exists, and no copy appears when no migration had work (`needed`) |
| upgrade: everything written before reads back | the agent, every message and reply, the memory, the routine and its schedule, the task, the saved key and the provider, through the candidate's API |
| upgrade: the box comes up with its volumes kept | the box connects (Start the box is pressed if it does not by itself); both volumes are the ones from before (same creation time) and both files still hold the code word. The report says whether the container was recreated |
| upgrade: a new message is answered | a fourth message to the agent is answered, and says whether the reply named the code word |
| downgrade: the previous app does not open the upgraded home | (`--downgrade-check`, only when the candidate's format is higher than the previous app's; otherwise a note says there is nothing to refuse) the previous app logs `server refused the home: …` and its server never answers. The shell then shows the "LumenBox cannot open its data" dialog; the script tries to photograph that window (`shots/downgrade-01-refusal-dialog.png`) and the step says what it got — macOS may refuse a capture to a shell without Screen Recording permission |
| downgrade: the previous server exits 78 with its message, home unchanged | the previous app's server, started alone on the home as the shell starts it, exits 78 with the "a newer LumenBox wrote this home" sentence naming the format, and `FORMAT` and the ledger are as the candidate left them |

The preflight asks for more room in this mode (two apps, the home's copy, and a second image
when the versions differ). Leftovers and `--cleanup` are the same as for a first run; the
previous release's image is listed and removed with `--remove-image` only if this run pulled it.

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

That prints the container, volumes, network and the app processes the run recorded, and removes
nothing. A recorded process is stopped only if what holds that number now runs from one of the
run's own installed apps and started before the run recorded it; anything else is listed as
"not ours, left alone" and never signalled — the run stopped its apps itself, so by cleanup time
a number may belong to anything on the machine. After a person has read
the list and said yes, run it again with `--yes`. The image is removed only with
`--remove-image`, and never if it was on the machine before the run. The run directory is
kept until the report is filed; delete it by hand afterwards.
