<!-- doc: 58-daily-research-digest
     title: 每日 research 总结：把一天的输入和逐条 research 横向综合，而不是再列一遍
     family: decision
     status: current
     updated: 2026-09-19
-->
# 58. 每日 research 总结：把一天的输入和逐条 research 横向综合，而不是再列一遍

状态：**调研稿，2026-09-19**。起因是 feishu-personal 里 Nova 的用法——一天丢进来
二十几条链接，每条得到一份「立场稿 + 盲区」——现在想要一个日终动作：把当天全部
用户输入和 agent 的 research 完整归档，并在上面做一次**横向**的提炼。本文是做这件事
之前的功课：我们现在有什么、Hermes / OpenClaw / Grok Bot 移植角色各能借什么、论文
里哪些结论直接改变设计，最后是一份推荐的流水线和落到本仓库的接口。没有写代码。

来源：本机 `~/.agentbox` 与运行中的 `agentbox-box`（2026-09-19 当天数据）；Hermes 在
`~/.hermes/hermes-agent`；OpenClaw 为安装包 `/opt/homebrew/lib/node_modules/openclaw`
加 `~/.openclaw` 的活状态；Grok Bot 本机没有源码，看的是本仓库移植的 48 个模板
（`docker/box/catalog-data/templates/`）。三个系统由子代理带 file:line 读过，论文
由子代理联网核过 URL；未核实的在文末单列。

## 1. 现状：今天在飞书里实际发生了什么

**数据形态。** 2026-09-19 一天，Nova 在 feishu-personal 收到 24 条输入（`ingress.jsonl`），
绝大多数是 X 链接或转帖正文，少数是文章链接。每条走一个 turn（MiniMax-M3），用
WebSearch 核事实，把一份 8–24 KB 的 markdown 写进 `outbox/`，turn 结束时随回复投递，
文件挪到 `sent/`。当天 `sent/` 里 15 个文件，约 250 KB。文件头部固定：发信人 / 时间 /
参考原文 URL 列表 / 「已核完 N 个事实」；主体是事实表、盲区、短推版、可选路径。

**横向综合已经在发生，但发生在错误的位置。** 每份回复都有一节「这条跟前面 N 条线的
关系」，到当天最后一条时这一节把前面 18 条全部重述了一遍（24 KB 里一半是这个）。
Nova 的记忆 episode 里也已经出现了主轴叙事：「Aparna（决策层拆出）→ Stoica（outer
loop）→ CUA-S1-FORMS + 0xCodila（物质化样板）→ …」。也就是说，横向综合现在是
**每条各做一遍、越做越长、且只存在于回复和易失的记忆里**——这正是要抽成「日终一次」的
东西，而不是新增一种能力。

**三个缺口。**
- **没有 seen log。** Nova 的月志（`memory/nova/log/2026-09.md:21`）自己记了：同一 URL
  第二次被丢进来，它原样再交付一次。今天 0xCodila 和 blanplan 各被发了三次。
- **用户原文只在 host 端。** 用户输入的原文在
  `~/.agentbox/agents/<nova>/conversations/<chat>.jsonl`（今天 709 KB，143 条 user 行），
  box 里 `chats/<chat>/inbox/` 是空的；box 内只能靠 `ReadHistory` 拿回来。X 的正文
  经常抓不到（`X 端拉不到正文`），所以「原始信息」很多时候就是用户贴的那段文字加 URL。
- **「立场稿 + 盲区」不是 skill。** 全仓库和 box 里 grep `立场稿|盲区|事实核实` 只命中
  输出和记忆，没有任何 prompt 文件——这套节奏是记忆里的约定，换一个 agent 或记忆被
  压缩就丢。

**已有的可以直接用的基础设施。** skill frontmatter 的 `schedule:` + `timezone:` +
`deliver: feishu-personal:oc_…` 就是一个每日例程（`src/host/skills.ts`、`schedule.ts`）。
定时 turn 的 prompt 已经规定：「由计时器启动，不是人；最终消息就是交付物本身，长版
放 `/home/box/work` 下并说路径；跑不了就一行说明，下次还会来」（`schedule.ts:412-422`）。
不补跑、不重叠、按 policy gate 扣预算。三个 starter skill 是最近的雏形：
`morning-summary`（24 小时内文件变化 + 待决定清单）、`weekly-retro`、`study-a-corpus`
（读一遍留索引）——都是**列举**，没有横向综合的指令。

## 2. 三个参照系统各能借什么

| | Hermes | OpenClaw | Grok Bot（移植模板） |
|---|---|---|---|
| 定时与投递 | cron job 文件，`deliver` 可多目标；prompt 前置「你是 cron，最终回复自动投递，没新东西回 `[SILENT]`」（`cron/scheduler.py:738-751`）；pre-run 脚本 `{"wakeAgent": false}` 可省掉整次 LLM | cron 四种 session 模式，其中 **`session:<id>` 持久命名 session**，文档明说给「基于前一天摘要的每日 standup」用（`docs/automation/cron-jobs.md:60-69`）；投递由 runner 而非 agent 做，首轮只回「on it」会再追问一次 | 例程就是带 cron frontmatter 的 skill，和我们同一格式；`cos-morning`：「Board: 过去 24h **主题** · 排序优先级 · 一个当日动作；Quiet-on-noop」 |
| 周期性再读→更高层 | **Curator**（`agent/curator.py:313-430`）：7 天间隔 + 2 小时空闲触发，先确定性分 stale/archived，再一次 LLM「伞式合并」pass，事前快照可回滚，事后 `REPORT.md` | **Dreaming**（`0 3 * * *`）：light 摄入日记 → REM 抽主题 → deep 晋升到 `MEMORY.md`；按文件 mtime+size 指纹增量摄入；每条主题带 `path:line-line` 证据和 confidence；**写入前回读原文**，删掉的不晋升 | `weekly-x-recap`：「读本周的 brief 而不是重抓」——跨日综合读的是**日报文件** |
| 综合的 prompt 语言 | 「这是一个 **建伞** 的合并 pass，不是审计也不是查重」「两两不同不是标准，标准是：一个人类维护者会写成 N 个还是一个带 N 个小节的」「合并少于 10 个就是停早了」「什么都没做的 pass 是错过学习机会，不是中性结果」 | 只有 dream diary 一段（80–180 字散文），结构可用（fragments + recurring themes + crystallized），语气全部不要 | `daily-x-brief`：信号门槛含「**领域争论点的转移**」；「留下的分成 2–4 个主题，用大白话命名」；输出 `The one thing / Being argued about（一句争议 + 双方各一链接）/ Quiet today / Could not open`。`themes-across-meetings`：「**主题 = 至少出现在两次会议里**，说几次、哪几次；只出现一次是细节不是主题」「每个主题一行说它怎么动的：first raised / still open / resolved / getting louder」「**悄悄消失的那些通常才是有用的**」「说清你看不到什么」 |
| 原始信息保存 | 弱：抓到的网页在途被 LLM 压缩，cron 只存最终答案 | 会话 JSONL 全量保留，pruning 只在内存；daily `memory/YYYY-MM-DD.md` 今明两天自动加载 | X Brief 的 **watch list + seen log**：「每次先读 seen log，报过的链接不再报，报了就写进去」 |
| 多文档策略 | `context_from` 把上游 job 最近一次输出注入（每源截 8k），委派 fan-out 后一次合并 | 无 map-reduce；dreaming 是「按天 map → 按概念标签频次 reduce → ≤12 条给 LLM」 | deep-research：每项一个 JSON → `report.md` 覆盖式编译，是 coverage 不是综合 |
| 反面教材 | 8k/源截断；只看最近一次输出，没有 N 天窗口 | `~/.openclaw` 里活着的 `Twitter Hourly Monitor`：每小时跑、回看 4 小时、无 seen set，按构造重复 4 倍 | — |

三家没有一家有「矛盾 / 张力」的检测语言；三家都没有 map-reduce 代码。横向综合这一
步在三个参照里都是**prompt 里的一句话**，差别只在这句话写得好不好。Grok Bot 的
`themes-across-meetings` 和 Hermes 的 curator 是写得最好的两句。

## 3. 论文与研究：哪些结论会改设计

分组按「它改变我们哪个决定」，不按年份。URL 都核过。

**任务定义和主要失败模式。**
- *Summary of a Haystack*（Salesforce, EMNLP 2024，https://arxiv.org/abs/2407.01370）：
  任务就是「多篇文档里反复出现的 insight，总结出来并**引用出处**」，评 Coverage（每条
  参考 insight 100/50/0）和 Citation。带 oracle 检索的系统仍比人低 10 分以上；纯长上下文
  不到 20%。LLM 判官与人工 coverage 相关 0.72–0.75，成本 2–5%。→ 这几乎就是我们的任务
  形状；每条主题必须点名它来自哪几条输入，评估用它的两轴。
- *DiverseSumm*（https://arxiv.org/abs/2309.09369）：把多文档摘要反过来问「同一事件各源
  **不同**的地方」，GPT-4 只覆盖不到 40%。→ 「张力 / 矛盾」是模型系统性漏掉的部分，
  必须单独一个 pass，并允许「今天没有」。
- *How LLMs Hallucinate in Multi-Document Summarization*（https://arxiv.org/abs/2410.13961）：
  幻觉集中在**摘要末尾**；让它总结一个不存在的主题，GPT-4o 有 44% 照编；人工复核 700
  条 insight，多数错误是「过于泛泛」。→ 不规定主题个数；允许「今天没有横向主题」；
  高置信内容放前面；few-shot 给出被拒绝的泛泛主题样例。
- *Summarization is Not Dead Yet*（2026-06，https://arxiv.org/abs/2606.08000）：人写的在
  信息量和忠实度上仍赢，尤其需要推理与综合的部分。→ 附录必须保留全部原文，综合是
  在原文之上而不是替代它。

**流水线架构。**
- *LLM×MapReduce*（ACL 2025，https://arxiv.org/abs/2410.09342）：每块产出**固定 schema**
  而非散文，reduce 时带置信度解决块间冲突而不是平均掉。
- *Context-Aware Hierarchical Merging*（https://arxiv.org/abs/2502.00977）：合并那一步
  **放大**幻觉，修法是合并时重新注入原文证据。→ 综合 pass 的输入是「主题 + 支撑原句」，
  不是「子摘要」。
- *STORM / Co-STORM*（https://arxiv.org/abs/2402.14207、https://arxiv.org/abs/2408.15232）：
  写前先立多个视角提问；Co-STORM 维护一棵**动态思维导图**，每条事实挂在检索到它的问题
  下，且有一个**moderator** 把检索到但没用上的材料塞回来防止停滞重复。→ 跨天主题登记簿
  用它的树；「没被任何主题用上的 claim」单独扫一遍是防止每天同样三个主题的办法。
- *Chain of Density*（https://arxiv.org/abs/2309.04269）：定长反复重写，每轮塞进 1–3 个漏掉
  的实体。*Chain of Summaries*（https://arxiv.org/abs/2511.15719）：生成「这份摘要答不了的
  问题」再改。→ 最后两步。
- Anthropic 多代理 research 系统（https://www.anthropic.com/engineering/multi-agent-research-system）：
  综合写完后由**独立的 CitationAgent** 给每条 claim 补引用；评估从 20 条真实查询起步。

**主题归纳（「横向」的核心技术）。**
- *TopicGPT*（https://arxiv.org/abs/2311.01449）：生成→细化（合并相似、丢无关）→
  **带引文**分配→纠正。
- *LLooM / Concept Induction*（CHI 2024，https://arxiv.org/abs/2404.12259）：
  Distill → Cluster → Synthesize，关键是每个概念带一条**可执行的纳入标准（zero-shot
  prompt）**，能反过来对每条文档打分。→ 这是「主题而不是列表」最好的答案：先出候选
  主题及标准，再用标准回扫当天全部输入，**少于两条支撑的主题机械地删掉**。「每个主题
  至少两个来源」于是是算出来的性质，不是 prompt 里的恳求。

**记忆、反思、离线计算。**
- *Generative Agents*（https://arxiv.org/abs/2304.03442）reflection tree：低层观察周期性
  综合成高层推断，高层再成为下次反思的输入。消融显示反思是承重的。
- *Sleep-time Compute*（Letta，https://arxiv.org/abs/2504.13171）：离线把上下文改写成
  「预判了问题的上下文」，多次查询共享时成本摊薄 2.5×。→ 日终 job 就是 sleep-time：
  没人等，可以多花 token。
- *A-MEM*（https://arxiv.org/abs/2502.12110）Zettelkasten 式原子笔记 + 链接 + **memory
  evolution**（新信息来了修旧笔记）；*Mem0*（https://arxiv.org/abs/2504.19413）抽取输出
  ADD / UPDATE / DELETE / NOOP。→ 「和昨天比变了什么」的原语。
- Karpathy 的 **LLM Wiki** gist（2026-04-04，https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f）：
  三层（**不可变原始源** / LLM 维护的 markdown wiki / schema 文档）三操作（ingest /
  query / **lint**），lint = 周期性查矛盾、过期、孤儿页、缺交叉引用；query 的结果**归档
  为新页面**让探索累积。研究跟进 *LLM-Wiki*（https://arxiv.org/abs/2605.25480）。
  → 这就是「附录保留全部原文 + 一个活的主题登记簿」的正当性来源。

**增量与矛盾。**
- 增量摘要 *Chain-of-Key*（https://arxiv.org/abs/2407.15021）：维护结构化表示，决定 add
  还是 update；*NovAScore*（https://arxiv.org/abs/2409.09249）文档级新颖度。
- *ContraDoc*（https://arxiv.org/abs/2311.09182）：模型对矛盾召回差，重「No」偏置；
  *CONFLICTS*（https://arxiv.org/abs/2506.08500）：**显式提示「推理潜在冲突」本身就大幅
  提升**，「观点冲突」最难；*MADAM-RAG*（https://arxiv.org/abs/2504.13079）多代理辩论
  +11–16 点。

**评估。**
- SummHay 的 Coverage / Citation；*AutoNuggetizer*（https://arxiv.org/abs/2411.09607、
  https://arxiv.org/abs/2504.15068）自动从源抽 nugget 再自动分配到输出，run 级 τ≈0.78，
  是每日 job 最便宜的严格 coverage 工具；*DeepScholar-Bench*（https://arxiv.org/abs/2508.20033）
  的 Nugget Coverage / Cite-P / Claim Coverage，最好系统几何均值只有 ~0.31，预期要放低。
- 自定义指标：**主题数 / 条目数**（接近 1 就是做成了列表）、每主题平均来源数（目标
  ≥2.5）、跨日主题流失率（太低是僵化，太高是噪声）、对手工埋入的矛盾的召回。
- 判官卫生：位置和长度偏置有文献（DiverseSumm、2606.08000）；打乱顺序，判官换一个
  模型家族。

子代理没有找到**专门**讲「个人链接流的每日横向综合」的论文：工具类（ArxivDigest、HN/
Slack/Discord digest bot）做的是过滤和逐条摘要，研究类（SummHay、DiverseSumm、STORM、
LLooM）做的是精选语料上的综合。把两者接起来是空地，所以评估集得自己建。

## 4. 推荐的设计

**分层。** 三层，对应 LLM Wiki：
1. **原始层，不可变。** 每条输入一个记录：URL、用户贴的原文、抓到的正文（抓不到就
   记「抓不到」）、时间、Nova 的完整回复文件路径。这层就是「包含所有原始信息」的
   附录，日终 job 不改它。
2. **结构层，每条一份。** 逐条 research 在写回复的同时产出一份固定 schema：原子 claims
   （每条带原句引文和置信度）、实体、立场、与前几天的关系、开放问题。这是 map 阶段的
   输入；给日终 job 散文回复只会得到列表式的日报（LLM×MapReduce 的教训）。
3. **综合层。** 当天的日报 + 一份跨天的**主题登记簿**（markdown，wikilink，可 grep）。

**日终 job 的九步。** 全部离线，没人等，可以多花 token。
1. Map：读当天 N 份结构记录（不是回复散文）。
2. 新颖度标记：每条 claim 对登记簿做 diff，标 new / recurring / contradicting。
3. 主题归纳（LLooM）：聚类 → 候选主题各带一条纳入标准 → 用标准回扫全部 N 条 →
   **支撑少于 2 条的主题删除**。另起一个 moderator pass 扫「没被任何主题用上的
   claim」，问是不是漏了一个主题。
4. 张力挖掘：单独一个 pass，分 事实 / 时间 / 观点 三类，每条张力表示为「一个问题 +
   至少两个分歧的回答簇 + 各自来源」（DiverseSumm 的 schema）。允许「没找到」。
5. 增量：每个存活主题对登记簿标 **NEW / STRENGTHENED / CONTRADICTED / RESOLVED /
   DORMANT**，每个标签都要今天的一条引用。
6. 综合：一次调用，输入是主题 + 标准 + **支撑原句**（不是子摘要）+ 增量 + 张力。
   输出节：**主线**（一段）/ **主题**（每个 ≥2 引用 + 一句所以呢）/ **张力与矛盾** /
   **和昨天比变了什么** / **含义** / **开放问题**。明令禁止「逐条」小节。
7. 致密化：Chain of Density 两轮，定长。
8. 引用与 lint：独立一步给每条 claim 挂 `[条目 id]`，未引用率超阈值打回；lint 查泛泛
   主题、单源主题、登记簿里的过期项。
9. 持久化：更新登记簿（A-MEM：新页链接旧页，旧页过期就改），当天全部原始层作附录
   附在日报后。

**给飞书的形态。** 短版发进聊天（能在手机上读完：主线 + 主题名 + 张力 + 变化），
长版和附录写文件并说路径；有 feishu-docs 写能力时长版进飞书文档。

**静默规则。** 当天少于 2 条输入，或没有主题过门槛：一行「今天安静」，不发填充
（Hermes `[SILENT]`、OpenClaw `HEARTBEAT_OK`、X Brief「安静的一天一行」三家一致）。

**去重。** seen log：URL 规范化后记一行（首见时间、条目 id、回复路径）。逐条 research
先查它——第二次丢同一 URL 回「9 月 19 日已核过，路径 …，要重看哪一点」——日终 job
也用它保证同一链接只算一条。

**评估。** 先手标 3–5 个「金标日」的参考 insight（SummHay 式），每次改 prompt 跑一遍
Coverage / Citation；日常用 AutoNuggetizer 自动 coverage 和上面四个自定义指标；判官用
非 MiniMax 的模型。

## 5. 落到本仓库的接口

不新增概念，用已有的三样：skill 例程、chat 文件目录、`ReadHistory`。

```
---
name: daily-research-digest
description: 把当天丢进来的链接和逐条 research 横向综合成一份日报，附全部原文
schedule: 0 22 * * *
timezone: Asia/Shanghai
deliver: feishu-personal:oc_d99f329dc01493cee8b0ba5c34168eea
agent: Nova
authored_by: Nova
because: 每条回复里的「跟前面 N 条线的关系」越写越长，横向综合应该一天做一次
paused: true
---
```

正文按第 4 节的九步写，读的东西：
- `chats/<chat>/sent/<today>_*.md` — 当天全部逐条回复（结构层落地前先直接读它们）；
- `ReadHistory` 拉当天 `fromPerson` 的原文 — 用户输入的原始层；
- `notes/digest/themes.md` — 主题登记簿；`notes/digest/seen.jsonl` — seen log；
- 写 `notes/digest/YYYY-MM-DD.md`（日报 + 附录），回复短版。

同时要改逐条那一侧，否则日终是在给已经膨胀的东西再套一层：
- 把「立场稿 + 盲区」从记忆约定写成 skill（`research-reply`），并在里面加两条：先查
  seen log；「跟前面的关系」只写 1–2 行指向登记簿里的主题名，**不再重述全部前文**。
- 逐条 skill 顺手输出结构记录（`sent/<name>.claims.json`），日终 map 阶段就有 schema
  可读。这是唯一需要在逐条侧新增的产出。

三件事都是 box 内的 skill 文件加 `notes/` 目录，不碰 host 代码；`paused: true` 按
docs/29 的规矩由人打开。真要动 host 的只有一处候选：让定时 turn 能像 OpenClaw 的
`session:<id>` 那样看到上一次自己的输出——目前靠登记簿文件替代，够用。

## 6. 和 OVP2（obsidian_vault_pipeline）的结合点

OVP2 是三层真相账本：Source（原文永不改写）→ Memory（每源的 grounded unit，原句 + 行号，
硬门 `accepted_without_quote = 0`）→ Knowledge（跨源 claim，durable 要求**至少两个独立源**且
分数 ≥ 0.70，机械门；主题 = 嵌入 + Louvain 社区；topic page 每句必带 `[claim:…]`，验证不过
修一次否则不写）。它的 `digest` 是运维 digest（新 pack 数 / 阻塞数 / claim 计数），
`product-pipeline.md` §5 自己写明「不是跨源模式 / 矛盾 / 新兴主题检测」，矛盾检测在 G4 是 ⬜。
所以两边正好互补：第 4 节的三层里，前两层 OVP 已经有并且比我们设想的更严，第三层的
「主题登记簿」OVP 也有（crystal ledger + themes.json + theme_pages.json），缺的只有**日级
横向叙事**这一步。逐条对应：

| docs/58 的部件 | OVP2 已有 | 怎么接 | 新代码 |
|---|---|---|---|
| 原始层（附录含全部原文） | `50-Inbox/00-Capture/` 投递目录；intake 按 URL + sha256 去重，重复停车不删；X 链接经 Xquik 抓推文正文 | Nova 每收一条写一个 markdown note（frontmatter `title` / `source` / `tags`，正文 = 用户贴的文字）。正文不足 200 字要加 `ovp/force`，否则 enrich 会用抓到的正文**覆盖**用户贴的文字 | 0；但 box 在 Docker 里，vault 在 Mac 上，要把 vault 目录挂进 box |
| seen log | intake 的 URL / sha256 去重 + `.ovp/intake.jsonl` | 逐条 research 前先 `ovp_search` / `find` 查 URL；命中就回「几号已核过」 | 0 |
| 结构层（claims + 原句 + 置信度） | reader trunk 的 `units.accepted.json` / `cards.json` | 日终 job 不再让 Nova 自产 schema，直接读当天新 pack 的 units 和 cards | 0 |
| 「跟前面 N 条线的关系」 | `ovp_search`、`ovp_list_themes`、`theme_page`、`claim` | 逐条回复里这一节改为查主题页、引 `[claim:ck-…]`，不再重述前文 | 0，prompt 改动 |
| 主题登记簿 + 增量动词 | `.ovp/crystal/ledger.jsonl` 的 `status` / `superseded_by`，near-dup skip、strengthen、supersede | NEW / STRENGTHENED / RESOLVED 三个动词直接从当天 ledger 追加行读出；CONTRADICTED 和 DORMANT 是 OVP 没有的，留在日终 job 里 | 0 + 日终 prompt |
| 综合 / 张力 / 致密化 | 无（正是 OVP 的空白） | 日终 job 的输入 = 当天新 pack 的 cards + 当天 ledger 新增 claim + 相关 theme page；输出每句带 `[claim:…]` 或 `[source:sha]` | 日终 skill |
| 引用与 lint | theme_page 的确定性验证器（每句一个 key，key 必须在给定集合里）；MCP `claim` 工具解析证据闭包 | 日终 job 写完后逐句用 `claim` 解析，解析不了打回；同一条规则，不用再写 CitationAgent | 0 |
| 中文 | `claims_zh.json` / `cards_zh.json` / `theme_pages_zh.json`，英文为唯一权威 | 日报中文直接用 zh 投影 | 0 |
| 调度 | `ovp2 schedule`（`init` 不装 OS unit）；桌面 app 每 600 秒 tick | LumenBox 的例程拥有时钟：先 `ovp2 daily`（或 `schedule run-now daily --unless-ran-within-secs 120` 与桌面时钟去重），再综合，再 `deliver:` 到飞书；失败读 `.ovp/last-run.json` 和 `reports/daily-<date>.json` 的 warnings 一行报告 | 0 |
| 日报落地 | 按 OVP 规则日报是 derived，不进真相层 | 写到 vault 的普通笔记目录（如 `10-Knowledge/Digests/YYYY-MM-DD.md`），**不要**放 capture 目录，否则会被当 source 吃进去 | 0 |

三个要提前知道的坑：
- `crystal-synth` 默认不在 daily tier，是手动命令，且文档列了五个进入自动调度的前提条件；
  日终 job 要自己调它，并接受某天零个新 claim 是合法结果。
- MCP 工具全部只读，没有「加一个 URL」的工具；写入唯一合法路径是往 capture 目录放文件
  （`skills/capture-drop`）。`serve` 的 POST 要 `Content-Type: application/json` 且不带
  `Origin` 头；GET 不受同源守卫限制。
- 预编译只有 macOS arm64 和 Linux x64，Apple Silicon 上的 Docker box 是 Linux arm64，所以 box
  内跑不了 `ovp2`。最省事的是 `ovp2 serve` 跑在 Mac 上，box 通过 `host.docker.internal:3141`
  用 HTTP API；或者 LumenBox 的 MCP 连接器把 host 上的 `ovp2 mcp` 接进 box。

Nova 自己的立场稿要不要也投进 vault：可以，作者 Nova、tag 区分，这样 agent 的 research 也进
真相层被 unit 化；但它是二手推断，和原文一起做 claim 时会混淆一手与二手，第一步先不投，
只投用户输入的原文。

## 7. 未核实与保留意见

- InsightEval（2511.22884）、GIANTSBENCH（2604.09793）、DataSage（2511.14299）、Memory as
  Metabolism（2604.12034）只在检索结果里见到，没打开；线索。
- 「Knowledge Compounding」（2604.11243）单源、未评审、自报数字，不当证据。
- Karpathy gist 的 star / fork 数来自二手转述；gist 本身和 2026-04-04 的日期核过。
- NotebookLM 的源数上限、Feedly Leo / Readwise Ghostreader 的功能描述来自竞品对比博客。
- MemGPT 的 arXiv 号（2310.08560）来自检索摘要，没单独打开。
- Grok Bot 的定时 turn 如何告诉 agent「不是人」本机看不到源码，引用的是我们自己的
  `schedule.ts:412`。
- OpenClaw 的读法是安装包 `dist/*.js`，不是源码树；行号对应打包文件。
- OVP2 的 X 抓取依赖 `XQUIK_API_KEY`，本机是否配置没有查；vault 的实际路径也没有查。
