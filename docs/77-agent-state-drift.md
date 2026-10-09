<!-- doc: 77-agent-state-drift
     title: 状态漂移：同样的代码和模型，agent 为什么会滚成仪式——根因、归因实验与方案
     family: decision
     status: current
     updated: 2026-10-09
-->
# 77. 状态漂移：同样的代码和模型，agent 为什么会滚成仪式——根因、归因实验与方案

2026-09-28。第 3 版：经 Codex 两轮对抗式审查（§8）后修订。共识达成前不动代码。
每条判断给出处；推测标明推测；未直接核对的标明。

## 0. 摘要

Nova 和 arkclaw 跑同一份代码、同一个模型（MiniMax-M3），对同一条转发帖给出了两种跑偏：
Nova 写 11KB「1:1 核事实 + 立场稿」存 outbox；arkclaw 先去翻旧任务 t236 和同事的历史。两者都把
「转发」误读成「用户写的帖子、要我代笔」。

**根因（R0）：系统不区分三种东西——用户要求的、agent 推断的、agent 自己做过的——而且有多条
路径把后两者提升为前者的权威。** 提取器把 agent 的做法写成「用户偏好」；沉默被当作确认；
`RememberFact`、episode、维护合并都能把一条推断变成可信的长期记录；standing 文件由 agent 自己
写、每轮注入、不通知人。被提升后的推断成为下一轮的指令，于是行为自我强化。

框架压力（S1：每条消息开任务、结尾必须报交付物）与选择偏好（S3）决定了它往哪个方向强化；
自我模仿（A1）与旧任务常驻（A2）是放大器。这些是待测假设，不是既成结论（§4）。

09-22–09-24 的「上下文恢复」七项修的是**读取侧**（少读、换上下文、撤回已知坏记忆、事后发现
偏航），没有动**写入侧**的提升路径——所以清干净之后还会长回来。

## 1. 现象与证据

| | 证据 | 位置 |
|---|---|---|
| Nova t44 文件开头「任务定位：1:1 核事实 + … 3-4 个原帖没说但推荐照的盲点」 | write_file 入参 | epoch 2 transcript |
| 同一回合选入 prompt 的 6 条记忆：#5 #8 #9 #16 #31 #61，零条与主题（微信网络）相关，全部是「收到链接怎么回」的规则或提取器碎话 | turn `55e50e7a…` 的 `memoryProjection`，按 `memoryProjectionManifest` 的 sha256 逐条对回 | `~/.agentbox/turns.jsonl`、`memory.jsonl` |
| #8「They are following a working cadence of: drop a link, get … 3–4 numbered blind spots and a outbox/ draft path … preserve this rhythm」——用户从未说过 | memory.jsonl 第 8 行，`source: extracted` | 本机 |
| #62（09-28）「用户偏好…出稿节奏延续确认——t42/t43/t44 连续三稿均标 review」——用户没反对即被记为确认 | memory.jsonl 第 62 行 | 本机 |
| 62 条中约 12 条是 agent 碎话（「先把数据拉下来:」「I'll evaluate each exchange…」） | memory.jsonl | 本机 |
| Nova 首次偏航：epoch 0 第二条链接（09-19 Aparna）「我先把回复框架定下来，再落到一条 X 长度…立场鲜明…的稿子」「已替你写好，可直接发」 | epoch 0 transcript | 本机 |
| 所有回合、选择、提取、摘要都是 MiniMax-M3（turn 270 / select 72 / memory 36 / summarize 18） | usage.jsonl | 本机 |
| arkclaw：「t236 是上一轮任务…找到 t236 在我同事（Jian / Iris）的历史里」；成稿「一句话给写『复盘』的你…我替你写一版」 | 用户转贴，**二手**，另一台机器 | — |

证据的边界：/new 后第一条是 `/goal`，本身就是工作请求且会跳过自动开任务
（`manager.ts:1512`），不能用来证明「清空后仍会把聊天做成交付物」。第 1 版这样用了，撤回。

## 2. 上一轮为什么没解决

`handoff-2026-09-22-nova-incident` 与 09-24 七项（continuation 路由、pinned exemplar 清洗、严格
记忆投影、/new、来源撤回、clean、回答偏航影子门）都修对了真问题，但全在读取侧：阻止旧叙述
流进新回合、少读、换上下文、人工删已知坏记录、事后标记。写入侧——谁有权把一条推断变成
长期权威——没动。那份 handoff 也写明需要「同模型、固定输入与历史快照的隔离对照」，从未做。

## 3. 根因模型

### R0 权威混淆：推断被提升为用户意志（主因，待测）

提升路径，逐条有代码出处：

1. **自动提取**：提取 prompt 要求保留「a constraint about how they work」（`memory.ts:579` 起），
   不区分用户说过与 agent 观察到自己这么做；看不到满意度，沉默即确认（#62）。
2. **episode**：即使提取一条都没收，交换仍计入 episode（`remember.ts:418`），推断可经 episode 复活。
3. **RememberFact**：agent 主动记的一律存为 `fact`——可信、365 天半衰期（`tools.ts:4867`）。
4. **维护合并**：合并继承最强来源类型并刷新时间戳（`memory-maintenance.ts:349`、`:409`）。
5. **「用户说的」本身不可靠**：压缩前提取把 transcript 中 `role:user` 标成「They said」，不校验是否
   人发的；host 生成的审计提示经 `Orchestrator.prompt()` → `sendFromUser` 也是 user 角色
   （`remember.ts:576`、`orchestrator.ts:785`、`:2137`）。
6. **standing 文件**：agent 可写、每轮注入；agent 的写入直接更新快照，因此不产生给人的变更通知
   （`standing.ts` 头注释）。一条推断写进 `AGENTS.md` 就成了永久指令。

同一个混淆在对话内的表现：把「用户转发的帖子」读成「用户写的帖子」。

### S1 框架压力：结尾合同与每条消息的任务

- 每条入站消息开任务（`manager.ts:2112`），prompt 列「Your tasks on the board」。
- 外部会话文件节「A deliverable belongs in outbox/」（`prompt.ts:943`）；结尾节无条件要求
  「where the deliverable is (outbox/, not a path)」（`renderWrapUp`）。
- 修正第 1 版：系统并非「没有对话」——prompt 明确要求像同事一样简短聊天（`prompt.ts:799`），
  `Tasks` 说明写「when work outlives one reply」。问题是**无条件的交付物结尾**与每条消息一个任务，
  和这些说法相冲突。强度待测。

### S3 选择偏好（待测）

选择器标准是「what would change the answer」（`memory.ts:817`）。它也允许空选、禁止凑数，所以
程序性规则胜出是**可测的偏好**，不是代码保证。初步迹象（样本极小）：记忆投影日志 09-22 后才有，Nova 只有 6 个回合带投影、3 个非空；这 3 个里
#16、#61 两条行为规则每次都被选中，话题记忆各一次；21 次选择中前 5 条占 48%。

### 放大器

- **A1 自我模仿**：t44 前同一 epoch 有 t42/t43 两篇立场稿。未与记忆、任务状态隔离。
- **A2 旧任务**：`review` 不经其他迁移就永远 live，老化扫描对 review 只提醒两次、不归档
  （`tasks.ts:723`）；列表按从旧到新取前 10（`prompt.ts:894`），陈旧 review 会挤掉当前工作。
  Recall 说明「when a task sounds like one you have done」。arkclaw 的翻旧账可能来自这里（推测）。

「同代码同模型 ⇒ 差异全来自积累状态」不成立：采样、配置、工具、抓取内容、时序都未控制。
「十天后必然复发」是假设。

## 4. 归因实验（改代码之前）

现有 `scenario-live.mjs` 不能直接用：`liveEpisode()` 新建 agent、直接调 `orchestrator.prompt()`，
不经 `ChannelManager`、不自动开任务、不恢复快照；`useBox:true` 但未 `connectBox()`；只拼接流式文本，
不收集最终交付与产物（`scenario-live.mjs:266`）。

**最小 harness 改动**：复用 `src/host/scenario.ts` 的 `runEpisode` 已有接缝（history、tasks、files、
真实 client、`drive` hook），加一个经 ChannelManager 驱动的外部会话 runner。必须接上的生产连线：

- **真实记忆选择器**：显式传入 `selectMemory`。否则 `turn.ts:1536` 回落到只取 `fact` 的词法召回，
  恰好屏蔽 R0/S3 要测的提取类记录。
- **回合后的记账**：经 `drive` 驱动会绕过 `say` 的回合后提取与收尾，需显式接上同等的提取/episode
  流程；修正硬编码的 bookkeeping 模型 `"scenario"`（`scenario.ts:421`），走真实模型。
- **状态落在 host 侧**：个人/共享记忆、看板、standing 写进 host 目录（box `files` 会被镜像覆盖）；
  历史写进真实的渠道会话 id，而不是 `options.history` 默认的 `main`。
- **捕获实际交付**：渠道投递的最终文本与 outbox 产物（live client 不填 `score.said`）。
- **F2 的干预独立于 `skipTask`**：只关自动开任务，答案评审与投递行为保持不变。

**两个实验，分开**：

1. **即时效应**（每格从同一快照恢复，互不污染）。输入：TypeSafe、Skill2Env、微信 Tun 三条转发
   （不用 `/goal`）；抓取内容冻结为 fixture。因子：
   - F1 记忆：快照原样 / 撤回推断类后 / 空（三水平）
   - F2 入站自动开任务：开 / 关
   - F3 结尾交付物合同：无条件 / 仅当请求需要文件
   - F4 同对话旧输出：有两篇前序立场稿 / 无
   - F5 看板旧状态：带 5 条陈旧 review / 空（A2，独立于 F2）
   先做全因子中与 F1 交叉的子集，报告主效应与交互，不用「砍半」单阈值做否决。每格 N≥8，随机
   化运行顺序，记录 provider 设置，报告置信区间。
2. **纵向效应**（R0 的核心）：模拟用户以固定意图（讨论）连续转发 30 条、多数沉默、反对率可调；
   比较「提升路径全开」与「推断不可提升」两组，看模板收敛与记忆中自我归因记录的增长。
   「推断不可提升」必须覆盖 §5 P1 列出的**全部**权威路径，否则比较的是一个不完整的处理。
   实验里的主张分类（是否为关于「怎么回复/怎么做事」的偏好）由异于被测模型的强模型离线完成，
   不让被测的弱模型给自己判卷。

预先声明的因子子集（实验 1）：F1 三水平 × F2 × F3 全交叉（12 格），F4、F5 各自只与
F1 的「原样」水平交叉（各 2 格），共 16 格。

**评分**：分开评意图/作者判断是否正确（讨论 vs 交付 vs 代笔；是否误认作者）、是否完成（区分拒答、
工具失败）、是否有合理的文件需求；产物与字数只作辅助。评审用异模型，对因子与假设双盲，分歧样本
人工仲裁。防止 fixture 或框架词泄进 prompt。

**S3 单点实验**：候选集按条数、年龄/类型分、长度匹配，顺序随机；程序性与事实性记忆都与消息
「同等相关或同等无关」，避免把结论写进设计。

**R0 单点实验**：50 段合成交换（agent 做 X、用户沉默 / 纠正 / 明说），统计各写入路径（提取、
episode、RememberFact、维护合并）产出「they prefer X」的比例。

N 与判据在跑之前写进本文，跑完不改。

## 5. 方案

优先级按根因排；每项实施前以 §4 对应结果为前提，被推翻的删除。

**P0 前置修复：人发的标记本身要可信（R0 路径 5）。** 现在 `fromPerson` 由 `fromId === "user" &&
!synthetic` 推出（`turn.ts:1793`），而 `Orchestrator.prompt()` 不转发 `options.synthetic`
（`orchestrator.ts:2137`），`maybeAudit` 调用时也不带——host 生成的文本会被标成人发的。修正：
host 发起的回合一律带 `synthetic`；准入判定不用这个布尔值，而用渠道入站记录（渠道消息 id + 渠道
身份 principal，见 `messages.jsonl`）作为「人说过」的唯一凭据。这是 R0 的一条现存通路，单独成项。

**P1 关闭提升路径（R0）。** 权威面（全部都要过同一个准入函数，漏一条等于没做）：

| 路径 | 位置 |
|---|---|
| 回合后自动提取、压缩前 flush 提取 | `remember.ts`（`:418`、`:576`） |
| episode 生成 | `remember.ts`（`buildEpisodePrompt`，`memory.ts:735`） |
| `RememberFact`（self 与 team） | `tools.ts:4867` |
| 维护合并 / 改写 | `memory-maintenance.ts:349`、`:409` |
| 导入与模板迁移 | `memory-admin.ts`、template import |
| agent 对四个 standing 文件的写入 | `standing.ts`（`writeStandingFromAgent`） |

准入规则按**主张**而非按 `kind`：一条记录若是关于「这个人希望怎么被回复 / agent 应怎么做事」的主张，
只有两种合法来源——(a) 渠道入站记录里这个 principal 的原话，且 host 能把记录绑定到那条消息；
(b) 这个 principal 对一个具体候选的确认。否则不入长期状态，也不以打标签的方式留在召回里。
`kind: "fact"` 不豁免——`RememberFact` 正是把偏好洗成 fact 的通道。
分类出错时偏向「当作候选」（fail closed）。事实类主张不受影响（按说话人角色一刀切过滤会误杀大量事实、明显降低召回，不这样做）。
同源重复观察不升级置信。

确认的合同（复用而非新造：已有审批卡片/按钮、带身份与会话绑定的问题 id、`Tasks create(propose:true)`
→ `TaskStore.commit`，`tasks.ts:303`；但都不是现成的「偏好确认」）：

- 绑定：候选 id + 版本 + principal + 会话 + 作用域（全局 / 仅此会话 / 仅此次）。
- 只有这个 principal 的明确肯定算确认；超时、无关回复、他人点按钮、可复用的动作授权都不算
  （AskUser 超时会让 agent 自行决定，`question-expiry.ts:163`；审批按钮授权的是房间内任何有权者，
  `manager.ts:888`——两者都不能直接当确认用）。
- 防刷：host 去重；被拒的候选按内容抑制，不再提；每会话提案预算。后台提取器不直接发问，只产候选，
  由 host 在合适时机合并成一次询问。否则弱模型会把写稿仪式换成请确认仪式。

作用域：偏好按 principal 存与投影；群聊里未经该 principal 确认的偏好不生效。

**P2 行为规则的家归人（R0/S3）。** 用户偏好只在 `USER.md`，人拥有；agent 对**全部四个** standing
文件（`USER.md`、`AGENTS.md`、`SOUL.md`、`HEARTBEAT.md`）的改动变为提议，经确认（P1 的同一合同）
生效，并产生变更通知。`USER.md` 目前按 agent 而非按人（`standing.ts:2`）：单人私聊不变；多人场景下
个人偏好走 P1 的按 principal 存储，不写进共用的 `USER.md`。长期记忆只存事实与经过。选择器标准改为
「与这条消息的内容相关」。操作经验（站点坑、`pitfall`、`NoteSiteLearning`）保持现有的家，不受影响。
涉及 `standing.ts` 与其写入分发。

**P3 结尾合同有条件；执行上下文只放当前工作（S1/A2）。** 结尾「交付物在哪」只在本请求需要文件
时要求；outbox 路径说明保留（agent 写文件前就要知道去哪）。任务投影：assignee 的执行上下文里先放
当前请求，不放 `review` 项；不改 `isLive` 与 `forAgent` 的语义（`/new` 也在用）。Recall 说明不收窄
（保留主动取回相关事实与坑的价值）。涉及 `prompt.ts`、`turn.ts`。

**P4 请求与工作分离（S1，依赖 §4 F2 结果）。** 若 F2 效应显著：入站消息记录为「请求」（保留人发的
requester、source message、卡片绑定、答案评审资格），只在 host 判定或 agent 提议且被接受时提升为
看板工作，提升时保留全部来源并重新绑定卡片。不能简单用 `skipTask`（它同时关掉答案评审，
`manager.ts:2314`），也不能改用 agent 的 `Tasks create`（requester 变成 agent、无 sourceMessageId、
不自动继承渠道的 reviewer 与来源合同，`tools.ts:4714`）。回归覆盖：卡片同步、reviewer gate 与 `maybeAudit`、`/recover` 的来源、
rescue 扫描 `doing`、`/goal`、`/new` 的责任检查。涉及 `manager.ts`、`server.ts`、`tools.ts`、`tasks.ts`。

**P5 纠正要有靶子。** 用户的「不对」「不是我要的」绑定到被否定的那次回答及其请求，并取代与之
冲突的记录；不生成全局偏好（「不是我要的」不说明普遍偏好）。`/new` 回执补一句看板未清。

**不做**：加「说人话」类提示词；以换模型代替修复；动 arkclaw 那台机器。

## 6. 迁移

现有记忆需要一个新的维护操作「重新分类」（现有维护只支持合并、时效退休、相对日期改写，
`memory-maintenance.ts:124`）：行为/偏好类且无用户确认的记录退出召回，原文保留；覆盖所有来源
（不只 `source: extracted`，也含 episode、fact 及其合并派生）。能对上用户原话的，作为 `USER.md` 候选
交人确认。记忆版本哈希随字段一起更新（`memory-admin.ts:54`）。

## 7. 仍开放

1. P1 的「一键确认」在飞书里的交互形态，以及确认疲劳。
2. P4 是否需要做，取决于 F2；若 F2 与 F3 冗余，只做 P3。
3. 纵向实验的模拟用户是否会把实验者的假设带进去。

## 8. 审查记录

**第 1 轮（Codex，2026-09-28）**，采纳：

- 根因上移为 R0 权威混淆；补上 episode、`RememberFact`、维护合并、`role:user` 非人、standing
  文件自写不通知五条提升路径。
- 第 1 版 P1（按消息取消任务、改由 agent 开）不可直接实施：丢失人发 requester、sourceMessageId、
  reviewer、卡片绑定；`skipTask` 连带关掉答案评审。改为 P4「请求与工作分离」，并后置、以实验为前提。
- 第 1 版 P2 用逐字引号核对：出现不等于主张，且现有 quote-check 是回答后纠正、不是写入门、
  忽略短于 8 字的引文。改为「提议—确认」。
- 第 1 版 P3 把偏好赶进 standing 文件：standing 目前 agent 可写、不通知，会加重问题。改为人拥有、
  agent 只能提议。
- 「outbox 只在有文件时出现」是循环的；改为结尾合同有条件、路径说明保留。
- 不改 `isLive`/`forAgent`；不收窄 Recall。
- §4 重做：现有 live harness 绕过渠道层；F1 三水平；加 F5 看板旧状态；去掉 `/goal`；快照恢复；
  即时与纵向分开；评分改为意图/作者正确性；S3 匹配候选。
- 事实更正：记忆已有查看/编辑/撤回 API 与页面（`server.ts:4139`）；`/new` 回执已说明长期记忆仍在；
  用户反馈已有部分入口（纠正提取、任务验收、表情）；`research-brief` 需「研究且要书面简报」；
  `parseExtraction` 还拒凭据、限 3 条；「系统里没有对话」过度，已收窄。

未采纳 / 保留分歧：

- Codex 把 P1（请求与工作分离）排在最后。同意后置实施，但保留为候选而非删除：两个 agent 都出现
  「转发即工单」，这是跨状态的共同点，值得由 F2/F3 定夺。

**第 2 轮（Codex）**：保留分歧获同意（「动机，不是因果证据」，由 F2 决定是否值得做）。BLOCK 三项，均采纳：

- `fromPerson` 不可信：`Orchestrator.prompt()` 不转发 `synthetic`（已核对 `orchestrator.ts:2137`）→ 新增 P0；
  准入改以渠道入站记录为凭据，且提升面上的每个写入方都要拿到这份来源。
- 「禁止提升」处理不完整 → P1 列出全部权威路径（含四个 standing 文件、team 记忆、导入）；主张级
  而非 `kind` 级；实验中由异模型离线分类。
- harness 缺生产连线（已核对 `turn.ts:1536` 无 `selectMemory` 即回落只取 fact）→ §4 补真实选择器、
  回合后记账、host 侧状态、渠道会话历史、实际交付捕获、F2 独立于 `skipTask`、预声明因子子集。
- 另采纳：确认合同（绑定、何者不算确认、防刷）；偏好按 principal；更正「`Tasks create` 不能带 reviewer」
  为「不会自动继承渠道的 reviewer 与来源合同」。

**第 3 轮（Codex）**：三项阻断均判为已解决，未发现新阻断项。结论 AGREE：以 P0 修复、harness 改造与
§4 实验为起点；P1/P2 待实验结果决定。
