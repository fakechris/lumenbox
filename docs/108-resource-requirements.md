<!-- doc: 108-resource-requirements
     title: Resource requirements and capacity sizing
     family: guide
     status: current
     updated: 2026-11-27
-->
# Resource requirements and capacity sizing

What one box, one server and the desktop app need in CPU, memory and disk, across a Kubernetes
cluster and a personal machine. Every default below comes from the deployment manifests
(`deploy/kubernetes/`), the allocation policy (`src/control/policy.ts`), the box launchers
(`src/control/kube-box.ts`, `src/box/docker.ts`, `src/box/box-cpus.ts`), and the desktop shell
(`electron/main.cjs`).

## 1. At a glance

| Component | CPU | Memory | Disk |
|---|---|---|---|
| **Kubernetes server pod** (`organisation.yaml` or `control-plane.yaml`) | Unset in manifest; recommend `250m–500m` request, `1–2` cores limit | Unset in manifest (`1Gi` request / `4Gi` limit when `quota.yaml` is applied); `512Mi–2Gi` is enough in practice | `1Gi` RWO PVC (`5Gi–20Gi` recommended with automated backups), plus ~1.6 GB node image cache |
| **Kubernetes box pod** (one per box or per tenant) | Unset by default (`staticPolicy`); recommend `2` request / `4` limit on shared nodes | **`4Gi` request and limit** by default (`AGENTBOX_K8S_MEMORY`, includes `1Gi` `/dev/shm`); `2Gi` practical minimum for a single desktop | **`30Gi` total** by default: three `10Gi` RWO PVCs (`work`, `config`, `hostd`; `AGENTBOX_K8S_STORAGE`), plus ~1.6 GB node image cache |
| **Desktop app (remote connections only)** | 2+ cores (< 5% of one core when idle) | ~0.4–1.2 GB steady state; renderer auto-recycles above `2048 MB` (`LUMENBOX_MEMGUARD_MB`) | ~380 MB unpacked app (~140 MB `.dmg`), ~1–2 GB free space including logs and local state |
| **Desktop app + local Docker box** | Box capped at `max(2, floor(engine_cores / 2))` cores (`AGENTBOX_CPUS`); **4 cores minimum, 8+ cores recommended** on the machine | Box capped at `4g` (`AGENTBOX_MEMORY`); **8 GB RAM minimum, 16 GB+ recommended** on the machine | ~0.4 GB app + ~1.6 GB box image + Docker volumes; **10 GB free minimum, 25 GB+ recommended** |

## 2. Kubernetes deployments

Both Kubernetes topologies — an organisation server (`deploy/kubernetes/organisation.yaml`, one
pod per box via `src/box/kubernetes-box.ts`) and the multi-tenant control plane
(`deploy/kubernetes/control-plane.yaml`, one pod per tenant via `src/control/kubernetes.ts`) —
create box pods through `KubeBoxes` (`src/control/kube-box.ts`) and size them through
`AllocationPolicy` (`src/control/policy.ts`).

### 2.1 Per-box pod resources

- **Memory (`AGENTBOX_K8S_MEMORY`, default `4Gi`).** `staticDecision()` sets `memoryRequest` and
  `memoryLimit` to the same value (`4Gi`), giving the container guaranteed memory reservation at
  schedule time. Every box pod also mounts `/dev/shm` as an in-memory `emptyDir`
  (`medium: Memory`, `sizeLimit: 1Gi`), which Kubernetes counts against the container's memory
  limit. Inside the box, each background shell job is capped at `BOXD_JOB_MEMORY_MB=1024` (1 GiB
  RSS, polled every 3 s).
- **CPU (unset by default).** `staticDecision()` omits `cpuRequest` and `cpuLimit` so boxes can
  burst on idle cores; inside the box, agent work runs at `BOXD_AGENT_NICE=19` behind the desktop
  and VNC processes. If your namespace enforces a CPU `ResourceQuota`, supply defaults through a
  `LimitRange` or replace `staticPolicy()` with explicit `cpuRequest` / `cpuLimit` (for example
  `cpuRequest: "2"`, `cpuLimit: "4"` for compute-heavy tiers; see
  [ONBOARDING.md](../deploy/kubernetes/ONBOARDING.md#6-capacity)).
- **Persistent volumes (`AGENTBOX_K8S_STORAGE`, default `10Gi` per PVC, `30Gi` per box).** Every
  box claims three `ReadWriteOnce` PVCs sized identically:
  1. `<box>-work` mounted at `/home/box/work` — agent workspace, desktop recordings, job logs and
     exec spool.
  2. `<box>-config` mounted at `/home/box/.config` — Chromium profiles, logins and desktop config.
  3. `<box>-hostd` mounted at `/home/hostd/.agentbox` — in-box orchestrator state (used by
     control-plane tenant boxes; mounted empty on externally driven personal boxes).
- **Work-volume retention and low-disk waterlines (`docs/06-deployment.md` §4).** `boxd` bounds
  its own disk growth on `/home/box/work`: ended job logs keep 7 days / `1024 MB`
  (`BOXD_LOG_KEEP_MB`), desktop recordings keep 14 days / `2048 MB` (`BOXD_RECORDINGS_KEEP_MB`),
  the exec spool keeps 1 day / `512 MB` (`BOXD_SPOOL_KEEP_MB`), and one job may write at most
  `1024 MB` (`BOXD_JOB_OUTPUT_MAX_MB`). When free space on `/home/box/work` drops below
  `max(512 MiB, 5%)`, new background jobs and recordings are refused (`BOXD_RECORDINGS_MIN_FREE_MB=512`),
  and `box-doctor` warns below `1024 MB` free and fails below `200 MB` free.
- **Node image cache.** Each worker node needs ~1.6 GB of node ephemeral storage for the unpacked
  Debian 12 box image (~750 MB compressed pull). Keep ~4 GB free on the node filesystem when
  pre-pulling a new release tag alongside the current one (`scripts/k8s-prewarm.ts`).

### 2.2 Control-plane and organisation server pods

Both `agentbox-control` and `agentbox-organisation` run a single replica (`replicas: 1`,
`strategy: Recreate`) because state lives on one `ReadWriteOnce` volume (`/state`). Neither sits
in the compute or browser path of a box:

- **CPU and memory.** A single Node.js 22 process (`/opt/hostd/hostd.mjs`) handles HTTP/WebSocket
  routing, channel sockets, authentication and model-relay streaming. Plan `250m–500m` CPU request
  (`1–2` cores limit) and `512Mi–1Gi` memory request (`2Gi` limit; `quota.yaml`'s `LimitRange`
  assigns `1Gi` request / `4Gi` limit when the manifest leaves resources unset).
- **State storage.** Both manifests request a `1Gi` RWO PVC (`agentbox-control-state` or
  `agentbox-organisation-state`). For production organisations keeping multi-month transcripts or
  scheduled backups (`AGENTBOX_BACKUP_HOURS`, default 7 copies kept via `AGENTBOX_BACKUP_KEEP`),
  size `/state` at `5Gi–20Gi` or write backups to external storage.

### 2.3 Namespace quota and node sizing

`deploy/kubernetes/quota.yaml` ships an optional namespace ceiling tuned for roughly **15 boxes**
plus the server pod at default sizes:

- `requests.memory: 64Gi` and `limits.memory: 64Gi` (15 × `4Gi` boxes + server headroom)
- `persistentvolumeclaims: "60"` (3 PVCs × 15 boxes = 45, plus `/state` and spare claims)
- `requests.storage: 200Gi` (raise to `500Gi+` if 15 boxes all claim `30Gi` without thin
  provisioning)
- `LimitRange` container ceiling: `defaultRequest: 1Gi`, `default: 4Gi`, `max: 8Gi`

Worker node sizing: reserve kubelet / system daemon overhead before dividing node RAM by `4Gi`.
An `8 GiB` node comfortably schedules **1** default `4Gi` box; a `32 GiB` node (8 vCPU) schedules
**6–7** boxes; a `64 GiB` node (16 vCPU) schedules **13–14** boxes.

## 3. Box memory floor: desktop + Chromium breakdown

When sizing boxes below the `4Gi` default, the floor is set by the X11 desktop stack plus
Chromium with accessibility enabled.

### 3.1 Measured baseline inside a running box

Measured on the Debian 12 box image at `1280×800×24` (`docker/box/Dockerfile`, `start-display`,
`box-chrome`):

| Layer | Resident memory (RSS) | What runs |
|---|---|---|
| **Daemon + 1 idle desktop (no browser)** | **~190 MiB** | `boxd` (~55 MiB), driving + view-only VNC stacks (`2 × websockify` ~59 MiB, `2 × x11vnc -noxdamage -noshm` ~29 MiB), `Xvfb` (~21 MiB), `xfwm4` (~21 MiB), `plank` (~13 MiB), `xwatchdog` (~11 MiB), `at-spi` bus + `picom` + `dbus` + `autocutsel` (~25 MiB) |
| **In-box orchestrator (`hostd`, when enabled)** | **+120–250 MiB** | Present when `AGENTBOX_HOST_ENABLED=1` (control-plane tenant pods and `--with-host` Docker boxes); absent on externally driven personal boxes |
| **Chromium base (`box-chrome`, blank / simple page)** | **+250–350 MiB** | Browser process, network/storage utilities, and software rasterizer (`--no-sandbox --disable-gpu --disable-dev-shm-usage`, no GPU in container) |
| **Active web applications (1–5 complex SPA tabs)** | **+300–900 MiB** | `box-chrome` sets `ACCESSIBILITY_ENABLED=1` and `--force-renderer-accessibility` so `box-ax` can read the AT-SPI tree (`docs/solutions/chromium-156-needs-accessibility-enabled.md`), which adds ~30–50% to renderer memory on DOM-heavy pages |
| **Capture and tool spikes** | **+80–250 MiB** | `ffmpeg -f x11grab` WebP frame capture, `box-ax` queries, and shell commands |

Idle desktops are reclaimed after **15 minutes** without operations, viewers or pins
(`BOXD_DESKTOP_IDLE_MS`, `src/boxd/desktop-resources.ts`), returning a dormant display's X11 and
VNC memory until the next turn touches it.

### 3.2 Minimum memory tiers per box

| Box memory limit | Viable workload | Tuning notes |
|---|---|---|
| `1Gi` | Headless shell or bare X11 desktop without modern web apps | Opening DOM-heavy pages with `--force-renderer-accessibility` + screenshot capture risks renderer OOM kills |
| **`1.5Gi`** | **Hard floor** — externally driven box (no `hostd`), **1 desktop**, Chromium with **1–2 light tabs**, no heavy build jobs | Set `BOXD_JOB_MEMORY_MB=384` so a background command cannot starve Chromium |
| **`2Gi`** | **Practical minimum** — **1 desktop**, Chromium with **3–5 modern SPA tabs**, normal CUA capture and light CLI work (`2.5Gi` if `AGENTBOX_HOST_ENABLED=1`) | Lower `BOXD_JOB_MEMORY_MB` from `1024` to `512` so one shell job cannot claim half the container |
| **`4Gi` (default)** | **Standard multi-agent box** — `hostd` + **2–3 concurrent agent desktops** (each display `:N` runs its own Xvfb, VNC stack and `box-chrome` profile) + `1 GiB` build/test jobs | Matches `AGENTBOX_MEMORY=4g` and `AGENTBOX_K8S_MEMORY=4Gi` |
| `8Gi` | Heavy repository builds, data workloads, or 4+ concurrent browser-driving agents in one box | Aligns with `quota.yaml`'s `LimitRange` `max: 8Gi` |

## 4. Desktop app (Electron) requirements

The desktop app (`electron/main.cjs`) has two resource profiles depending on the machine use
chosen on first run (`docs/96-box-hosts.md` §3): connecting to remote installations only, or
running a Docker box on this computer.

### 4.1 The Electron shell and local orchestrator (without local Docker)

When the person works purely in remote Kubernetes organisations or attached remote VMs, this
computer runs only the Electron shell and its local Node children:

- **CPU.** Any modern dual-core or better processor; idle load is under 5% of one core. The shell
  runs the Electron main process, one renderer window, and (when a personal installation is
  present) two `ELECTRON_RUN_AS_NODE` children (`web` and `supervision`), plus a 20-second count
  poll per connected organisation (`electron/installation-views.cjs`).
- **Memory.** Steady-state footprint is **~400 MB–1.2 GB** (~200–400 MB across main + `web` +
  `supervision`, plus the Chromium renderer). A built-in **renderer memory guard**
  (`electron/main.cjs`, `LUMENBOX_MEMGUARD_MB`, default `2048` MB) checks `vmmap` physical
  footprint every 10 minutes and reloads the stateless UI once an active turn finishes if Chromium
  pools exceed **2 GB**. Each connected organisation opens an isolated in-memory `WebContentsView`
  (`cache: false`), adding roughly **150–300 MB** while loaded.
- **Disk.** The packaged `.dmg` / `.zip` is **~140 MB**; unpacked in `/Applications/LumenBox.app`
  (`asar: false` in `package.json`), the app occupies **~370–380 MB**. Logs under
  `~/Library/Logs/LumenBox/` (`server.log`, `supervision.log`) rotate at `5 MB` keeping one `.1`
  copy (~20 MB ceiling). Local state in `~/.agentbox` (config, tokens, JSONL transcripts and up to
  7 backups when enabled) fits comfortably inside **1–2 GB** of free disk space.

### 4.2 Personal machine or organisation node (with a local Docker box)

Running the default local box (`agentbox-box`) adds Docker Desktop or OrbStack plus the Linux box
container (`src/box/docker.ts`, `src/box/box-cpus.ts`):

- **CPU.** `ensureCpuLimit()` caps the box container at **half the Docker engine's cores, with a
  floor of 2 cores** (`Math.max(2, Math.floor(NCPU / 2))`), adjustable live via `AGENTBOX_CPUS` or
  Settings → Boxes (`boxCpus`). Plan **4 cores minimum** on the machine (2 for the box, 2 for the
  OS and Electron) and **8+ cores recommended** (Apple Silicon M-series or 8-core x64).
- **Memory.** `docker run` sets `--memory 4g` (`AGENTBOX_MEMORY`) and `--shm-size 1g`. Including
  macOS, the Linux VM inside Docker Desktop / OrbStack, and the Electron shell:
  - **Minimum machine RAM:** **8 GB** (tight with a `4g` box; lower `AGENTBOX_MEMORY=2g` if the
    machine runs other heavy apps and only needs one agent desktop).
  - **Recommended machine RAM:** **16 GB or 32 GB** (comfortable headroom for a `4g` box, the
    Electron app, and local development tools).
- **Disk.** The unpacked box image takes **~1.6 GB** inside the Docker VM (~750 MB download), on
  top of the ~0.4 GB `.app` bundle, Docker's own VM base disk, and the `agentbox-box-work` /
  `agentbox-box-config` named volumes:
  - **Minimum free disk space:** **10 GB+** (below `512 MiB` free on the work volume, recordings
    and new background jobs stop).
  - **Recommended free disk space:** **25 GB+** so box image upgrades (`Apply update`, which pulls
    the new image before recreating the container and keeps the old tag for rollback) and workspace
    artifacts never hit the low-disk waterline.
