<!-- doc: handoff-2026-09-22-deployment-queue-review
     title: Handoff — Nova 修复部署与 INV 队列复发风险审查
     family: handoff
     status: current
     updated: 2026-09-22
-->
# Handoff — Nova 修复部署与 INV 队列复发风险审查

## 1. 结论

**不是“全部修复”。** PR #205 修复了本次证据确认的两条机械路径：独立长请求被正文关键词吞入旧任务；压缩的工具示例复播旧研究叙述。现在已经部署到实际服务。它没有证明真模型的回复已完全恢复，也没有修复所有投递失败、追问归属、来源完整性问题。

**队列中确有会让相同体验复发的合同。** 最直接的是 INV-615：仍要求把“立场稿 + 盲区”写成逐条回复 skill；其次是 INV-616 把可靠投递回执放在日报第三阶段。前者会固化用户反对的行为，后者会继续允许“内部完成、用户未收到”。这不是对将来实现必然出错的断言，而是当前验收不能挡住这些失败。

本轮范围：部署已合并代码；只读盘点 INV 队列；将意见落文档。**没有擅自修改远端合同、优先级、状态或模型/记忆/skill。**

## 2. 部署收据

| 项目 | 实测结果 |
|---|---|
| 合并 | [PR #205](https://github.com/fakechris/lumenbox/pull/205)，23f51fd79711cc36693c2effdf4feb499ba3cdc8 |
| 部署前宿主 | /api/state 返回 6597460，不是已合并版本 |
| 部署源 | 独立干净 worktree /tmp/lumenbox-deploy-23f51fd；主 checkout fast-forward 到同一提交，保留他人改动 |
| 闸门 | npm run release:check exit 0；1,721 tests；typecheck、lint、build、产物启动检查通过 |
| 真实模型 | scorecard 明确 INCOMPLETE：model scenarios SKIPPED；不能当文风/业务质量验收 |
| 新镜像 | agentbox/box:57bc5c0cb08f；image sha256:c0ef4ab107e656a7122c8ee85cee52e35274d2296819e1193af37dc283b40921 |
| 升级前 | Atlas / Bot Boss / Nova 均无运行回合；box runningJobs=0；strayFiles=0 |
| 宿主备份 | /Users/chris/.agentbox-backups/2026-09-22-pre-deploy-23f51fd |
| 卷备份 | /Users/chris/.agentbox-backups/2026-09-22T10-08-20-volumes/ 下 work/config 两份 tar.gz |
| 操作 | 暂停 launchd 宿主；box up --recreate 自动备份、重建、验证；恢复原 launchd 服务 |
| 部署后宿主 | /api/state HTTP 200，build.commit=23f51fd，box.connected=true |
| 部署后渠道 | feishu-personal、feishu-enterprise 均 configured=true、running=true、socket ready |
| box 功能 | 内置已知页面渲染检查通过；box-doctor 18 passed、0 failed、0 warned |
| 字节核对 | 容器 /opt/boxd/boxd.cjs、/opt/hostd/hostd.mjs 与干净构建 SHA256 分别完全一致 |
| 回退 | agentbox/box:previous 保留旧镜像；旧容器已替换，非卷运行状态/浏览器标签不保留，工作文件和登录资料卷保留 |

boxd SHA256：c355ef9feda71500c6a9e004847f20cc533d5a284ff835ed063829484d7de74f。
hostd SHA256：5463e8a749c79ba784095df3bac7258b45494c07862d9c36b075f5f5545577b9。
实际编排服务仍沿用原 launchd 的宿主源码入口，不是容器里的 hostd；因此同时检查宿主 build 和容器字节。

本地日志：/tmp/lumenbox-deploy-release.log、/tmp/lumenbox-deploy-image.log、/tmp/lumenbox-deploy-recreate.log。
未向真实聊天发送测试消息，未跑有外部副作用的整套 smoke；没有把 socket ready 冒充用户收到答案。

## 3. 盘点范围与方法

2026-09-22 本次通过 Involute MCP 分别查询 team=INV，state-type 为 BACKLOG、UNSTARTED、STARTED、REVIEW，排除 rejected，first=250。四组分别 **43 / 170 / 25 / 55，共 293 个节点**，各组未达查询上限；不是只看 work_list_ready。包含候选、阻塞/已领取、待评审和项目/里程碑，不含 Done/Canceled 历史全库。

其中 **67 个属于 fakechris/lumenbox**，合同逐项审读；同时审查相关 Involute 请求/交接和 OVP 证据接口合同。其他仓库按项目、标题与交付范围排查关联，不冒称对这些仓库全部代码做了审计。附录逐条保留所有 293 项的编号、revision、状态与分流结论。

LumenBox 的 ready 查询为 41 个节点，含项目/里程碑。INV-631–634 是 **CANDIDATE**，虽然 workflow 字段显示 UNSTARTED，也不是可直接开工的已承诺工作。

INV-630 本次 context 显示已 COMMITTED、无 claim；尝试 work_claim 被拒绝：“Claiming work requires an authenticated actor.” 未借用他人身份，不伪造 run，不标 Done。部署依用户本轮明确指令执行；本地收据保留，远端执行记录需正确绑定的 agent 凭证才能补录。

## 4. 逐项意见：哪些会复发，怎样挡住

### R1 — INV-615 / INV-612：不要把这次被投诉的回复模式产品化（高）

INV-615 revision 2 明写 research-reply 把“立场稿 + 盲区”从记忆约定写成文件，只限制“跟前面的关系”三行。它约束了形式，没有约束是否回答当前问题；引用齐全也不能阻止一篇与用户问题无关的审查报告。

建议修订实现合同：先根据当前请求交付解释、答案或明确判断；只有会改变答案的证据限制才进入主答复。“立场/盲区”仅在用户要求研究评审或相关时启用，不能成为所有链接的固定模板。OVP 的引用校验留在内部，最终回复不罗列核验动作冒充解释。

必须加的验收：技术介绍题能解释“是什么/有什么用”；25 道题逐题回答或逐题说明未知，不能转交回执收尾；普通介绍不得自动扩成无边界研究；比较题给出适用场景；同一来源在不同请求下产生不同任务对应的答复。真实模型盲评独立于引用 lint，固定模型、prompt、memory、skill、输入版本。

### R2 — INV-616：送达可靠性不能等整个日报做完（高）

已核对部署提交：src/channels/feishu.ts 的 sendFile 在空 chatId 或 apiClient 缺失时直接 return；manager.ts 的 outbox 推送在 await 返回后就把文件名加入 delivered，再调用 outboxDelivered。因此静默未发出可以被记为已交付。**这是现存代码缺口，不是本次 25 题故障已证实的原因。**

建议从 INV-616 既有范围中优先交付通用 adapter 回执，不另复制一套日报专用交付事实。文本/文件分别记录渠道确认 ID、失败或 unknown；sent 文件存在、turn 结束、agent 声称完成都不等于收件人收到。网络超时且结果未知时不能盲目重发。

验收必须覆盖：文本成功文件失败、缺 client、空 chatId、发送已成功但回执落盘前崩溃、重启回收、同名旧文件。最终能从原 request 追到回执，未送达必须明确显示失败/未知。

### R3 — INV-611 / INV-630：旧合同必须以新边界为准，修复也不是完整语义判别器（高）

INV-611 revision 3 仍写“文本含纠正/追加语气”，正是会被重新实现成正文关键词扫描的表达。后继实现应明确以 PR #205 的独立请求默认排队为准，保留本次 scenario，而非照旧描述重写。

本轮对**部署提交**直接调用 isContinuation 的结果：

| 输入 | awaitingAnswer=false | awaitingAnswer=true |
|---|---|---|
| 我想知道毛利改成百分比会怎样？ | 新任务 | 续写 |
| 另外介绍一下一个无关的新模型 | 续写 | 续写 |
| 同时支持哪些格式？ | 续写 | 续写 |
| https://example.com/new-topic | 新任务 | 续写 |

第一个正常情况已修复。后几项说明剩余范围：句首启发式仍会误判；awaitingAnswer 会直接接受所有输入。manager 的 awaitingAnswer 按 identity 存储，运行中分支的窗口为 30 分钟，未绑定 question/agent/conversation/turn 的完整身份；另一会话的问题可能影响当前任务。这里是可复现的分类行为和代码风险，不冒充第二次线上故障已经发生。

后续验收需有：追问后收到全新链接、跨会话/跨 agent 同一人、过期问题、显式回答卡片、句首“另外/同时”新话题。建议问题回复使用明确 reply-to/question ID；不明确的输入保留为独立任务。不要继续靠不断堆关键词宣称彻底解决。

### R4 — INV-600 / INV-599：研究不能偷偷变成生产路由（条件风险）

INV-600 当前是研究加 spike，明确“不在没有样本对比前上线门控”，不是已批准的 Jev 生产接入。仓库另有未跟踪 jev-router 模板，本轮未提交、安装或启用。

将来若用 Jev 判断模型、记忆或续写，须保留确定性独立请求边界，决策失败/超时默认排队而不是吞并；记录决策版本与理由；在相同 25 题/文章输入上对照交付完整度，不能仅报告路由准确率或省时。当前未发现它已经造成此次故障的运行证据。

### R5 — INV-144 / 140 / 142 / 397 / 415：便宜、压缩、共享不能替代质量验收（高/条件风险）

INV-144 的验收只要求成本下降；涉及换模型、压缩阈值和预算，足以使“便宜但漏答”仍被判成功。INV-142 已有事实保留验收，但还需要“旧分析不成为新指令”；经验分享、分层指令也可能把一次研究习惯传播成所有回复规范。

建议所有相关改动绑定版本清单：主模型、摘要模型、system prompt、memory 选择、skill、路由策略。固定事件对照必须同时验收回答覆盖、任务归属、失败可见和阅读可理解性；旧工具示例不能恢复 assistant 叙述，旧 summary 回放也必须过滤。工具 input 中的正文、普通 summary 和其他记忆并未因 PR #205 全部消失，不能声称清除了所有上下文污染。

### R6 — INV-631–634：方向有帮助，但不是已经到位的保证（候选审查）

- INV-632：完整度 full 只说明所见内容/传输范围，不代表观点正确、原文权威或证据足以支持结论；partial 的局部原句仍可能支持有限结论。不要让“非 full 不可核实”变成每个问题都无限补查。要报告局部可用与未知范围；段落/文本比例只能作启发式，短公告/表格/代码页等需反例，无法判断时保守标未知。
- INV-633：应把全文保全和模型回放分开，不能为保真而每轮塞回全文；保密 recordAs 优先，指针不能信任工具正文自称 kept；文件路径与真实存在性由宿主掌握。增加写盘失败、路径穿越、并行调用、敏感内容和过期指针测试。现代码使用 REPLAYED_RESULT_LIMIT，不能照合同旧变量名机械实现守卫。
- INV-634：先归档后改活动文件在两个写入间崩溃会重复，反过来会丢失；需按稳定 ID 去重与 crash 恢复验证。归档读取应有界，不让“留证据”重建为无限模型上下文；读指标和审计可以跨归档，模型回放不必。
- 三项含文本扫描式架构守卫，只能挡已知写法，不能代替实际 tool producer、磁盘故障和账本行为测试。

它们主要减少错误核实与证据遗失，不直接解决“25 题未答完”或“有引用但难读”。

### R7 — INV-614 与 OVP 关联项：原文、评论、生成结论保持分层（高/条件风险）

INV-614 的保守归属（判不出当评论）应保留；归档完成不应升级成回答完成。INV-619/627 的 annotation 和 frontmatter 解析必须与部署的 OVP 版本核对，尤其 CRLF/未闭合围栏不能把评论当原文。INV-576 的 score 合同已指出排名位置不是可信度；bridge 不能把高排名当足够证据。INV-622 的 claim 闭包和 INV-455 的主题简报明确不把引文命中当语义正确，日报不能丢掉这个限制。

OVP 日报只消费明确 READY 的冻结包；拒绝全部 claim 时应交付“证据不足及已覆盖范围”，不能为了凑主题编造结论，也不能无休止补查。

### R8 — INV-557 / 582 / 609 / 562 / 593 / 597 等：把接手与答复归属分开（条件风险）

这些项提高可寻址、接手、轮询/SSE/push 和交接链可见性，并不天然保证最初提问的人收到了答案。验收应串起 root request → claim/run → answer → 原线程投递，区分未启动、执行中断、已答未送达；失联接手必须有期限、明确责任人，不能以“已转给某人”作为成功终态。INV-571 暂缓 agent 自主提及开请求的约束应继续保留，不能为补交付随意放开自动循环。

新语音/连接器、跨 installation、身份迁移等项也应复用这套边界，不因同一用户、同一 agent 或同一账号而合并不同任务。当前聊天“带到了”来自本地 steering 回执，不应误归因给 Involute hand-off。

### R9 — INV-128 / INV-101：验收缺口比再加一条文风提示更重要（防护项）

把本次真实输入变成脱敏 fixture；同时断言两次输入各有任务/回合、最终输出关联原消息、25 个问题有覆盖清单、未完成项明确原因。脚本模型证明调度不吞单，真实模型对照证明内容好用；两者不能互相替代。发布 scorecard 缺真模型结果必须继续写未验证。

## 5. 建议执行顺序与边界

1. **已完成**：部署 PR #205，保存版本与功能检查收据。
2. **下一优先**：在现有 INV-630/611 边界内补追问归属与歧义输入的完整任务场景；从 INV-616 提前处理通用送达回执，不能等 OVP。
3. **实施前改合同**：INV-615 去掉默认每条“立场稿+盲区”；INV-144 补质量非回归。未修改这些远端记录，需在正确 agent 身份及修订权限下按 revision 更新，保持历史。
4. **候选待决定**：INV-631–634 按上述故障测试细化后由人承诺；不是因为此次部署就已经完成。
5. **内容验收**：固定版本做一次隔离的真模型对照。包含技术介绍、25 题、证据不足的比较题、无关新链接与追问。无足够证据时应给有限答案/明确缺口，而不是自动扩展研究任务。

本轮没有新产品代码修改；只产生此审查和部署记录。原 AGENTS.md 修改、.context/、未跟踪 Jev 模板均保留。

## 6. LumenBox 67 项逐项记录

B=Backlog，U=Unstarted，S=Started，R=Review；C=Candidate，已=Committed。状态是查询快照，不等于执行成功；父项含“全部已交付”也不能代替子项的证据。

| 编号 | rev | 状态/承诺 | 审查意见 |
|---|---|---|---|
| INV-96 | 4 | U/已 | 项目容器；父状态不代表子项未实现 |
| INV-97 | 4 | U/已 | 对话呈现父项；不替代交付合同 |
| INV-98 | 4 | U/已 | 入口去重与任务边界必须保持 |
| INV-99 | 4 | U/已 | 团队列表父项；无直接根因路径 |
| INV-100 | 3 | U/已 | 父项称全部交付，仍须回归完整交付（R8） |
| INV-101 | 5 | U/已 | 防护：脚本与真模型验收分开（R9） |
| INV-102 | 4 | U/已 | 审计层；无直接路由/文风改动 |
| INV-103 | 4 | U/已 | 多租户层；保持任务身份边界 |
| INV-110 | 6 | R/已 | 呈现功能；无直接路由/压缩改动 |
| INV-111 | 6 | R/已 | 呈现功能；无直接路由/压缩改动 |
| INV-112 | 6 | R/已 | 呈现功能；内部 diff 不等于最终答复 |
| INV-115 | 5 | U/已 | 签名重放防护；保持独立消息 ID |
| INV-116 | 5 | U/已 | 密钥轮换；不得重复消费 |
| INV-119 | 5 | U/已 | 团队重命名；无直接根因路径 |
| INV-120 | 5 | U/已 | 列表筛选；无直接根因路径 |
| INV-121 | 5 | U/已 | 排序偏好；无直接根因路径 |
| INV-128 | 6 | U/已 | 防护：加入本次真实输入与交付断言（R9） |
| INV-134 | 6 | U/已 | 会话录制不等于用户交付 |
| INV-136 | 7 | U/已 | 中心审计不等于用户交付 |
| INV-139 | 6 | U/已 | 多人模型保留按人/会话/任务边界（R8） |
| INV-140 | 4 | U/已 | 同 INV-144；须增加质量非回归（R5） |
| INV-141 | 4 | U/已 | 浏览器读取质量与失败降级，见 R6 |
| INV-142 | 5 | U/已 | 记忆召回/压缩须保持任务与示例边界（R5） |
| INV-143 | 4 | U/已 | 同新连接器/语音子项 |
| INV-144 | 6 | S/已 | 高：仅降成本验收不足（R5） |
| INV-145 | 7 | S/已 | 浏览器执行器；读取结果仍受 R6 约束 |
| INV-149 | 5 | U/已 | 新入口不得绕开 request/交付追踪（R8） |
| INV-150 | 5 | U/已 | 新入口不得绕开 request/交付追踪（R8） |
| INV-152 | 5 | U/已 | 身份聚合不等于上下文/任务聚合 |
| INV-153 | 5 | S/已 | 身份条件缺失未验收；不凭同人合并任务 |
| INV-154 | 6 | S/已 | 身份合并不得合并独立任务 |
| INV-155 | 5 | U/已 | 账号链接不得合并独立任务 |
| INV-157 | 6 | U/已 | 迁移须保留 pending request 与回复归属 |
| INV-394 | 3 | U/已 | 效果证据有益；不把核验日志直接当答复 |
| INV-395 | 3 | U/已 | 权限防护；无直接本次根因路径 |
| INV-396 | 3 | U/已 | 教学链路与常规问答任务分开 |
| INV-397 | 4 | U/已 | 分享经验不得把旧叙述当规范（R5） |
| INV-413 | 2 | U/已 | 架构文档；无直接运行行为 |
| INV-414 | 3 | U/已 | 能力/指令加载记录版本，见 R5 |
| INV-415 | 2 | U/已 | 分层指令须可追溯，不隐式覆盖交付目标（R5） |
| INV-416 | 2 | U/已 | 审计投影与用户答复分开 |
| INV-417 | 3 | U/已 | 保持 request/turn/送达边界与恢复（R8） |
| INV-440 | 7 | U/已 | 跨 installation 超时保持 unknown，验证回收责任（R8） |
| INV-536 | 2 | S/已 | 桌面租约收尾；无直接研究回复路径 |
| INV-543 | 3 | R/已 | 状态投影不能把内部完成当送达（R8） |
| INV-545 | 2 | U/已 | 独立美团演练，不是 Nova 同次运行证据 |
| INV-555 | 2 | S/已 | 教学澄清限原教学任务；不借用聊天全局 awaiting |
| INV-557 | 2 | U/已 | 接续/多传输须验证原请求收到终态答案（R8） |
| INV-575 | 3 | R/已 | 授权拒绝须可见，不冒充正常交付 |
| INV-582 | 3 | R/已 | 接手署名不等于回收交付（R8） |
| INV-599 | 2 | U/已 | 研究边界；不得隐式启用新判断层（R4） |
| INV-600 | 2 | S/已 | 条件风险：仅研究，不可直接上线判路（R4） |
| INV-601 | 2 | U/已 | 独立小组件研究；不得扩成回复默认模板 |
| INV-611 | 3 | R/已 | 高：旧关键词合同与新修复冲突（R3） |
| INV-612 | 2 | U/已 | 高：父契约须同步 R1/R2 |
| INV-613 | 3 | R/已 | 已合并部署；追踪基础，不保证答案质量 |
| INV-614 | 2 | U/已 | 归档不等于交付；保留输入/原文/推断边界（R7） |
| INV-615 | 2 | U/已 | 高：固定立场稿/盲区；需改交付契约（R1） |
| INV-616 | 2 | B/已 | 高：送达确认不应依赖日报第三段（R2） |
| INV-617 | 2 | R/已 | 设计决定；用 R1/R2 修订后继实现，不重写历史 |
| INV-628 | 3 | R/已 | 已合并部署；X 特例改善，不代表所有页面完整 |
| INV-629 | 3 | R/已 | 已合并部署；WebFetch 保全，不覆盖所有工具 |
| INV-630 | 2 | S/已 | 已部署；仍有等待回答与句首误判边界（R3） |
| INV-631 | 1 | U/C | 候选；防护方向正确但不能宣称已修复（R6） |
| INV-632 | 1 | U/C | 候选；完整度不等于真实性（R6） |
| INV-633 | 1 | U/C | 候选；保全与有限回放必须分开（R6） |
| INV-634 | 1 | U/C | 候选；归档需 crash 一致性与去重（R6） |

## 7. INV 全队列快照（其余 226 项）

下列不属于 lumenbox；逐项盘点以判断本次问题的依赖/接缝，不代表这些产品全部无 bug。Involute 与 OVP 的关联详见 R7/R8；其他项目没有在本次部署中改动。保留标题，便于核对有无遗漏。

| 编号 | 仓库 | rev | 状态/承诺 | 标题 |
|---|---|---|---|---|
| INV-2 | lumen-notes | 4 | U/已 | fakechris/lumen-notes：面向中文 STEM 学生的手写学习工作台 |
| INV-3 | lumen-notes | 4 | U/已 | [M1-M3 / R0-R1] 可靠笔记库、原生墨水与页内 AI 底座 |
| INV-4 | lumen-notes | 4 | U/已 | [M4 / R1] 真实 PDF 连续阅读、页面事务与设备体验 |
| INV-5 | lumen-notes | 4 | U/已 | [M5 / R2] 可信公式识别、逐行诊断与受限绘图 |
| INV-6 | lumen-notes | 4 | R/已 | [M6 / R3] 真实课堂录音、笔迹回放与可引用转录 |
| INV-7 | lumen-notes | 4 | U/已 | [M7 / R2] 持久化主动回忆、可回源复习与 Anki 导出 |
| INV-8 | lumen-notes | 4 | U/已 | [M8 / R4] 可恢复归档、单后端同步与文献生态 |
| INV-44 | obsidian_vault_pipeline | 2 | U/已 | fakechris/obsidian_vault_pipeline — 可核对、可修订的个人知识复用底座 |
| INV-45 | obsidian_vault_pipeline | 2 | U/已 | M1：日常摄取、生命周期与读取闭环 |
| INV-49 | obsidian_vault_pipeline | 2 | U/已 | M2：来源绑定、Crystal准入与证据审计 |
| INV-53 | obsidian_vault_pipeline | 2 | U/已 | M3：双语阅读与可解释的富化状态 |
| INV-56 | obsidian_vault_pipeline | 2 | U/已 | M4：桌面宿主、调度与Agent读取入口 |
| INV-60 | obsidian_vault_pipeline | 2 | U/已 | M5：Rust日常运行与历史语料验收收尾 |
| INV-62 | obsidian_vault_pipeline | 2 | U/已 | 历史语料覆盖基线、差量补跑与失败归类 |
| INV-63 | obsidian_vault_pipeline | 2 | U/已 | 真实任务与KMEM的公平配对评测 |
| INV-65 | moyu-badge | 1 | U/已 | DeskPet Game（moyu-badge）：FoloToy AI Passport 桌面宠物放置迷宫 RPG 固件 |
| INV-69 | moyu-badge | 2 | S/已 | vocab 宿主测试接入 budget.py 验收门 |
| INV-70 | moyu-badge | 2 | S/已 | 定位固件 bin 未解释的 +225KB 增长 |
| INV-79 | Involute | 3 | U/已 | fakechris/Involute Work-Graph Kernel |
| INV-83 | lumen-notes | 5 | U/已 | [M4] 真机书写性能预算与双文档分屏 |
| INV-87 | lumen-notes | 4 | U/已 | [M5] 提示式图文解题与受限 2D 函数绘图 |
| INV-89 | lumen-notes | 4 | U/已 | [M6] 录后分块转录、时间引用纪要与后台实时听记 |
| INV-91 | lumen-notes | 4 | U/已 | [M7] 可回源 Anki 包导出与经确认的变式题 |
| INV-92 | lumen-notes | 4 | U/已 | [M8] 单后端可恢复同步到 WebDAV / S3 / iCloud 扩展 |
| INV-93 | lumen-notes | 4 | U/已 | [M8] 可恢复归档、PDF 导出与 Zotero / Typst 互联 |
| INV-158 | planofplan | 8 | U/已 | fakechris/planofplan |
| INV-164 | planofplan | 3 | U/已 | M6 自包含 macOS 交付与编译态运行验收 |
| INV-174 | lumen-translation | 2 | U/已 | fakechris/lumen-translation |
| INV-175 | lumen-translation | 3 | R/已 | v0.1.0 — Phase 1 MVP 与 Phase 2/3 框架 |
| INV-176 | lumen-translation | 2 | U/已 | Windows 桌面移植（Tauri v2） |
| INV-177 | lumen-translation | 2 | U/已 | macOS 实时字幕（系统音频→流式翻译） |
| INV-178 | lumen-translation | 2 | U/已 | v0.2.0 — 深度与覆盖 |
| INV-179 | lumen-translation | 2 | U/已 | v0.3.0 — 原生移动与 Safari |
| INV-180 | lumen-translation | 2 | U/已 | v0.4.0 — 扩展性 |
| INV-181 | lumen-translation | 2 | U/已 | v1.0.0 — 稳定性与 API 冻结 |
| INV-186 | lumen-translation | 2 | U/已 | Windows Stage 5：真机验证清单 |
| INV-187 | lumen-translation | 5 | S/已 | 实时字幕静音 tap 排查收尾与诊断代码清理 |
| INV-188 | lumen-translation | 2 | U/已 | PDF 原版式保留（overlay 覆盖翻译） |
| INV-189 | lumen-translation | 2 | U/已 | 漫画/条漫分格与文字区域修复 |
| INV-190 | lumen-translation | 2 | U/已 | 100+ 视频平台社区适配包 |
| INV-191 | lumen-translation | 2 | U/已 | Chrome BuiltinAI / Translator API 适配器 |
| INV-192 | lumen-translation | 2 | U/已 | Thunderbird 支持 |
| INV-193 | lumen-translation | 2 | U/已 | 术语表导入导出（CSV/JSON） |
| INV-194 | lumen-translation | 2 | U/已 | iOS 原生 App（Capacitor 上架 + 相机 OCR） |
| INV-196 | lumen-translation | 2 | U/已 | Android 原生 App（WebView 双语翻译） |
| INV-197 | lumen-translation | 2 | U/已 | Safari 扩展公证构建与分发 |
| INV-198 | lumen-translation | 2 | U/已 | iOS Userscripts / Orion 支持 |
| INV-199 | lumen-translation | 2 | U/已 | 插件/钩子系统（翻译生命周期） |
| INV-200 | lumen-translation | 2 | U/已 | 云端 OCR 适配器钩子 |
| INV-201 | lumen-translation | 2 | U/已 | 自定义引擎模板 UI（无代码引擎） |
| INV-202 | lumen-translation | 2 | U/已 | 社区规则市场 |
| INV-203 | lumen-translation | 2 | U/已 | 核心包公共 API 冻结 |
| INV-204 | lumen-translation | 2 | U/已 | 文档站点（Astro） |
| INV-205 | lumen-translation | 2 | U/已 | Playwright E2E（Chrome/Firefox/Safari） |
| INV-206 | lumen-translation | 2 | U/已 | 本地化扩展（ja/ko） |
| INV-208 | planofplan | 5 | U/已 | 免 Bun 环境的独立 App Bundle 与 launchd 自包含配置 |
| INV-209 | lumen-asr | 2 | U/已 | fakechris/lumen-asr |
| INV-224 | lumen-asr | 2 | U/已 | Windows 移植与跨平台验证(Windows port & cross-platform verification) |
| INV-225 | lumen-asr | 3 | R/已 | Windows 听写 Alpha 闭环(Windows dictation alpha loop) |
| INV-226 | lumen-asr | 3 | R/已 | Windows CI 与安装包流水线(Windows CI & installers) |
| INV-227 | lumen-asr | 2 | U/已 | Windows 引擎与桌面运行时验证(Windows engine & runtime verification) |
| INV-228 | lumen-asr | 2 | U/已 | Windows 前台目标与上下文采集(Windows foreground target & context capture) |
| INV-229 | lumen-asr | 2 | U/已 | Windows 会议能力补齐:说话人日记移植(Windows meeting & diarization port) |
| INV-230 | lumen-asr | 2 | U/已 | 发布工程与代码签名(Release engineering & code signing) |
| INV-232 | lumen-asr | 2 | U/已 | SignPath 受信 Windows 签名接入(SignPath trusted Windows signing) |
| INV-233 | lumen-asr | 2 | U/已 | 听写音频避让与系统集成(Audio ducking & OS integration) |
| INV-235 | lumen-asr | 2 | U/已 | 媒体播放暂停模式(NowPlaying pause, opt-in) |
| INV-236 | lumen-learn | 4 | U/已 | fakechris/lumen-learn |
| INV-238 | lumen-learn | 4 | S/已 | 里程碑：状态驱动白板客户端与参考画质对齐（计划 Stage 5–6） |
| INV-241 | lumen-learn | 5 | S/已 | 里程碑：因材施教——教会为北极星（计划 Stage 10，进行中） |
| INV-248 | lumen-learn | 4 | U/已 | 打断语音输入与旁白学生姓名占位 |
| INV-257 | lumen-learn | 5 | R/已 | 审阅模式：人工反馈入库并触发 --only 定向重生成 |
| INV-260 | lumen-learn | 4 | U/已 | 111 会话课程变体预计算跑批 |
| INV-261 | lumen-learn | 4 | U/已 | 声音与节奏：TTS 引擎、句级停顿与首音延迟 |
| INV-262 | Involute | 3 | B/已 | M6 数据可信后再做交付时延与范围变化洞察 |
| INV-263 | Involute | 3 | B/已 | M7 提升人工分诊：键盘导航与可恢复速览编辑 |
| INV-264 | Involute | 3 | B/已 | M8 先验证 Table 需求，Gantt 等待时间与依赖数据成熟 |
| INV-265 | Involute | 3 | B/已 | M9 Cycles 与容量规划等待外部采用需求验证 |
| INV-266 | Involute | 3 | B/已 | M10 先做版本失效通知，再评估富文本与多人同编 |
| INV-267 | Involute | 3 | B/已 | 实现可重放时延指标，显式区分运行时长与未知工时 |
| INV-268 | Involute | 3 | B/已 | 基于范围事件重建里程碑燃尽，缺历史时显示未知 |
| INV-269 | Involute | 3 | B/已 | 展示交付时延、样本覆盖和当前等待项 |
| INV-271 | Involute | 3 | B/已 | Peek 速览编辑：保留草稿、明确冲突与安全切换 |
| INV-274 | planofplan | 3 | U/已 | M7 可追溯消息检索与可信需求交接 |
| INV-275 | planofplan | 3 | U/已 | M8 有证据的研发经验卡片与复用评测 |
| INV-281 | lumen-navi | 3 | U/已 | fakechris/lumen-navi |
| INV-285 | lumen-navi | 3 | S/已 | Windows 跨平台移植（五阶段计划） |
| INV-288 | lumen-navi | 3 | U/已 | 执行 Observe 屏幕/音频长跑 soak（docs/SOAK.md） |
| INV-289 | lumen-navi | 3 | U/已 | 系统音频 loopback 采集（ScreenCaptureKit） |
| INV-292 | lumen-navi | 3 | U/已 | macOS 普通用户分发：签名、公证与升级验证 |
| INV-293 | lumen-navi | 4 | U/已 | Lumen ASR 会话桥（可选互通） |
| INV-294 | lumen-navi | 4 | U/已 | Coding-agent 会话记录适配器 |
| INV-295 | lumen-navi | 3 | U/已 | Windows 真机验证清单（移植阶段 5 收官） |
| INV-296 | lumen-navi | 3 | U/已 | 浏览器扩展长跑 soak 与隐私策略审计 |
| INV-297 | lumen-navi | 4 | U/已 | 划词助手的受控 Act 意图与效果闭环 |
| INV-299 | chris/staffgics | 2 | U/已 | chris/staffgics |
| INV-303 | chris/staffgics | 2 | S/已 | M4 交付产品化与测试加固 |
| INV-304 | chris/staffgics | 2 | U/已 | 统一 Node 版本并固定 better-sqlite3 原生模块 ABI |
| INV-305 | chris/staffgics | 2 | U/已 | Swift 监控 agent 测试接入统一测试入口与 CI |
| INV-306 | chris/staffgics | 2 | U/已 | mac-client E2E 无头自动化 |
| INV-307 | QuantHarvest | 2 | U/已 | fakechris/QuantHarvest |
| INV-308 | lumen-cut | 2 | U/已 | fakechris/lumen-cut |
| INV-309 | lumen-cut | 3 | R/已 | 本地转写与字幕编辑核心（导入 · ASR · Cue 编辑） |
| INV-314 | lumen-cut | 2 | S/已 | Windows 平台移植（Windows 10/11 x64） |
| INV-315 | lumen-cut | 2 | U/已 | 合并 Windows 移植分支至 main |
| INV-316 | lumen-cut | 2 | U/已 | Windows 真机硬件验证与本地转写替代路径决策 |
| INV-317 | lumen-cut | 2 | U/已 | Windows 安装包与 CI 发布链 |
| INV-318 | lumen-cut | 4 | U/已 | 云端 ASR 适配器测试补强 |
| INV-319 | mreviewer | 2 | U/已 | fakechris/mreviewer |
| INV-320 | mreviewer | 2 | U/已 | 里程碑：轻量部署与开源就绪基线（v0.20.0–v0.21.0） |
| INV-324 | mreviewer | 3 | S/已 | 里程碑：结构化输出可靠性与国产模型生态 |
| INV-327 | mreviewer | 3 | S/已 | DeepSeek 等国产模型 OpenAI 兼容性实测与矩阵补全（P1） |
| INV-328 | mreviewer | 2 | U/已 | 里程碑：多模型共识护城河（粗匹配共识 + 语义去重） |
| INV-329 | mreviewer | 2 | U/已 | 统一 Anthropic compact schema 打通共识指纹匹配（P0，阻塞共识） |
| INV-330 | mreviewer | 2 | U/已 | ProviderResponse 多 provider 可观测性（per-provider 延迟/token/审计）（P1） |
| INV-331 | mreviewer | 3 | U/已 | 实现 ConsensusReviewService：多模型并行调用与粗匹配共识（P2 核心） |
| INV-332 | mreviewer | 3 | U/已 | 多模型语义去重（LLM-based cross-model dedup）（P2/v1.1） |
| INV-333 | mreviewer | 2 | U/已 | 里程碑：中文 Review 质量护城河（prompt 术语调优与显示层中文化） |
| INV-334 | mreviewer | 2 | U/已 | Review prompt 中文术语专项调优与 finding/summary 中文模板（P1） |
| INV-335 | mreviewer | 2 | U/已 | Severity 中文显示层映射（critical→严重 等六级，DB 保持英文）（P1） |
| INV-336 | QuantHarvest | 2 | U/已 | 数据采集与迁移管线（TDX/QMT/AKShare 多源入库） |
| INV-337 | QuantHarvest | 2 | U/已 | QMT/xtquant 策略运行环境与模拟交易桥 |
| INV-338 | QuantHarvest | 2 | U/已 | PyBacktest 回测引擎 |
| INV-339 | QuantHarvest | 2 | U/已 | 财经新闻监控与 LLM 事件驱动分析 |
| INV-340 | QuantHarvest | 2 | U/已 | 多源数据探索与可视化 |
| INV-341 | QuantHarvest | 2 | U/已 | 自动化测试基线与工程质量 |
| INV-345 | QuantHarvest | 2 | U/已 | L2 历史数据读取器样例数据与测试修复（l2_history） |
| INV-346 | QuantHarvest | 2 | U/已 | himport-data 导入中断点续传与错误恢复 |
| INV-347 | QuantHarvest | 2 | S/已 | qmttools 策略框架与行情函数库（functions/stgentry/stgframe） |
| INV-348 | QuantHarvest | 2 | S/已 | MockClient：QMT 交易接口到 PyBacktest 的模拟交易桥 |
| INV-349 | QuantHarvest | 2 | S/已 | xtdatacenter 非 QMT 环境 stub 层 |
| INV-350 | QuantHarvest | 2 | S/已 | 手保板（首板）打板策略脚本集 |
| INV-352 | QuantHarvest | 2 | U/已 | 回测结果与线上实盘数据对比验证 |
| INV-354 | QuantHarvest | 2 | S/已 | 财联社电报 LLM 题材挖掘与涨停跟踪（event_driven） |
| INV-357 | QuantHarvest | 2 | U/已 | 自动化测试基线修复：收集错误、缺失 fixture、numpy pickle 兼容 |
| INV-361 | douban-books-next | 2 | U/已 | fakechris/douban-books-next |
| INV-366 | douban-books-next | 3 | U/已 | 里程碑：存量缺口与测试工程化收尾 |
| INV-383 | douban-books-next | 3 | U/已 | api-real-data 测试套件稳定性修复（数据漂移断言 + 性能预算波动） |
| INV-384 | douban-books-next | 3 | U/已 | 笔记内容级同步（bookmarklist/review raw 采集与投影） |
| INV-385 | douban-books-next | 3 | U/已 | JD/Zhangyue 远程刷新与价格历史快照 |
| INV-386 | douban-books-next | 3 | U/已 | 数据质量远程补全任务队列 |
| INV-387 | douban-books-next | 3 | U/已 | 前端构建化迁移（浏览器 Babel → Vite） |
| INV-446 | Involute | 3 | R/已 | Bug 管理闭环：Report Bug、/bugs 统计、bug.reported 事件与视频上传 |
| INV-455 | obsidian_vault_pipeline | 3 | B/已 | 主题证据简报、知识变化与现有图谱导航 |
| INV-463 | moyu-badge | 2 | U/已 | 背单词文档拆分：需求+机制概览 vs 详细机制 |
| INV-464 | moyu-badge | 2 | U/已 | 游戏文档拆分：需求+机制概览 vs 详细机制 |
| INV-465 | moyu-badge | 2 | U/已 | 社区发布：公开 GitHub 与 Recovery hook |
| INV-469 | planofplan | 2 | U/已 | 额度面板三处展示误报修复：fable 空闲前缀匹配、agy disabled 5H 车道、minimax 车道去重碰撞 |
| INV-471 | Involute | 10 | S/已 | R1 可信自用闭环：项目一致、人工验收安全与事件恢复 |
| INV-472 | Involute | 3 | B/已 | R2 开源采用验收：双客户端接续与独立安装恢复 |
| INV-476 | Involute | 4 | B/已 | 双客户端符合性套件、绑定 doctor 与版本协商 |
| INV-477 | Involute | 4 | B/已 | 固定版本自托管：安装、升级、恢复与首个外部团队验收 |
| INV-482 | planofplan | 4 | B/已 | 编译态扫描凭证、全入口协调与新鲜度诊断 |
| INV-483 | planofplan | 2 | B/已 | 可重建投影与持久用户状态的备份恢复 |
| INV-484 | planofplan | 2 | B/已 | 项目接手视图、版本化 HandoffManifest 与效果验收 |
| INV-485 | planofplan | 2 | B/已 | 30–50 张证据经验卡与检索对照实验 |
| INV-486 | planofplan | 2 | B/已 | 外部伴侣状态事件订阅与过期语义 |
| INV-488 | lumen-navi | 2 | B/已 | M7 可信时间与项目回顾 |
| INV-489 | lumen-navi | 2 | B/已 | M8 可追溯检索与上下文交付 |
| INV-490 | lumen-navi | 2 | B/已 | M9 低打扰上下文提示实验 |
| INV-491 | lumen-navi | 2 | B/已 | 统一历史读取授权与模型外发边界 |
| INV-492 | lumen-navi | 2 | B/已 | 按范围删除与派生证据失效 |
| INV-493 | lumen-navi | 2 | B/已 | 项目时间归因、人工纠正与日周对账 |
| INV-494 | lumen-navi | 2 | B/已 | 时段证据抽屉与稳定来源引用 |
| INV-495 | lumen-navi | 2 | B/已 | 跨来源有界检索与 Context Pack v1 |
| INV-496 | lumen-navi | 2 | B/已 | 工作回顾逐条引用与过期重算 |
| INV-497 | lumen-navi | 2 | B/已 | 稳定项目切换下的可控相关历史提示 |
| INV-499 | obsidian_vault_pipeline | 2 | B/已 | M7：证据生命周期、解析完整性与可测量规模 |
| INV-500 | obsidian_vault_pipeline | 2 | B/已 | 导入解析完整性报告与持久原件定位 |
| INV-501 | obsidian_vault_pipeline | 2 | B/已 | 证据版本漂移进入阅读与审阅闭环 |
| INV-502 | obsidian_vault_pipeline | 2 | B/已 | Portal与MCP真实读路径规模基线及有界优化 |
| INV-503 | lumen-learn | 2 | U/已 | 可信学习证据与课程版本基础 |
| INV-504 | lumen-learn | 2 | B/已 | 操作驱动的自适应课堂与可靠恢复 |
| INV-505 | lumen-learn | 2 | B/已 | 真实学习试点与持续复习验证 |
| INV-507 | lumen-learn | 4 | R/已 | 幂等学习证据与可解释掌握估计 |
| INV-510 | lumen-learn | 2 | R/已 | 误概念定向补救与独立迁移复核 |
| INV-511 | lumen-learn | 2 | B/已 | 学习尝试检查点与取消断线恢复 |
| INV-512 | lumen-learn | 2 | B/已 | 概念复习队列与延迟复测闭环 |
| INV-513 | lumen-learn | 2 | B/已 | 真实学习者分层试点与可复算产品评估 |
| INV-514 | lumen-notes | 2 | U/已 | [R0] 笔记库与文档事务持久化：创建、重开、恢复及迁移 |
| INV-515 | lumen-notes | 2 | B/已 | [R1] 真实 PDF 阅读与页面增删重排的文档级接线 |
| INV-516 | lumen-notes | 2 | B/已 | [R1] 页内 AI 来源绑定、任务恢复与可编辑追问闭环 |
| INV-517 | lumen-notes | 2 | U/已 | [R2] 真实本地公式 OCR 接线与失败结果可信修复 |
| INV-518 | lumen-notes | 2 | B/已 | [R2] 胶带与复习单元持久化、回源及再次复习 |
| INV-519 | lumen-notes | 2 | B/已 | [R3] 真实录音播放器与跨暂停笔迹媒体时间映射 |
| INV-520 | lumen-notes | 2 | B/已 | [R2] 逐行公式诊断结构化结果与原笔迹定位 |
| INV-521 | lumen-navi | 3 | R/已 | 修复 lumen-cua 跨平台图像哈希依赖声明 |
| INV-562 | Involute | 2 | R/已 | B5 通知策略：agent 从'一律不收'改为'按消费者投递'，并显示会不会被回 |
| INV-563 | planofplan | 3 | R/已 | Windows 平台运行时适配:路径、凭据与系统能力优雅降级 |
| INV-567 | lumen-learn | 2 | U/已 | 里程碑：Stage 11 头十分钟——零门槛上手与产品面补齐 |
| INV-570 | lumen-learn | 3 | R/已 | BYOK 设置面板：UI 内配置 LLM/TTS 端点与密钥并测试连通性 |
| INV-571 | Involute | 3 | R/已 | 暂缓：agent↔agent 自主发起请求（先只放人工发起 + 显式委派），待协作协议归属定清 |
| INV-576 | obsidian_vault_pipeline | 3 | U/已 | 检索置信信号：ovp_search 的 score 必须反映匹配质量而非排名位置 |
| INV-583 | Involute | 2 | R/已 | feat(server): cascade repository updates across CONTAINS hierarchy & add repo migration CLI |
| INV-584 | Involute | 3 | U/已 | Agent 作为一等身份：actor / 执行 / 归因 / 回执 / 交接 |
| INV-585 | Involute | 3 | R/已 | 阶段1 身份原则：关闭 SERVICE 越权、执行绑定 claim、reflex 走认证 |
| INV-586 | Involute | 3 | R/已 | 阶段2 身份生命周期：User.ownerId、SERVICE 供给、停用不删除 |
| INV-587 | Involute | 3 | R/已 | 阶段3 审计覆盖：agent_request_answer 与 GitHub 状态机写 WorkAudit |
| INV-588 | Involute | 3 | R/已 | 阶段4 决策回执 DecisionReceipt：写入时冻结依据 |
| INV-590 | Involute | 1 | R/已 | Actor lifecycle authorization + deactivated sessions + SERVICE identity collision |
| INV-591 | Involute | 1 | R/已 | Decision receipt binds to the audit row it explains |
| INV-592 | Involute | 1 | R/已 | Agent authorization from credential binding, not TeamMembership |
| INV-593 | Involute | 1 | R/已 | Hand-off grace window, chain fields in GraphQL/UI, legacy agent cleanup |
| INV-594 | Involute | 1 | R/已 | Cross-team authorization: request tools, actor representation, credential lifecycle |
| INV-595 | Involute | 1 | R/已 | Terminal run replays: idempotent replay or refusal, never silent drop |
| INV-597 | Involute | 1 | R/已 | Hand-off chain and receipt display: work page, work context, agent page |
| INV-598 | Involute | 1 | R/已 | Housekeeping: @mia retirement, INV-573 evidence retraction, plan accuracy, flaky test root cause |
| INV-602 | Involute | 4 | R/已 | 移动端导航抽屉与未登录页的登录入口 |
| INV-603 | Involute | 3 | R/已 | agent-setup 文档：各 coding CLI 全局 MCP 配置路径对照表与凭证落地规范 |
| INV-604 | Involute | 3 | R/已 | Agent 凭证签发与 actor 创建缺少审计记录 |
| INV-605 | Involute | 3 | R/已 | Agent 详情页补齐生命周期操作：停用、转移 owner、撤销凭证、重新启用 |
| INV-606 | Involute | 3 | R/已 | Settings → Agents 签发表单补齐 handle、owner、runtime、描述与 answer scope，并防止重复建 actor |
| INV-607 | Involute | 3 | R/已 | /agents 目录与 Settings → Agents 打通：显示停用 actor、无 handle actor 的详情页、凭证与 actor 的双向链接 |
| INV-608 | Involute | 3 | R/已 | 看板页直接敲数字即按 issue 编号过滤 |
| INV-609 | Involute | 2 | U/已 | agent_inbox 行带上交接来源：handed_off_from_id / handed_off_from_handle / hop_count |
| INV-610 | lumen-asr | 2 | R/已 | 会议自动检测默认开启、提示全局可见与纪要完成通知(meeting detection default-on, global prompts & minutes-ready notification) |
| INV-618 | obsidian_vault_pipeline | 2 | S/已 | M8：外部投递者的通用契约——备注分离、needs-content 终态、来源自描述与机器可读出口 |
| INV-619 | obsidian_vault_pipeline | 3 | R/已 | 读者备注与来源正文分开：annotation frontmatter 键端到端契约（GitHub #481） |
| INV-620 | obsidian_vault_pipeline | 3 | R/已 | needs-content 终态与 enrich 尝试计数：ContentUnavailable、3 次/72 小时门槛、--retry-unavailable（GitHub #482） |
| INV-621 | obsidian_vault_pipeline | 3 | R/已 | 自定义 frontmatter 键透传到 index：解析层 flatten、SourceRow 白名单 meta、find --meta（GitHub #483） |
| INV-622 | obsidian_vault_pipeline | 3 | R/已 | ovp2 claim <key> --json：claim 证据闭包迁到 ovp-memory，CLI 与 MCP 共用（GitHub #484） |
| INV-623 | obsidian_vault_pipeline | 3 | R/已 | 来源自描述：SourceRow.capture_path 与 run-status.json 的 url/sha256/rel_path，doctor 交叉核对（GitHub #485） |
| INV-624 | obsidian_vault_pipeline | 3 | R/已 | enrich 留痕与 daily 机器可读结束行：source_enriched 事件与 daily-result JSON 行（GitHub #486） |
| INV-625 | obsidian_vault_pipeline | 3 | R/已 | 修复 main 上既有的 12 个 clippy 警告，让 AGENTS.md 声明的 -D warnings 闸门重新可用 |
| INV-626 | obsidian_vault_pipeline | 3 | R/已 | Windows CI 自 2026-09-14 起一直红：resources/read 的 fallback 分支漏了反斜杠归一化，MCP 读不出正文 |
| INV-627 | obsidian_vault_pipeline | 3 | R/已 | split_frontmatter 只认 ---\n 围栏：CRLF 或未闭合的 note 会把整块 frontmatter 当正文，title/source/tags 一并误解析 |

