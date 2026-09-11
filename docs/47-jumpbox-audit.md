# 47 · Jump-box behaviour audit

*2026-09-09. A disclosed audit trail for a company operations jump box, and the line between that
and a keylogger. This started as a covert, credential-capturing, tamper-proof surveillance daemon;
this note is why it isn't one, and what it is instead.*

## What this is for

A LumenBox box is used as a company **operations jump box** (a bastion): people with sudo do ops
work on it, and the company needs a behaviour audit — who ran what, when, under which enterprise
identity. That is a legitimate, standard thing, on the two conditions a bastion always meets:

1. **It is disclosed.** The person is told, plainly, on entry: this is a company ops box, the
   session is recorded and audited to their identity, and it is for company work, not personal
   use. Told once on the label they already read — not a popup that fires each time.
2. **It audits actions, not content.** Commands run, windows focused, the auditor's own health.
   Not keystrokes, not mouse coordinates, not what was typed into a browser or a password field.

## What it is not

The first cut of this was the opposite of a bastion audit, and every property that made it so was
removed:

- **It captured keystroke content** off X11, with a "redaction" that triggered on the *window
  title* containing "password"/"sudo". A sudo prompt in a terminal titled "Terminal" would have
  been recorded in cleartext. Recording everything typed in every window, credentials included,
  is a keylogger; the redaction made it a keylogger that lied about it. **Removed** — the daemon
  records `window_focus` (which app was in front) and nothing typed. (It was also dead code: no
  X input hook ever called it. The summary that shipped described a capability that did not exist.)
- **It was framed as covert** ("伪装", "opaque system daemon"). A disclosed audit has no reason to
  hide; concealment is what turns audit into surveillance, and it contradicts this product's whole
  stance (the box already tells people "nothing here is private"). **Removed** from name and docs.
- **Its anti-tamper claimed root could not undo it** (`chattr +i` + a `--cap-drop` that was never
  configured and would have been self-contradictory). On a box where the user has sudo, that claim
  is false. **Corrected**, and the real guarantee moved off-box (below).
- **The events endpoint had no role gate** — any signed-in session, including a viewer, could pull
  the audit stream. **Now admin-only.**

## How commands are audited (the "how do you see xterm commands without a keylogger" question)

You record the shell, not the keyboard. Three layers, in order of what exists:

1. **Snoopy (execve), shipped and working.** `LD_PRELOAD` hooks `execve`, so every program a shell
   runs — including in xterm, however it was typed — is logged with full argv, uid, tty, pwd, pid,
   *before* it runs. This is the command audit. It is why "we don't keylog" does not mean "we
   can't see what was run in the terminal": we already do.
2. **Shell command-line audit (optional, not yet built).** Snoopy misses shell builtins (`cd`,
   `export`, `history -c`) and the exact typed line. A disclosed `PROMPT_COMMAND`/`trap DEBUG`
   hook, or a full-session recorder (`tlog`, `script`), captures those — scoped to the shell
   session, not the X keyboard. Offered as the next slice if builtin-level fidelity is wanted.
3. **Full session replay (optional).** `tlog`/`script` record the terminal I/O stream for replay,
   the way Teleport and PSM do. Disclosed, per-session, TTY-scoped — still not a global keylogger.

The distinction that matters: **X11 global key capture** sweeps up every window (browser
passwords, chat, personal) and is a keylogger; **shell/TTY audit** is scoped to the ops shell and
is what a bastion does.

## Tamper-evidence when the box user has sudo

The box user can sudo, so nothing *inside* the box truly stops them disabling the auditor:
`chattr -i`, `rm /etc/ld.so.preload`, `kill -9 xwatchdog` are all within reach, and `chattr +i`
is defeated by the same caps that set it. Pretending otherwise is the false-security failure this
project keeps deleting. So the guarantee lives where the box user has no authority — **the host**:

1. **Heartbeat.** The daemon emits a `system/heartbeat` event every 10s. The host pulls events by
   sequence (`since_seq`), a channel the box cannot suppress. A killed daemon stops answering; the
   host marks the session `at_risk` and logs a **high-risk** line naming the box. SIGKILL cannot
   be caught, but it cannot fake a heartbeat either.
2. **The kill is self-reporting.** Disabling the auditor is itself a command — `sudo rm
   /etc/ld.so.preload`, `kill …` — and Snoopy execve-logs it before it takes effect. The last
   thing in the log is the tampering.
3. **Exfiltration, not local immutability.** The integrity of the record is that it has already
   left the box: the host has pulled it within seconds. Append-only + immutable flags are kept as
   best-effort friction, documented as friction, not as a boundary.

`at_risk` currently keys on "did the daemon answer" — authoritative and false-positive free for
the kill case. Catching a *wedged* (alive but stuck) daemon reliably needs the host to track the
maximum heartbeat time across polls; that is the next slice.

## 资源上限（Bounded disk & memory footprint）

本地落盘是**有界近窗**（bounded near-window）而非无期限全量归档；容器通常分配紧凑磁盘，审计落盘
绝不能因无上限追加撑爆容器根分区（INV-462）：

1. **events.jsonl 环形压实（compact-from-ring）**：`EventStore` 是宿主按 seq 增量拉取的耐久层，
   内存环已有界（默认 20,000 条）。当落盘文件超过上限（默认 32MB，环境变量 `AGENTBOX_AUDIT_EVENTS_MB` 可调）
   时，自动从内存环重写文件（保留半数预算的最热近窗事件）并重开追加模式；启动时以现有文件大小为种子，
   保证历史巨型文件在守护启动首次写入时即刻被压实。
2. **exec.log 原地 copy-truncate 保尾**：Snoopy 独占写入该日志，守护进程每 30 秒巡检一次，超过
   上限（默认 64MB，环境变量 `AGENTBOX_AUDIT_EXEC_MB` 可调）时就地截断并保留后半段有效内容，丢弃
   可能残缺的首行；`TailSnoopyLog` 在检测到该截断后平滑调整偏移量至新尾部，无缝续读且无重复事件。
3. **Snoopy 祖先过滤**：在 `/etc/snoopy.ini` 中启用 `filter_chain = "exclude_spawns_of:start-display,box-healthcheck"`，
   使高频自愈巡检与探针在 `execve()` 拦截层直接被丢弃，源头降噪 99% 以上，同时完好保留所有终端交互与 agent 工具调用。
   `exclude_spawns_of` 只覆盖两者的*子进程*；`box-healthcheck` 自身的 exec 行由容器健康探针拉起，祖先链在容器之外，
   且 Snoopy 2.5.2 没有 `exclude_comm` 过滤器——因此这一行（每 10 秒一条）改由 `xwatchdog` 在摄取层丢弃
   （`IsSupervisorSelfExec`），`exec.log` 保留原始记录，事件流不占内存环与落盘预算；boxd 文件回退路径与
   Web UI 则将其归类为 probe，默认隐藏。
4. **单实例守护**：`start-display` 仅由主桌面（`:1`）拉起 `xwatchdog`，消除多桌面后台轮询的端口冲突。

## Surfaces

- **Disclosure (web):** appended to the box's existing notice (`#boxnotice`) when the installation
  runs the auditor (`AGENTBOX_AUDIT=1`) — one label, no popup.
- **Disclosure (shell):** `/etc/motd`, shown once at login, the bastion convention.
- **Audit stream (host):** `GET /api/xwatchdog/events?boxId=&since=&limit=`, admin-only, carrying
  `daemon_up`, `heartbeat_age_ms`, `at_risk`.
- **Daemon:** `src/xwatchdog/` (Go), on `127.0.0.1:49099`, started and self-healed by
  `start-display`; box service `src/boxd/xwatchdog-service.ts` proxies it and falls back to the
  persisted log.

## Policy

For company operations only. Not to be pointed at anyone's personal or private activity, and not
to be run undisclosed. The disclosure is not decoration — it is the condition that makes this an
audit rather than surveillance.

## Not done

- Shell builtin / full-session recording (layers 2–3 above).
- Host-side wedge detection (max-heartbeat tracking) and a standing collector that alarms without
  someone reading the endpoint; today `at_risk` surfaces on pull and in the host log.
- A central, tenant-scoped audit table binding events to the enterprise principal for retention.
- A UI that shows a session red when `at_risk`.
