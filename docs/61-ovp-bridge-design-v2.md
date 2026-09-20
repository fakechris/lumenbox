<!-- doc: 61-ovp-bridge-design-v2
     title: OVP 接入程序第二版：一个 id 贯穿、每个输入有终态、对 OVP 只提通用改动
     family: decision
     status: current
     updated: 2026-09-20
-->
# 61. OVP 接入程序第二版：一个 id 贯穿、每个输入有终态、对 OVP 只提通用改动

第二版，2026-09-19，取代 docs/60。docs/60 §15 的十五条复审发现全部收下；本文按 §15.5 的
九项重写，并新增一节专门讨论「改 OVP」：哪些改动是通用的（任何外部投递者都受益）、
哪些我们在 bridge 里绕过去、OVP 2.0.1 不改也能跑的最小形态是什么。写代码前仍要过一轮
review（§14）。

## 0. 三句话

1. **数据流不变**：host 上的 bridge 搬运，box 不挂 vault、不装 ovp2、不连网；vault 是日常
   vault。
2. **变的是根基**：不再扫四个会清空的账本，而是在消息进门处铸一个 id、写一条永不压缩的
   逐消息账本，让这个 id 贯穿 ingress → inbox → transcript → turn → capture → pack → claim；
   每个对象都有枚举出来的终态；运行键贯穿包、草稿、投递、回执；引用在投递前校验。
3. **对 OVP 提六个通用改动**（§9），每个都有「不改也能跑」的绕法；其中「用户备注和来源
   正文分开」和「needs-content 要有终态」是 OVP 自己 Pinboard 路径上已有的 bug。

## 1. 身份：一个 id 从进门走到 claim

### 1.1 今天为什么断

- 飞书 `om_` id 在 `manager.ts:1338`（"past the door"）手里，往下调 `orchestrator.prompt()`
  → `bus.sendFromUser()` 时**只传文本**，inbox 的 uuid 在 `bus.ts:449` 新铸，`om_` 丢了。
- inbox、turns、ingress、deliveries 四个账本都在无待处理项且超阈值时**整文件清空**
  （`inbox.ts:133,219`；`resume.ts:196,303`；`ingress.ts:110,161`；`deliveries.ts:91,143`）。
- transcript 是追加不改的（docs/24），user 行有 `causedBy: [inbox uuid…]`，但**同一 turn 的
  多条输入被拼成一段文本**（`prompt.ts:1232`），且文本在 `bus.ts:25` 被截到 8,000 字。
- transcript 行没有 turn id；`turns.jsonl` 的 begin 行没有消息 id。
- `cards.jsonl` 的 handle 是机器人**发出去的任务卡片**（`manager.ts:1902`），不是用户消息。

### 1.2 两处 host 改动（docs/13 第 2 类，单独 review）

**H1 逐消息持久账本 `~/.agentbox/messages.jsonl`。** 在 `manager.ts:1338` 处（`om_` id、原文、
chatKey、identity、senderLabel、附件都在手里）铸 uuid、追加一行，然后把这个 uuid 作为
inbox 消息 id 传下去（`prompt()` 和 `sendFromUser()` 各加一个可选 `messageId` 参数；缺省
仍自铸，旧调用方不变）。行的形状：

```json
{"schema":"lumenbox.message/v1","id":"<uuid>","channel":"feishu-personal",
 "channelMessageId":"om_x100…","chatKey":"feishu-personal:oc_…","identity":"feishu-personal:ou_…",
 "senderLabel":"宋传胜","receivedAt":"…","text":"<全文，截断前>","textChars":404,
 "files":[{"name":"…","boxPath":"chats/<chat>/inbox/<name>","bytes":…}],"conversation":"…"}
```
**永不压缩**（和 `receipts.ts` 同一条纪律：「要活过 transcript 和任务历史」）。只在 admitted
之后写，refused 的不写（ingress 已记）。secret 不在这里处理，导出时处理（§5.5）。

**H2 transcript 行带 `turnId`。** `turn.ts:1527` 和 `:1822` 两处 append 的作用域里已有 turn
id；user 行、assistant 行都加。旧行没有的，bridge 标 `join: inferred`（同 conversation、
`causedBy` 命中、时间窗）并在 manifest 里如实写。

**H3（第二段）投递回执。** `outboxDelivered`（`manager.ts:1227`）只在 adapter 调用正常返回
时触发，飞书 `sendFile` 缺 API client 时静默返回成功（`feishu.ts:2278`）。改动：adapter 的
发送结果（渠道消息 id 或明确的失败原因）写进 `receipts.ts`（追加不改），subject
`digest:<runKey>`，文本和文件各一条。在 H3 之前，回执只有 `sent-observed`（§7）。

有了 H1/H2，bridge 的关联不再是推断：`messages.id` = inbox id = transcript `causedBy` 元素；
transcript `turnId` = `turns.jsonl` id；turn 内 `activity.jsonl` 的 `write_file` 路径 = box
`sent/` 文件。四个会清空的账本只作提示，不作依据。

### 1.3 其余身份

| 对象 | 键 | 来源 |
|---|---|---|
| 来源（capture） | OVP：文件 sha256 主键、规范化 URL 副键；bridge：`captureId = <messageId>/<n>` 写在 frontmatter | `.ovp/intake.jsonl`（`from`、`to`、`url`、`sha256`、`dup_of`、`run_id`、`action`） |
| 来源版本 | 每次 sha 变化一条链：needs-content 的 sha → enrich 后 ingested 的新 sha | intake 记录按 `from` 路径串成链，取最新 |
| pack / case | pack 目录名 = crystal 的 `case_id`；`PackRow.source_sha256` 回到来源 | `.ovp/index/index.json` |
| claim | `claim_key`（确定性哈希，重建不变）+ 生成时的证据闭包 hash | `.ovp/crystal/ledger.jsonl` 的 `write/supersede/retract` 事件 |
| OVP 调用 | `--run-id lumenbox-<uuid>`（`main.rs:176`，intake 和 daily-runs 记录都盖它） | 报告 `.ovp/reports/<run-id>*.json` |
| 摘要运行 | `runKey = <vaultId>/<agentId>/<chatKey>/<window>/<revision>`；`vaultId` = 配置里的 vault 路径的 sha 前 8 位 + 用户可读名 | bridge 账本 |
| 研究产物 | `<turnId>/<artifactId>`，artifact 是 sent 文件或最终回复文本 | 归档区 |

## 2. 状态机：每个对象都有终态，未知有期限

写法：每阶段 ∈ { 完成 | 明确失败(原因) | 跳过(原因) | 未知(原因, 期限, 下一步) }。到期的
未知升级为 `stale`，进 doctor 的人工队列，不再自动重试。

### 2.1 消息

```
admitted ─▶ exported(H1 行存在)
         ─▶ archived            | archive-failed(io, 重试 ≤5 → stale)
         ─▶ redacted(n) / clean(=未命中已配置检查)
         ─▶ sources: 0..n 个来源对象（§2.2），每个独立
         ─▶ attachments: 0..n 个附件对象（§2.3）
终态：archived 且每个来源、附件到终态
```

### 2.2 来源（一条消息里的一个 URL）

```
captured(文件已写) ─▶ intake:
     ingested          ─▶ reader: succeeded(pack, units, cards)
                                   | succeeded-zero-units（OVP 判不值得蒸馏；合法终态）
                                   | failed(n, reason)   n<3 → 等下次 daily
                                   | blocked(derived: 同 sha failed ≥3 且未成功)   终态，人工
                                   | not-run(期限 2 次 daily 之后 → stale)
     duplicate(dup_of) ─▶ resolved-to(canonical sha)   终态；找不到 canonical → stale
     needs-content     ─▶ attempts++ 每次 daily；attempts ≥ 3 或 72h → content-unavailable   终态（bridge 推导，直到 OVP G4）
     skipped(ovp/skip) 终态
     unparseable       终态，人工
     unknown(无 intake 记录) 期限 2 次 daily → stale
capture-write-failed  重试 ≤5 → stale
```
「blocked 是推导的」：OVP 的 `RunStatus` 只有 `succeeded/failed`，blocked 由 `failed_counts`
按 sha 计数 ≥3 且不在 `succeeded_hashes` 推出（`ovp-daily/src/lib.rs:57,186-189`）。bridge
用同一规则并写明 `derived: true`。

### 2.3 附件

```
listed(H1 files) ─▶ downloaded(downloadFile, 长度+hash 校验) | download-failed(重试 ≤5 → stale)
                 ─▶ archived
                 ─▶ office/pdf: captured → 走 §2.2（注意原件 sha 与生成 markdown 的 sha 是两个身份）
                    image/other: not-ingested(by-policy)   终态
```

### 2.4 turn

```
begun ─▶ ended(how) ─▶ final-reply(text 来自 transcript 最终 assistant 行) | no-final-reply
                    ─▶ artifacts: 每个 sent 文件 downloaded+archived | artifact-missing(记录路径)
      ─▶ aborted(进程死亡 / 恢复耗尽，turns.jsonl 无 end 且 resume 判定放弃)   终态
      ─▶ missing-end(期限 24h → stale)
```

### 2.5 摘要运行

```
windowed(消息清单冻结) ─▶ packed(全部文件写完, hash 清单) ─▶ READY 标记
  ─▶ drafted(skill 写 draft.md)          | skill-did-not-run(超时 60min)  → 明日带 carried-from
  ─▶ validated(引用校验通过 / 通过但有说明) | validation-failed(打回一次) → 二次失败 → published-with-notice
  ─▶ frozen(digest.md + sha256)
  ─▶ published: text: ok|failed|unknown ; file: ok|failed|unknown   （H3 前只有 sent-observed|not-observed）
  ─▶ collected(vault 副本 + 回执写入)
```

### 2.6 doctor

`agentbox ovp-bridge doctor [--window]` 输出五类对象各自的非终态计数、stale 列表、最老未知
的年龄；CI 用 fixture 断言。这不是「三个集合」，是全部对象。

## 3. 触发与保证

| 触发器 | 何时 | 做什么 | 幂等键 |
|---|---|---|---|
| T1 采集 | 每 5 分钟（launchd） | 读 `messages.jsonl`、transcript、`activity.jsonl` 各自游标之后的行：§2.1–2.4 推进一步 | 消息 id / turn id / artifact id |
| T2 处理 | T1 写了 ≥1 个 capture，或有非终态来源且距上次 ≥60 分钟 | 若 `.ovp/last-run.json.status == running` 则等待；否则 `ovp2 daily --vault-root V --client live --max-sources N --run-id lumenbox-<uuid>`；回读 `intake.jsonl`、`daily-runs.jsonl`、`reports/<run-id>*.json`、`index.json` | run-id |
| T3 出包 | 每天 08:00 Asia/Shanghai，窗口 = 昨天自然日 `[00:00, 24:00)` | `crystal-synth --client live --cluster-mode batch`；`ovp2 index`；冻结昨日窗口的消息清单；写包；`READY` | runKey |
| T4 校验 | skill 调 `ext__ovp_bridge_validate`（同步） | 解析四类引用，返回报告 | runKey + draft hash |
| T5 回收 | T1 发现 `sent/<runKey>.digest.md`，或 H3 回执出现 | 拷回 vault，写回执与状态 | runKey + hash |

**保证的语义**：至少一次 + 键幂等 + 每个对象在期限内到终态或 stale；不保证恰好一次投递，
不保证一定有 pack，不保证 08:00 前 OVP 跑完（partial 是一等状态并列缺口）。

**游标与状态分开**：`~/.agentbox/ovp-bridge/cursors.json`（每个源账本一个 offset + inode）、
`~/.agentbox/ovp-bridge/state.jsonl`（每个对象的状态事件，追加）。重启从两者折叠；源账本
被清空（inode 变）时游标归零，靠 `messages.jsonl` 不清空保证不漏消息。

**日界**：自然日，次晨出报，22:00 和 23:30 都撤回。窗口内消息在 08:00 仍非终态的，进
`gaps` 并在次日包里 `carried-from`；不重跑昨日日报，只发「补充」。

## 4. vault 布局与文件

### 4.1 bridge 直接写的三处；OVP 间接写它自己的目录

```
<vault>/50-Inbox/00-Capture/lumenbox/<YYYY-MM-DD>/<messageId>-<n>.md      B：sweep 递归子目录（sweep.rs:625,659）
<vault>/60-Agent/lumenbox/<channel>/<chatKey>/<YYYY-MM-DD>/<messageId>.md   A：消息
<vault>/60-Agent/lumenbox/<channel>/<chatKey>/<YYYY-MM-DD>/<messageId>/attachments/…
<vault>/60-Agent/lumenbox/<channel>/<chatKey>/turns/<turnId>/reply.md       A'：最终回复文本
<vault>/60-Agent/lumenbox/<channel>/<chatKey>/turns/<turnId>/<artifactId>   A'：sent 文件原样
<vault>/60-Agent/lumenbox/<channel>/<chatKey>/turns/<turnId>/research.jsonl
<vault>/60-Agent/lumenbox/digest/<runKey>/manifest.json + package/ + draft.md + digest.md + events.jsonl
<vault>/10-Knowledge/Digests/<YYYY-MM-DD>.md（revision >1 时 <date>.r2.md）           F
```
OVP 在 T2/T3 里会写 `01-Raw`、`03-Processed`、`40-Resources/Reader`、`.ovp/*`、`10-Knowledge/Crystal`
——这是调用 OVP 的必然副作用，白名单测试只约束 bridge 自己的 `write()` 调用。

### 4.2 capture：来源正文和用户评论分开

```yaml
---
title: <URL 可读形式，或用户贴的原文第一行（仅当归属为 quoted）>
source: <normalized url>
tags: [lumenbox, feishu-personal]
lumenbox_capture_id: <messageId>/<n>
lumenbox_message: 60-Agent/lumenbox/…/<messageId>.md
annotation: |               # 用户评论：只在 frontmatter，不进正文（G5 之前 OVP 忽略它，正好）
  <user_comment，可空>
---
<quoted_source_text：用户明确贴出的原文；没有就空正文（OVP 记 needs-content 并去抓）>
```
归属规则（bridge 判，记进消息归档）：一条消息只有 URL → 正文空；URL + 文字且文字含引用
标记（`>`、「转发」、原推作者名开头）→ `quoted`；否则 → `user_comment` 进 `annotation`。
判不出的一律当 `user_comment`。这是保守方向：宁可让 OVP 去抓，也不把评论当原文。
不打 `ovp/force`。

### 4.3 消息归档 `<messageId>.md`

frontmatter 含 §1.2 H1 行的全部字段 + `turnIds`、`join`、`sources[]`（captureId、url、
normalized、状态快照）、`attachments[]`、`redaction: {exact, pattern}`。正文 = 全文（截断
前），经 `redactLine`（`audit-export.ts:66`，已存在：held 值 → `<redacted:name>`，凭证形状
→ `<redacted:pattern>`，计数）。

### 4.4 包 `digest/<runKey>/package/`

| 文件 | 内容 | 供哪种引用 |
|---|---|---|
| `manifest.json` | 窗口、消息清单（全文、脱敏后）、每条来源状态链、turn 与产物、`gaps`、`carried_from`、`previous`（昨日 manifest 全文内嵌）、`ovp_runs`、`hashes` | `[msg:]` |
| `turns/<turnId>/reply.md`、`research.jsonl` | 最终回复、检索记录、读过的 URL、写过的文件 | `[turn:]` |
| `packs/<case>/{reader.md,cards.json,units.accepted.json}` | 窗口内来源的 pack 副本 | `[unit:<case>/<unitId>]` |
| `claims/<claimKey>.json` | 证据闭包快照（claim 文本、citations → unit → quote → source sha/url）+ `closureHash` | `[claim:<key>@<closureHash8>]` |
| `themes.json` | 窗口内 claim 所属主题 + 昨日主题清单 | 增量动词的基线 |
| `READY` | 全部文件 sha256 清单，最后写 | — |

`claims/` 的闭包在 OVP 2.0.1 上由 bridge 从 `index.json` 联接得到（`ClaimRow.sources` →
`PackRow.pack_dir` → `source_sha256` → `SourceRow`，`build.rs:985,712`），不需要 `ovp2 claim`
（G3 之后换成调 CLI）。「本次可用 claims」= 引用了窗口内来源 pack 的 **全部**活跃 claim，
不只是当天新写的；`claims_delta` 另列当天 ledger 的 `write/supersede/retract`。

## 5. bridge 模块 `src/host/ovp-bridge/`

### 5.1 配置

```json
"ovp": { "enabled": true, "vaultRoot": "…", "vaultName": "daily", "bin": "…/ovp2",
         "channels": ["feishu-personal"], "timezone": "Asia/Shanghai", "digestAt": "08:00",
         "maxSourcesPerRun": 10, "maxDailyRunsPerDay": 6, "needsContentAttempts": 3,
         "crystalSynth": { "enabled": true } }
```
启动校验：路径存在、`ovp2 --version` 可执行且 ≥ 2.0.1、`.ovp/` 存在（否则先 `ovp2 init`
由人做）。任一失败 → 退出非零并写 `state.jsonl` 一行 `bridge-refused`。

### 5.2 子命令

`agentbox ovp-bridge scan | process | day | collect | validate <runKey> | doctor | status`。
launchd 跑 `scan && process` 每 5 分钟、`day` 08:00；`validate` 由 extension 工具同步调用；
`status` 给 automations 页（最近成功、积压、失败原因、下一次、暂停）。

### 5.3 采集细节

- 读 `messages.jsonl`（H1）为主；无 H1 的旧数据不补（明确不做回填，避免用推断造历史）。
- 每条消息：`redactLine` → 写归档 → 抽 URL → 规范化（纯函数：去 `utm_*`、`twitter.com→x.com`、
  去 fragment；**不**在这里展开 `t.co`）→ 每 URL 一个 capture。`t.co` 展开是网络动作，单独
  一步 `resolve`，成功写 `resolved_url`，失败记录原样。
- turn：transcript 按 `turnId` 聚合，最终 assistant 行为 `reply.md`；`activity.jsonl` 该 turn 的
  `tool_start` 压成 `research.jsonl`；`write_file` 到 `outbox/` 的路径 → box `sent/` 同名文件
  `downloadFile`（`client.ts:388`，字节 + hash），不用 `readFile`。
- 回复里 Nova 引用的外部 URL：抽出来列进 `research.jsonl` 的 `cited_urls`，**不**自动投
  capture（避免二手来源污染），日报可引用为 `[turn:]` 的依据。

### 5.4 处理与回读

- 先看 `.ovp/last-run.json`：`running` 且 pid 活着 → 本轮跳过并记 `deferred`。
- `ovp2 daily … --run-id lumenbox-<uuid>`；exit 与 stderr 尾 20 行入账。
- 回读顺序：`intake.jsonl` 按 `from` = 我们的 capture 路径取**全部**记录成链；`daily-runs.jsonl`
  按链上每个 sha 取记录；`reports/lumenbox-<uuid>*.json` 核对本次处理集合；`index.json`
  取 `pack_dir`、`units`、`cards`。`dup_of: url:…` → 在 `index.json` 按 url 找 canonical sha；
  `dup_of: sha256:…` 直接用。
- 每天 `ovp2 usage` 回读进 `status`。

### 5.5 秘密

`redactLine` + `heldValues`（`audit-export.ts:66,218`）已存在，覆盖正文、URL、frontmatter、
回复、research、子进程 stderr。附件不做文本扫描，归档区目录权限 0700，manifest 标
`attachments_unscanned: true`。`clean` 的定义是「未命中已配置检查」。

### 5.6 暂停的三层

| 层 | 开关 | 效果 |
|---|---|---|
| bridge | `ovp.enabled=false` 或 `agentbox ovp-bridge pause` | T1–T5 全部停；游标不动；`status` 显示 paused |
| 日终例程 | skill `paused: true` | 只停 T4/T5 消费；采集与 OVP 处理照常 |
| 已投的 capture | 无法撤回；用户在 Obsidian 打 `ovp/skip` | OVP 下次 sweep 记 `Skipped`，bridge 回读为终态 |

### 5.7 staging 与切换

staging = 日常 vault 的 rsync 快照（含 `.ovp/`），`vaultName: staging`。bridge 状态按
`vaultId` 分区。切换到日常 vault：改配置 → bridge 对每条已归档消息检查目标 vault 里有无
`lumenbox_capture_id` 对应的 intake 记录，没有就重投 capture（归档区整目录 rsync 过去）。
staging 里的 pack/claim 不迁移，日报引用里的 `@closureHash` 会失配，旧日报保留但标
`vault: staging`。

## 6. box 侧两个 skill

### 6.1 `research-reply`

同 docs/60 §7.1，三处改动保留，另加：回复里 Nova 的推断句前缀「（推断）」；引用外部资料
写完整 URL。这两条让 §5.3 能机械抽取。

### 6.2 `daily-research-digest`（`schedule: 20 8 * * *`，`deliver:` 本聊天，`paused: true`）

1. 找 `/home/box/work/digest/` 下最新带 `READY` 的包；没有 → 一行「昨天的包没到」。
2. 读 `manifest.status`；`partial` → 日报首行列缺口。
3. 综合（docs/58 §4 的步骤）：主题 = LLooM 式候选 + 纳入标准 + 回扫全部消息；每主题
   ≥2 个不同 **canonical 来源**（按 `SourceRow.sha256`，duplicate 已解析到 canonical）；
   张力单独一遍；增量动词只标 NEW / STRENGTHENED / CONTRADICTED，且 NEW 相对 `themes.json`
   的昨日清单判断。
4. 引用四种，逐句必带其一：`[msg:<id8>]`、`[unit:<case>/<unitId>]`、`[claim:<key>@<hash8>]`、
   `[turn:<id8>]`（Nova 的分析，且同句必须再带一个 `[unit:]` 或 `[msg:]` 作依据）。
5. 写 `draft.md` 到包目录；调 `ext__ovp_bridge_validate runKey=…`；报告里 `unresolved > 0`
   → 修一次再调；仍不过 → 在首行写明「有 N 处引用未能解析」后继续。
6. 把校验后的文件按 `<runKey>.digest.md` 放 `outbox/`，回复 ≤600 字短版（主线、主题名、
   张力、变化）。附录是索引不是全文：每条消息一行（预览 + 归档路径 + 来源状态 + 回复路径）。

### 6.3 `validate` 做什么、不做什么

做：四类引用能否在包里解析；`[claim:]` 的 hash 是否等于包内闭包 hash；`[turn:]` 句是否
带依据引用；短版字数；是否出现「逐条」小节（标题匹配消息标题的连续小节 ≥3 个）。
不做：语义支持（docs/59 §9 R5）。语义只靠金标日人工评。

## 7. 回执

H3 之前：`published.text = sent-observed | not-observed`（`sent/<runKey>.digest.md` 存在且
sha256 = 冻结值），不写 delivered。H3 之后：文本与文件各自 `ok(渠道消息 id) | failed(原因) |
unknown`。所有状态进 `digest/<runKey>/events.jsonl`，manifest 不改。

## 8. 失败表增补（docs/60 §9 之外）

| 失败 | 留痕 | 恢复 |
|---|---|---|
| 源账本被清空（inode 变） | 游标归零记录 | 依赖 `messages.jsonl`；transcript 不清空 |
| H1 行存在但 transcript 无 `causedBy` 命中 | 消息 `turnIds: []`，`join: none` | 合法（消息被 refused 后才 admitted 等） |
| 同一 turn 多条消息 | 每条消息都指向该 turn；产物按 turn 存一份 | — |
| steering 消息 | transcript `:1822` 行 `causedBy` 有它，turnId 同上一 turn | — |
| capture 写了但 OVP 从未跑 | 来源 `unknown` 到期 → stale | doctor |
| enrich 抓到正文 sha 变 | 链上第二条 intake 记录 | 取最新 |
| 半包（READY 不存在） | skill 不读 | T3 重跑覆盖同 runKey 的 package/ |
| 旧 `sent/` 同名文件 | 按 sha 比对，不按文件名 | — |
| 文件投递成功但 mv 失败 | `not-observed` 但 H3 回执 ok | H3 前标 unknown |
| vault 失联 | `bridge-refused`，所有对象保持原状态，不推进游标 | 恢复后续跑 |

## 9. 对 OVP 的改动：只提通用的，每条都有绕法

原则：改动对任何外部投递者（Pinboard、Web Clipper、别的 bot）都有意义；不出现 lumenbox
字样；走 OVP 自己的 CLI 标签和 evolution 规矩；bridge 第一版在 OVP 2.0.1 上不依赖任何一条。

| # | 通用改动 | 为什么通用 | 改哪 | bridge 现在怎么绕 |
|---|---|---|---|---|
| G1 | **frontmatter 透传到 index**：`ClippingFrontmatter`/`SourceDoc` 加 `#[serde(flatten)] extra`，`SourceRow` 加白名单 `meta` 映射 | 任何投递者的自定义键（Pinboard 的 `clipped_from` 今天就被丢）都能在 index 里查到，`find --meta k=v` 成为可能 | `ovp-domain/src/sources/markdown_inbox.rs:103`、`source_doc.rs:9`、`ovp-index/src/model.rs:48`、`build.rs:279`。注意 `source_doc.rs` 的 invariant #3（sum type，不要可选字段口袋）：flatten 只放解析层，`SourceRow` 用白名单，别给 `SourceDoc` 挂泛袋 | 用 `intake.jsonl` 的 `from` 路径当键；路径含 `<messageId>-<n>` |
| G2 | **来源自描述**：`SourceRow` 加 `capture_path`（intake 的 `from`）；`run-status.json` 加 `url/sha256/rel_path` | pack 不靠 index 联接就能说自己来自哪；`doctor` 的 claim→pack→source 链多一环可核 | `ovp-index/src/build.rs:279`、`ovp-domain/src/reader/pack.rs:85` | 同上 |
| G3 | **`ovp2 claim <key> --json`**：把 `claim_closure` 从 `ovp-mcp/src/lib.rs:113` 提到 `ovp-memory`（**不是** `ovp-index`：closure 还调 `ovp_memory::bilingual::evaluate_claim_projection`，而 `ovp-memory` 已依赖 `ovp-index`，放进 index 会成环），CLI 与 MCP 共用（`find` 的先例 `index_cmd.rs:143`，但 find 是纯 index 查询） | 脚本、CI、别的 agent 都能拿证据闭包；MCP 私有函数变公共能力 | `ovp-memory` 新 `closure.rs`（或拆：纯联接进 `ovp-index`，中文投影在 `ovp-memory` 包一层）；`ovp-cli/src/main.rs` 加 `PRODUCT —` verb；`commands/claim.rs` | bridge 自己在 `index.json` 上做同样的联接（§4.4） |
| G4 | **needs-content 有终态**：`IntakeAction::ContentUnavailable` + `attempts` 字段；sweep 在 N 次或 T 时之后不再 re-offer | 今天所有抓不到的 Pinboard 书签**永远**每次 daily 重试（`sweep.rs:180-190`，`daily.rs:294-349`），没有出口 | `ovp-intake/src/ledger.rs:16-63`、`sweep.rs:180`。新增 `IntakeAction` 变体 = ledger schema 变化：`read_jsonl`（`vaultops.rs:133`）一行解析失败就整份报错，旧 sidecar 读新 ledger 会整体失败，必须先装新 sidecar 再让它写新变体（同 cadence 那类坑） | bridge 按 `attempts ≥3 或 72h` 自己推导 `content-unavailable`，并在 Obsidian 里提示用户打 `ovp/skip` |
| G5 | **用户备注与来源正文分开**：约定 frontmatter `annotation:`（或 `note:`）为「读者自己的话」；intake 保留、reader **不**把它送进 unit 抽取、index 暴露、门户显示；Pinboard 的 `extended` 改写到这里 | 这是 OVP 自己的 bug：Pinboard 备注今天是正文（`pinboard.rs:579,657`），先被当来源证据，再被 enrich 整体覆盖丢掉 | `ovp-intake/src/pinboard.rs:657`、`ovp-domain/src/units/prompt.rs:39`（跳过）、`markdown_inbox.rs`、index/console | bridge 已把评论放 `annotation:`，OVP 当前忽略未知键——**绕法与改动兼容**，G5 落地后无需改 bridge |
| G6 | **enrich 留痕**：`update_source_body` 发 `source_enriched` pipeline 事件（旧正文长度 + sha）；`daily` 结束时 stdout 打一行 JSON（report 路径、run-id、计数） | 正文替换今天完全不可见（`web_fetch.rs:621-648` 无事件、无备份）；机器可读的结束行让任何调用方省掉猜报告文件名 | `ovp-enrich/src/web_fetch.rs:648`、`ovp-cli/src/commands/daily.rs:735` | bridge 用 `--run-id` 猜报告路径 `reports/<run-id>*.json`；正文替换靠 intake 链上 sha 变化推断 |

不提的：`run-now --max-sources`（直接调 `daily` 即可）、blocked 落账（推导规则稳定）、
「写 vault 的 MCP 工具」（OVP 的只读原则是对的）。

建议顺序：G5 和 G4 先（修 OVP 自身的 bug，和我们无关也该修）；G1 次之（一处 flatten
换来整条可追溯）；G3 与 G2 按需；G6 最后。每条各开一个 OVP 侧 issue，描述里不出现
lumenbox。

已开（2026-09-19，fakechris/obsidian_vault_pipeline）：G5 #481、G4 #482、G1 #483、G3 #484、G2 #485、G6 #486。

## 10. OVP 不改时的最小可跑形态

OVP 2.0.1 原样：H1/H2 落地 → bridge 采集与归档 → capture（`annotation:` 被忽略，无害）→
`daily --run-id` → 三个账本 + `index.json` 回读 → 包（闭包由 bridge 联接）→ skill → validate
→ outbox → `sent-observed`。缺的只是：needs-content 的终态靠 bridge 推导、closure 靠 bridge
联接、投递回执只到 sent-observed。三者都在 doctor 和 manifest 里如实标出。

## 11. 验收

- 单测 fixture（真实 24 条脱敏）：归档 24；来源对象数 = URL 数；每对象有终态或期限；重跑
  零重复写；URL 规范化表；`redactLine` 计数。
- 反例 fixture（每条一个测试）：源账本清空后重启；崩溃在写归档中途；同 turn 两条消息；
  steering；附件（图片 / PDF）；needs-content 三次；duplicate `url:` 与 `sha256:` 两种；
  enrich 后 sha 变；半包；旧 sent 同名；`sendFile` 静默成功（H3 后）；vault 失联再恢复。
- `doctor` 在 fixture 上全零；`validate` 对四类引用各有通过与不通过样例；「逐条小节」检测。
- skill scenario：ready / partial / absent 三个包；断言「该有的引用存在、不该有的不出现」，
  零 claim 的包不得出现 `[claim:]`。
- 金标日 3 天，Coverage / Citation；每次改 prompt 跑。

## 12. 分段

| 段 | 内容 | 退出条件 | 估计（不含 review） |
|---|---|---|---|
| H | H1 + H2 host 改动、测试、docs/05 数据文档更新 | 新消息 24/24 一个 id 贯穿到 transcript 与 turn | 1 天 + review |
| 1 | 配置、游标/状态账本、T1 采集归档、capture、规范化、脱敏、doctor；staging 快照 | 反例 fixture 前 6 条过；staging 连续 3 天 doctor 无 stale | 3 天 |
| 2 | T2 处理回读、来源状态链、T3 出包（闭包联接）、`validate`、两个 skill、T5 sent-observed | 其余反例过；3 个金标日 | 4–5 天 |
| 3 | H3 回执；切日常 vault；automations 页状态 | 文本 / 文件回执分开可见 | 1–2 天 + review |
| G | 向 OVP 提 G5、G4、G1（各自 issue），落地后 bridge 删对应绕法 | 每条独立 | 各 0.5–1 天，在 OVP 仓库 |

## 13. 待核实（开工前）

1. `orchestrator.prompt()` 的其它调用方（web、MCP face、routine）传 `messageId` 会不会撞：
   缺省自铸即可，但要确认没有调用方复用同一 id 两次。
2. 文本 8,000 字截断是否也影响 steering；H1 记全文即可，但 transcript 里的截断要在归档
   frontmatter 标 `textTruncatedInTranscript`。
3. `activity.jsonl` 的保留窗口（`activity.ts:102`）是否足以覆盖 5 分钟采集间隔加一次停机。
4. 日常 vault 真实路径、`.ovp/daily.env` 里是否有 `XQUIK_API_KEY`、`60-Agent/` 与 `10-Knowledge/Digests/` 无冲突。
5. `sent/` 文件在 outbox 投递失败时是否留在 outbox（`manager.ts:2050` 注释说会留），采集时要
   同时看 outbox。

## 14. 给第三轮 review 的问题

1. H1 把 uuid 铸在进门处并传下去，是否比「inbox 铸 id、H1 记 om_↔uuid 对照」更小？
2. `annotation:` 作为通用约定，OVP 那边是否更愿意用正文里的固定标题（如 `## Note`）？
   两者对 enrich 覆盖的行为不同（frontmatter 活、正文死），我倾向 frontmatter。
3. G4 的阈值（3 次或 72 小时）该由 OVP 定还是投递者定？
4. `[turn:]` 必须再带一个依据引用——这会不会让「开放问题」段无法书写？开放问题允许只有
   `[msg:]`。
5. 次晨 08:00 出昨日日报后，当天 22:00 前的内容用户想看怎么办：是否加一个按需的
   `/digest now` 生成「至今」版（revision 递增）？
6. staging 切换时不迁移 pack/claim，旧日报的 `@closureHash` 失配是否可接受？
7. 请再跑一遍 docs/59 §7 的十个输入，这次对照 §2 的状态机逐个给出终态名。

## 16. 修订（2026-09-20）：从信息流本质看，Nova 本身是一个采集入口；前提是先把 X 的正文拿全

### 16.1 看了 session 之后的事实

昨天 Nova 在 feishu-personal 的 transcript：WebSearch 82 次（Brave，只有标题、URL、引擎摘要），
WebFetch 82 次（host 端 `web.ts` 抓页，只抽 `<title>`，不抽 og:/author/published，正文最多
40,000 字给模型看；落盘只留 2,000 字残段，`DURABLE_RESULT_CHARS`；WebFetch 不像 bash 那样
spill 到文件）。其中 X 链接 21 次全部撞登录墙，拿到的只有 `<title>` 里的推文文本。

把昨天出现过的 19 个 X status id 拿 FxTwitter 分类：**18 条是 X Article**（`x.com/i/article/…`），
正文 3k–28k 字（合计约 16 万字），推文本身只是一个 43 字的 t.co 链接——Nova 对这 18 条看到
的就是这 43 个字加搜索摘要。立场稿里的「已核完 N 个事实」核的不是原文。这就是「信息质量
不足以可信」的量化，也是本节前提条件的来源。

结论：Nova **看见过**正文（非 X 页面最多 40k），但工作流只保存了结论；Clippings 那种带
`source/author/published/tags` 的 frontmatter 它从未产生；X 的正文它根本没拿到。

### 16.2 本质：三段信息流，两边各缺一段

获取（artifact + 来历）→ 落地（原句 + 位置）→ 综合（claim / 立场）。Clippings 与 Pinboard
进 OVP：获取被动（人剪什么读什么，不知为何读）、落地与综合齐全。Nova：获取主动（82 次
抓取里读了几十个用户没给的源）、综合强，但获取即用即弃，落地整段跳过。所以结合点不是
「把用户丢的 URL 投给 OVP」，而是：**Nova 的 research 过程就是一个 clipper**——每次
WebFetch 是一次 capture，每核一个事实是一次 grounding，立场稿是 crystal 的候选 claim；
差别只在它没把中间产物写成 OVP 认得的形状。

三种形态（可叠加）：A. Nova 是第三个采集入口——WebFetch 的结果同时写成 capture，带
Clippings 和 Pinboard 都没有的 provenance（哪条消息、哪个 turn、哪个 query、为核哪个
事实）；B. Nova 用 OVP 的 reader 做核实，立场稿引用 unit id；C. vault 是 Nova 研究的第一站，
先查 theme page / claim 再出去搜。合起来：发现（人剪 / 人丢链接 / agent 搜）→ 统一 capture
（带角色 `user-dropped | agent-read | clipped`）→ 落地 → 综合。对本文的改动：§4 的 capture
不只来自用户消息的 URL，也来自 Nova 每次抓取（角色 `agent-read`，只有被立场稿引用的才投
reader，其余只留 capture）；docs/60 §15 第 8 项「回复里六个外部 URL 没进状态机」随之消失。

### 16.3 前提：X 内容解析器（先于 INV-614）

2026-09-20 实测（语料：昨天 19 个 id，原始 JSON 存 `~/workspace/artifacts/x-corpus-2026-09-19/`）：

| 途径 | 全文 | 长推 | 线程 | Article 正文 | 引用 | 不可用原因 | 账号 | 结论 |
|---|---|---|---|---|---|---|---|---|
| FxTwitter v2 `GET api.fxtwitter.com/2/thread/{id}` | 是 | 是 | 是（同一调用返回 `thread[]`） | **是**：`status.article.content.blocks`（Draft.js：header/list/blockquote/atomic + entityMap 的 LINK/MEDIA/MARKDOWN 代码块），19/19 全取回，3k–28k 字 | 是 | tombstone `deleted/suspended/private/blocked/unavailable` | 否 | **主** |
| `cdn.syndication.twimg.com/tweet-result` | 短推 | **否**（`note_tweet` 只有 id 存根） | 否 | **否**（只有 title + preview） | 是 | 否（返回 HTML 错误页） | 否 | 备，必须标 partial |
| Xquik（OVP 现有路径） | 声称 | 未知 | 未知 | 未知 | 是 | 未知 | 否，付费 | 新厂商无记录；OVP 里只映射了 `text`+`entities.urls`，且本机无 key |
| X API v2 | 是 | 是 | 7 天窗口 | **不可能**（Articles 只有写接口） | 是 | 是 | 开发者账号，无免费档 | 排除 |
| twscrape / Playwright 登录 | 是 | 是 | 是 | 部分 | 是 | — | **真实账号，封号风险** | 不做 |
| Nitter / agent-twitter-client / Google cache / RSS | — | — | — | — | — | — | — | 2026 已死 |

规格（两边共用一份 fixture：上述 19 组 JSON → 期望 markdown；LumenBox 用 TypeScript 实现在
`web.ts`，OVP 用 Rust 实现在 `ovp-enrich`，同输入同输出）：
- 输入 status URL → id；主调用 `/2/thread/{id}`；`code ≠ 200` 读 tombstone；网络失败退
  syndication，并把结果标 `completeness: partial`（`note_tweet` 存在或 `article` 存在即 partial）。
- 输出 markdown + frontmatter：`source`（原 URL）、`canonical`、`kind ∈ tweet|note|article|reply`、
  `title`（Article 标题或作者 + 前 60 字）、`author`（handle、name）、`published`（`created_at`）、
  `fetched_at`、`fetcher ∈ fxtwitter-v2|syndication`、`completeness ∈ full|partial|unavailable`、
  `unavailable_reason`、`article_id`、`thread_ids[]`、`links[]`（展开后的 URL）、`media[]`（URL + alt）、
  `community_note`。正文：Article 按 blocks 渲染（h1/h2/h3、有序/无序列表、引用、`MARKDOWN`
  实体原样、`MEDIA` 实体写 `![alt](url)`、`DIVIDER` 写 `---`）；非 Article 写推文全文，随后
  线程各贴一节，引用推一节。
- 原始 JSON 与渲染后的 markdown 一起落盘（证据），frontmatter 记两者的 sha256。
- 自托管：FxEmbed 是 MIT，可部署到 Cloudflare Workers；先用公共实例（1,000 req/min/IP），
  配置项 `fxtwitterBase` 可换。ToS 风险：X 在 2026-08/09 对 Nitter 发了 C&D；FxEmbed 体量小但
  不是零风险，所以备选路径与「partial 必须标出」不可省。
- 验收：19 条语料 Article 正文 100% 取回且渲染后字数与 `blocks` 文本和一致；tombstone 三种
  以上 fixture；syndication 退路对同一 id 给出 `partial`；LumenBox 侧 `WebFetch` 对 x.com URL
  走该解析器后，Nova 看到的是全文而不是 43 字。

**两处实现，一份 fixture，不互相调用。** 需要 X 正文的时刻有两个：Nova 在回合里读链接（LumenBox
host 的 `WebFetch`，TypeScript，交互式）和 OVP 批处理 needs-content 书签（`ovp-enrich`，Rust，
离线）。INV-628 改的是前者，是关键路径：agent 行为与 skill 都不变，变的是工具返回全文。
OVP 侧的 G7（主路径 FxTwitter v2、syndication 为备、Xquik 可选第三、Article 渲染、
`completeness` 进 index）是**可选的通用改进**，不在关键路径上：bridge 投的 capture 直接带
LumenBox 已抓到的全文（INV-629 落盘后），正文 ≥ 200 字 OVP 直接 ingest，不会再去抓 X；G7 只
修 Pinboard / Clipper 进来的 X 书签，那是 OVP 自身今天就坏着的功能，排期由 OVP 定。不让
LumenBox 调 OVP 抓取：交互式与批处理形状不同、通用工具不能绑在 Mac 上的 ovp2 二进制、
跨语言进程调用换来的只是省一份两百行解析。两边共用 19 条语料的 fixture 防止漂移。

**实现记录（INV-628，2026-09-20）。** `src/host/x-post.ts`：`xStatusRef` 识别链接、`parseFxThread` /
`parseSyndication` 解析、`renderArticleBody` 渲染 blocks、`renderXPost` 输出带 frontmatter 的
markdown、`fetchXPost` 编排（`/2/thread` → 空正文时 `/2/status` 再取一次 → syndication 备路径，
tombstone 不走备路径）并落盘 `~/.agentbox/fetched/x/<id>/`；`WebFetch` 对 x.com 链接改走它
（`tools.ts`）；`fetchPage` 加了 `maxText` 与 `passStatuses` 两个选项（API 答复不截断、404 的
JSON 正文是答案）。fixture 是 19 组 `src/host/fixtures/x-corpus/<id>.{fx2,synd}.json` 加金标
`<id>.expected.md`，17 个测试。实测两条与文档不同处：FxTwitter 偶发返回「有 article 无 blocks」
（两条，重抓即齐），已作 partial 加重试处理；不存在的 id 是 HTTP 404 带 JSON 正文，不是 200。

**实现记录（INV-629，2026-09-20）。** `src/host/fetched.ts`：`keepFetchedPage` 把每次 `WebFetch` 的
全文（不受 40k 上限）连同 frontmatter（url / final_url / title / fetched_at / content_type / bytes /
text_chars / clipped / sha256 / author / published / site_name / agent_id / agent / conversation）写到
`~/.agentbox/fetched/<yyyy-mm>/<sha8>-<instant>.md`；`fetchPage` 多返回 `fullText`、`contentType`、
`bytes`、`meta`，`htmlMeta` 从 JSON-LD、Open Graph、`<meta>` 抽作者、日期、站名；tool result 末尾
`[full page kept: <path>]`，`storableResult` 的指针正则同时认 `full output kept` 与 `full page kept`；
保留 `AGENTBOX_FETCHED_RETENTION_DAYS`（默认 90，上限 3650），抓取时最多每小时清一次并记一行；
`audit-export` 把窗口内的 fetched 文件脱敏后带走，manifest 单列 `fetched`。`turn_id` / `tool_use_id`
留空，等 INV-613 的 H2 落地后再填。

### 16.4 顺序

X 解析器 → WebFetch 抓取落盘（所有 agent 抓取带元数据写 `~/.agentbox/fetched/`，是形态 A 的
基础，也终结 2,000 字截断丢证据）→ INV-614 第一段 → 第二段。前两项各提一个候选挂在 INV-612
下，X 解析器 BLOCKS INV-614，抓取落盘 BLOCKS INV-615。

