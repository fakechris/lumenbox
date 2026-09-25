# Muse / Hatch：skill 与盒子 binary 对照，以及哪些值得迁移

2026-09-25，静态阅读 `github.com/win4r/MuseAI-Skills`（commit `61121ab`）：72 个
`SKILL.md`、38 个 `manifest.yaml`、12 个 `eval/*.yaml`（187 条场景）、`opt/hatch/runtime-cell/`
全部脚本，以及从 LFS 取下的 13 个 x86-64 ELF（全是 Rust，`hatch` 本体 338 MB；`spawnd` 里
内嵌了全部 systemd/nspawn 单元模板，是读架构最有用的一个）。**没有运行任何 binary。**

**来源注意**：这是一个第三方存档的 Muse（muse.ai）运行环境快照，不是官方开源发布，许可不明。
下面只记**设计**，不搬文字；迁移时一律用我们自己的话重写，不复制它的 SKILL 正文或 manifest。
路径写成 `muse:<相对路径>`；二进制字符串的推断到字符串为止。

## 它是什么

一台 AMD SEV-SNP 机密 VM，里面用 **systemd-nspawn 起一个「runtime cell」** 跑 agent：

- **凭据、出网策略、浏览器、加密密钥全部在 cell 外面**。cell 里的连接器 CLI（gmail、plaid…）
  只是不可信的一半，通过 `/run/hatch/privsep/<tool>.sock` 让 systemd 起一个按连接派生、独立 uid
  的宿主 worker 执行带凭据的一半（`Accept=yes`，参数 + env 白名单 + fd 走 `SCM_RIGHTS`）。
  调用方身份用 SO_PEERCRED + cgroup 路径判定，不用 bearer token。
- **出网**：cell 内 DNS 故意是死的，只能走 `HTTP(S)_PROXY` 到一个做 MITM 的 egress 代理
  （Sentinel），下面再垫一层 eBPF `connect4/6` + veth tc 过滤，失败即关闭。
- **rootfs 是一次性的**：按镜像摘要做 btrfs 快照，镜像一换就丢；用户装的包记到
  `os-intent/ledger.jsonl`，开机后重放（`muse:opt/hatch/runtime-cell/ensure-rootfs.sh`、
  `hatch-preflight-opportunistic`、`hatch-manifest` 的 KDL 声明式对账）。
- **浏览器是宿主上的 broker 租出来的**：per-task slot、带 TTL 的 lease、语义级 RPC
  （`page_*`/`ax_*`/`input_*`），`credential_fill` 在 broker 里完成，模型看不到凭据。
- **自愈是单独一个平面**：`hatch-healthd` 汇总组件健康；`hatch-rescue` 先留证据
  （stall 快照、诊断包、agent 状态 git 备份）再动手，重启有冷却/退避/上限，策略分
  `shadow|enforce`，最后一级是换 VM；还挂了一个只有窄工具集的 Codex 诊断 agent。
- **skill 与二进制按渠道揭示**：`skill-scopes.conf`/`bin-scopes.conf` 用 overlay 把额外的
  skill 叠到只读基础树上，失败即退回基础树；文件里明说「可见性不是权限」，真正的权限在审批门。

## Skill 层对照

| 维度 | Muse | LumenBox 现状 |
|---|---|---|
| 包格式 | `SKILL.md` + 可选 `manifest.yaml` / `references/` / `eval/` / `bin/`；别名用符号链接 | `SKILL.md` + 助手文件（`src/host/skills.ts:37`），无 manifest、无 eval 目录 |
| frontmatter | `name`、`description`、`metadata.includeInPrompt`（常驻 vs 按需）、偶见 `allowed-tools` | 14 个已知键（`skills.ts:141-156`），**`allowed-tools` 被静默忽略**，而 vendored 的 5 个 hub skill 都写了它 |
| 渐进披露 | 描述常驻，正文与 `references/` 按「任务 → 先读哪个」表按需读；有「重注入后不许重读」的规则防止重启 intake | 只注入名称+描述+路径，12k 上限（`renderSkills`，`skills.ts:375-452`）——**已对齐** |
| description 写法 | 写「做什么 / 何时触发 / **何时不要用**」，并把相邻场景路由到兄弟 skill | 只写做什么；没有写作约定 |
| 方法级权限 | manifest 的 `actions.<组>.default: allow|ask` + 方法级覆盖 + `approval_phrase`（审批卡片动词短语）+ `commands` 把 ~100 个 CLI 命令归到少数权限键 | `SideEffectScope` 已定义（`tools.ts:2152`）但**生产代码里没有调用方**；审批靠 env 列表与 `rules/*.md`，默认除 RunOnHost 与不可逆点击外全放行 |
| 分层依据 | **按影响范围与可逆性，不按读/写**：只影响自己的放行，触达他人（发送、带邀请、共享、付款）才问；删除改为进回收站 | 不可逆检测只在浏览器 `act`，按关键词（`boxd/browser-service.ts:225`） |
| 配额 | `request_quota`，`shadow` 先行再 `enforce`，超限返回「本次终止」要求报告部分进度 | 策略门有模型花费与唤醒限流，没有按连接器方法的配额 |
| 评测 | 每 skill `eval/*.yaml`：`objective`（模拟用户首句）、`persona`、`world`（预置的假连接器数据）、`tests`（行为断言+禁止项）；类别含 trigger-positive/**negative**、safety、duplicate-protection；**诚实标 N/A** | `scenario.ts` 是整回合脚本化模型评测，很强，但**没有 per-skill 场景、没有触发评测**（roadmap:567 列为未来） |
| 调优闭环 | `eval/findings.md`：每场景约 10 次，失败打 `[Agent] trigger/jargon/incorrect/wasted-calls` 或 `[Infra]`，Agent 类改 SKILL，Infra 类改场景，连续两轮干净才停 | AGENTS.md「conduct 修复必须成为 scenario」——有规则，没有带停止条件的流程 |
| 遗忘 | 两阶段：只读子 agent 出计划 → 一次明确确认 → **新的**子 agent 重新校验后执行；9 类「数据可能躲藏或被重新生成」的清单；**先停生产者再清产物**；验证时不许复述被遗忘的内容 | `memory-admin.ts` 按来源撤销（9546aba），范围只到记忆；fetched/results/日程不在内 |
| 定时任务纪律 | 任务正文必须自足（cron worker 拿不到 skill 与对话）；确定性 job id + owner，先找已有的再建；先落指纹再通知；无变化静默；连续失败 N 次写「覆盖降级」 | 调度器有 skill 与 routine，但这些是写作约定，没人写下来 |
| 交付验收 | `artifacts/testing`：**看重新渲染出来的产物**，不信生成它的代码；占位符扫描；三次修不好就上报 | outbox 只按大小与文件名推送（`channels/manager.ts:1263`），**不检查文件能不能打开** |

## 盒子层对照

| 维度 | Muse | LumenBox 现状 | 结论 |
|---|---|---|---|
| 隔离 | 机密 VM → nspawn cell → per-exec cgroup → BPF taint | Docker 容器 + boxd bearer | 平台与威胁模型不同，**不迁** |
| 凭据 | 永不进 cell；privsep worker；代理侧注入（surrogate） | vault 只在宿主解析，经 RunOnHost 或 `browser_fill_secret` 用（`vault.ts`）；egress relay 只转字节不注入 | 方向一致；**relay 侧注入**值得做，见下 |
| 出网 | 死 DNS + 强制代理 + 内核级兜底 | box 内 loopback 代理 → 带令牌的 relay，按 bundle 白名单 | 已有同构的上层；内核兜底不迁 |
| 浏览器 | 宿主 broker、per-task lease | boxd 内 CDP，display 有独占 lease（`box/display-lease.ts`） | 已够用；per-task slot 暂不需要 |
| rootfs | 一次性快照 + 装包账本重放 | 容器可写层随升级丢失，`preflight.ts` 只提示「卷外最近文件」 | **账本重放值得做** |
| 自愈 | healthd + rescue（先取证，shadow/enforce，冷却/上限，最后换 VM） | HEALTHCHECK 只测可达；`wedge.ts` 只告警不动手；`rescue.ts` 只告诉人 | **取证 + shadow 重启值得做** |
| 输出投影 | `hatch-connector-output`：provider JSON → 有界的模型友好 JSON | INV-633 超长工具结果落盘 | 已覆盖，不迁 |
| 声明式装配 | `hatch-manifest`（KDL，指纹快路径 ~1ms） | Dockerfile 是唯一真相 | 与我们的规则冲突，**不迁** |

## 迁移清单（按价值排序）

每条都要先 `work_search`，再作为候选提给人承诺；这里只写判断。

1. **Skill 方法级权限声明，接进策略门。** 给 skill 与连接器加一个可选的权限声明（我们自己的
   schema，不照搬 manifest），把闲置的 `SideEffectScope` 真正接到 `needsApproval`：
   按「只影响自己 / 触达他人 / 花钱 / 不可逆」分层，而不是读/写；审批卡片的动词短语来自声明。
   同时让 `allowed-tools` 真的起作用：作为该 skill 运行时的**收窄**，永远不能放宽。
   *落点*：`skills.ts` 的 `KNOWN_KEYS`、`tools.ts:2152`、`policy.ts:653`、docs/05 §3.1a。
2. **Per-skill 行为场景 + 触发正/反例。** 允许 skill 带 `eval/*.yaml`（首句、人设、预置文件/世界、
   行为断言、禁止项、N/A 说明）；接到 `npm run scenario` 的实模型通道，脚本模型测不了触发。
   先给 12 个 starter 各写一条正例和一条反例。*落点*：`scenario.ts`、`scripts/scenario-live.mjs`。
3. **交付前的产物验收。** outbox 推送前做机械检查：魔数与扩展名一致、docx/xlsx/pptx 能解压且主部件在、
   PDF 能打开、文本里没有 `TODO`/`{{`/`lorem` 类占位符；不过就不推送，并告诉 agent 哪里坏了。
   配一个 starter skill 讲「看渲染结果而不是生成代码」。*落点*：`channels/manager.ts:1263`、`named-files.ts`。
4. **Skill 写作约定写进教学与文档。** description 写「何时**不**用」与相邻 skill 的分流；
   定时 skill 的正文必须自足；有副作用的定时任务要先找已有的、用确定性 id、先落指纹再通知、
   无变化静默。*落点*：`teach-drafts.ts` 的发布检查（可机械检查一部分：定时 skill 引用了
   「上文」「刚才」即警告）、docs/05。
5. **遗忘扩到「生产者清单」。** 把按来源撤销从记忆扩到 fetched 页、kept results、以及会重新
   写回的定时 skill；顺序是先暂停生产者再清产物；报告里不复述被撤销的内容。
   *落点*：`memory-admin.ts`、`fetched.ts`、`results.ts`、`schedule.ts`。
6. **盒内装包账本。** boxd 记下 agent 在盒子里 `apt install` 的包（dpkg post-invoke 钩子写
   卷上的 jsonl），升级盒子后机会式重放、失败退避、永不阻塞启动；`preflight` 报告账本
   而不只是「卷外有文件」。这是在不违背「Dockerfile 是真相」的前提下，让 agent 自己装的
   东西不在升级时无声消失。*落点*：`docker/box`、`src/box/preflight.ts`。
7. **自愈：先取证，再 shadow 重启。** `wedge` 判定 wedged 时先保存诊断（boxd 状态、最近日志、
   进程表），按冷却/上限记录「本来会重启」；跑一段 shadow 再决定是否 enforce。
   *落点*：`src/host/wedge.ts`、`rescue.ts`。
8. **relay 侧凭据注入。** 对白名单里的 API 主机，由盒外 relay 按 bundle 注入头部，盒内只拿到
   不透明句柄；这让「盒内需要一个 secret」第一次有安全的路。改动最大，放最后。
   *落点*：`src/egress/relay.ts`、`vault.ts`。

**不迁**：nspawn/机密 VM/eBPF taint/Noise 远程证明（平台与威胁模型不同）；70 个消费级连接器；
multicall 二进制；KDL 声明式装配（与 Dockerfile 规则冲突）；Codex 诊断 agent（等第 7 条的
shadow 数据说明值得再说）。
