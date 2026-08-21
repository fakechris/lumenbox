# Deployment

## 1. Requirements

| | Driven from outside | Self-contained |
| --- | --- | --- |
| Docker engine | yes | yes |
| Node ≥ 22.18 on the operator's machine | yes | no |
| A checkout | yes | no, once the image is built |
| A browser | to watch | the only thing needed |

The image is Debian 12, about 1.6GB, and builds on `amd64` and `arm64`.

## 2. Ports

| Port | Bound | Published | Carries |
| --- | --- | --- | --- |
| 1337 | 0.0.0.0 in the container | yes, ephemeral | boxd — the whole API, bearer-authenticated |
| 7777 | 0.0.0.0 in the container | `127.0.0.1:7777`, only with `--with-host` | The web UI |
| 5900+N | container loopback | no | x11vnc per desktop |
| 6080+N | container loopback | no | noVNC per desktop, proxied through 1337 |
| 8791 | container loopback | no | The egress proxy |
| 8790 | the operator's machine | n/a | The egress relay |

Only 1337 and, in the self-contained shape, 7777 leave the container. Everything per-desktop is
proxied, so adding a desktop does not need a port mapping decided at create time.

## 3. Starting it

### 3.1 Driven from outside

```bash
npm install && npm run build && npm run build:box
node dist/cli.js box build
node dist/cli.js box up
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

## 4. Configuration

**Environment** for what changes per run:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTBOX_HOME` | `~/.agentbox` | State directory |
| `AGENTBOX_TOKEN` | generated | Box API bearer |
| `AGENTBOX_UI_TOKEN` | generated when not on loopback | UI secret |
| `AGENTBOX_BOXD_URL` | — | Attach to a box instead of using Docker |
| `AGENTBOX_PROVIDER` / `_MODEL` / `_BASE_URL` / `_KEY_ENV` / `_AUTH` | anthropic | Which endpoint |
| `ANTHROPIC_API_KEY`, `MINIMAX_CODE_CN_API_KEY`, `AGENTBOX_API_KEY` | — | Model credential |
| `AGENTBOX_WIDTH` / `_HEIGHT` | 1280×800 | Desktop size |
| `AGENTBOX_MEMORY` / `_CPUS` | 4g / unset | Container limits |
| `AGENTBOX_EGRESS_RELAY` / `_TOKEN` | — | Egress |
| `AGENTBOX_SETTLE_MS` | 2000 | Capture settle |
| `AGENTBOX_MAX_ROUNDS` | 400 | Turn round limit |
| `BOXD_AGENT_NICE` | 19 | How far behind the desktop the agent runs |
| `BOXD_SUPERVISE_MS`, `BOXD_MAX_RESTARTS`, `BOXD_RESTART_WINDOW_MS`, `BOXD_BACKOFF_*`, `BOXD_GIVE_UP_EPISODES` | see design | Supervision tuning |

**`config.json`** for what is decided once: currently `activityLimit`.

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
- **Egress is off unless configured**, and the relay refuses to run without a token.

For anything shared, the three things to add are identities, per-tenant boxes, and a credential
relay so the model key never enters a box. The seams are named in
[03-architecture.md](03-architecture.md) §7.
