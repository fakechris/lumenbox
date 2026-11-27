<!-- doc: 06-deployment
     title: Deployment
     family: guide
     status: current
     updated: 2026-11-27
-->
# Deployment

## 1. Requirements

| | Driven from outside | Self-contained |
| --- | --- | --- |
| Docker engine | yes | yes |
| Node ≥ 22.18 on the operator's machine | yes | no |
| A checkout | yes | no, once the image is built |
| A browser | to watch | the only thing needed |

The image is Debian 12, about 1.6GB, and builds on `amd64` and `arm64`. For CPU, memory and disk
sizing across Kubernetes clusters, box desktops and the Electron desktop app, see
[108-resource-requirements.md](108-resource-requirements.md).

## 2. Ports

| Port | Bound | Published | Carries |
| --- | --- | --- | --- |
| 1337 | 0.0.0.0 in the container | yes, ephemeral | boxd — the whole API, bearer-authenticated |
| 7777 | 0.0.0.0 in the container | `127.0.0.1:7777`, only with `--with-host` | The web UI |
| 5900+N | container loopback | no | x11vnc per desktop |
| 6080+N | container loopback | no | noVNC per desktop, proxied through 1337 |
| 8791 | container loopback | no | The egress proxy |
| 8790 | the operator's machine | n/a | The egress relay |
| 1337, 8790, 7777 | the gate container of a confined box | 1337 to `127.0.0.1`, ephemeral | Forwarding only: the daemon inwards, the relay and the web port outwards (§3.4) |
| 7766 | the operator's tailnet IPv4 | n/a | The tailmsg door (docs/82), only when a `tailmsg` channel record exists |

Only 1337 and, in the self-contained shape, 7777 leave the container. Everything per-desktop is
proxied, so adding a desktop does not need a port mapping decided at create time.

## 3. Starting it

### 3.1 Driven from outside

```bash
npm install && npm run build && npm run build:box
node dist/cli.js box build          # tags fakechris/lumenbox:<version> and :latest
node dist/cli.js box push           # Docker Hub; needs docker login
node dist/cli.js box up             # pulls that version when it is not local
export MINIMAX_CODE_CN_API_KEY=…        # or ANTHROPIC_API_KEY
node dist/cli.js web --provider minimax
```

### 3.2 Self-contained

```bash
node dist/cli.js box build
export MINIMAX_CODE_CN_API_KEY=…
node dist/cli.js box up --with-host
# prints: web UI: http://127.0.0.1:7777/?token=…
```

The orchestrator runs in the container; nothing on the host does. The UI token is generated and
persisted, so recreating the box does not invalidate an open tab.

### 3.3 Attaching to a box someone else runs

```bash
export AGENTBOX_BOXD_URL=http://box-host:32768
export AGENTBOX_TOKEN=…                  # must be the box's token; one cannot be invented
node dist/cli.js web
```

No Docker needed on this machine.

### 3.4 Egress through the operator's network

```bash
node dist/cli.js egress --allow example.com,*.internal.example.com
AGENTBOX_EGRESS_RELAY=host.docker.internal:8790 node dist/cli.js box up --recreate
```

**A box started with a relay named is confined to it (INV-816).** Its network is created
`--internal` — no route out, nothing published — and a second container, `<box>-gate`, on that
network and on an ordinary one (`<box>-gate-net`), forwards three ports and nothing else: 1337
inwards (published on loopback, where the box's own port used to be), and outwards the relay's
port and the web port (`AGENTBOX_PORT`, 7777). Inside the box `host.docker.internal` is the
gate. `box up` and the server's start both print which it is:

```
outbound: confined — the box is on an internal network with no route out; only agentbox-box-gate crosses it, forwarding to host.docker.internal:8790, host.docker.internal:7777
```

What changes for the agent: anything that does not speak through an HTTP proxy has no network —
`git` over ssh, a raw socket, `ping`, DNS itself (names are resolved by the relay). `sudo`
drops the proxy variables, so `sudo apt-get install` needs them handed over:
`sudo -E apt-get …` or `sudo env http_proxy="$http_proxy" apt-get …`. That is the point, and it
is also why this is tied to naming a relay rather than switched on for everyone.

- An existing box is not changed by setting the variable: it says `NOT confined … Recreate the
  box` until it is recreated (`box up --recreate`; the work and config volumes are kept).
- `AGENTBOX_EGRESS_ENFORCE=off` keeps a relay-named box on an ordinary network, steered and not
  confined, and every start says so.
- A box with the orchestrator inside (`--with-host`) is not confined: it calls its model from
  the box. A box with no relay named is as before.
- On a Linux engine the gate reaches this machine at the bridge's gateway address, so the relay
  and the web server have to listen there, exactly as the box needed before (below). **Not
  measured on a Linux engine or Docker Desktop**: the check has only been run on OrbStack.
- To check a machine: `npm run test:egress -- --name lumenbox-egress-check-1` starts a box of
  its own, tries to get out without the proxy (plain, by address, with `sudo`, by adding a
  route), and checks that a proxied command, a package download and the browser still work and
  are still recorded against their call.

The MCP face (docs/33) reaches the web server by the same name: `host.docker.internal:7777`
resolves to the host's loopback on Docker Desktop, which is what the web server binds. On a
Linux engine that name is the host's gateway address, and a loopback listener is not on it —
bind the web server to the bridge address (`--host 172.17.0.1`, or whatever `docker network
inspect bridge` says) and set `AGENTBOX_MCP_FACE_URL=http://172.17.0.1:7777`. A self-contained
box (the orchestrator inside the container) needs nothing: the face uses loopback there.
A confined box is the exception to the variable: it reaches the web port only through its gate,
so leave `AGENTBOX_MCP_FACE_URL` unset (the default, `host.docker.internal:7777`, is the gate)
and bind the web server where the gate can reach it.

## 4. Configuration

**Environment** for what changes per run:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTBOX_HOME` | `~/.agentbox` | State directory |
| `AGENTBOX_TOKEN` | generated | Box API bearer |
| `AGENTBOX_UI_TOKEN` | non-loopback: read or create `$AGENTBOX_HOME/ui-token` | Operator UI secret; also derives the browser session signing key |
| `AGENTBOX_BOXD_URL` | — | Attach to a box instead of using Docker |
| `AGENTBOX_PROVIDER` / `_MODEL` / `_BASE_URL` / `_KEY_ENV` / `_AUTH` | anthropic | Which endpoint |
| `ANTHROPIC_API_KEY`, `MINIMAX_CODE_CN_API_KEY`, `AGENTBOX_API_KEY` | — | Model credential |
| `MINIMAX_CODE_GLOBAL_API_KEY` | — | MiniMax (global) credential. If you previously used the China-named variable for a global account, move the key to this variable or save it again under MiniMax (global) in Settings → Model. |
| `AGENTBOX_WIDTH` / `_HEIGHT` | 1280×800 | Desktop size |
| `AGENTBOX_MEMORY` / `_CPUS` | 4g / half the engine's cores (at least 2) | Container limits; the CPU one is also in Settings → Boxes |
| `AGENTBOX_EGRESS_RELAY` / `_TOKEN` | — | Egress |
| `AGENTBOX_K8S_NAMESPACE` | `agentbox` | Namespace the kubernetes allocator creates boxes in |
| `AGENTBOX_K8S_STORAGE_CLASS` | cluster default | StorageClass for box PVCs |
| `AGENTBOX_K8S_MEMORY` / `_STORAGE` | 4Gi / 10Gi | Per-box memory request *and* limit, and per-PVC size (kubernetes allocator) |
| `AGENTBOX_K8S_RELAY_URL` / `_CONTROL_URL` | the `agentbox-control` Service | How boxes reach the relay/control plane in-cluster |
| `AGENTBOX_SETTLE_MS` | 2000 | Capture settle |
| `AGENTBOX_MAX_ROUNDS` | 400 | Turn round limit |
| `BOXD_AGENT_NICE` | 19 | How far behind the desktop the agent runs |
| `BOXD_JOBS_PER_AGENT` | 4 | Background jobs one agent may run at once; past it a new one is refused with the reason (0 = no limit) |
| `BOXD_JOB_MEMORY_MB` | 1024 | Resident memory one job's processes may hold, measured every 3 s; a job past it is stopped and its log says why (0 = off) |
| `BOXD_JOB_LOG_MAX_MB` | 64 | One job log's ceiling: past it the head stays, the last 2 MB are written when the job ends, with how much was cut |
| `BOXD_LOG_KEEP_DAYS` / `BOXD_LOG_KEEP_MB` | 7 / 1024 | Ended jobs' files kept; older ones go, and the oldest first while the total is over. Running jobs are never touched |
| `BOXD_RECORDINGS_KEEP_DAYS` / `BOXD_RECORDINGS_KEEP_MB` | 14 / 2048 | Desktop recordings kept per box; older ones go, and the oldest first while the total is over. The one being written is never touched (0 = off) |
| `BOXD_RECORDINGS_MIN_FREE_MB` | 512 | Free space on the work volume a new recording needs; below it the start is refused with the reason (0 = off) |
| `BOXD_SPOOL_KEEP_MB` | 512 | The exec spool's ceiling on top of its one-day age; oldest first, never a file written in the last ten minutes |
| `BOXD_JOB_OUTPUT_MAX_MB` | 1024 | Output one job may write; past it the job is stopped and its log says why (0 = off). Separately, below max(512 MiB, 5%) free on the work volume, new jobs are refused and jobs that are writing are stopped |
| `BOXD_SUPERVISE_MS`, `BOXD_MAX_RESTARTS`, `BOXD_RESTART_WINDOW_MS`, `BOXD_BACKOFF_*`, `BOXD_GIVE_UP_EPISODES` | see design | Supervision tuning |

For an organization web server, keep `AGENTBOX_HOME` on a persistent state volume across
restarts. Browser sessions are signed with a key derived from the UI token. When the token comes
from `$AGENTBOX_HOME/ui-token`, a pod that starts without that volume creates a new token and
signs out the whole organization. `deploy/kubernetes/organisation.yaml` mounts a PVC at
`/state` for this purpose. If you supply `AGENTBOX_UI_TOKEN` from a Kubernetes Secret instead,
keep that Secret stable across rollouts. Replacing the UI token invalidates existing browser sessions.

**`config.json`** for what is decided once: currently `activityLimit`, and `turnBudget`
(`{ "calls": 60, "repeats": 3 }`, INV-1354: model calls one turn may make before handing the
work back, and how often the identical tool call runs before it is replayed).

## 5. Operating it

### 5.1 Is it healthy

```bash
node dist/cli.js box status
node dist/cli.js box exec box-doctor          # 15 checks, non-zero if any fail
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:PORT/health
```

`/health` carries `desktop_health` (per-component state, `degraded`) and `crashes` (what died
unsupervised). "ok" alone is not an answer: a desktop whose compositor was abandoned still
serves a screen, and one whose x11vnc is crash-looping does not.

### 5.2 When something is wrong

| Symptom | Look at |
| --- | --- |
| The screen is frozen | `desktop_health` for x11vnc; `vnc-probe <port>` proves frames still arrive |
| The screen is black | Compositor state; `box-doctor` names it |
| Computer use is slow | Whether the agent is saturating the box; `nice` values |
| A dialog cannot be clicked | `box-doctor` file-chooser check |
| Text is empty boxes | `box-doctor` fonts check |
| The desktop is empty after a restart | The stale X lock sweep; container logs |
| Something keeps dying | `crashes` in `/health`, aggregated by signature |

### 5.3 Restarting

`docker stop`/`start` keeps the container layer — logs, sessions, /tmp. The stale X lock is
swept on the way up. `box up --recreate` replaces the container: the volumes survive, the layer
does not.

## 6. Upgrading

```bash
npm run build:box && node dist/cli.js box build
node dist/cli.js box up --recreate
```

What survives: the agents' work and recordings (`work`), the browser logins and desktop
settings (`config`), the orchestrator's transcripts (host dir or `hostd`).

What does not: anything an agent installed with `sudo`, `/tmp`, shell sessions, in-flight turns.
Installed packages are deliberately ephemeral — that is what makes a rebuilt image a fresh box.

The image's own desktop config is re-seeded on every start, so a fix reaches an existing box.

## 7. Backup

```bash
node dist/cli.js backup            # ~/.agentbox-backups/<timestamp>
node dist/cli.js backup /mnt/nas   # or somewhere that is not this disk
```

Nothing is stopped. Every file under `~/.agentbox` is either append-only JSONL or a document
replaced atomically by rename, and every reader here already skips a torn last line — because that
is also what a crash leaves behind. The old instruction to `box down` first was solving a problem
the formats had already solved, and its real cost was that a backup requiring downtime does not get
taken.

`AGENTBOX_BACKUP_HOURS=6` makes `agentbox web` do it on a timer, with one at startup so a fresh
deployment has a copy before it has run anything. `AGENTBOX_BACKUP_KEEP` (default 7) bounds how many
are kept — by count rather than by age, because "keep the last seven" survives a machine that was
off for a month and "delete older than a week" throws them all away on the first run after.

The directory is `0700`. A backup is a second copy of everything, including the box token, the UI
token and the control-plane database; the files keep their own modes so credentials stay `0600`, but
transcripts do not, and a transcript is where a secret an agent read ends up.

**What this does not cover:** `/home/box/work` is a Docker volume and is not in here. It is the
agents' output rather than their memory, and it has its own lifetime — but if it matters, it needs
its own copy.


## 8. Destroying it

```bash
node dist/cli.js box down --rm                     # container only; volumes survive
docker volume rm agentbox-box-work agentbox-box-config agentbox-box-hostd
rm -rf ~/.agentbox                                 # transcripts, tokens, config
```

`box down --rm` deliberately does not remove volumes: losing the agents' work must take an
explicit act.

## 9. Security posture

State it plainly, because a deployment decision depends on it.

- **The container is the boundary.** The agent has passwordless `sudo` inside it. Nothing in the
  box should be anything its owner would not hand to the model.
- **The box API is one bearer token** on a published port. On a remote engine, anything that can
  route to that port and holds the token has a shell in the box.
- **The UI is one shared secret and no identities.** Whoever holds it drives every agent.
- **In the self-contained topology the model credential is in the container**, and therefore
  reachable by an agent that goes looking. The uid split prevents the accident, not the act.
- **Egress is off unless configured**, and the relay refuses to run without a token. With no
  relay named, the box connects to the internet directly and nothing decides or records it;
  with one named, a Docker box is confined to it at the network (§3.4, INV-816). Which of the
  two a box is, is printed at every start; docs/03 §5 has the whole table.
- **Through the egress relay, two targets are refused before any allow list** (INV-1224,
  `src/egress/hard-deny.ts`): every cloud metadata address (169.254.0.0/16, `fd00:ec2::254`,
  `metadata.google.internal`), and the host itself — loopback, `host.docker.internal` and its
  kin — except the ports that are channels on purpose: the web port (MCP face and model relay)
  and the relay's own (`agentbox egress relay --host-ports 7777,…`). The same two rules are
  applied again to every address a name *resolves to* (INV-1343, `hardDeniedAddress`), and the
  relay dials the address it checked rather than the name, so an allow-listed domain whose DNS
  answer is 169.254.169.254 or 127.0.0.1 is refused with the answer in the event's `detail`; a
  name that does not resolve is refused `unresolved`. Every stream is one line
  in `network-events.jsonl` at the decision (host, port, box, who asked, allowed or why not)
  and one more when it closes (bytes each way, duration); the file rotates at 20 MB keeping one
  previous generation. The relay is a tunnel, so an HTTPS request's method and status are not
  seen there — only what crossed.

### The host-side sandbox (INV-1344)

Two things run outside the box with the orchestrator's own privileges: a `RunOnHost`
command and a stdio MCP server. Both now run under the operating system's sandbox,
built in `src/host/host-sandbox.ts`:

- **Mechanism.** macOS: a Seatbelt profile handed to `sandbox-exec -p`. Linux: bubblewrap
  (`bwrap --ro-bind / /`, the writable paths bound back in, `--unshare-net --unshare-pid`),
  with `socat` bridging the allowed loopback port from a Unix socket into the namespace.
  Where neither can be applied the process is **refused with the reason**, never run bare.
- **Rules.** Reads allowed. Writes only under the working directory (`hostExec.cwd`; an MCP
  server gets its own directory under the temp directory), the temp directory and
  `hostExec.allowWrite` / `mcpServers.<name>.allowWrite`. Never writable, even under a
  writable parent: `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/.kube`, `~/.netrc`,
  the shell rc files, `~/.gitconfig`, `~/.agentbox*`, and `.git/hooks` and `.git/config`
  under the working directory.
- **Network.** Only the host egress proxy on loopback (`src/host/host-egress.ts`), which
  speaks to the relay named by `AGENTBOX_EGRESS_RELAY` / `AGENTBOX_EGRESS_TOKEN` — the same two
  variables the box is handed — and so applies the relay's allow list, hard denials and
  resolved-address check to host commands too. A `RunOnHost` command's connections carry its
  call token, so its refusals come back on the result (INV-1345). No relay configured means
  **no network** for host processes; the rules say so.
- **What the model sees.** A failed command whose output looks like a refusal (EPERM, read-only
  file system, network unreachable…) gets a `<sandbox_violations>` block listing the rules in
  force, so `claude` failing to write `~/.claude` reads as "add it to `hostExec.allowWrite`"
  rather than a mystery.
- **Opt-out, in writing.** `hostExec.sandbox: "off"` or `mcpServers.<name>.sandbox: "off"` in
  `config.json` — the same class of decision as `hostExec.enabled`, and not one the Settings
  form offers. The form's `enabled`/`cwd` save merges into `hostExec` and no longer erases
  hand-written keys.
- **Known gaps.** A hard link made outside the rules; on Linux the deny list covers only paths
  that exist when the process starts; the Seatbelt profile matches real paths, so every path is
  resolved before it is written into the profile (a `/var/folders` rule would silently miss
  `/private/var/folders`). The sandbox is an accident boundary around an approved command, not
  a replacement for the approval.

### What the box reaches *without* the relay (measured 2026-10-20)

**This section describes an unconfined box**: no relay named, `AGENTBOX_EGRESS_ENFORCE=off`, or
the orchestrator inside. A confined box (§3.4) reaches none of the targets in the table
directly — measured 2026-11-19 on OrbStack: `curl` without the proxy variables exits 6 or 7
for an internet name, an internet address, 169.254.169.254 and a loopback-bound port on this
machine, with and without `sudo`.

The relay decides only for traffic sent through it (the box's browser, and whatever an agent
points at the proxy). A command in the box that connects directly is decided by the container
network alone, and that differs by platform. Probed from inside the running box with
`curl -m 3` (exit 28 = timed out, 1 = connected to a non-HTTP service):

| target | OrbStack (this Mac) | a cloud VM on the operator's tailnet (Linux Docker) |
|---|---|---|
| `http://169.254.169.254/latest/meta-data/` | timed out — no metadata service on a Mac | **not measured today**: the VM was unreachable (tailscale offline). Expected reachable: Docker's default bridge routes link-local through the host; a request there returns the instance's credentials |
| `host.docker.internal:7777` (web, a channel) | 401 — reachable, as intended | expected reachable |
| `host.docker.internal:11434` (Ollama, bound to 127.0.0.1 on the host) | **200 — reachable** | expected unreachable: a 127.0.0.1-bound host port is not routed to a bridge container |
| `host.docker.internal:3306` (MySQL, 127.0.0.1-bound) | **connected** (curl exit 1) | expected unreachable, as above |
| `host.docker.internal:7000` / `:5000` (bound to `*`) | 403 — reachable | reachable |
| container capabilities | default set (no `NET_ADMIN`); no `iptables`/`ip` in the image | same |

So on OrbStack `host.docker.internal` reaches the host's loopback-bound services, which a
Linux bridge would not; and the container cannot add its own firewall rules without
`NET_ADMIN`, which this deployment does not grant and INV-1224 does not add. The remaining
risk, stated: **direct connections from the box to the host's loopback ports (OrbStack) and
to the metadata service (a cloud VM) are not refused by anything in this repository.** What
would close it is on the host side — a `DOCKER-USER` iptables chain on a Linux engine, or
OrbStack's own network settings — and is the operator's to add; the relay path is closed here.

For anything shared, the three things to add are identities, per-tenant boxes, and a credential
relay so the model key never enters a box. The seams are named in
[03-architecture.md](03-architecture.md) §7.

## Packaging the desktop app

The desktop shell (Electron) packages per platform through electron-builder. asar is
off on purpose — the shell supervises the CLI as a child process and spawns it from
plain files, so there is no archive to unpack at runtime.

- `npm run dist:app` — a quick unpacked build for the current platform (development).
- `npm run dist:mac` — signed `.dmg` and `.zip`, arm64 and x64. Notarization is a
  separate step and is skipped without credentials.
- `npm run dist:win` — an NSIS installer (x64). Built on Windows, or on another
  platform with wine present.
- `npm run dist:linux` — AppImage and `.deb`. Built on Linux.

The macOS menu-bar name reads "Electron" only under `npm run app` (the dev launch);
the packaged app carries `productName` (LumenBox) in its bundle. Icons come from
`assets/app-icon/`, regenerated from the SVG sources by `scripts/make-icons.sh`.

## Feishu app configuration (console side)

Two switches live in the Feishu developer console and nowhere in our config, so a fresh
deployment can look wired while half the surface is dead:

1. **Events over long connection** — the message events themselves. This one fails loudly
   (nothing arrives), so it gets noticed.
2. **Card callbacks over long connection** (事件与回调 → 回调配置 → 卡片回调 →
   使用长连接接收). This one fails *quietly on our side*: a pressed card button pops
   "该应用尚未配置卡片回调" to the person and never reaches the bot. The consent card's
   buttons shipped in this state and nobody noticed for days, because the word path
   ("允许" / "拒绝" typed as a reply) kept working — the question card's buttons are what
   finally surfaced it. The console's "一键配置" deep link may claim the app does not
   exist when the logged-in account differs from the app's owner; configure it manually.

Neither switch is detectable from our side at boot, so they cannot go into `absences.ts`;
this note is the substitute.

The card switch has a no-console path: `node scripts/feishu-enable-cards.mjs` runs the
SDK's registerApp *update* flow — it prints a link whose QR the app's owner scans in
Feishu, the phone shows exactly the one change being authorized (the
`card.action.trigger` callback), and on confirm the buttons start arriving over the
websocket the bot already holds. No restart. This is also the answer to the console
saying 该应用不存在: an app created through the scan flow is owned by the phone account,
not by whoever happens to be logged into the console.

The document reader (`ReadFeishuDoc`) needs two read-only scopes the scan-created app
does not start with: `docx:document:readonly` and `wiki:wiki:readonly`. Same no-console
path: `node scripts/feishu-enable-docs.mjs`, scan, confirm the two scopes, no restart.
Until they are granted, reads fail with the permission advice the tool relays.

## TLS is required for anything not on loopback (INV-578, 2026-09-16)

A published installation over plain HTTP hands somebody's session to anyone on the path.
Since 2026-09-15 a sign-in issues a per-person session rather than the installation's token,
so it is no longer *the* credential — but a person's session is that person's work.

The server therefore **refuses to start** when it binds a non-loopback address and
`AGENTBOX_PUBLIC_URL` is not `https://…`. Put a terminator in front — Caddy, nginx, or a
tunnel that terminates for you — and point `AGENTBOX_PUBLIC_URL` at it:

```
# Caddyfile
box.example.com {
  reverse_proxy 127.0.0.1:7777
}
```

```
AGENTBOX_PUBLIC_URL=https://box.example.com
```

### The exposure level (INV-2204, 2026-11-27)

That check is now one case of a declared level (docs/106 §5): **local** — only this machine
reaches the port; **private** — a tailnet or a company network; **public** — the Internet.
`agentbox web` and `agentbox control up` read it once, at start, and refuse a configuration
weaker than the level requires, naming what is missing.

| Bind | `AGENTBOX_EXPOSURE` | Level |
| --- | --- | --- |
| loopback (the default; the desktop app) | unset | local — nothing changes |
| any other address | unset | private |
| any | `local`, `private` or `public` | as declared |

`AGENTBOX_EXPOSURE` is an environment variable; `env` in `config.json` sets it like any other.

- **Private and public need HTTPS in front**: `AGENTBOX_PUBLIC_URL=https://…` (for `control up`,
  `--public-url` or `AGENTBOX_SECURE_COOKIES=1` also say it). Cookies are then `Secure` and every
  response carries `Strict-Transport-Security`. `X-Forwarded-Proto` is not consulted for either.
- **Private and public do not take the installation token from a person.** `?token=` in an
  address is refused, the `agentbox_ui` cookie is ignored, and `Authorization: Bearer <token>` is
  accepted only from the server's own machine — a direct loopback connection with no proxy
  headers, which is the CLI there — or, on a tenant's box, from the control plane's gateway.
  People sign in as themselves: the first Admin at `/bootstrap`, everyone else at `/login`. The
  terminator must set `X-Forwarded-For` (ingress-nginx, Caddy, Traefik and the tunnels do); one
  on the same machine that sets no proxy header makes its visitors look like the CLI.
- **`local` on a wider bind** is the operator's statement that only this machine reaches the
  port — a container published on loopback, a `kubectl port-forward`. It starts, and it says what
  was claimed on every start, because nothing can check it.
- **`private` on a loopback bind** is the Caddy example above: the proxy is on the same machine.
  Undeclared, that server stays local and behaves as before; declare it to get the token rule.
- **`AGENTBOX_INSECURE=1` no longer starts a server.** It used to wave a plain-HTTP server
  through on any bind. A tailnet is a network: use `tailscale serve` (or any terminator) and an
  `https://` address, or declare `local` if the variable was only there for a port-forward. The
  one place it remains is the control plane's own tenant pods, where the hop from the gateway is
  plain HTTP inside the cluster and `AGENTBOX_TRUST_GATEWAY_IDENTITY=1` is what admits it.

### Sign-in limits and what a browser is held to (INV-2204 part 2, 2026-11-27)

**Sign-in limits (private and public; local has none).** Every way a credential is tried asks
one limiter (`src/web/sign-in-limits.ts`): an invite code (`POST /api/login`), the first Admin's
code (`POST /auth/<door>`), a door's sign-in callback, a side-door token (`/mcp`), the
installation token, and the control plane's password form (`/gateway/login`). A try is counted
against the address it came from and, where the credential names one, the account it was for (the
user name on the password form; the first Admin's code is one account). Five wrong tries from an
address cost nothing (ten against an account); after that each doubles the wait — 2 s, 4 s, 8 s …
up to 15 minutes — and an hour without a wrong try forgets the count. While waiting, the answer
is `429` with `Retry-After` and the code `sign-in-limited`, given before the credential is looked
at. Signing in clears the account's count, not the address's. The counts are in memory: a
restart clears them, as it clears nothing that was durable before. Invite codes keep their own
installation-wide cap as well (`CodeAttempts`, INV-2078).

Tries that did not get in are recorded in `<home>/sign-ins.jsonl` — when, which way in, the
address, the account if any, why, and one line when a wait begins; never the code, password or
token tried — and `audit export` includes the file. On the control plane they are `signin.failed`
and `signin.limited` rows in its audit, beside `signin`.

**What the terminator in front must set.** `X-Forwarded-For`, with the client's address
**appended as the last entry** — what ingress-nginx, Caddy, Traefik and the tunnels do by
default. The server reads the last entry and never the first, which the client can write. It is
how a person's request is told from the CLI's on the server (which carries no proxy header), and
it is the address the limiter counts. If a second proxy stands in front of the adjacent one (a
CDN, a cloud load balancer), configure the adjacent one to pass the real client address through
(ingress-nginx: `use-forwarded-headers` with `proxy-real-ip-cidr`; nginx: `real_ip`), or every
person arrives as that proxy's one address and one person's wrong tries make everyone wait.
**Say which proxies are in front: `AGENTBOX_TRUSTED_PROXIES`.** Addresses and CIDR ranges,
comma-separated (`10.42.0.0/16, 192.0.2.10`): the Ingress controller's pod range, the load
balancer's address. With it set, `X-Forwarded-For` is believed only from one of them or from the
server's own machine; any other machine that reaches the port is counted, and recorded, as the
peer it is, whatever it wrote. A list that cannot be read refuses the start.

**Unset, the server's port must be reachable only through the terminator.** Then the server
cannot tell its proxy from another machine, so a client that
reaches the port directly (another pod in the cluster, a host on the same network) writes its own
`X-Forwarded-For` and is counted, and recorded, under any address it likes. What still holds
against it: the per-account counts and the invite-code cap do not depend on the address, the
tokens it could try are not guessable, and each line of `sign-ins.jsonl` keeps the connection's
real other end as `peer` when it differs from `address` — on a correct deployment `peer` is always
the proxy. Close the path: a NetworkPolicy admitting only the Ingress controller (the example is
in `deploy/kubernetes/README.md`), a firewall rule, or a loopback bind with the proxy on the same
machine.

`X-Forwarded-Proto` is not read. A connector's OAuth callback address is built from
`AGENTBOX_PUBLIC_URL` off local, not from the request's headers.

**What a browser is held to (every level).** A request that changes something — anything but
`GET`, `HEAD`, `OPTIONS` — and every socket upgrade must come from the installation's own page:
its `Origin` (or, without one, its `Referer`) is the declared public address off local, or, where
none is declared, the address the request was sent to (`http://127.0.0.1:<port>` for the app,
the same or `localhost` in a browser). Otherwise the answer is `403`, code `cross-origin`. Not
asked: a request with an `Authorization` header (a program's credential), a request with neither
`Origin` nor `Referer` (not a browser), and `/hooks/<id>` (a webhook carries its own secret).
Nothing answers with `Access-Control-Allow-Origin`. So off local **people must open the address
in `AGENTBOX_PUBLIC_URL`**: the same server reached by another name or a port-forward shows the
page and refuses its changes.

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and a
content security policy (`src/web/browser-guard.ts`) that forbids framing by another site,
plugins, a foreign `<base>`, posting a form elsewhere, and loading or connecting anywhere but the
installation itself (images may also come from `https:`). `script-src` and `style-src` still
allow `'unsafe-inline'`, because the page is written with inline scripts, handlers and styles: the
policy does not yet stop an injected script.

The two pages here that are somebody else's — noVNC's desktop page, served by the box, and a
card drawn by the A2UI bundle — are checked against these rules in a real browser by
`npm run check:desktop-page`: a disposable box and a temporary home, headless Chrome, the desktop
as a page, in a viewer's session and embedded, and one card. It needs Docker and `npm run build:vendor`, so
it is run by hand after a change to the policy, the box image's noVNC or the bundle, not in CI.

A door's sign-in is tied to the browser that started it: `/auth/<door>` sets a ten-minute
`agentbox_signin` cookie and the callback is honoured only with it, so a finished callback link
signs in nobody else's browser.

## The token key belongs outside the directory it protects (INV-579, 2026-09-16)

Box tokens are stored encrypted. Unset, the key is minted `0600` beside `control.db` — encryption
that is on by default, which is the right trade on a laptop and the wrong one on a volume that gets
snapshotted, since the snapshot carries both halves.

```
agentbox control key    # prints a fresh key once, with the kubectl line
```

`deploy/kubernetes/control-plane.yaml` requires an `agentbox-control-key` Secret. That reference is
not `optional`: a forgotten password can be reset, a forgotten key cannot — change it after the fact
and every token already in the store is unreadable, which means re-registering the boxes. Mint it
before the first start.

`control up` and `control status` both say which key they got, so there is no need to guess.

## A spend ceiling that the box cannot edit (INV-580, 2026-09-16)

The in-box policy gate explains a budget to an agent, which is what it is good at, and it runs
inside the thing being billed next to a shell with sudo. The relay is outside the box, holds the
credential, and already measures every request where it passes.

```
# deployment-wide
AGENTBOX_RELAY_LIMIT_USD=25
AGENTBOX_RELAY_WINDOW_HOURS=24
AGENTBOX_RATES='{"claude-opus-5":{"inputPerM":15,"outputPerM":75}}'

# or per tenant, in its quota
{"relay": {"limitTokens": 5000000, "windowHours": 168}}
```

Absent, nothing changes: no ceiling is imposed on a deployment that did not ask for one. Past the
ceiling the relay answers `403 permission_error` before forwarding — the refusal costs nothing and
the provider never sees the request — and the message says what the limit is, what has been spent,
when the allowance starts coming back, and that the operator sets it.

A money ceiling needs a rate for every model used. When one is missing the spend is a floor rather
than a total, so the relay **refuses and names the model**: a limit that cannot be measured is not a
limit, and an unpriced model would otherwise walk straight through it. A token ceiling needs no
rates at all, which is the one to reach for when the rate table is not kept up to date.
