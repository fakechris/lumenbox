<!-- doc: 73-outside-research-map
     title: 外部调研全景：读过哪些项目、记在哪、拿走了什么
     family: guide
     status: current
     updated: 2026-09-26
-->
# 73. 外部调研全景：读过哪些项目、记在哪、拿走了什么

一张表回答三个问题：**这个项目我们读过没有、结论记在哪、拿走了什么**。它是索引，不是结论本身——
结论在各自的文档或 INV 调研条目里，这里只指过去。

为什么要有这一页：到 2026-09-26，调研过约 40 个具名项目，结论散在 decision 文档、
[roadmap](11-roadmap.md) 的段落、[docs/research/](research/) 下没有头部块的文件（因而不进
[INDEX](INDEX.md)）、仓库外的原始报告，以及 INV 条目里。[docs/14](14-from-outside-reading.md)
是最接近的一页，但它是 decision、止于 08-26、只收文章与观点，覆盖不到五分之一。结果是同一个项目
被重读、同一条结论被重提。

同一张表在 Involute 的 INV-599（外部方向研究与调研全景）描述里也有一份。两处任一处更新，另一处
同步。

## 怎么维护

- **新调研**：在 INV-599 下建一个调研 ISSUE，写清项目是什么、可借鉴项、**不借鉴的与理由**；
  改进项拆成候选并 `DERIVED_FROM` 它。然后在下表对应领域追加一行。
- **读之前先查这张表**。读过的项目只做增量：看上次之后的变化和上次没覆盖的面，不重提已借过或
  已明确搁置的东西。
- **许可证写进调研条目**。AGPL（Memoh、zuse）与 FSL（raft-source）只借设计，不拷代码。

## Agent 运行时 / harness

| 项目 | 类型 | 日期 | 记在哪 | 拿走了什么 | INV |
|---|---|---|---|---|---|
| Hermes Agent（NousResearch） | 开源 | 08-29～09-22 多次 | [24](24-context-memory.md)、[27](27-testing-and-release.md)、[31](31-harness-review.md)、[51](51-follow-through.md)、58、65；[research/…hermes](research/2026-09-14-hermes-follow-through.md) | 压缩器、并行安全工具、按模型家族注入纪律提示、clarify 超时、`/new` | 147、426、530–535 |
| OpenClaw | 开源 | 08-29～09-22 | 24、26、27、51、58、65；[research/…openclaw](research/2026-09-14-openclaw-follow-through.md) | Telegram 持久 offset、共享 inbound 合同测试、记忆来源防回灌 | 530–535 |
| Grok Bot（0.30 等） | 闭源，拆包 | 08-25～09-10 | 14、[28](28-grokbot-0.30-delta.md)、29–31、35、39–42、46、49 | 盒内 harness、auto-review、hooks、示范学习、bot 模板与市场 | 406、411、481 |
| Claude Code | 产品文档 | 08-29～09-03 | [23](23-context-compaction.md)、28、31、34、54、57 | 按比例触发压缩、system-reminder、hooks | — |
| Argus（Microsoft） | 开源 | 09-06 | 11「Argus read」、51 | 没看过的 reviewer 不能验收、按角色 capsule、doctor | — |
| FrontierAgent（ApodexAI） | 开源 | 08-26 | 11 R30/R8 | 代码层提交门 | — |
| TurnkeyAI | 开源（已归档） | 09-07 | 11「TurnkeyAI read」 | Idempotency-Key、副作用 scope、压缩前 flush、失败分类 | — |
| Octop（腾讯云） | 开源 | 09-14；09-26 增量 | [research/…octop](research/2026-09-14-octop-follow-through.md)、51、52；INV-723 | HITL 只认被问的人、投递归属、i18n；增量：开放重定向、扫码建机器人、MCP OAuth、钉钉/企微登录、frontmatter 合一 | 532、533、541–544；724、725、728、729、737 |
| WorkBuddy（腾讯）/ 豆包 Work（字节） | 闭源，二进制 | 09-03、09-14 | [research/…workbuddy](research/2026-09-14-workbuddy-doubao-binaries.md)、33、51 | 审批超时自动拒、无人值守跳过提问、回环 MCP host、专家包 | 527、601 |
| QwenWork | 产品 | 09-03 | [33](33-mcp-face.md) | MCP 走 vsock，凭据不进沙箱 | — |
| Muse / Hatch | 第三方存档 | 09-25 | [research/…muse-hatch](research/2026-09-25-muse-hatch-skills-and-box.md) | skill 权限声明、per-skill eval、交付前产物验收 | 690–693 |
| zuse、raft-source、OpenMuse、google/ax、ZCode | 开源 | 09-25 | INV-694 | webhook 投递幂等、投递 outcome_unknown、例程退避暂停、审批有效期、microcompact、唤醒提示伪造转义等 18 条 | 695–712（707 已修，PR #240） |
| egoist/lorca | 开源（GPL-3.0） | 09-26 | INV-739 | Grok Bot 的单人一周复刻，设计完整的 alpha、E2E 只防中继；记忆写入扫凭据、无人时暂停例程、跨会话近况简报、命令卡住交回 agent | 740–743 |
| Antigravity Teamwork | 产品 | 08-28? | [19](19-pitfalls.md) | 与答案无关的 pitfall 登记 | — |
| Kimi K3 AgentENV / 300-agent swarm | 文章 | 08 月 | 14、[16](16-long-work.md) | 测量边界要说清、节点合同 | — |

## 记忆与上下文

| 项目 | 类型 | 日期 | 记在哪 | 拿走了什么 | INV |
|---|---|---|---|---|---|
| Manus 上下文工程 | 文章 | 08-29 | 23 §4、[71](71-evidence-provenance-practice.md) §1 | 可恢复压缩、todo 复述、稳定前缀 | 148、661 |
| Anthropic context editing / compaction / memory tool | 文档 | 08～09-22 | 14、23、71 | 结构保留的编辑优先于摘要 | 148、662 |
| OpenHands Condenser | 开源 | 09-22 | 71 §1 | 追加 Condensation 事件，摘要指回被替换区间 | 662 |
| Memoh | 开源（AGPL） | 09-06；09-26 增量 | 11「three rounds from the Memoh read」；INV-723 | 飞书 pong 看门狗、重投冲突、召回只描述不指令；增量：MCP OAuth、agent 发起能力变更、企业微信入口、provider 深链 | 725–727、736 |
| memmy-agent（MemTensor） | 开源 | 09-26 | INV-723 | 抽取判新建/确认/纠正并引证原文、skill 使用结果统计、易变经验到期核对 | 733–735 |
| MemGPT/Letta、A-MEM、Mem0、Generative Agents、Sleep-time Compute | 论文 | 09-19 | 58 §3、71 | 反思、记忆演化、conversation_search | 661 |
| Jev / TypeSafe、laya、Awesome Jev 生态约 25 个仓库 | 产品 / 开源 | 09-22、09-23 | 63、64、[66](66-awesome-jev-lumenbox-opportunities.md)、67、68、[72](72-laya-vs-jev-language-evaluation.md) | 判断服务合同、降级回退、不静默丢弃 | 600、643、647 |
| OVP2（obsidian_vault_pipeline） | 自有仓库 | 09-19 | 58、59、61 | 不可变原文层、crystal ledger | 612–615 |
| 多文档摘要论文约 20 篇、Karpathy LLM Wiki、Anthropic 多代理 research | 论文 / 文章 | 09-19 | 58 §3 | 每日横向综合的流水线设计 | 668–670 |
| Chroma Context Rot、Weaviate、LangChain OpenWiki、Slack CPO 访谈 | 文章 | 08-18～08-26 | [14](14-from-outside-reading.md) | 干扰项损害效果；对话不会自己变成知识 | — |

## Computer-use / 桌面

| 项目 | 类型 | 日期 | 记在哪 | 拿走了什么 | INV |
|---|---|---|---|---|---|
| trycua/cua（Driver、Bench、Lume）、DioxusLabs/accessibility-cli | 开源 | 09-22 | 62、[70](70-cua-linux-validation.md) | 快照绑定 ref、动作回执与验证分离、GUI 验收矩阵、原生语义动作 | 635–640、654 |
| agent-desktop（lahfir） | 开源 | 09-26 | INV-723 | 不改变 docs/62 结论（Linux/Windows 是空壳）；后置条件短轮询、命中测试、稳定性采样 | 730–732 |
| huashu-chrome、huashu-mac-use、browser-use-pi、ego-lite | 开源 / 半闭源 | 09-10 | 49 | 操作要有证据、不可逆操作设门、接管即教学 | 394–412 |
| Modal 上 10 ms 点击 | 文章 | 07-31 | 14 | 测量边界 | — |

## 渠道 / 集成 / 多用户

| 项目 | 类型 | 日期 | 记在哪 | 拿走了什么 | INV |
|---|---|---|---|---|---|
| Linear Agent API、A2A Protocol | 文档 | 09-15 | 54 §2、[57](57-agent-consumer-contract.md) | 平台不托管 agent，接手不迁移会话 | 551、553、556 |
| Linear / Slack / Notion 托管 MCP | 产品 | 09-14 | 53 | 凭据到位即开连接器门 | 725 |
| GitHub / Stripe webhook 签名 | 惯例 | 09-09? | [44](44-webhook-triggers.md) | HMAC 签 body、时间戳防重放 | 114、115、695 |
| Claude Tag、first-tree-ai/opentag | 产品 / 开源 | 09-10 | 50、[22](22-domain-model.md) §8、[36](36-enterprise.md) | 访问与记忆跟「地方」走；delivery custody、direct/ambient 注意力 | 413–439 |
| Tailscale | 产品 | 09-03 | [30](30-multi-box.md)、35、37 | 盒子接入的传输层 | — |

## 证据与溯源（[docs/71](71-evidence-provenance-practice.md)，09-22）

| 项目 | 拿走了什么 | INV |
|---|---|---|
| OTel GenAI semconv、OpenInference、MLflow、Langfuse、LangSmith、Braintrust、Traceloop、Weave | 截断显式标出；`compacted` 三值 | 632、634、659 |
| Anthropic Citations API、ContextCite、LLM-AggreFact / MiniCheck、ALCE | 引文拿回原文比对，不做蕴含判断 | 660 |
| WARC/WACZ、Browsertrix、RFC 9530/9421、Web Bot Auth、SCITT、Kafka cleanup.policy、ISO 15489/MoReq | 账本性质声明；内容摘要随记录走 | 634、659、663、665 |
| Firecrawl、Jina、Exa、Perplexity、Zyte、Apify | 反面例子：都不返回内容哈希 | — |

## 其他文章与评测（[docs/14](14-from-outside-reading.md)、[roadmap](11-roadmap.md) R22–R30）

Seltz / CrewAI GTM、《LLMs Eat Scaffolding》、《Against agent sprawl》、google/skills 与几套 skill 标准、
多代理协作综述、《Subagents on Subagents》、评测债、DoorDash 仿真平台、Graph Engineering、LoopTrap
（arXiv 2605.05846）、GAIA trace 研究（2606.01365）、Dijkstra–Scholten 终止检测。

## 缺口

- **引用了但不在本仓库的原始报告**：`research/MEMOH-COMPARISON.md`、`ARGUS-COMPARISON.md`、
  `TURNKEYAI-CLAIMS-CHECK.md`、`GROKBOT-2026-09-07-TEAM-WORKFLOW.md`、
  `MULTIPLAYER-PRODUCT-DESIGN.md`、`grokbot/RESEARCH_CUA_FOUR_PROJECTS.md`、
  `grokbot/versions/0.30.0/*`、`LONGHORIZON-HARNESS-COMPARISON.md`（`src/host/audit.ts` 引用）、
  docs/25 提到的 `CODING-AGENT-*`。结论已经进了上面各文档，原文只在作者本机。
- **docs/research/ 下的文件没有头部块**，不进 INDEX；本页是它们唯一的入口。
- **2026-09-25 之前的调研多数没有 INV 节点**，只能从本页或文档找到。
