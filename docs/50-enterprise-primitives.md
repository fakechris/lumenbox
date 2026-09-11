# 50. 企业级 agent 的高层规划：原语、数据、控制、记忆、审计、运行时

日期：2026-09-10。输入：白宦成《Claude Tag 产品分析》（ixiqin.com，2026-09-10）、first-tree-ai/opentag 源码深读（/tmp/cua-review/opentag，Apache-2.0，41 个 migration、334 个测试文件、单 squash commit）、我们自己 docs/08、09、22、24、35、36、37、45、47 与 src 的盘点。

本文回答三个问题：Claude Tag 的分析方法论是什么、我们按这套方法论盘点后缺什么、哪些要进里程碑。它是 docs/36 enterprise 的上位规划，不推翻 docs/22 与 docs/35 的裁决，而是用它们的语言把 Claude Tag 翻译过来。

## 一、方法论：六个透镜

白宦成的拆解之所以比"把模型接进 Slack"的仿品高一层，是因为它按固定顺序看六件事，每一件都问"归谁、放哪、谁能改"：

| 透镜 | 问题 | Claude Tag 的答案 |
|---|---|---|
| 1 产品原语 | 任务发生在哪（Space）、能做什么（Capability）、怎么管（Control） | Org / Workspace / Channel；Session / Routine；Environment。Repositories / Domains / Plugins / Credentials。Instructions / Memory / Auto-mode rules / Channel name rules。Access Bundle 横跨后两类 |
| 2 数据设计 | 所有数据归谁；继承链怎么走 | 一切归 Org；Workspace 各有独立 Channel/Memory/Bundle；Channel 是权限与运行的最小单元；Channel 拿到自己 + Workspace + Org 的并集 |
| 3 产品设计细节 | To B 直觉：多 Workspace、Bundle 叠加、规则化自动审批、Guest 开关、群名规则、计费 | 见原文 |
| 4 Memory | 记忆归地方不归人；索引 + 相关性加载 | memory.md 进 system prompt 作索引，按 description 相关性二次判断，取前 4K；channel/ 与 silo/ 两个目录 |
| 5 审计 | 定时任务、记忆、网络事件三类 | Scheduled Work 列表、Org 级 Memory 浏览编辑、按时间范围查 Network Event |
| 6 Runtime | 企业可控的执行环境 | Self-hosted Environment 注册 runner；Domains + Federated cloud access 接内部 gateway |

两条元原则贯穿全部：**访问按地方配，不按人配**；**记忆跟地方走，不跟人走**。

## 二、opentag 给的反例与正例

opentag 是"Claude Code in Slack"而不是 Claude Tag：Slack/Lark 事件路由到用户笔记本上的 daemon，每回合起一个 `codex app-server` 或 `claude --print`。按六个透镜看：

- 原语：User / Agent / Computer / IM binding / Session（channel、thread、internal）/ ImMessage + Delivery / Task（投影，不是表）。**没有** Org、Workspace、Approval、Audit、Policy。
- 数据：一切挂在 `users.id`，migration 0037 甚至删掉了早期的 workspace 概念；`im_messages` append-only + `im_message_deliveries` 用 CHECK 约束编码 custody 状态机（`schema/im-messages.ts:139-162`）。
- 设计细节：direct 与 ambient 两种注意力，thread session 惰性物化 + channel 观察副本（`docs/thread-sessions.md`）；**没有发送 API**，agent 自己 shell 出 `slack api` / `lark-cli`，凭据以每回合 0600 env 文件投影。
- Memory：git 仓库形态的 Context Tree，全 Computer 共享，`members/<agent>/` 私有；agent 显式读写，无自动提取、无按 channel/user 的 scope、无密钥卫生。
- 审计：无审计表；turn report 挂在 delivery 行；OTel 里主动擦掉 prompt 与工具负载。
- Runtime：无沙箱，`--permission-mode bypassPermissions`，同一 daemon 用户下 session 互相不隔离（文档明说）；`approvals: "never"` 硬编码。

**正例值得拿**：delivery custody 用 DB 约束而不是队列做 exactly-once；direct/ambient 注意力模型；每回合凭据投影、internal session 拿不到 IM 权限；对记忆不可用的诚实 prompt。**反例正是白宦成说的"仿其型未仿其神"**：把 To C 的"我的电脑上的助手"放进团队群，没有地方、没有门、没有审计。

## 三、按六个透镜盘点我们自己

| Claude Tag 原语 | 我们的对应 | 位置 | 状态 | 关键差异 |
|---|---|---|---|---|
| Organization | Installation（一台 host + Principal 名册）/ 控制面 tenant | docs/36 §0、src/control | installation 已有；控制面裁定"厂商托管、以后" | 产品内没有 org 对象 |
| Workspace | **Box** | docs/22、src/box | 已有 | 我们的中间层是一台机器（桌面、登录态、文件），不是权限文件夹 |
| Channel | Door（ChannelRecord）+ chatKey | src/channels/identity.ts | 已有 | 门只路由进 box，**不带任何能力**（docs/22 §0 的裁决） |
| Session | agent 会话上的 turn | src/host/turn.ts | 已有 | session 归 agent（持久人格 + transcript），不归 channel |
| Routine | skill 文件的 `schedule:` / `trigger:` | src/host/schedule.ts、docs/44 | 已有 | routine 是 box 里 agent 写的文件，有 provenance 门 |
| Environment | Box 的 docker / attached / compose / k8s | src/box/provisioner.ts、docs/30 | 已有 | 全部自托管；agent 建在 box 里不迁移 |
| Repositories | 无一等对象；Scope.filesRoot 声明未强制 | src/host/scopes.ts | 缺 | 我们给整台机器，不给 repo 授权 |
| Domains | egress relay 的全局 allow 列表；Scope.egressHosts 声明未强制 | src/egress/relay.ts | 部分 | 按 relay 不按 box/租户（docs/10 S-8） |
| Plugins | skills + MCP + connector doors + extensions + hooks | docs/26、34、37 | 已有 | installation 级，按 agent 收窄；没有挂在地方上的 bundle |
| Credentials | connector door = 一个 MCP server 由 env var 门控；vault secrets 按 agent/principal 授予，只经 RunOnHost | src/host/mcp-connectors.ts、vault.ts、docs/37 | 已有 | **无 OAuth 流程**，凭据是运营者的 env var |
| Access Bundle | Scope（tools、secretIds、egressHosts、filesRoot、chats） | src/host/scopes.ts、docs/11 R4 | 部分 | 扁平、无继承无并集；docs/22 §3 已把 agent/chat 绑定 scope 判为建模错误 |
| Custom Instructions | agent persona 四段 + base/conduct/front/box/profile | src/host/prompt.ts | 仅 per-agent | 指令挂在工人上，不挂在房间或门上 |
| Memory | per-agent 类型化 JSONL + installation 级 shared shards + `about:<principal>` 标签；镜像进 box 为 profile.md；R17 project tier 仅设计 | src/host/memory.ts、docs/24 | 已有 | scope 是 agent / installation / 人，不是 workspace / channel；shared memory 没有 box 过滤；无浏览编辑 UI |
| Auto mode allow rules | PolicyGate 的 once/session/standing 授权按动作指纹；auto-review 分类器 | src/host/policy.ts | 已有 | 授权是"回答过的审批"，不是用户写的规则 |
| Channel name rules | knock / bind / invite 针对人；目录自动链接仅设计 | src/host/principals.ts、docs/35 U2 | 部分 | 我们门控的是人，不是群 |
| Guest toggle | 未链接身份 = viewer 角色 | principals.ts | 部分 | guest 是最低角色，不是开关 |
| 审计：Scheduled Work | Settings → Automations | schedule.ts | 已有 | 按 installation 不按地方 |
| 审计：Memory | box 内镜像文件；Recall 引用来源；template forget 撤回 | docs/24 §7 | 部分 | 无 UI，编辑即撤回 |
| 审计：Network Event | relay 拒绝日志到 stdout；usage/spend 账本；turn ledger；auto-review.jsonl；vault audit；xwatchdog；录屏 | docs/47、src/host/spend.ts | 部分 | 每类动作都有账本，**唯独没有可查询的网络出口事件日志** |
| Custom Runtime | `box attach`，Grok VM 在线 | docs/30 | 已有 | 一切自托管，没有"我们托管"的一侧 |

结论：**六个透镜里我们最强的是 Runtime（真机器、真桌面、每 agent 独立、隔离在 box 内）与审计原料（账本比谁都多）；最弱的是"地方"这一层：没有挂在地方上的能力包、指令、记忆，也没有把审计原料按地方切出来的视图。**

## 四、翻译：box 就是"地方"

Claude Tag 的 Workspace 是一个权限文件夹加一个运行环境，Channel 是最小会话单元。docs/22 已经裁定：权限只在 box，门不带权限，agent 与 chat 绑定 scope 要退役。这与"访问按地方配"并不矛盾，只要认清映射：

| Claude Tag | 我们 | 说明 |
|---|---|---|
| Organization | Installation | 一台 host、一份 Principal 名册、一份 org 级 bundle 与指令 |
| Workspace + Environment | **Box** | 一个 box 既是权限容器（members、登录态、secrets、egress）也是运行环境 |
| Channel | Door + 该 box 里的 agent | 门决定进哪个 box、谁能敲门；能力仍来自 box |
| Access Bundle on Workspace | **Bundle on Box** | bundle = skills + MCP + connectors + secrets + egress domains + instructions，挂在 installation 与 box 两级，box 拿并集 |
| Access Bundle on Channel | 不做 | 保持 docs/22 裁决；要"同一 agent 在不同群不同职能"，用不同 box 或不同 agent |
| Memory 跟 Workspace 走 | shared memory 按 box 分片 | docs/35 §4 已指出 shared memory 缺 box 过滤 |
| Channel Memory | agent memory | 一个门通常对应一个 agent |
| Custom Instructions per Org / Workspace | installation 级 + box 级指令段拼进 system prompt | 现在只有 per-agent |

这样 Claude Tag 的三条"神"在我们这里成为：**能力挂 box 与 installation 并向下并集；记忆按 box 分片；bundle 叠加组合出不同的 box**。docs/29 的模板（worker 配方）与 bundle（地方能力）是两个正交的东西，模板可以引用 bundle 名而不携带凭据。

## 五、里程碑

### F. 企业原语与高层设计（本文成为活文档）

- F1 **领域模型 v2 决策记录**：Installation / Box / Door / Agent / Session / Routine / Environment / Bundle 八个原语的归属与继承规则写进 docs/22 附录；Scope 退役路径；把六个透镜作为每个企业功能的评审清单。这是一条 DECISION，不是代码。
- F2 **盘点表进 docs/36**：本文第三节的表作为 docs/36 §4 的现状基线，之后每次交付更新状态列。

### G. Access Bundle：能力按地方配

- G1 **Bundle 对象与两级挂载**：`bundles/<name>.json` = {skills, mcpServers, connectors, secretIds, egressHosts, instructions}；installation 级默认 bundle + box 级 bundle 列表；agent 生效能力 = box 并集 ∩ agent.tools 收窄；docs/22 §3 的 Scope 迁移到 bundle。验收：同一 skill 在两个 box 分别启停；agent 看到的工具集随 box 变化；scope 文件全部迁完。
- G2 **Bundle 叠加与模板引用**：一个 box 可挂多个 bundle 并集生效；docs/29 模板导出时只写 bundle 名，导入方按名匹配或提示缺失（延续"agent 自己判断"的原则）。
- G3 **Connector 的 OAuth 门**：docs/37 的 connector door 增加 OAuth authorization-code 与 client-credentials 两种授权，token 存 vault，按 bundle 授予；agent 得到的是预制的请求方式而不是 token（与 CUA 计划的 fill_secret 同一原则）。验收：GitHub 与飞书任一走完授权后 agent 能调用；transcript 无 token。
- G4 **Egress domains 按 box**：relay 的 allow 列表从全局改为按 box 生效（docs/10 S-8），bundle 的 egressHosts 真正强制；被拒请求产生事件供 J3 消费。
- G5 **本地 host environment**：用户的 Mac 作为一种没有桌面的 box（exec、文件、本地 Chrome 的 CDP；没有 Xvfb 与 computer 工具），实现上是 boxd 的 macOS 精简形态或 RunOnHost 执行面的升格。"本地 project" 不是新原语，就是 Claude Tag 的 Repositories：一条目录授权挂在该 environment 的 bundle 里。两个环境对应两个 agent，云端 agent 需要本地材料时给本地 agent 派任务（Tasks + team），不做目录同步。策略上本地 environment 是 host 级：写操作默认审批，规则放行只读与指定目录。验收：在 Mac 上注册本地 environment，建一个人格的本地实例，它只能在授权目录内读写，越界被拒且进审计；云端 agent 经任务板让本地 agent 读一份本地文件并回报。
- G6 **MCP 条目按 bundle 分配并带 host 级标记**：`config.json mcpServers` 的条目可被 bundle 引用而只对某些 box 可见；本地 stdio 的 MCP（如用户自己维护的知识库 bot）标为 host 级，写类工具走审批或 I1 规则。验收：同一本地 MCP 对一个 box 可见对另一个不可见；其写工具触发审批，读工具经规则放行。

### H. 记忆跟地方走

- H1 **shared memory 按 box 分片**：shards 带 boxId，agent 只读所属 box 的分片；跨 box 只能经 installation 级显式提升。验收：两个 box 的 agent 互相看不到对方的 shared memory。
- H2 **索引 + 相关性加载**：`memory.md` 索引进 system prompt，正文按 description 相关性二次判断后取前 4K，agent 可再读全文；替代现在的 4k 预算平铺。这也是 docs/24 §5 修复计划的形状。
- H3 **记忆浏览与编辑 UI**：installation 级看到每个 box 的摘要，进入 box 看到 agent 记忆明细；编辑与撤回留痕（延续 R27 证据附着）。这是审计三类之一。

### I. 控制：规则、门、指令

- I1 **用户可写的 auto-mode 规则**：PolicyGate 新增 `rules/*.md` 由管理员书写（"读只读的 API 不问、写 Jira 评论不问、任何删除必问"），auto-review 分类器把规则作为判据；与 CUA 计划 B1 的确定性门互补。验收：规则命中的调用不弹审批且留痕；规则文件变更进审计。
- I2 **指令按地方拼接**：installation 级与 box 级 instructions 段按 org → box → agent 顺序拼进 system prompt；bundle 的 instructions 随 bundle 生效。
- I3 **门的名称规则与 guest 开关**：door 级 `autoJoin: {allow: [...], deny: [...]}` 按群名前缀自动加入或拒绝（docs/35 U2 目录自动链接的一部分）；door 级 `guest: on|off` 决定未链接身份能否敲门。

### J. 审计按地方切

- J1 **Scheduled Work 按 box**：Automations 视图按 box 分组，显示所属 agent、上次运行、下一次、暂停状态；一次性任务单独一类。
- J2 **成本按地方**：spend 账本增加 boxId 与 doorId 维度，Settings 增加"哪个 box / 哪个门最烧钱"视图（docs/47 与 R31 的延伸）。
- J3 **网络事件日志**：relay 与 box-chrome 的出口请求落 `network-events.jsonl`（时间、box、agent、host、方法、状态、被拒原因），按时间范围与 box 查询；这是六个透镜里我们唯一完全没有的审计面。
- J4 **审计导出**：transcript、usage、auto-review、vault audit、network events 按 box 与时间范围打包导出（jsonl + 摘要），供合规留存。

### K. 运行时：环境注册与 IM 送达

- K1 **Environment 注册流程**：`box attach` 升级为管理界面里的"Self-hosted environment"：生成连接码、runner 上 boxd 用连接码注册、显示健康与所属 bundle；opentag 的 `computer_connect_codes` 形状可直接借。
- K2 **IM 送达 custody**：inbound 回合的 custody 状态机（accepted 需 turnId、reportOwner）用持久化约束而不是内存实现，crash 后不重复回合；opentag `im_message_deliveries` 的 CHECK 约束是范本；接 docs/26 inbound-reliability。
- K3 **direct 与 ambient 注意力**：群里未 @ 的消息作为 ambient 进入观察副本，thread 首次 @ 时惰性物化为独立 session；替代 `groupMessages: all|addressed` 的二选一。
- K4 **长期 MCP face 路由**：docs/33 的 face 现在按委托任务临时铸造、30 分钟租约。新增按 agent 铸造的长期路由：可撤销、有租约上限、tools/call 走同一 policy 与审计，让另一个 installation 或外部系统里的 bot 能稳定调用本 agent 的工具面。同一 installation 内跨 box 仍走 Tasks 与 bus，不走 face。验收：另一 installation 把本 face 注册为远程 mcpServers 条目后可调用；撤销后 401；每次调用有审计行。

## 六、不吸收

- 把本地目录同步进云端 box：材料多、含敏感内容、用户本来就在本地干活，同步只制造两份真相；用目录授权与本地 environment 代替。

- Channel 级 Access Bundle：与 docs/22 裁决冲突，且白宦成自己预测 Claude Tag 会去掉 channel 级单独配置。
- opentag 的无沙箱、无审批、无审计的 runtime：与我们相反方向。
- Claude Tag 的"只能在 Channel 用、不能私聊"：这是 Slack 产品约束，我们的门已经同时支持群与单聊。
- 托管侧 Runtime：docs/36 已裁定控制面是厂商托管场景，以后再说。

## 七、顺序

F1 先（一条决策，改 docs/22 附录），G1 与 H1 紧随（它们都以 box 为地方，互相印证模型），然后 I2、J2、J3（低成本、立刻可见），再 G3、I1、H2、K1，最后 G2、H3、I3、J1、J4、K2、K3。CUA 计划（docs/49）的 B1 确定性门与 I1 规则门、B2 fill_secret 与 G3 OAuth 门是同一原则的两半，实施时合并考虑。

## Involute 映射（2026-09-10 提为候选，repository fakechris/lumenbox）

| 本文 | Involute | 父节点 |
|---|---|---|
| F 企业原语与高层设计 | INV-413 | INV-96 |
| F1 领域模型 v2 决策 | INV-418 | INV-413 |
| F2 六透镜清单与基线表 | INV-419 | INV-413 |
| G Access Bundle | INV-414 | INV-96 |
| G1 Bundle 两级挂载与 Scope 迁移 | INV-420 | INV-414 |
| G2 叠加与模板引用 | INV-421 | INV-414 |
| G3 Connector OAuth 门 | INV-422（关联 INV-143） | INV-414 |
| G4 Egress 按 box | INV-423（关联 INV-138） | INV-414 |
| G5 本地 host environment | INV-438（关联 INV-139） | INV-414 |
| G6 MCP 按 bundle 分配、host 级标记 | INV-439 | INV-414 |
| H1 shared memory 按 box 分片 | INV-424 | INV-142（既有） |
| H2 索引 + 相关性加载 | INV-425 | INV-142（既有） |
| H3 记忆浏览编辑 UI | INV-426 | INV-142（既有） |
| I 控制按地方 | INV-415 | INV-96 |
| I1 auto-mode 规则 | INV-427 | INV-415 |
| I2 分层指令 | INV-428 | INV-415 |
| I3 门名规则与 guest 开关 | INV-429（关联 INV-139） | INV-415 |
| J 审计按地方切 | INV-416 | INV-96 |
| J1 Scheduled Work 按 box | INV-430 | INV-416 |
| J2 成本按地方 | INV-431 | INV-416 |
| J3 网络事件日志 | INV-432（关联 INV-136） | INV-416 |
| J4 审计导出 | INV-433（关联 INV-136） | INV-416 |
| K 运行时注册与 IM 送达 | INV-417 | INV-96 |
| K1 环境连接码注册 | INV-434 | INV-417 |
| K2 送达 custody 持久化 | INV-435 | INV-417 |
| K3 direct/ambient 注意力 | INV-436 | INV-417 |
| K4 长期 MCP face 路由 | INV-440 | INV-417 |

2026-09-10 产品决策：本地做成 Environment 而不是 Project；本地材料靠目录授权不靠同步；本地能力靠宿主注册的 MCP；跨 box 靠任务板，跨 installation 靠长期 MCP face。近期 INV 增长较快（INV-394..440），下一步要做一次优先级梳理。
