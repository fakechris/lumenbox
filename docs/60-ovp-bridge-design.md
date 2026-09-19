<!-- doc: 60-ovp-bridge-design
     title: OVP 接入程序（ovp-bridge）详细方案：哪个 vault、什么触发、保证什么
     family: decision
     status: superseded
     superseded-by: 61-ovp-bridge-design-v2
     why: §15 复审后按九项修订重写；第二版一个 id 贯穿、每个对象有终态、对 OVP 只提通用改动
     updated: 2026-09-19
-->
# 60. OVP 接入程序（ovp-bridge）详细方案：哪个 vault、什么触发、保证什么

送审稿第一版，2026-09-19；§15 是同日 codex 第二轮复审的裁定，与 §0–14 冲突处以 §15 为准。承接 docs/58（功课）和 docs/59（路线 review，含 §9 复审、§10
数据流）。本文回答两个被问到的问题，然后把接入程序写到能开工的粒度：对象与身份、触发
与保证、vault 布局与文件 schema、host 模块、OVP 侧约定、box 侧两个 skill、交付回执、
失败表、验收、分段。末尾是给下一轮 review 的问题。

## 0. 两个问题的直接回答

**Q：这个 vault 是单独配给 LumenBox 的，还是用户日常的 vault？**
**A：日常 vault，同一个。** 选路线 B 的全部理由是「一个真相层」：飞书里丢的链接和
Obsidian Web Clipper / Pinboard 存的文章进同一个 crystal 账本，跨源 claim 才能跨这两个
入口。OVP 也是按单 operator 单 vault 设计的，两个 vault 就是两个互不引用的账本。
代价是接入程序在往一个人每天用的目录里写东西，所以本文用四道栏杆换这个决定：
1. **写入白名单只有两处**：`50-Inbox/00-Capture/`（OVP 认可的唯一投递口）和一个新的顶层
   归档目录 `60-Agent/lumenbox/`（不在 OVP 的三个 sweep 目录里，OVP 不会碰，Obsidian 能看）。
   其余任何路径写入都是 bug，由测试守。
2. **首周走 staging**：配置项 `ovp.vaultRoot` 先指向一个空的 staging vault 跑一周，验证
   对账和幂等；切到日常 vault 是改一行配置。OVP 按文件 sha256 认身份，staging 里的
   capture 复制到日常 vault 的 capture 目录会被当新文件正常吃掉，归档区整目录搬。
3. **每条 capture 打 `lumenbox` 和渠道 tag**，用户在 Obsidian 里加 `ovp/skip` 就停掉这条，
   和 Pinboard 来的书签同一套人工控制。
4. **kill switch**：`ovp.enabled: false` 或例程 `paused: true`，接入程序停在 checkpoint，
   恢复后从 checkpoint 续，不会补一周的洪水（`--max-sources` 限流）。

**Q：有没有触发条件能保证自动写入 vault 并处理？**
**A：有，但要说清「保证」的语义。** 保证的是「至少一次 + 幂等 + 每个输入到达终态或被
显式标为未知」，不是「恰好一次」，也不是「一定产生 pack」。四个触发器在 §3：账本扫描
（每 5 分钟）、有新 capture 就跑 `ovp2 daily`、日界到点出当日包、投递后回收回执。每个
触发器都有失败后的留痕和重试规则，并且有一条 `ovp-bridge doctor` 对账命令把「今天有几条
输入没走到终态」变成一个数字。

## 1. 对象与身份

| 对象 | 身份键 | 今天在哪（已核实） | 备注 |
|---|---|---|---|
| 消息 | inbox 消息 id（uuid） | `inbox.jsonl` admitted 行的 `message.id`；transcript user 行的 `causedBy[0]`（今天 24/24 对上） | 飞书 `om_` id 经 `cards.jsonl` 的 taskId ↔ handle 关联 |
| turn | turn id + workId | `turns.jsonl` begin/end | **和消息之间没有 id 级关联**：begin 行只有 `about`（消息文本前缀）和时间；今天靠「同 conversation、begin.at 在 admitted.at 之后 2 秒内、about 是 text 前缀」能配上，但这是推断不是键 |
| 来源 | 文件 sha256（主）、规范化 URL（副） | OVP `.ovp/intake.jsonl` 的 `sha256` / `url` | OVP 定义，接入程序不另造 |
| research 产物 | turn id | box `sent/<file>.md`（文件名是 Nova 起的，不含 id） | 靠 activity.jsonl 里该 turn 的 `write_file` 路径对应 |
| 摘要运行 | 日期 + 清单版本 | 新 | 见 §4.4 manifest |
| 交付 | 摘要运行 + 投递记录 | `deliveries.jsonl` 只有 open/close，没有「发到了飞书哪条消息」 | 见 §8 |

**一处 host 改动请求（唯一动核心的地方）。** turn ↔ 消息靠时间推断是 docs/59 §9 R4
「不能靠文件名和模型回忆推测」的直接违反。建议 `turns.jsonl` 的 begin 行增加
`wokenBy: [<inbox message id>…]`（`src/host/turn.ts:1301` 附近已有 workId，orchestrator 知道
是哪些 inbox 消息触发了这次 turn）。字段是追加的，旧行没有它就回退到时间推断并在
manifest 里标 `join: inferred`。这是 docs/13 的第 2 类（持久格式变更），本身要过 review。

## 2. 数据流总图

```text
飞书 ──▶ LumenBox host（ingress/inbox/transcript/turns/activity 账本）──▶ box turn ──▶ sent/*.md
                       │                                                       │
                       │  T1 每 5 分钟扫账本                                   │ T1 读 sent
                       ▼                                                       ▼
              ovp-bridge（host 进程 / cli 子命令）
                  │ A 归档  ─────────▶ <vault>/60-Agent/lumenbox/<chat>/<date>/<msgid>.md
                  │ A' 归档回复/过程 ─▶ …/<msgid>.reply.md  …/<msgid>.research.jsonl
                  │ B 投源  ─────────▶ <vault>/50-Inbox/00-Capture/lumenbox_<date>_<slug>-<msgid8>.md
                  │ T2 有新 capture ─▶ exec ovp2 daily（RunLock、--max-sources）
                  │ C' 回读 ◀──────── .ovp/intake.jsonl  .ovp/daily-runs.jsonl  .ovp/index/index.json
                  │ T3 日界 ─────────▶ exec ovp2 crystal-synth；ovp2 index
                  │ D 对账 ─────────▶ …/digest/<date>/manifest.v<N>.json
                  │ E 推包 ─────────▶ box:/home/box/work/digest/<date>/{manifest.json, packs/…}
                  │                          │
                  │                          ▼ box 日终 skill（schedule: 22:10）：只读本地包
                  │                          │ 写 outbox/<date>_digest.md → deliver: 飞书
                  │ F 回收 ◀──────────────────┘ BoxClient.readFile；投递结果
                  └─────────────────▶ <vault>/10-Knowledge/Digests/<date>.md + manifest 交付字段
```

box 不挂 vault、不装 ovp2、不连 OVP 的网络。三条物理连接都是 host 已有能力：读自己的账本、
`BoxClient.readFile / writeFile`、Mac 文件系统 + `ovp2` 命令行。

## 3. 触发与保证

### 3.1 三个状态机

**每条输入（消息）**
```
admitted ─▶ archived ─▶ [每个 URL] captured ─▶ intake: ingested | duplicate(dup_of) | needs-content | unparseable | unknown
                                            ─▶ reader: pack(units,cards) | zero-unit | failed(reason) | blocked(3 strikes) | not-run
终态 = archived 且每个 URL 的 intake ≠ unknown 且 reader ≠ not-run（或 intake 为 duplicate / unparseable）
无 URL 的消息（纯文字 / 附件）：archived 即终态；附件见 §5.6
```
**每个 turn**
```
begin ─▶ end(done | failed | …) ─▶ reply-archived | no-artifact(显式记录)
```
**每个摘要运行**
```
manifest.v<N> ─▶ pushed ─▶ digest-produced | skill-did-not-run ─▶ delivered(receipt) | delivery-unknown ─▶ collected
```

### 3.2 四个触发器

| 触发器 | 谁 | 何时 | 做什么 | 幂等键 | 失败留痕 / 重试 |
|---|---|---|---|---|---|
| T1 扫描 | ovp-bridge（launchd 或 host 内定时器） | 每 5 分钟 | 读 checkpoint 之后的账本行：新 admitted 消息 → A + B；新 turn end → A' | 消息 id；turn id | 任一步失败，该消息不推进 checkpoint，记 `bridge.jsonl` 一行 `retry`；连续 5 次失败标 `stuck` 并计入 doctor |
| T2 处理 | ovp-bridge | T1 写入 ≥ 1 个 capture 后，或距上次 ≥ 60 分钟且有未处理 capture | `ovp2 schedule run-now daily --unless-ran-within-secs 120`（与桌面时钟去重；OVP 自己的 RunLock 防并发）；然后 C' 回读处置 | OVP run_id（`daily-<date>`） | exit ≠ 0 照记；回读不到处置 = `unknown`，下次 T1 再回读；3 次 blocked 由 OVP 记，bridge 只搬状态 |
| T3 日界 | ovp-bridge | 每天 22:00 Asia/Shanghai（窗口 = 前一天 22:00 ≤ admitted.at < 今天 22:00） | `crystal-synth --max-seeds 25` → `ovp2 index` → D 对账（manifest.v1）→ E 推包 | 日期 + 版本 | 任一步失败：manifest 仍写，`status: partial`，列出缺口；box 例程读到 partial 照常跑但日报头一行说明 |
| T4 回收 | ovp-bridge | box 例程结束后（T1 的下一次扫描发现 `outbox/<date>_digest.md` 已投递，或超时 40 分钟） | F：日报拷回 vault；投递结果写 manifest | 日期 + 版本 | 投递结果查不到 = `delivery-unknown`，不宣称已送达；下次扫描再查 |

**日界规则。** 22:00 之后来的消息进第二天的窗口；当天 22:00 的 manifest 覆盖的是一个
明确的半开区间，附录的「今天」以此为准，不是自然日。若 22:00–22:10 之间 T2 还在跑，
manifest 仍按当时的处置生成并标 `pending: [ids]`，第二天的 manifest 会把它们收进去并标
`carried-from: <date>`。不重跑昨天的日报。

**「保证」的边界。** 至少一次：每一步以 checkpoint 之后的账本行为输入，写完再推进；重启
最多重做一步，重做靠键幂等。终态：doctor 能列出「admitted 但未 archived」「captured 但
intake unknown」「ingested 但 reader not-run」三个集合，非空就是待办。不保证：恰好一次
投递（§8）、一定产生 pack（短文、抓取失败、OVP 判不值得蒸馏都合法）、当天 22:00 前
OVP 一定跑完（partial 是一等状态）。

### 3.3 触发器怎么装

- T1/T2/T3/T4 都是 `agentbox ovp-bridge <scan|process|day|collect>` 四个子命令（`src/cli.ts`
  新增），无状态、可手跑。定时用 launchd（Mac 上 host 进程本身就是 launchd/手启的），
  每 5 分钟跑 `scan` 再 `process`；22:00 跑 `day`。不用 LumenBox 的 `schedule:`，因为那会
  起一个 agent turn、花 token、且时钟在 box 侧例程里。
- box 侧只有一个 `schedule: 10 22 * * *` 的日终 skill。它和 T3 是时间耦合的，所以包里有
  `status: ready | partial | absent`，skill 先看状态再动手；absent 时回一行「今天的包没到」。
- 也注册一个 extension 工具 `ext__ovp_bridge_status`，让 Nova 在逐条回复时能问「这条 URL
  的来源处置是什么」——只读。

## 4. vault 布局与文件 schema

### 4.1 写入白名单

```
<vault>/50-Inbox/00-Capture/lumenbox_<YYYY-MM-DD>_<slug>-<msgid8>.md      ← 只有 B 写
<vault>/60-Agent/lumenbox/<channel>/<chat>/<YYYY-MM-DD>/<msgid>.md          ← A
<vault>/60-Agent/lumenbox/<channel>/<chat>/<YYYY-MM-DD>/<msgid>.reply.md    ← A'
<vault>/60-Agent/lumenbox/<channel>/<chat>/<YYYY-MM-DD>/<msgid>.research.jsonl
<vault>/60-Agent/lumenbox/<channel>/<chat>/<YYYY-MM-DD>/attachments/<file>  ← §5.6
<vault>/60-Agent/lumenbox/digest/<YYYY-MM-DD>/manifest.v<N>.json           ← D
<vault>/10-Knowledge/Digests/<YYYY-MM-DD>.md                                ← F
```
capture 文件名平铺加 `lumenbox_` 前缀，不用子目录——OVP 的 sweep 是否递归子目录未核实
（§13）。`60-Agent/` 是新顶层目录；OVP 只 sweep `Clippings/`、`00-Capture/`、`02-Pinboard/`
（`vault_layout.rs:110`），不会碰它。`10-Knowledge/Crystal/` 是 OVP 管理的，`Digests/`
与之并列。

### 4.2 归档文件 `<msgid>.md`

```yaml
---
schema: lumenbox.archive/v1
message_id: e855206b-…            # inbox 消息 id
feishu_message_id: om_x100…       # 经 cards.jsonl 关联；关联不到留空并 join: missing
channel: feishu-personal
chat_key: feishu-personal:oc_d99f…
sender: 宋传胜                     # senderLabel；不写 open_id 之外的个人信息
received_at: 2026-09-19T05:59:36.574Z
agent: Nova
turn_ids: [e7f4a305-…]            # 关联到的 turn；join: id | inferred | missing
urls:
  - url: https://x.com/shao__meng/status/2101146387736142138
    normalized: https://x.com/shao__meng/status/2101146387736142138
    capture: 50-Inbox/00-Capture/lumenbox_2026-09-19_shao-meng-2101146387736142138-e855206b.md
secret_scan: clean | redacted(n)
---
<用户原文，逐字；被 secret-scan 命中的片段替换为 [REDACTED:<pattern>]，并在 frontmatter 计数>
```

### 4.3 capture 文件

```yaml
---
title: <用户贴的第一行 或 URL 的可读形式>
source: <normalized url>
tags: [lumenbox, feishu-personal]
lumenbox_msg_id: e855206b-…
lumenbox_archive: 60-Agent/lumenbox/feishu-personal/oc_d99f…/2026-09-19/e855206b-….md
---
<用户贴的正文（若有）；没有就一行「(URL only; pasted text: none)」>
```
说明：正文不足 200 字会走 OVP 的 needs-content → enrich 抓正文并**替换整个正文**
（`web_fetch.rs:618-649`）。这是接受的：用户原文的保真在归档文件里，capture 只是给 OVP
的来源投递。不打 `ovp/force`：force 只绕 intake 大小门，reader 仍可能零 unit（docs/59 §9 R3），
且会把明显不值得读的短文送去花钱。
一条消息含多个 URL 就多个 capture，都指回同一个 `lumenbox_msg_id`。

### 4.4 manifest `digest/<date>/manifest.v<N>.json`

```json
{
  "schema": "lumenbox.digest-manifest/v1",
  "date": "2026-09-19", "version": 1,
  "window": { "from": "2026-09-18T14:00:00Z", "to": "2026-09-19T14:00:00Z", "tz": "Asia/Shanghai" },
  "status": "ready | partial",
  "gaps": [ { "message_id": "…", "stage": "intake", "state": "unknown" } ],
  "carried_from": [], "pending": [],
  "messages": [ {
      "message_id": "…", "received_at": "…", "archive": "60-Agent/…/<msgid>.md",
      "text_preview": "前 120 字", "join": "id | inferred | missing",
      "turns": [ { "turn_id": "…", "how": "done", "reply": "…/<msgid>.reply.md",
                   "research": "…/<msgid>.research.jsonl", "searches": 6, "urls_read": 4 } ],
      "sources": [ {
          "url": "…", "capture": "50-Inbox/00-Capture/…", "sha256": "…",
          "intake": "ingested | duplicate | needs-content | unparseable | unknown", "dup_of": null,
          "reader": "pack | zero-unit | failed | blocked | not-run",
          "pack_dir": "40-Resources/Reader/2026-09-19_…-ab12cd34/", "units": 14, "cards": 3
      } ]
  } ],
  "claims_delta": [ { "claim_key": "ck-…", "op": "append | supersede | strengthen", "theme": "…",
                       "source_cases": ["…"], "cites_messages": ["…"] } ],
  "previous": { "date": "2026-09-18", "version": 1, "themes": ["…"] },
  "ovp_runs": [ { "run_id": "daily-2026-09-19", "status": "completed", "warnings": [] } ],
  "digest": { "box_path": null, "vault_path": null, "delivered": null, "delivery_state": "pending" }
}
```
`claims_delta` 只取 ledger 中 `source_cases` 与当天 capture 的 pack 有交集的追加行——今天
的用户活动决定范围，再关联 OVP 证据（docs/59 §9 R6）。

推进 box 的包 = `manifest.json` + 每个 `pack_dir` 的 `cards.json`、`units.accepted.json`、
`reader.md` 副本 + `claims_delta` 引用到的 claim 的证据闭包（`ovp2` 的 `claim` 输出
JSON）。副本是只读快照，skill 不写回。

## 5. host 模块 `src/host/ovp-bridge/`

### 5.1 配置（`~/.agentbox/config.json`）

```json
"ovp": {
  "enabled": true,
  "vaultRoot": "/Users/chris/…/staging-vault",
  "bin": "/Users/chris/workspace/obsidian_vault_pipeline/target/release/ovp2",
  "channels": ["feishu-personal"],
  "dayBoundary": "22:00", "timezone": "Asia/Shanghai",
  "maxSourcesPerRun": 10,
  "crystalSynth": { "enabled": true, "maxSeeds": 25 }
}
```
`ovp2` 今天不在 PATH 上（`target/release/ovp2` 和 `OVP2.app` 的 sidecar 都有），所以 `bin`
必填。缺任何一项 → bridge 启动即报错退出，不静默。

### 5.2 自己的账本 `~/.agentbox/ovp-bridge.jsonl`

追加不改，每行一个动作：`{at, op: archive|capture|process|readback|day|push|collect|retry|stuck, key, ok, detail}`。
checkpoint 不是单独文件，是「账本里最后一个 ok 的 (op,key)」——重启后从账本折叠出状态。
doctor 就是对这个账本和 LumenBox / OVP 账本做三方对账。

### 5.3 扫描算法（T1）

1. 读 `inbox.jsonl` 中 `event: admitted` 且 `message.conversation` 属于配置渠道、seq 大于
   checkpoint 的行。
2. 对每条：从 transcript 找 `causedBy` 含该 id 的 user 行取全文（transcript 是全文，inbox
   行也有 `text`，两者不一致以 transcript 为准并记 `detail`）；从 `cards.jsonl` 找 `om_`；
   secret-scan（`src/host/secret-scan.ts` 的 `scanText`）；抽 URL；写归档；每个 URL 写
   capture；记账。
3. 读 `turns.jsonl` 新的 `end` 行：找对应 begin（同 id）；关联消息（`wokenBy` 有就用，
   没有就时间推断）；从 `activity.jsonl` 取该 conversation 在 [begin.at, end.at] 内的
   `tool_start` 行，压成 `research.jsonl`（WebSearch query、write_file 路径、读了哪些 URL）；
   `write_file` 路径落在 `chats/<chat>/outbox/` 的，去 box `sent/` 同名文件 `readFile`，
   写 `.reply.md`；没有就记 `no-artifact`。
4. URL 规范化：去 `utm_*`、`t.co` 展开（不展开就记原样）、`twitter.com → x.com`、去尾斜杠。
   规则写成纯函数带表驱动测试。

### 5.4 处理与回读（T2）

- 调 `ovp2 schedule run-now daily --unless-ran-within-secs 120 --vault-root …`，等待退出，
  记 exit code 和 stderr 尾 20 行。
- 回读：`intake.jsonl` 按 `from` 路径 = 我们写的 capture 路径匹配，得到 `action`、`to`、
  `sha256`、`dup_of`；`daily-runs.jsonl` 按 `source_path` = `to` 匹配，得到 `status`、
  `pack_dir`、`units`、`cards`、`reason`。两个都没有 = `unknown`，留给下次。
- `--max-sources` 是 OVP 自己的每次上限；一天 24 条通常两轮 T2 吃完。

### 5.5 日界（T3）与回收（T4）

- `crystal-synth --cluster-mode batch --max-seeds N`（默认模式，L3 A/B 未定不切）；零
  claim 合法。`ovp2 index`。
- D：按 §4.4 组 manifest；E：`BoxClient.writeFile` 推包，路径
  `/home/box/work/digest/<date>/`；推失败 manifest 记 `push: failed`。
- F：扫描发现 `chats/<chat>/sent/<date>_digest.md`（日终 skill 的产物经 outbox 投递后落到
  sent）就 `readFile` 拷回 vault；投递状态从 channel manager 的投递记录取（§8）。

### 5.6 附件

飞书图片 / 文件由 channel 下载后以空文本消息进 box 的 `chats/<chat>/inbox/`
（`feishu.ts:1430`）。bridge 把它们 `readFile` 到归档区 `attachments/`；PDF / Office 另外
复制一份到 capture 目录让 OVP 的 anydoc 吃（是否支持从 capture 目录直接吃二进制文件，
§13 待核实）；图片不进 capture。

### 5.7 秘密与隐私

- 归档前 `scanText`；命中即替换并计数，不因命中而跳过归档（跳过会让对账缺口无法解释）。
- 不写 open_id 之外的用户标识；不写任何 token；vault 在仓库外；`ovp-bridge.jsonl` 只记
  键和路径不记正文。
- docs/15 的问题（agent 读到的秘密进 transcript）在这里会被放大成「进 vault 并被 OVP 索引」，
  所以 `.reply.md` 和 `research.jsonl` 也过扫描。

## 6. OVP 侧约定（不改 OVP）

- 只用公开接口：capture 目录、`ovp2 daily | schedule run-now | crystal-synth | index | claim`、
  三个账本 + `index.json`。不碰 `.ovp/crystal`。
- tag：`lumenbox` + 渠道名，用户在 Obsidian 里 `ovp/skip` 可停单条。
- 预算：`.ovp/providers.toml` 的 `[budget]` 只报不拦；bridge 侧用 `maxSourcesPerRun` 和
  每天最多 N 次 T2 限流；`ovp2 usage` 的数字回读进 doctor。
- 与桌面 app 时钟共存：只用 `run-now --unless-ran-within-secs`；不 `schedule install`。
- 版本：bridge 启动时 `ovp2 --version`，记进账本；账本 schema 字段以 `schema:` 值为准，
  遇到未知版本报错不猜。

## 7. box 侧两个 skill

### 7.1 `research-reply`（逐条，把记忆约定写成文件）

保留今天的节奏：事实表、盲区、短推版、可选路径。改三处：
1. 开头先 `ext__ovp_bridge_status url=…`：若来源已 ingested 且本聊天已有回复，回「几号已核，
   路径 …，你这次多说的是 …，要我看哪一点」，不重做（消息照常归档）。
2. 「跟前面 N 条线的关系」≤ 3 行，只写主题名和一句关系，指向 `10-Knowledge/Digests/` 最近
   一份日报里的主题；日报不存在就写「今天还没有日报」。
3. 引用外部资料时写 URL；Nova 自己的推断句前加「（推断）」。这为 §7.2 的引用类型服务。

### 7.2 `daily-research-digest`（日终，`schedule: 10 22 * * *`，`deliver:` 本聊天，`paused: true`）

输入只有 `/home/box/work/digest/<date>/`。步骤沿 docs/58 §4 的九步，改为：
- 先读 `manifest.status`；`absent` → 一行回复；`partial` → 日报首行列缺口。
- 主题从 `claims_delta` 和 packs 的 cards 起，用 LLooM 式「主题 + 纳入标准 + 回扫全部
  消息」；每个主题 ≥ 2 条不同 `sha256` 的来源。
- 张力单独一遍；增量动词只在有依据时标：NEW（主题里全部 claim 是今天 append）、
  STRENGTHENED（有 strengthen/supersede 行）、CONTRADICTED（张力 pass 找到且引两方）；
  RESOLVED 和 DORMANT 第一版**不标**（docs/59 §9 R8：supersede ≠ resolved，缺席 ≠ 消失）。
- 引用四种，逐句必带其一：`[msg:<id8>]`（用户说的）、`[src:<sha8>]`（原文 unit / card）、
  `[claim:ck-…]`（OVP claim）、`[nova]`（Nova 的分析，明示是推断）。
- 输出两份：`outbox/<date>_digest.md`（长版：主线 / 主题 / 张力 / 变化 / 开放问题 / 附录 =
  manifest 里每条消息的原文预览 + 归档路径 + 来源处置 + 回复路径）；回复正文 ≤ 600 字短版。
- 附录不复制原文全文（已在 vault 归档），复制会让日报比原文还长；附录是索引，每条可点回
  vault 路径。飞书里长版作为文件随 outbox 投递（A8：手机上能打开）。

### 7.3 引用校验（bridge 在 F 做，确定性）

拷回日报时逐句解析引用：`[msg:]` 在 manifest 的 messages 里、`[src:]` 在 sources 的 sha 前缀
里、`[claim:]` 用 `ovp2 claim` 能解析、`[nova]` 直接过。统计未解析率写进 manifest
`digest.citation_unresolved`。这只验证「引用存在」，不验证「句子被支持」（docs/59 §9 R5）；
语义支持用金标日人工评（§11）。未解析率 > 10% 的日报仍投递，但首行加一句说明——
不投递会让人以为今天安静。

## 8. 交付与回执

`deliveries.jsonl` 今天只有 open / close，没有「发到飞书的消息 id」。日终 skill 的回复经
channel manager 投递，manager 知道飞书返回的 message id 但没落账本。两个选项：
- 第一段：回执 = `sent/<date>_digest.md` 存在（outbox 投递成功后才挪到 sent，
  `manager.ts:1247` 的 `outboxDelivered`）。这证明文件投递过，不证明文本消息到达。
- 第二段：host 改一处，投递成功时把渠道消息 id 追加到 `deliveries.jsonl`（第 2 类持久格式
  变更，另 review）。
在此之前 manifest 的 `delivery_state` 只有 `file-delivered | unknown`，不写 `delivered`。

## 9. 失败表（每一行都要在 doctor 里可见）

| 失败 | 表现 | 留痕 | 恢复 |
|---|---|---|---|
| vault 路径不存在 / 改名 | bridge 启动失败 | 账本 `stuck: vault-missing`；doctor 红 | 改配置，重跑 scan 从 checkpoint 续 |
| transcript 找不到 causedBy 对应行 | 只有 inbox 的 text | 归档用 inbox text，`join: missing` | — |
| secret-scan 命中 | 正文有 REDACTED | frontmatter 计数 | 人工看归档 |
| box 不在线（readFile 失败） | A' 缺 reply | `retry`，5 次后 `stuck` | box 回来自动续 |
| `ovp2` exit ≠ 0 | 处置 unknown | `process: failed` + stderr 尾 | 下次 T2 |
| OVP 3 次 blocked | reader blocked | 原样搬 | 人在 OVP 门户处理；bridge 不 `--retry-blocked` |
| enrich 抓不到正文 | needs-content 持续 | 处置原样 | 用户原文仍在归档 |
| 日界时 T2 未完 | manifest partial + pending | 明日 carried-from | 不重跑 |
| 推包失败 | skill 读到 absent | `push: failed` | 手跑 `day` |
| skill 没跑 / 跑失败 | 无 sent 文件，40 分钟超时 | manifest `digest: skill-did-not-run` | 手跑例程 |
| 引用未解析率高 | 日报首行说明 | manifest 数字 | 改 prompt |
| 桌面 app 与 T2 同时跑 | OVP RunLock 挡一个 | run-now 的 skip 日志 | 无需处理 |
| 用户在 22:00–22:10 发消息 | 进明天窗口 | — | — |

## 10. 安全边界一句话

bridge 是 host 进程权限下的代码，只读 LumenBox 账本和 box 文件，只写 §4.1 的白名单路径和
自己的账本，只 exec 配置里那一个 `ovp2` 二进制。测试里用一个假 vault 断言「写出白名单
= 失败」。

## 11. 验收与测试

- **fixture**：把今天真实的 24 条消息对应的账本片段（去掉正文里的个人信息）做成
  `src/host/ovp-bridge/fixtures/2026-09-19/`，含一个假 `.ovp` 账本；单测断言：归档 24 条、
  capture 数 = URL 去重前的数、每条处置可解释、重跑零重复写、URL 规范化表。
- **对账命令** `agentbox ovp-bridge doctor --date`：输出三个集合大小和 stuck 列表；CI 用
  fixture 断言全零。
- **skill scenario**（docs/43）：一个 ready 包、一个 partial 包、一个 absent 包，断言回复
  形状（短版 ≤ 600 字、首行说明、四种引用非空、无「逐条」小节）。
- **金标日**：手标 3 天的参考 insight，评 Coverage / Citation（docs/58 §3）；这是唯一的
  语义质量检查，每次改 prompt 跑。
- 验收条款沿 docs/59 §9.4 的修订版。

## 12. 分段与工作量

| 段 | 内容 | 退出条件 | 估计 |
|---|---|---|---|
| 1a | 配置、账本、T1 归档 + 投源、URL 规范化、secret-scan、doctor；staging vault | fixture 全过；staging 上连续 3 天 doctor 三集合为零 | 2–3 天 |
| 1b | T2 处理 + 回读；T3 manifest + 推包（不含 crystal）；`research-reply` skill | 每条输入有处置；包能推到 box | 2 天 |
| 1c | host 改动：`turns.jsonl` begin 加 `wokenBy` | 新 turn 的 join 全是 `id` | 0.5 天 + review |
| 2 | crystal-synth 接入、`daily-research-digest` skill、引用校验、F 回收；切日常 vault | docs/59 §9.4 的 A2/A3/A4/A7；3 个金标日 | 3–5 天 |
| 3 | 投递回执进账本；评估固定；是否迁 OVP evolution 由数据定 | — | 待定 |

第一版这里的估计不含 review 往返。docs/59 第二版的「1–2 天」是错的。

## 13. 写代码前必须核实

1. OVP sweep 是否递归 `00-Capture/` 子目录（决定用前缀还是子目录）。
2. `run-now --unless-ran-within-secs` 在当前 `target/release/ovp2` 版本里是否存在（源码有
   测试，二进制版本未查）；`ovp2 --version`。
3. `daily-runs.jsonl` 的 `source_path` 是 `01-Raw` 路径还是 `03-Processed` 路径，决定回读的
   join 走 `intake.to` 还是别的。
4. anydoc 是否接受直接放进 capture 目录的 `.pdf/.docx`。
5. transcript 里 assistant 的最终回复文本是否完整可取（今天最后一行 text 为空）。
6. `outboxDelivered` 是否在文本回复投递失败但文件成功时也触发。
7. `XQUIK_API_KEY` 是否配置；日常 vault 路径。
8. 日常 vault 里 `60-Agent/` 和 `10-Knowledge/Digests/` 与用户现有目录有无冲突。

## 14. 给下一轮 review 的问题

1. 「日常 vault + 首周 staging」是否比「永久独立 vault」更好？反例：staging 一周内 crystal
   只有 lumenbox 来源，主题会和日常 vault 里的不一样，验证的不是最终形态。
2. 22:00 日界把 22:00 后的消息推到明天，用户会不会觉得「今天发的没进今天的日报」？
   替代：23:30 日界，或次日 08:00 出昨日日报。
3. `wokenBy` 是不是最小的 host 改动？有没有已存在的字段能承担这个 join？
4. capture 不打 `ovp/force`，会不会让大部分推文永远 needs-content、进不了 reader，从而
   claims_delta 长期为空，日报退化成只靠 cards 和 Nova 分析？
5. `[nova]` 引用类型是否会成为「什么都能说」的后门？要不要限制 `[nova]` 句子占比？
6. 回执只到 `file-delivered`，第一段可以接受吗？
7. bridge 用 launchd 而不是 LumenBox 的 `schedule:`，会不会让「谁在跑」对操作者不可见？
   要不要在 LumenBox 的 automations 页列出 bridge 的状态？
8. 请用 docs/59 §7 的十个输入再跑一遍本文的状态机，指出哪一个没有终态。

## 15. 第二轮复审（codex，2026-09-19）：裁定与修订清单

codex 只读审阅了本文、docs/58–59、两边源码和 `~/.agentbox` 现场，实测了 `ovp2 --version`
和 `--help`，没有运行摄取、综合或投递。它给出 15 条发现（12 条 P1）。按仓库规矩，最有
杀伤力的几条我逐条对源码复核后再收；下表是裁定。

### 15.1 §13 核实结果（源码实测）

| 项 | 结论 | 证据 |
|---|---|---|
| sweep 是否递归 `00-Capture/` 子目录 | **递归**，可用 `00-Capture/lumenbox/` 子目录，不必平铺加前缀 | `ovp-intake/src/sweep.rs:625, 659` |
| `daily-runs.source_path` 指向哪 | **`01-Raw` 路径**（计划阶段的相对路径，成功先落账再移动），`moved_to` 始终为空 | `ovp-daily/src/lib.rs:245, 283`；`ledger.rs:46` |
| anydoc 接受 capture 里的 PDF/DOCX | **接受**，含 PPTX/XLSX；原件移到 `03-Processed/office/`；**原件 sha 与生成 markdown 的 sha 是两个身份** | `ovp-intake/src/anydoc/mod.rs:35`、`sweep.rs:292, 358` |
| `outboxDelivered` 触发条件 | 至少一个文件的 adapter 发送**正常返回**；文本先投、文件后投，文本抛错则文件不投；**飞书 `sendFile` 缺 API client 或空 chatId 时静默正常返回** | `manager.ts:1227, 2045, 1191`；`feishu.ts:2278` |
| begin 行是否已有消息关联字段 | **没有**；`workId` 是工作 id 不是消息 id | `turn.ts:1301, 1679` |
| `ovp2` 版本与 `run-now` | `ovp2 2.0.1 (9bb9f474)`；`run-now --unless-ran-within-secs` 存在；**没有 `--max-sources`**；**没有 `claim` 子命令**（claim 只是 MCP 工具，`ovp-mcp/src/lib.rs:407`） | 实测 `--help` |
| `crystal-synth` 默认 | **`--client replay`**、cluster-mode auto；`--max-seeds` 只限 llm 模式 | `ovp-cli/src/main.rs:695, 739` |
| assistant 最终回复是否可取 | 完整写入 `text`，但要按 turn 取最终回复，不能拿最后一行或全部 blocks | `turn.ts:2307, 2612` |
| Xquik、日常 vault 路径、目录冲突 | **仍未确认**；调度器读 `.ovp/daily.env`，shell 未设不代表调度环境未设 | `scheduler.rs:185` |

### 15.2 发现的裁定（P1 十二条，P2 三条）

| # | codex 的发现 | 我复核 | 裁定 | 对本文的修订 |
|---|---|---|---|---|
| R1 | `inbox.jsonl`、`turns.jsonl` 不是永久日志：无待处理消息且行数超阈值时**整文件清空**（`inbox.ts:133, 218`；`resume.ts:194, 302`），bridge 停机期间的输入会消失 | **确认**，两处 `compact()` 都是「temp 写空 + rename」 | 成立 | §5.3 的扫描源改为**持久记录**：消息以 transcript（追加不改）为准；但 transcript 的 user 行是把同一 turn 的多条输入**拼成一段**（`prompt.ts:1232`），所以还需要 host 侧一个**逐消息的持久导出**（见 15.3 host 改动 1）。checkpoint 拆成「各账本游标」和「逐项处理状态」两个 |
| R2 | 三个状态机不完整：`needs-content + not-run` 无终态且 doctor 三集合漏报；`ovp/skip` 的 `skipped` 没列；附件被「无 URL 即终态」提前结案；turn 缺进程死亡 / 只有文本回复 / 产物未投递分支；摘要缺 `push-failed` 等分支 | 确认（对照 §3.1） | 成立 | §3.1 重写为每阶段「完成 / 明确失败 / 跳过 / 截至快照未知（含原因、期限、下一步）」；新增 `content-unavailable`、`skipped`、`attachment-*`、`turn-aborted`、`reply-text-only`、`push-failed` 等态；doctor 覆盖消息、附件、turn、摘要、交付五类对象 |
| R3 | capture 把用户评论当外部来源正文：一条消息两个 URL 一段评论，评论被复制成两个来源的正文 | 确认 | 成立 | §4.3 拆三个字段：`user_comment`（只进归档）、`quoted_source_text`（用户明确贴的原文）、`fetched_source_text`（OVP 抓的）；capture 正文只放后两者之一，归属不明的文字不挂在 URL 下 |
| R4 | `cards.jsonl.handle` 是机器人**发出去的任务卡片**的 handle（`manager.ts:1902`），不是用户消息的 `om_` id；产物按 `<msgid>.reply.md` 命名会被多 turn / 多消息覆盖 | **确认**（`postTaskCard` 返回值） | 成立 | `feishu_message_id` 改从 `ingress.jsonl` 的 `arrival.id` 取（其持久性见 15.4）；产物按 `turnId/artifactId` 存，消息只引用 |
| R5 | §4.4 的包撑不起 §7.2 的四种引用：`[msg:]` 只有 120 字预览；`[src:]` 定位不到 unit；`[claim:]` 靠不存在的 CLI；`[nova]` 无依据直接放行；包里没有消息全文、回复、research、昨日基线 | 确认 | 成立 | 包内容改为：全部消息全文（脱敏后）、每 turn 的最终回复与 research 记录、每个来源的 pack 副本 + `case_id`、claim 及证据闭包快照（host 经 OVP **MCP** 取，非 CLI）、昨日 manifest 全文。引用改为 `[msg:<id>]`、`[unit:<case>/<unit-id>]`、`[claim:<key>@<snapshot-hash>]`、`[turn:<id>]`（替代裸 `[nova]`，必须附依据引用） |
| R6 | OVP 状态不是「原样搬」：`RunStatus` 只有 `succeeded/failed`，blocked 是按 sha 汇总推导（`ledger.rs:24`；`lib.rs:175`）；crystal 操作是 `write/supersede/retract`（`crystal.rs:552`）；`dup_of` 是 `url:`/`sha256:` 不是 pack id；enrich 后 sha 会变；Office 双 sha | **确认**（两处枚举实测） | 成立 | §4.4 / §5.4 按真实枚举改：`reader: succeeded \| failed(n) \| blocked(derived, n≥3) \| not-run`；`claims_delta.op ∈ write/supersede/retract`；回读按「capture 路径 → intake 记录链（可多条）→ 最新 sha」而不是取第一条 |
| R7 | 引用校验在投递之后做，已发出的附件没有提示；`sent` 有旧文件 / 同名覆盖 / 发送成功但移动失败等情况 | 确认 | 成立 | 校验移到**发布 outbox 之前**（skill 产物先落 `digest/<run>/draft.md`，bridge 校验并冻结 hash，再由 skill 投递）；回执按 hash 绑定 |
| R8 | 日期 + 版本只在 manifest 里，box 包、outbox、sent、日报都按日期固定命名；推多个文件无原子完成标记 | 确认 | 成立 | 统一运行键 `vaultId + agentId + chatKey + window + revision`；包目录按运行键命名，最后写 `READY` 标记；状态变化写事件账本，manifest 不改 |
| R9 | `run-now` 依赖已有 registry、无 `--max-sources`、`daily-<date>` 同日复用；`crystal-synth` 默认 replay；「每天最多 N 次」无配置 | **确认**（`--help` 实测） | 成立 | §5.4 改为直接 `ovp2 daily --vault-root … --client live --max-sources N`，并在前面用 `.ovp/last-run.json` 判断桌面时钟是否正在跑；`crystal-synth --client live --cluster-mode batch`；限流由 bridge 自己的账本计数 |
| R10 | §0「只写两处」与 `10-Knowledge/Digests/` 矛盾；bridge 调的 OVP 会写 Raw/Processed/Reader/crystal/index；staging 的 capture 处理后已被搬走，复制目录迁不走；skill `paused` 不停 launchd；`ovp/skip` 只在 capture 阶段有效 | 确认 | 成立 | §0 改为：bridge **直接**写三处（capture、归档区、Digests），OVP **间接**写它自己的目录；staging 改用日常 vault 的**代表性快照**而非空 vault，切换时按目标 vault 重建来源 / pack / claim 映射；暂停分三层（bridge、摘要例程、已投 capture）各自写明 |
| R11 | `BoxClient.readFile` 是给模型的文本接口（默认 2,000 行、带 truncated），二进制要用 `downloadFile`（`client.ts:388`） | **确认** | 成立 | §5.3 / §5.6 全部改用 `downloadFile` + 长度 / hash 校验 |
| R12 | `scanText` 只返回模式名和 34 字摘录，**不返回位置、不做替换**（`secret-scan.ts:104-135`） | **确认** | 成立 | §5.7 的「替换为 [REDACTED]」是不存在的能力；要新写一个可测的脱敏器（正文、URL、frontmatter、回复、research、子进程日志），`clean` 改为「未命中已配置检查」 |
| R13 (P2) | 两个 sha ≠ 两个独立来源；frontmatter 含 msgid 会让同文重复 capture 的 sha 都不同；t.co 展开不是纯函数 | 确认 | 成立 | 规范化（纯函数）与重定向解析（网络、可失败）分开记录；来源独立性按 canonical source 判，不按 sha |
| R14 (P2) | 5 分钟采集 + 22:10 定时消费制造竞争；status 工具挡不住并发重复研究 | 部分成立 | 收 | 消息 / research 状态在 admission 时即登记（host 改动 1 顺带解决）；日终 skill 按 `READY` 标记跑，定时器只兜底 |
| R15 (P2) | 1a 未实现 T2 却要求三集合为零；「四种引用非空」会诱导编造 | 确认 | 成立 | §11 / §12 改为「该有的引用存在、不该有的不出现」；退出条件按阶段能力定 |

### 15.3 对 §14 八个问题的最终答复

1. **日常 vault，否决空 staging。** staging 用日常 vault 的代表性快照（含旧来源、重复 URL、已有 claim），切换时重建映射。
2. **自然日窗口，次日 08:00 出昨日日报。** 生成时间与窗口分离；迟到的 research 进补充并注明活动日。22:00 日界撤回。
3. **不加 `wokenBy`，改在 transcript 加 `turnId`** 并复用已有 `causedBy`；旧记录标 `missing / inferred`。再加一个**逐消息持久导出**（host 改动 1）：admission 时把 `{message id, om_ id, chat, at, text, attachments}` 追加到一个不压缩的账本，因为现有 inbox 会清空、transcript 会拼接。这两处是本方案对 host 核心的全部请求，都属 docs/13 第 2 类，单独 review。
4. **不自动 `ovp/force`**；短文抓取失败进 `content-unavailable` 终态并有重试期限；日报可引用用户贴的文字但标为用户材料；没有 pack 就没有 cards，不假设 cards 兜底。
5. **禁止裸 `[nova]`**，改为 `[turn:<id>]` 且必须附依据引用；无法核实的外部事实进开放问题。不用占比阈值。
6. **`sent` 存在只能叫 `sent-observed`**，不叫 `file-delivered`。最小合格回执 = adapter 明确确认的发送结果，绑定目标聊天、运行键、文件 hash；文本与文件分别记。飞书 `sendFile` 的静默成功要进失败测试。
7. **launchd 驱动 CLI，同时在 automations 页显示 bridge 状态**（最近成功扫描、积压、失败原因、下一次、暂停）。撤回「时钟在 box 侧」的说法，例程调度本来就在 host（`schedule.ts:426`）。
8. 十个输入中：第 2 项是严格死路，第 8 项（回复里的六个外部 URL）根本没进状态机，第 10 项缺故障闭合，第 4 项混淆单源失败与整次进程失败。都按 15.2 的修订收。

### 15.4 codex 的结论（原文，≤ 400 字）

> 结论：暂不进入实现。源码确认 capture 递归扫描并支持 PDF/DOCX；daily 账本记录处理前的
> Raw 路径；当前二进制支持 run-now，但没有 claim 子命令。主要阻断是：输入与 turn 日志会
> 压缩清空，扫描不能保证不漏；needs-content、skip、附件和中断运行未闭合；capture 混淆
> 用户评论与外部原文；摘要包缺少消息全文、research 和历史基线；sent 文件不足以证明本次
> 投递成功，投递后校验也无法修正已发附件。保留日常 vault 方向，改用代表性快照验证并明确
> 迁移。开工前须补齐持久采集与身份关联、完整状态机、证据包与真实 OVP 接口、原子版本及
> 可信回执、写入与脱敏边界；日报采用自然日窗口、次晨生成，并将本轮反例纳入验收。

### 15.5 开工前必须修订的条目（第二版要改的地方）

1. 持久采集：host 逐消息导出账本 + transcript `turnId`；bridge 游标与逐项状态分离；崩溃重放测试。
2. 状态机重写，覆盖 needs-content / skipped / 附件 / 无产物 / 中断；doctor 五类对象。
3. 身份：`om_` id 不能靠 `ingress.jsonl`——它同样会压缩（`ingress.ts:28, 110, 161`，500 条 settled 后清空；`deliveries.ts:29, 91` 亦然），所以逐消息持久导出（host 改动 1）必须在 admission 时就把 `om_` id 写进去；产物按 turn / artifact 存。
4. 用户评论与外部原文分离；duplicate、内容版本、Office 双 sha 的关联规则。
5. 可独立消费的完整摘要包与四类可定位引用；昨日基线随包。
6. 真实 OVP 接口：`ovp2 daily --client live --max-sources`、`crystal-synth --client live`、claim 经 MCP；状态映射按真实枚举。
7. 运行键贯穿、原子 `READY`、投递前校验、文本 / 文件分开的回执。
8. 日常 vault 的间接写入范围、快照式 staging 与迁移、三层暂停、`downloadFile`、真实脱敏器。
9. 验收改写：把本轮反例（日志压缩、崩溃重放、半包、旧 sent、发送成功移动失败、多消息一 turn、steering、附件转换、needs-content）写进 fixture。

第二版之前不开工。本文 §0–14 保留作为「第一版 + 复审」的记录，不再修改。

