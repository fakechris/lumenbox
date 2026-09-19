<!-- doc: 59-daily-digest-review
     title: 每日 research 总结的方案 review：参考 OVP 还是结合 OVP
     family: decision
     status: current
     updated: 2026-09-19
-->
# 59. 每日 research 总结的方案 review：参考 OVP 还是结合 OVP

送审稿，2026-09-19。功课在 docs/58（现状、三个参照系统、论文、独立方案、和 OVP 的结合
点）。本文只做一件事：把两条路线摊开，给一个推荐，列出必须由人拍板的点，以及按 docs/13
的要求给审稿人「怎么把它弄坏」的具体输入。

## 0. 一句话结论

**推荐「结合 OVP」，分三段落地；横向综合的逻辑先放在 LumenBox 的 skill 里迭代，稳定后
迁进 OVP 的 evolution 流程。** 理由一句话：docs/58 独立方案里要自建的四样东西——不可变
原文层、去重、带原句的证据单元、至少两源的跨源主题账本——OVP 全有并且带机械门；OVP
唯一没有的「日级横向叙事」，两条路线都得新写。所以结合的增量成本只是**管道**，而参考的
增量成本是**重造一个没有门的真相层**。

这是本文的第三版。第一版（docs/58 §4–5）是独立方案；第二版看完 OVP 后改成结合；第三版
吸收 §9 的复审，并在 §10 把「怎么进 vault」写成具体的数据流。§0–8 中被 §9 推翻的表述
（「新代码 0」「pack 数 = 输入数」「ReadHistory 拉原文」「120 秒去重即幂等」）以 §9、§10 为准。改变结论的
事实是：OVP 的 `digest` 只做运维计数，`product-pipeline.md` §5 明写「claim 层的模式 /
矛盾 / 新兴主题检测是未来工作」——也就是说它缺的正好是我们要做的那一步，而不是重叠。

## 1. 要解决的问题，和验收标准

**问题。** Nova 在 feishu-personal 每天收 10–25 条链接 / 转帖，逐条写「立场稿 + 盲区」。
需要一个日终动作：(a) 当天全部用户输入和逐条 research 完整归档；(b) 在其上做一次横向
提炼——主题、张力、和前几天比的变化、含义、开放问题——**明确不是逐条再列一遍**。

**验收标准**（无论选哪条路线都要过）：
| # | 标准 | 怎么量 |
|---|---|---|
| A1 | 附录含当天全部输入的原文（或「抓不到，用户贴的是这些」）和全部逐条回复 | 附录条目数 = 当天 admitted 输入数（去重后） |
| A2 | 主题不是列表 | 主题数 / 条目数 ≪ 1；每个主题 ≥ 2 条支撑，机械检查 |
| A3 | 每句可溯源 | 每句带 `[claim:…]` 或 `[source:…]`，解析不了的句子率 = 0 |
| A4 | 有增量 | 每个主题标 NEW / STRENGTHENED / CONTRADICTED / RESOLVED / DORMANT 之一，且有当天引用 |
| A5 | 安静日不发填充 | 输入 < 2 条或无主题过门槛时只发一行 |
| A6 | 同一 URL 不二次交付 | seen log 命中率可查 |
| A7 | 逐条回复瘦身 | 「跟前面 N 条线的关系」一节 ≤ 3 行，指向主题名 |
| A8 | 能在手机上读完短版 | 飞书消息 ≤ 600 字；长版有路径 |

## 2. 两条路线

### 路线 A：参考 OVP，独立在 box 里做（docs/58 §4–5 原案）

box 内三个 skill 文件加 `notes/digest/`：逐条 skill 顺手产结构记录（claims + 原句 +
置信度 JSON），日终 skill 读 `sent/` + `ReadHistory` + 登记簿做九步综合，seen log 一个
JSONL。不碰 host 代码，不碰 OVP。

### 路线 B：结合 OVP，把它当真相层

Nova 每收一条写一个 markdown note 进 vault 的 `50-Inbox/00-Capture/`；OVP 的 daily 做
去重、抓正文、grounded reader（unit 带原句 + 行号）、crystal（跨源 claim，durable 要求
≥ 2 独立源）、主题、topic page、中文投影。日终 skill 读当天新 pack 的 cards / units、
当天 ledger 新增 claim、相关 theme page，做张力 / 增量 / 综合 / 致密化，每句引 claim key，
用 OVP 的 `claim` 工具逐句校验，投递到飞书。逐条回复里的「关系」一节改为查 `theme_page`。

### 对比

| 维度 | A 参考 | B 结合 |
|---|---|---|
| 原文层 | 自建：`ReadHistory` 拉用户原文 + `sent/`；X 正文抓不到就只有用户贴的字 | OVP intake：原文永不改写，URL + sha256 去重，X 经 Xquik 抓推文正文 |
| seen log | 自建 JSONL | intake 去重 + `ovp_search` |
| 证据单元 | Nova（MiniMax-M3）自产 claims JSON，**无门**，引文是否真在原文里没人查 | reader trunk，`accepted_without_quote = 0` 硬门 |
| 「≥ 2 源」规则 | prompt 里恳求 + 自写检查 | crystal 机械门（distinct_sources ≥ 2 且分数 ≥ 0.70） |
| 主题登记簿 | 自建 markdown | `ledger.jsonl` + `themes.json` + `theme_pages.json`，有 supersede / strengthen 血缘 |
| 引用校验 | 自写 CitationAgent | theme_page 验证器同款规则 + `claim` 工具 |
| 中文 | 直接中文写 | zh 投影，英文单一权威 |
| 人看的界面 | 飞书 + box 文件 | 飞书 + Obsidian + OVP 门户（Today / Library / Knowledge / Ask） |
| 和已有阅读流合一 | 否：飞书链接流和 vault 的 Clippings / Pinboard 是两个知识库 | 是：一个真相层 |
| 上线时间 | 1–2 天 | 第一段 1–2 天（只投 capture，不改综合），第二段再 3–5 天 |
| 运行成本 | 日终一次 LLM | 多一份 OVP 的 reader 每源 `$` 和 crystal-synth `$`；预算是软的，只报不拦 |
| 新代码位置 | 只有 box 内 skill | box 内 skill + LumenBox 配置（vault 挂载、MCP 连接器）+ 可能一处 OVP（见 §5 Q3） |
| 跨系统失败面 | 无 | 两个时钟、一个挂载、一个 HTTP 端口、arm64 没有预编译 |
| 锁定 | 无 | 日报的引用键是 `ck-…`，OVP 没了引用就断——但 OVP 本来就是同一个人的产品 |

### 为什么不是 A

A 不是错，是**会把同一件事做两遍且做得更差**：Nova 用 MiniMax-M3 自产的 claims 没有
「引文必须在原文里」的门，docs/58 §3 引的幻觉研究（合并放大幻觉、末尾集中、泛泛
insight）正是针对这种无门综合的；而 OVP 从 2026-07 起就是为这个门建的。A 唯一的真实
优势是快 1–2 天，而 B 的第一段同样快。

### 为什么不是「全部进 OVP」

也考虑过把日终综合直接写成 `ovp2 digest --synthesis`（Rust，走 evolution 候选、cassette
回放）。没选它做第一步，因为综合 prompt 还要迭代很多轮，Rust + cassette 的迭代成本是
skill 文件的十倍；OVP 自己的 L3 聚类还在 A/B 阶段。它是**第三段**的去处，不是起点。

## 3. 推荐：结合，分三段

**第一段：归档与接入闭环（§9.6 的重划；具体数据流见 §10）。**
- host 侧一个接入程序（不是挂载，不在 box 里）：从 LumenBox 的账本确定性导出每条用户
  消息、每个 turn 的 research 记录和回复，写进 vault 的归档区；从消息里的 URL 生成
  capture 投 `00-Capture/`；调用 `ovp2 daily`，回读 intake / daily-runs 账本，给每个输入
  记处置。幂等键是消息 id 和 turn id，不是 URL。
- 逐条 skill：把「立场稿 + 盲区」从记忆约定写成文件；「跟前面的关系」先缩到 3 行。
- 退出条件：连续 3 天对账通过——归档条数 = 当天 fromPerson 消息数；每个 capture 都有
  intake 处置（ingested / duplicate / needs-content）和 reader 结果（pack / 零 unit /
  失败）；没有任何输入落在「不知道去哪了」。不以 pack 数验收。

**第二段：综合改吃 OVP（3–5 天）。**
- 日终 skill 输入换成当天新 pack 的 cards / units + ledger 新增 claim + theme page；
  每句引 `[claim:…]` / `[source:…]`；写完逐句 `claim` 校验，不过打回一次再拒。
- 逐条回复「关系」一节改为 `theme_page` 查询，≤ 3 行。
- 增量动词：NEW / STRENGTHENED / RESOLVED 从 ledger 读；CONTRADICTED / DORMANT 由日终
  pass 判。
- 日报写到 vault 普通笔记目录（不是 capture 目录），中文用 zh 投影。
- 退出条件：A2、A3、A4、A7 过；手标 3 个金标日跑 SummHay 式 Coverage / Citation。

**第三段：把稳定的综合迁进 OVP（时机由第二段数据决定）。**
- 综合 prompt 作为 OVP evolution 候选进 Rust，`ovp2 digest --synthesis`；LumenBox 例程
  退化为「调 OVP、投递飞书」。OVP 顺便得到它 roadmap 里空着的「claim 层矛盾检测」。

**谁拥有时钟。** LumenBox 例程（`schedule: 0 22 * * *`，`deliver: feishu-personal:oc_…`）。
它先 `ovp2 schedule run-now daily --unless-ran-within-secs 120`（和桌面 app 每 600 秒的
tick 去重），再 `crystal-synth`（默认不在 daily tier，手动命令），再综合，再投递。失败读
`.ovp/last-run.json` 和 `reports/daily-<date>.json` 的 warnings，一行报告。

## 4. 已知风险和应对

| 风险 | 事实 | 应对 |
|---|---|---|
| 推文太短，reader 榨不出 unit | 正文 < 200 字进 NeedsContent；今天 24 条里多数是 X 链接 | Xquik 抓 thread 全文；仍短的打 `ovp/force`；接受推文的 unit 少，横向主题主要由文章和 Nova 核实出的事实支撑（见 Q2） |
| crystal-synth 不自动跑 | 文档列了 5 个进入 daily tier 的前提 | 日终例程显式调用；零新 claim 是合法结果，日报改用 cards / units 兜底 |
| box 里跑不了 `ovp2` | 预编译只有 macOS arm64 / Linux x64，box 是 Linux arm64 | `ovp2 serve` 在 Mac 上，box 走 `host.docker.internal:3141`；或 MCP 连接器接 host 上的 `ovp2 mcp` |
| 两个时钟撞车 | 桌面 app 自带 tick；`is_due` 失败不重试 | `run-now --unless-ran-within-secs`；例程里判 `last-run.json` 状态 |
| enrich 覆盖用户贴的正文 | 薄 note 被 `update_source_body` 整体替换 | ≥ 200 字或 `ovp/force`；用户原文另存一份在 frontmatter 之外的字段（见 Q4） |
| OVP 主题质量 | 关键词分桶在规模上被证伪，L3 LLM 聚类 A/B 未定 | 第二段主题以 claim 为单位，不依赖社区标签；社区只当分组 |
| 花钱 | reader 每源 `$`，budget 只报不拦 | `--max-sources` 限流；LumenBox 侧 policy gate 兜底 |
| 一手二手混淆 | Nova 立场稿若也投 vault，会和原文一起做 claim | 第一步只投用户输入；立场稿是否入 vault 见 Q2 |
| 引用键失效 | 日报引 `ck-…`，OVP 重建 ledger 不会变（key 是确定性哈希），但删 pack 会断链 | `doctor` 查链；日报附录同时留 source sha |

## 5. 需要审稿人拍板的点

**Q1. 路线。** A 参考 / B 结合 / B 但跳过第一段直接做第二段。推荐 B 三段。

**Q2. Nova 的立场稿要不要进 vault。**
- 不进（推荐第一步）：真相层只有一手材料，Nova 的核实结果只在飞书和 `sent/`。
- 进，tag `nova-reply`，只允许做 caveated：agent 的 research 也被 unit 化，可被引用，
  但永远不成 durable。
- 进，和原文同等：最省事，最容易把二手推断混成事实。

**Q3. 综合逻辑的家。** box skill（推荐起点）/ 一开始就进 OVP Rust / 永远留在 skill。

**Q4. 用户原文的保真。** 投 capture 时用户贴的文字放正文（可能被 enrich 覆盖）还是放
frontmatter 自定义字段 `pasted_text`（intake 忽略未知键，保真但 reader 看不到）。推荐：
正文 + `ovp/force`，`pasted_text` 再存一份。

**Q5. 日报落在 vault 哪里。** 普通笔记目录（推荐，人在 Obsidian 里读）/ 只在 box /
两处都写。

**Q6. 中文权威。** 日报直接中文写（推荐，日报是 derived）/ 英文写再走 zh 投影。

## 6. 影响面（哪些决定事后改不了）

- **capture note 的 frontmatter 字段和 `source` URL 规范化**：进了 intake 就是 sha256
  身份，改字段不会重处理，但历史 note 不会补字段。
- **日报里的引用键格式**（`[claim:ck-…]` / `[source:sha]`）：写进每一天的日报，改格式
  等于旧日报失去可校验性。
- **seen log 的键**（规范化后的 URL 还是 sha）：决定「同一条」的含义；OVP 用 sha 主键
  URL 副键，跟着它。
- 逐条回复格式的改动（A7）只影响之后的回复，可逆。

## 7. 给审稿人：怎么把它弄坏

按 docs/13，请逐个用下面的输入跑一遍脑内模拟，说每一个会落到哪、产生什么键：
1. 同一条 X 链接，第一次是纯 URL，第二次是 URL + 用户 300 字评论——是一条还是两条？
   （OVP 按 sha 是两条，按 URL 是重复停车；日报该算几条？）
2. 一条 X 链接，Xquik 抓不到（限流 / 私密），用户贴的只有 40 字——它能进 reader 吗？
   进不了时日报附录怎么呈现它？
3. 一天 3 条输入全是同一篇文章的转发——主题门槛「≥ 2 独立源」怎么判「独立」？
4. `ovp2 daily` 当天失败（3 次阻塞），日终例程照常触发——日报发什么？
5. 桌面 app 的 tick 在 21:58 跑了 daily，例程 22:00 又 run-now——会不会双写 pack？
6. crystal-synth 全部 refuse（零 claim）——A2 怎么算，主题从哪来？
7. 昨天的主题今天没有任何输入提到——DORMANT 由谁判，凭什么引用？
8. 一条 30 KB 的逐条回复里 Nova 自己引了 6 个外部 URL——这些 URL 要不要也进 capture？
9. 用户在 23:30 又丢了一条——算今天还是明天？日界怎么定，重跑会不会重复投递？
10. vault 挂载路径在 Mac 上改名——box 内例程会怎么失败，会不会静默？

## 8. 明确不做

- 不改 OVP 的门和账本格式；不给 MCP 加写工具（`capture-drop` 是唯一写路径）。
- 不在第一、二段动 host 的调度代码；OpenClaw 式「持久命名 session」用登记簿文件替代。
- 不做周报；周报是日报文件的再综合，等日报稳定。
- 不自动判断「这条值不值得读」（OVP 自己测过结构信号判不准，留 `ovp/skip` 给人）。

## 9. 实现边界复审（2026-09-19）

**审查结论：认可复用 OVP 的方向，但 §0–8 尚不能直接作为实施合同。** 本节保留前文作为
送审方案，记录审查发现和修订建议；不代表 Q1–Q6 已经由人拍板，也不代表接入已经实现。
前文的「增量成本只是管道」「新代码为 0」和 1–2 天 / 3–5 天估计，需要在接入合同明确后
重新评估。OVP 提供证据基础，但不自动承担聊天归档、research 关联、日报运行和交付保证。

审查范围：docs/58、本文、docs/13、LumenBox 的 history / tools / MCP / Docker 配置代码、
本地 OVP 源码，以及当前 `agentbox-box` 的挂载。OVP 检查时 HEAD 为 `9b69407`；下列 OVP
路径均相对于 `obsidian_vault_pipeline` 仓库，行号是本次检查位置。运行现场是当时快照，
不能由源码检查推定未来部署状态。本次没有运行真实摄取或向飞书投递。

### 9.1 现在是否已经结合

检查到的 `agentbox-box` 仅挂载 `/home/box/.config` 和 `/home/box/work`，没有 Obsidian vault。
本机默认 `~/.agentbox/config.json` 的 `mcpServers` 无配置项。这不排除其他环境里的人工
操作，但没有证据表明 Nova 当前的输入、过程和产出已经自动进入 OVP。

**挂载只解决文件可见性。** 它不会自动把聊天写进 vault，不会把回复关联到用户消息，
也不会保证 capture 已被读取、证据已生成、日报已交付。§3 描述的是待建设链路。

### 9.2 输入、过程、产出分别怎么接

应区分「保存在 vault」和「成为 OVP 的来源证据」。两者不是同一个准入决定。

| 对象 | 进入 vault 的方式 | 与 OVP 的关系 |
|---|---|---|
| 用户消息原件，包括评论、贴文、附件信息 | 从 LumenBox 持久记录确定性导出，保留消息身份、时间和原文 | 不能全部无差别当外部来源；用户评论和转贴原文需区分归属 |
| 外部文章、推文原文 | 接入程序生成 capture，并关联触发它的消息 | 经 intake / reader 产生可引用证据 |
| research 过程与逐条回复 | 归档工具调用及结果、引用资料、完整回复和失败状态 | 回复是派生产物，不能作为独立来源反哺 crystal |
| 日报 | 写普通笔记目录，关联本次输入清单、证据和运行记录 | 派生产物，不进 capture |

这里的「过程」是可观测的检索、工具记录和产物，不是模型隐藏思维过程。归档也不意味着
把凭据或其他秘密复制进 vault；导出边界应遵守仓库的秘密处理规则。

建议的数据流（待实现）：

```text
LumenBox 持久化消息、research 记录、回复
                    |
           接入程序：归档、关联、重试
                    +----> vault：消息 / research / 回复归档
                    +----> 00-Capture：外部来源材料
                                        |
                                  OVP intake / reader
                                        |
                                packs / units / claims
                                        |
当日消息与 research 清单 -----------------+
                                        v
                                   日报综合 skill
                                        |
                              vault 日报 + 飞书交付
```

物理连接可以采用 OVP 在 Mac 运行、LumenBox host 通过 MCP 读取证据、接入程序写 capture
和归档的方式；box 未必需要整个 vault 的读写权限。若直接挂载，需明确可写目录、写入者、
原子投递和结果检查。读取 MCP 与触发 daily / crystal 是不同接口，必须分别说明。

接入合同至少要记录：消息身份、聊天范围、接收时间、原件位置及摘要、来源身份及版本、
research run、回复产物、OVP 处置 / pack 关联、摘要窗口及版本、交付结果。命名可复用已有
概念，但这些关联不能靠文件名和模型回忆推测。

### 9.3 阻断问题与修订要求

#### R1 · P1：ReadHistory 不能提供完整原文归档

§3 第一段依赖 `sent/ + ReadHistory` 满足 A1。但 `src/host/history.ts:37–41` 规定每条
最多 600 字符、每次最多 25 条；`:112–114` 还会折叠空白并截断。分页能解决条数，不能
恢复被截断的正文。`src/host/tools.ts:1249` 也明确它返回 bounded compact reading，
不是 raw content。

修订要求：原件归档走持久记录的确定性导出，按消息身份对账；ReadHistory 只作辅助回查。
Skill 可以调用导出，但「全部归档」必须由程序检查，不能仅依靠 prompt。

#### R2 · P1：只接原始来源，会丢失 research 的增量

§1 要求完整归档逐条 research，Q2 却推荐立场稿第一步不进 vault；第二段又只读 packs /
claims。这可能让 Nova 新发现的资料、盲区和推断退出日报输入。

修订要求：完整回复和可观测过程进入归档区；外部证据进入 capture；Nova 的分析可以参与
日报，但注明是分析并关联依据。原文和 Nova 对原文的复述不能计成两个独立来源。
`nova-reply` tag 本身不能证明「永远不得 durable」已有机械实现；若保留该选项，必须指出
限制执行的位置和测试。归档入 vault 不需要以真相准入为前提。

#### R3 · P1：ovp/force 不保证短文获得 reader pack

OVP `crates/ovp-intake/src/sweep.rs:243` 的 force 绕过 intake 大小门；但
`crates/ovp-daily/src/lib.rs:321–335` 仍调用 `worth_distilling`，短文可能以 Succeeded、
零 unit、无 pack 结束。默认 Balanced 门槛是 200 字符，不是对所有配置通用的固定值。

另据 `crates/ovp-enrich/src/web_fetch.rs:618–649`，enrich 会保留 frontmatter、替换整个
正文。因此「原文永不改写」不能不加限定地用于 capture 阶段。

修订要求：聊天原件独立保全，抓取正文另存并关联；force 不兼任保真、补全文和成功保证。
删除「pack 数 = 输入数」的退出条件，改查逐项处置。正文加 frontmatter 副本不能替代完整
的原件归档合同。

#### R4 · P1：来源去重不能替代处理与回复去重

先 `ovp_search` 查 URL 有两种反例：URL 已由 Pinboard 入库但 Nova 从未回复；第一条
capture 尚未索引，第二条同 URL 已到达且查不到。搜索命中不是研究或交付回执。

| 身份 | 需要回答的问题 |
|---|---|
| 消息身份 | 用户这次说了什么，有没有新增评论或要求？ |
| 来源身份及版本 | 是否同一篇资料，正文有没有变化？ |
| research / 交付身份 | 是否已研究、是否成功回复、是否要求重做？ |

修订要求：分别维护上述关联。相同 URL 第二次带 300 字评论，应保留第二次输入、复用来源
关联，按新增意图决定研究行为，不能按 URL 抹掉评论。

§6「改字段不会重处理」也不能作保证：`crates/ovp-intake/src/sweep.rs:170–173` 对完整文件
字节计算 sha256，frontmatter 改动也会改变 hash；其后 URL 去重可能停车，需按实际分支解释。

#### R5 · P1：claim 可解析不等于日报句子受到支持

`crates/ovp-mcp/src/lib.rs:407–417` 的 claim 工具返回已有 claim 的证据闭包，不接收日报
新句子并判定其含义。将「特定测试上提高」写成「已全面超越」，仍能引用一个存在的 key。
theme page 的引用门也不能被描述为完整的语义真实性判断。

修订要求：分开验收引用存在、原句可定位、表述受支持、推断有明确标记。`[source:sha]`
不能交给 claim 查询直接验证，units / cards 兜底也需要对应定位规则。新综合仍需自己的
质量校验；复用证据基础不等于省掉该步骤。

#### R6 · P1：当天新 pack / claim 不等于当天用户活动

今天讨论旧文章而 pack 上周已生成，会被漏掉；昨天失败今天补跑，会混入今日；同 vault
其他入口的新材料，也可能被误算成 Nova 的输入。

修订要求：先固定本次覆盖的消息、聊天和 research 清单，再关联 OVP 证据。接收时间、
来源发布时间、处理时间和摘要窗口分别记录。处理时间不能代替用户活动时间或范围。

#### R7 · P1：两分钟去重不构成日报幂等

OVP 已有 dispatch lock，不能把风险概括为「没有并发保护」。但
`crates/ovp-cli/src/commands/scheduler.rs:443–453` 的 recency 判断为 `< window`，
恰好 120 秒不跳过，且不只对成功运行生效。跳过只能说明最近有执行记录，不能证明当前
摘要清单已被处理。

修订要求：写清 box 无二进制时谁触发 host 作业、用什么接口、怎样等待和检查结果。
daily 的幂等不能推导出综合、写日报、发飞书的幂等；后者需独立的摘要运行键、输入快照、
产物版本和交付记录。发送结果不明确时应保留待核状态，不宣称已经保证恰好一次。
`.ovp/last-run.json` 也必须关联到预期运行，不能把另一轮的状态当成本轮结果。

#### R8 · P2：独立源和增量标签超出了现有门的语义

`crates/ovp-domain/src/crystal.rs:254–270` 将通过 grounding 的 case_id 去重计数；这不是
对转载、共同上游和信息来源独立性的自动证明。两篇不同文章可以复述同一个来源。

`crates/ovp-domain/src/crystal/lineage.rs` 的 supersede 表示近似文本获得更多证据，
不等于争论或开放问题已经 RESOLVED。新 claim 也不必然代表新主题。

修订要求：证据 case 数与独立信息来源数分开；不要将 supersede 直接映射为 RESOLVED。
DORMANT 表示某个完整观察窗口未见新材料，应引用历史状态与窗口清单，不能强求当天有
正向来源引用，也不能将漏采或故障解释成主题消失。

### 9.4 验收标准修订建议

以下替换项待方案修订时落实，不把尚未实现的行为写成已通过：

| 原条款 | 修订要求 |
|---|---|
| A1 完整归档 | 按消息身份对账，重复消息中的新评论也保留；检查原文内容和附件处置，不只数去重后的条目；逐条 research 有产物或明确失败状态 |
| 第一段 pack 数 = 输入数 | 删除等式；一条消息可含多 URL，多条消息可关联同一来源，合法处置也可能无 pack；每个输入必须有可解释的结果 |
| A2 主题不是列表 | 比值只作观察指标；检查主题具体性、材料支撑和覆盖，防止「AI 很重要」这一泛化主题骗过数量门 |
| A3 每句可溯源 | 引用解析率与语义支持分开；事实、综合推断、开放问题按类型校验，不能以真 key 洗白无依据的新结论 |
| A4 有增量 | 指明比较基线、观察窗口和标签语义；问题解决需直接依据，未出现需覆盖证据 |
| A5 安静日 | 区分没有输入、没有横向主题、证据不足、处理失败；全部失败不能称为今天安静 |
| A6 不重复交付 | 以消息意图、research 及交付回执判断；允许新增评论和明确要求重做，不以 URL 已入库代替已回复 |
| A7 回复瘦身 | 保留三行约束；主题页尚不存在或过期时应明确降级，不编造主题关联 |
| A8 手机可读 | 短版限制保留；长版必须有附件或手机实际可访问的链接，box 本地路径不足以验收 |

归档和运行检查应使用确定性 fixture；综合质量用金标日检验。实现时如引入 agent 行为
变更，按仓库要求将失败 episode 纳入 scenario，再执行 `npm test`。

### 9.5 十个破坏性输入的预期结果

| §7 输入 | 应有结果 |
|---|---|
| 1. 同 URL 第二次加评论 | 两个消息记录，共享来源关联；新增评论进入当天活动，按意图决定是否新增 research |
| 2. 40 字贴文且抓取失败 | 原文完整归档；明确内容不足 / 抓取失败；不得以 intake 已通过宣称生成了 pack |
| 3. 同一文章三次转发 | 保留三次活动；不能因此计成三个独立信息来源 |
| 4. daily 失败或阻塞 | 归档继续可核对；日报报告处理覆盖和缺口，可用证据有限时明确部分结果，不发「今天安静」 |
| 5. tick 与例程相邻 | 分别验证执行锁、摘要输入快照、日报版本和交付回执；不以 120 秒窗口作为完整保证 |
| 6. crystal 全 refuse | 保留拒绝状态；可基于 units 做明确标为暂定的综合，但不得升级成 durable；没有合格主题也允许如实报告 |
| 7. 昨天主题今天未出现 | 仅在观察窗口覆盖明确时标记未观察到；不能推断主题已失效或问题已解决 |
| 8. 回复引用六个 URL | 区分实际使用的外部证据与仅提及链接；保留引用角色和来源关联，不把回复本身当第七个独立来源 |
| 9. 23:30 新消息 | 由明确的时间窗口纳入下一次摘要或修订；22:00 触发不能声称覆盖尚未结束的自然日；重跑遵守交付记录 |
| 10. vault 改名或失联 | 接入显式失败并保留待处理记录；恢复后可重试和对账；不得静默丢弃或将空目录当空闲日 |

### 9.6 决策建议及新的分段方式

| 决策 | 复审建议 |
|---|---|
| Q1 路线 | 继续 B，但第一段改成归档与接入闭环，不跳过 |
| Q2 立场稿 | 进入 vault 归档区，不作为独立外部证据喂给 crystal |
| Q3 综合逻辑 | skill 起步；采集、关联、重试、回执由程序保证，不能全放 prompt |
| Q4 原文保真 | 原始消息独立保存，抓取正文另存；frontmatter 副本不作唯一保障 |
| Q5 日报落点 | vault 为正式落点，box 可有工作副本；飞书交付长版可打开的附件或链接 |
| Q6 中文 | 日报直接中文，保持稳定证据引用；前文 §3 的 zh 投影推荐与 Q6 不一致，应统一 |

建议重新划分三段：

1. **归档与接入闭环。** 确认实际 vault 和运行位置，落地消息 / research / 回复的保全、
   capture 投递、身份关联、逐项处置和故障恢复。先以完整性及幂等验收，不以 pack 数验收。
2. **基于证据的日级综合。** 固定摘要清单，组合当日活动、research 增量与 OVP 证据，加入
   类型化引用验证、语义支持评估、明确日界及交付记录，再收敛逐条回复的横向关系段。
3. **按运行数据决定归属。** 稳定后把输入、输出、验证及评估合同纳入 OVP evolution。
   是否迁入 Rust 由部署和运行需求决定，不将实现语言迁移预设为成功的必要条件。

建议用于下一版的结论：

> 复用 OVP 的来源处理和证据基础是合理方向，但 LumenBox 仍需建设消息与 research 的归档
> 接入、跨系统身份关联、摘要运行及交付回执。OVP 的证据门能降低来源和引用错误，不能
> 替代日级综合的语义校验。日报的范围由用户实际输入与研究活动确定，再关联 OVP 证据，
> 不能直接等同于当天 OVP 新处理的文章。

## 10. 接入数据流：现在什么都没连，具体怎么连（第三版新增）

### 10.1 现状：四样东西各在一处，没有一根线连着 OVP

| 对象 | 今天在哪 | 形态 | 能被谁读 |
|---|---|---|---|
| 用户输入原文 | Mac host：`~/.agentbox/agents/<nova>/conversations/<chat>.jsonl`，`role: user` 行的 `text` 是**全文**，带 `at`、`fromPerson`、`causedBy`（= `inbox.jsonl` 里的消息 id） | JSONL，追加不改 | host 进程；box 只能通过 `ReadHistory` 拿截断版（每条 ≤ 600 字，§9 R1） |
| 飞书消息身份 | host：`ingress.jsonl`（飞书 `om_…` id、到达时间、字数）、`cards.jsonl`（taskId ↔ `om_` handle）、`inbox.jsonl`（消息 id、原文、receivedAt） | JSONL | host |
| 过程 | host：`activity.jsonl`（每次 WebSearch 的 query、每个 write_file 的路径）、`turns.jsonl`（turn begin / end、workId、about）、`usage.jsonl` | JSONL | host |
| 逐条回复 | box 卷 `agentbox-box-work` → `/home/box/work/chats/<chat>/sent/2026-09-19_*_reply.md`（15 个，250 KB）；回复正文也在 transcript 的 assistant 行里 | markdown | box；host 通过 `BoxClient.readFile` |
| OVP | vault 路径未配置（`~/.agentbox/config.json` 无 `mcpServers`，无 vault 项）；`ovp2` 只有 Mac 版；box 没挂 vault、没装 ovp2 | — | 谁也没读 |

所以「结合」今天是零。§3 第二版说的「挂载 vault」也是错的方向：挂载只让 box 看见目录，
不会有任何东西自己走进去。

### 10.2 接法：host 上一个接入程序搬运，box 不挂 vault、不装 ovp2、不连网

四样东西里三样在 Mac host 上，OVP 也在 Mac 上，box 只有 `sent/`。所以搬运的程序放在
**host**，用 LumenBox 进程的权限跑；box 侧只接收 host 推进来的当日包，日终 skill 读本地
文件即可。三条物理连接全是 host 已有的能力：host 读自己的账本、host 用 `BoxClient`
读写 box 文件、host 在 Mac 文件系统上写 vault 并调用 `ovp2` 命令行。

```text
                Mac host（LumenBox 进程 / 接入程序）
  ┌───────────────────────────────────────────────────────────────┐
  │ 读账本：conversations/*.jsonl  ingress  inbox  cards  turns   │
  │         activity                                                │
  │ 读 box：BoxClient.readFile  chats/<chat>/sent/*.md            │
  │                                                                 │
  │ A 归档  ──写──▶ <vault>/60-Agent/lumenbox/<chat>/<date>/       │
  │                  <msgid>.md（原文 + 身份 frontmatter）          │
  │                  <msgid>.reply.md（回复）                        │
  │                  <msgid>.research.jsonl（query / 读了什么）      │
  │ B 投源  ──写──▶ <vault>/50-Inbox/00-Capture/<date>_<slug>-     │
  │                  <msgid8>.md（frontmatter source: <url>）        │
  │ C 跑 OVP ──exec─▶ ovp2 daily / crystal-synth / index            │
  │           ◀─读── .ovp/intake.jsonl  daily-runs.jsonl            │
  │                  index/index.json  crystal/ledger.jsonl         │
  │ D 对账  ──写──▶ <vault>/60-Agent/.../digest/<date>/manifest.json│
  │                  （消息清单、每条处置、pack 路径、新 claim）      │
  │ E 推包  ──BoxClient.writeFile──▶ box:/home/box/work/digest/<date>/│
  │                  manifest.json + cards.json + units.accepted.json│
  └───────────────────────────────────────────────────────────────┘
                                   │
                        box：日终 skill（定时例程）
                        只读 /home/box/work/digest/<date>/
                        写 outbox → deliver: 飞书
                                   │
  host：F 回收 ◀─ BoxClient.readFile 日报 → <vault>/10-Knowledge/Digests/<date>.md
        + 交付回执（deliveries / manager 的投递记录）写进 manifest
```

每一步的键和幂等：

| 步 | 触发 | 幂等键 | 输入 | 输出 | 失败怎么留痕 |
|---|---|---|---|---|---|
| A 归档 | 账本有新的 `fromPerson` 行 | inbox 消息 id | transcript user 行 + ingress/inbox/cards 的身份 | 归档区一个 `.md`；frontmatter：消息 id、`om_` id、chat、时间、agent、taskId、URL 列表 | 写不进就不推进 checkpoint，下次重来 |
| B 投源 | A 里每个 URL | 消息 id + URL 规范化 | URL、用户贴的正文（若有）| capture note；frontmatter `source`、`title`、`tags: [lumenbox, feishu-personal]`、`lumenbox_msg_id` | 同上；重复 URL 由 OVP intake 停车，B 不自己判 |
| C 跑 OVP | A/B 之后，或按时 | OVP 自己的 RunLock | vault | pack / 账本 | `daily-runs.jsonl` 里的 failed / blocked 原样回读 |
| C' 关联回读 | C 之后 | capture 路径 → 文件 sha | `.ovp/intake.jsonl`（处置）、`daily-runs.jsonl`（reader 结果）、`index.json`（pack 路径、unit 数） | 每条输入一行处置 | 找不到处置 = 「未知」，manifest 里显式标出，不当成静默成功 |
| A' 归档回复与过程 | `turns.jsonl` 出现 end | turn id | `sent/` 文件、activity 里该 turn 的 tool_start | `<msgid>.reply.md`、`<msgid>.research.jsonl` | turn 无 sent 文件 = 记「无产物」，不补造 |
| D 对账 | 日界到 | 日期 + 清单版本号 | A、A'、C' 的结果 + ledger 自上次以来追加的 claim | `manifest.json` | 清单版本递增，旧版不覆盖 |
| E 推包 | D 之后 | 日期 + 版本 | manifest + cards/units 副本 | box 内目录 | 推失败例程读不到包，按「跑不了一行说明」处理 |
| F 回收 | 例程结束 | 日期 + 版本 | box 日报文件 + 投递记录 | vault 日报 + manifest 的交付字段 | 投递结果不明标「待核」，不宣称已送达 |

### 10.3 接口清单：哪些今天就有，哪些要新写

| 接口 | 方向 | 今天 | 要做 |
|---|---|---|---|
| 读 LumenBox 账本 | host 读自己 | 有，JSONL 追加 | 一个读取 + checkpoint 模块 |
| host ↔ box 文件 | host 读写 box | 有：`BoxClient.readFile / writeFile / uploadFile`（`src/box/client.ts:373-399`） | 无 |
| 写 vault | host 写 Mac 文件系统 | 有（普通 fs） | 配置项 `ovp.vaultRoot`；归档区目录约定（`60-Agent/lumenbox/…`，不是 capture 目录） |
| 调 `ovp2` | host exec | 二进制在 Mac 上 | 配置项 `ovp.bin`；封装 daily / crystal-synth / index 三条命令和退出码 |
| 读 OVP 账本 | host 读 vault | 有，schema 有版本（`ovp.intake/v1`、`ovp.daily/v1`） | 解析 + 按 sha / 路径关联 |
| 接入程序的宿主 | — | `~/.agentbox/extensions/` 可注册工具和监听器（`src/host/extensions.ts`），**但 TurnEvent 没有 turn 结束事件**（只有 text / interim / delegate_call / tool_start / round） | 所以接入程序按账本驱动，不按事件驱动：定时扫 `turns.jsonl` 的 end 行。宿主二选一：extension 工具由日终例程调用，或 `cli.ts` 子命令由 launchd 调用 |
| 定时 | LumenBox `schedule:` | 有 | 例程先调 `ext__ovp_bridge`（或 host 已按时跑过），再读包 |
| box → OVP 网络 | — | 无 | **第一、二段不需要**。第三段若逐条回复要查 `theme_page`，再接 MCP 连接器指向 host 上的 `ovp2 mcp` |

结论：**新代码不是 0，是 host 侧一个模块**（读账本、写 vault、调 ovp2、对账、推包、回收，
加测试），box 侧两个 skill 文件。§0 第二版「增量成本只是管道」的「管道」就是这个模块。

### 10.4 三个身份怎么串（§9 R4 要求分开维护）

- **消息身份**：inbox 消息 id（transcript `causedBy` 能对上 `inbox.jsonl`，今天 24 条 24 中）；
  飞书 `om_` id 经 `cards.jsonl` 的 taskId ↔ handle 关联。归档文件名用消息 id。
- **来源身份**：OVP 的文件 sha256 主键、URL 副键。接入程序不自己算「同一篇」，只在
  capture 的 frontmatter 记 `lumenbox_msg_id`，让一条来源能反查到所有提到它的消息。
- **research / 交付身份**：`turns.jsonl` 的 turn id + workId；回复文件和过程记录挂在
  turn 下，再由 turn 挂到消息。同一 URL 第二次带评论：新消息 id、新 turn、复用来源。

### 10.5 待核实（写代码前必须查）

- `turns.jsonl` 的 workId 和 `inbox.jsonl` 的消息 id 是否同一个 id 空间；今天肉眼看
  `about` 字段是消息文本前缀，不是 id，join 键要从 `deliveries.jsonl` 的 taskId 走。
- transcript 的 assistant 行里回复正文是否完整（最后一行 text 为空，正文可能在另一行）。
- 用户发的附件（图片 / 文件）落在哪：box `chats/<chat>/inbox/` 今天为空。
- vault 的真实路径；`XQUIK_API_KEY` 是否配置；`ovp2` 版本是否含 `schedule run-now`。

