# 35 — Onboarding a Grok Bot box: the bot prepares its own box, the person connects from the laptop

**Status: built 2026-09-03; published 2026-09-04 as https://x.ai/bot/U8xEPyVxQHL_JznVhVotB
("LumenBox Bridge by Chris").** The public page shows only the name and description — the
recipe's contents are visible once signed in — so the end-to-end test is a fresh bot made from
the link (§"Verifying" below). `docker/box/lumen-bridge.sh` (in the drop-in and published on its
own), the Grok-side skill, routine and template recipe in `share/grok-bridge/`, the release
`dropin-2026-09-03`. Tested on the Grok VM this installation already drives, end to end minus the
Tailscale login (that box was already joined).

## The story

Mei has Grok Bot: a bot with a VM box behind it. She wants LumenBox — her own agent team, on her
laptop, with Feishu and the task board — to be able to work in that box too. She has never seen a
terminal on that VM; she talks to her bot.

1. **She opens a share link** — `x.ai/bot/<id>`, the "LumenBox Bridge" template — and clicks
   *Use template*. Grok creates a bot with the template's profile, two memory lines, the
   `lumenbox-bridge` skill and a paused hourly routine. Because the recipe names the skill as
   `gettingStarted`, the bot's first turn runs it.
2. **The bot looks first.** It fetches `lumen-bridge.sh` from the LumenBox release and runs
   `check`. Mei reads three lines: what the box is, that Tailscale is (or is not) here, that
   nothing is in the way. Nothing has changed yet.
3. **The bot asks before joining a network.** A question widget: *Join this box to your
   Tailscale network?* Yes. `lumen-bridge.sh tailscale` installs Tailscale with sudo if it is
   missing, runs `tailscale up --ssh`, and prints a login URL. The bot sends her the URL and one
   sentence: sign in with your Tailscale account (free; the page creates one), and put the
   Tailscale app on your laptop signed in to the same account. The script waits up to ten
   minutes; when the box is on her network the bot says so, with its name `lumenbox-…`.
4. **The bot installs the daemon.** `lumen-bridge.sh install` downloads the drop-in, mints a
   token into `~/.lumen/token` (mode 0600, never printed), starts a desktop of its own at `:10`
   and the daemon on the box's Tailscale address, port 13370, and a keep-alive. The bot reports
   `BOXD_URL http://100.x.y.z:13370`.
5. **The bot tells her how to connect.** `lumen-bridge.sh connect-hint`, verbatim: read the
   token over Tailscale SSH from the laptop (`ssh box@lumenbox-… cat ~/.lumen/token` — it never
   passes through the chat), then in LumenBox *Settings → Boxes → Attach* with name `grok`, the
   URL and the token; or the one-line `agentbox box attach …`. Then what she will see: a box
   named `grok`, where she creates an agent whose desktop is `:10` on that VM.
6. **Later.** The VM has no cron and no systemd; after a reboot the daemon is down. The routine
   that came with the template runs `status` every hour and `start` when needed, and speaks only
   when it did something. Or she tells the bot "把 LumenBox 桥拉起来" and it runs `start`.

At no point did Mei type on the VM, and at no point did the bot touch Grok's own desktops,
daemons or files: the installer refuses displays below `:10`, starts the desktop only if it can
mark it as ours, and binds the daemon to the tailnet address only.

## What was built

| piece | where | what it is |
|---|---|---|
| `lumen-bridge.sh` | `docker/box/`, in `lumen-dropin.tar.gz`, and as a release asset | the in-box installer: `check`, `tailscale`, `install`, `start`, `status`, `token`, `connect-hint`; every subcommand idempotent; the remote half of `scripts/attach-grok.sh` made self-contained |
| `lumenbox-bridge` skill | `share/grok-bridge/SKILL.md` | Grok's `SKILL.md` dialect (frontmatter, Grok's tool names, a question widget before the one step that changes the box), one script call per step, never the token in the chat unless asked |
| `lumenbox-bridge-keepalive` routine | `share/grok-bridge/routine.md` | hourly `status`, `start` if down, silent otherwise |
| `recipe.json` | `share/grok-bridge/` | the template in Grok's recipe shape (docs research §2): profile, two memory lines, the skill, the routine, `gettingStarted` |
| release `dropin-2026-09-03` | GitHub | `lumen-dropin.tar.gz` + `lumen-bridge.sh` at `releases/latest/download/…`, which is what the skill and the installer fetch |

## Publishing the template (Chris, once)

Grok's templates are packed by the bot itself and published through a consent card (the
`export-bot-template` managed skill; `BOT_TEMPLATE_SHARING.md` §3). The way in:

1. On a Grok bot of yours, install the skill: copy `share/grok-bridge/SKILL.md` to
   `~/work/skills/lumenbox-bridge/SKILL.md` in its box and `routine.md` as a routine named
   `lumenbox-bridge-keepalive`; write the two memory lines from `recipe.json` into its profile
   memory.
2. Tell the bot: *"Export a public template of yourself: keep the lumenbox-bridge skill and the
   keepalive routine, keep the two LumenBox memory lines, leave out everything else, and make
   lumenbox-bridge the getting-started skill."* It runs `export-bot-template`, shows the review
   card, you approve, it publishes; the share link is the `x.ai/bot/<id>` you hand out.
3. Or, if the import surface accepts a recipe blob directly one day, `recipe.json` is that blob.

## Stated limits

- **Reboot survival is a routine, not a service.** Grok's VM has neither cron nor systemd as
  init; an hourly routine is the honest option and means up to an hour of "box unavailable"
  after a restart unless the person asks the bot.
- **Sudo.** Installing Tailscale needs it; the VM we know has passwordless sudo for `box`. Where
  it does not, `check` says so and the bot must ask the host to add Tailscale.
- **The token is readable by anything running as `box`** on that VM, the same limit as docs/33
  §4; it protects a daemon only tailnet devices can reach.
- **Node 22.** The daemon needs it; Grok boxes ship one at `/exec-daemon/node`. A box without
  any fails at `install` with that sentence.
- **Two installs on one box** would collide at `:10` and 13370; `--display`/`--port` exist, and
  the check names the clash. Not a scenario the story needs.

## Verifying the published template (signed in, on a fresh bot)

1. Open the link in the Grok Bot app and press *Add to Grok Bot*. Before confirming, the
   preview should list one skill (`lumenbox-bridge`), one routine
   (`lumenbox-bridge-keepalive`, paused) and two memory lines; nothing else. If other skills or
   memories are listed, the export kept too much: tell the exporting bot which to drop and
   re-export.
2. The new bot's first turn should run the skill by itself: a short hello, then the `check`
   lines. If it only greets, say "接入 LumenBox".
3. Watch for the question widget before the Tailscale step, the login URL, and — after
   signing in — the `TAILSCALE_IP` line. On a box that is already on a tailnet (this
   installation's VM) the step reports "already joined" instead.
4. `install` should end with a `BOXD_URL` line and the connect hint should name the box by
   its tailnet hostname. Then attach from the laptop and create an agent in the new box.

## First run, 2026-09-04

Chris made a bot from the link. The template's setup turn installed the skill, saved the routine
(paused, as Grok imports every routine) and wrote the memories — then stopped and asked whether
to enable the routine. It did not start the bridge until told "你做一下 onboarding 过程"; then it
ran `check`, saw the box already joined and the daemon up, and gave the connect hint, which is
the designed path for a prepared box. Two fixes in the skill and one memory line: start on your
own the moment setup is done; enable the keep-alive yourself instead of asking. Re-exported as
the next template version.

