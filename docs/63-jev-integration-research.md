<!-- doc: 63-jev-integration-research
     title: Jev 接入研究：先改善记忆与交付判断，再考虑执行加速
     family: decision
     status: current
     updated: 2026-09-22
-->
# 63. Jev 接入研究：先改善记忆与交付判断，再考虑执行加速

本轮对应 **INV-600 → INV-599 → INV-96**。这是研究建议，尚未批准为产品实现方案；不替代 docs/03、docs/22 的规范。Chris 要求先深入分析、更新 INV，未来即使实现也必须有功能开关。本轮没有修改产品代码或启用运行时功能。

## 1. 建议与范围

**建议建立宿主内可选、可替换后端的结构化判断接口，以 Jev 为第一个实验 adapter；首个集成实验选记忆重排，交付证据核对列为第二优先级。** 不新建一个“Jev agent”承担所有判断，不接管现有 registry、bus、policy 或 turn loop。Chris 补充要求 A/B 开关和未来替换类似方案，已纳入下文设计；所有名称仍是提案，尚无产品实现。

排序依据是现有痛点、接口成熟度、错误损失和可回退性，而非单次模型价格：

| 顺序 | 场景 | 对用户的价值 | 建议阶段 |
|---|---|---|---|
| 1 | 记忆候选重排 | 找到本轮真正有用的约束，减少旧主题污染 | 先离线对照，再 shadow，最后小范围启用 |
| 2 | 交付前证据核对 | 区分“文件写了/发了”和“问题答对/答全了” | 先做离线评审；补齐证据输入后 shadow |
| 3 | 工具授权语义审查 | 补充授权撤回、草稿与发送、外部内容诱导等判断 | 沿用 auto-review；禁止概率自动越过 policy |
| 4 | Skill 推荐、research 材料筛选与证据检查 | 少找错 skill、少把不相关材料塞进报告 | 只推荐/排序，不静默丢消息或证据 |
| 5 | 语义卡住/偏题识别 | 识别“换着命令重复失败”，减少无效长跑 | 低频判断、最多一次纠偏，先不自动停 worker |
| 6 | 每回合模型/effort 路由 | 可能节约总成本 | 完成质量有基线后再试，尊重用户指定模型 |
| 7 | CUA operation + target 选择 | 在有语义树的小步骤上减少主模型往返 | 先完成观测/结果合同，限定任务试点 |
| 8 | 上下文工具结果裁剪 | 可能减少 token，保留原文细节 | 最后做；先 shadow，不能直接换掉现有压缩 |

**暂不采用**：自动判断新消息属于旧任务并吞并；用高置信度授权支付/发布/删除；让 Jev 直接识别截图；生成正文、总结或命令；按模型评分删原始记忆/记录；自动把 INV 标成 Done。

## 2. 本次读了什么、证明到哪里

本地代码基线 `23f51fd79711cc36693c2effdf4feb499ba3cdc8`。已先读 docs/INDEX，核对 docs/03、22、43、58、61 及近期 Nova 调查和 CUA 研究。工作区原有未提交的 AGENTS、docs/62、部署复核记录、CUA probe 和 Jev 模板不属于本轮实现。

补充 A/B 设计期间，共享工作区推进到 `cc71f8223138a010b70c2e211cf739fa3a7ac57c`（PR #207）。已复核差异与请求归属 handoff：聊天接续已改为显式 `/answer`、`/continue`，删除隐式词法合并；这是其他工作交付，不能算成本轮 Jev 成果。下文接续项按该现状更正，其余深入研究引用仍固定在初始基线。

仅使用一种安装方式：

```sh
npx skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes
```

安装到 `.agents/skills/typesafe-ai/SKILL.md`，`skills-lock.json` 保存来源；`npx skills list --agent codex` 确认是 Codex 项目级 skill。本轮已直接读取并按其“读实时文档、代码控制流程、窄问题、用领域数据验证”的方法研究。后续项目会话可发现该 skill。

环境中存在 `TYPESAFE_TOKEN`，仅在请求进程内读取；未打印、复制或落盘其值。官方 SDK 默认环境名是 `TYPESAFE_API_KEY`，因此“有 key”不等于 SDK 已自动配置；未来 adapter 应显式处理当前别名。

从 [Awesome Jev](https://awesomejev.com/) 发现案例，再读官方文档和下面固定版本的源码。榜单、star 数、作者宣传的速度不当作生产成熟度或本项目性能证据。未运行上游完整应用、浏览器/Android 演示或上游基准。

| 案例与固定源码 | 值得借用 | 对 LumenBox 的限制 |
|---|---|---|
| [Browser Use / jev-ultrafast](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py) | 一次请求同时问 operation 与各操作的 target，只消费选中分支；候选来自当前 DOM，填文本另交生成模型 | 是有观测候选的浏览器循环，不能直接替换像素桌面；仍须本地执行前复验和独立后置条件 |
| [Droidrun / mobile-jev](https://github.com/droidrun/mobile-jev/blob/395fc222beac4f059f9a0beb337d114a2b066e99/scripts/mobile-agent/policy.mjs) | 动态动作空间、Choice 分布校验、输入状态影响可选动作 | Android demo 的平台合同不同；借设计，不引入第二套移动端运行时 |
| [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction/blob/e3f262a7f4d42bd8dd32ced30d26176f7cb545b0/README.md) | 分别判断保留调用/保留结果，保护近尾部并维持调用结果成对；失败退回原压缩 | 判断 state 省略结果正文；不可能证明被省略的结果无关。输出保留 assistant prose，不能解决旧叙述复播；请求限额说明也须按官方新文档核对 |
| [pi-warden](https://github.com/DevMortimer/pi-warden/blob/0b99fe89d0284e7423e5a4fddb3ea8342badde8f/src/done.ts) | 变更后的新鲜检查证据、claims_done/claims_verified 分开问，优先纠偏 | 有测试不等于满足用户内容要求；我们还要检查产物与当前请求的逐项对应 |
| [pi-jev](https://github.com/y0usaf/pi-jev/blob/4c25ef77da474ae230a561582ba47b3e0de4a68a/README.md) | 破坏性、越界、影响程度分开，输出失败分类与重试建议 | 上游明确六个状态只够 smoke、不能直接默认 enforce；其错误 fail-open 不能作为我们的授权规则 |
| [Foreman](https://github.com/thruwire/foreman/blob/a7d21d18d306a0cb9f3e15acefbdb5663521405c/README.md) | 把 drift/stuck/verification 等判断交给 Jev，再由有预算和冷却期的确定性策略消费 | 作者明确为架构实验。我们已有 bus/tasks/progress，不应照搬另一套 supervisor/worker 生命周期 |
| [jev-harness-router](https://github.com/JoacoMarc/jev-harness-router/blob/25d2b1601e5768e16b8ea23ccdb17bc1a3785146/src/jev.ts) | deadline、既有路由回退、连接复用、迟到结果处理；[经验记录](https://github.com/JoacoMarc/jev-harness-router/blob/25d2b1601e5768e16b8ea23ccdb17bc1a3785146/README.md#what-the-measurements-changed)展示缺上下文时甚至输给 regex | 不能抄阈值或固定 350ms；双峰 Score 的平均值会低配模型。迟到结果只能用于同一证据版本的缓存，不能改已开始的 turn |
| [Canny](https://github.com/qkal/Canny/blob/a266600711c2b46b1aa4537cc459c3319852c0b7/src/jev.ts) | 结构化判断、内容摘要缓存、审计；[项目说明](https://github.com/qkal/Canny/blob/a266600711c2b46b1aa4537cc459c3319852c0b7/README.md)强调证据与确定性 hook | 不把“judge 说 done”当验收；复用本项目 receipts/evidence，而非再建真相账本 |
| [jev-recall](https://github.com/samdotmak/jev-recall/blob/d3e4acfb45c7cf6231f1621b7dafb09d21e95862/src/jev_recall/core.py) | 每条记忆独立判断是否改变本轮行动；候选池与相关性判断分开 | 多个事实可同时相关，不能拿单个 Choice 的互斥概率直接作为多条独立相关度；不能复活已撤回或跨 Box 事实 |
| [jevmail](https://github.com/fazlerocks/jevmail/blob/f6f20af9c2805efd924c29cbea59547e72c558fc/README.md) | 分类/分流先做成可见的只读结果；[只读 Gmail scope](https://github.com/fazlerocks/jevmail/blob/f6f20af9c2805efd924c29cbea59547e72c558fc/src/auth.ts)在代码里约束副作用 | 对应我们的研究收件箱“建议类别/优先级”；不能据此静默丢弃请求或替用户回复 |

另核对 [Vercel AI SDK TypeSafe provider](https://ai-sdk.dev/providers/ai-sdk-providers/typesafe-ai)：其定位是 experimental evaluation API。说明应给 Jev 一个判断接口，而非强装成普通聊天 provider；本项目不因此新增 AI SDK 依赖。

## 3. 官方合同中的关键区别

官方 [API](https://docs.typesafe.ai/api) 提供 `POST /v1/systemone`，输入 state 与具名问题，输出 Choice / Score / Noul。问题 ID 不参与推断，题意必须在 instructions/criteria 中完整表达；批内问题独立，不能让第二题隐含依赖第一题的答案。

[模型页](https://docs.typesafe.ai/models) 在研究日列出 `jev-1.13.0`，`jev-latest` 指向它；文本输入，非图像模型；总请求 64k token，state 加最长问题 32k。输入 $0.042/Mtoken、输出免费。上线评测固定具体版本，升级需重新对照，不跟随 alias 悄悄改变行为。中文需单独测，不从英文演示外推。

[Confidence](https://docs.typesafe.ai/confidence) 的值反映分布集中程度，**不是“这个动作有 85% 的执行授权”**；Noul 没有另一个 confidence 字段。多个可接受选项会分散 Choice 概率，不能机械把它解释成错误。每条材料用相同 rubric 的 Score 或独立 Noul 才适合多项筛选。

[Jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) 明示算术、时间比较、多跳、冗长干扰和对抗内容限制。身份、期限、配额、幂等、调用/结果配对和授权版本仍由代码判定。输入写上“这是不可信内容”有帮助，但不构成防注入安全边界。

研究方法参考官方 [reranking](https://docs.typesafe.ai/cookbooks/rerank_typesafe)、[citation check](https://docs.typesafe.ai/cookbooks/citation_check)、[skill suggestion](https://docs.typesafe.ai/cookbooks/skill_suggestion)、[guardrails](https://docs.typesafe.ai/cookbooks/llm_guardrails)、[fan-out](https://docs.typesafe.ai/patterns/fan-out)。这些 cookbook 的阈值与效果只属于各自数据。

## 4. 结合本项目的接入设计

### 4.1 首选：记忆重排

`src/host/memory.ts:821 chooseRelevant` 已有清晰边界：预算不足时才选择；候选是 top-by-score 60 与 lexical 20 的并集再去重；当前 ask 返回 JSON 文本、parseSelection 解析，最后最多提升 8 条，由 recall 按原预算输出。`turn.ts:1345` 调用它，`orchestrator.ts:1633` 注入 askCheaply。这里已有生成模型成本，接 Jev 是一次可直接比较的替换实验。

建议未来增加 typed selector seam，直接传 query 与候选 ID/正文/来源，而不是把旧 JSON prompt 丢给 Jev或伪造一段 JSON 回给旧 parser。逐候选问“是否会改变本轮回答/行动”，需要排序时再用定义一致的 Score；重要约束的必保规则留在代码。保留现有的去重、撤回、预算和索引，不改变共享记忆的权限边界。回退链为“现有选择器 → 既有 scored recall”，在同一总 deadline 内有界执行。

三个要测的结果：required 事实 Recall@预算、forbidden 暴露数、最终任务完成质量。只比较排序一致率无法判断哪个好；也不能靠发送全部历史掩盖候选漏召回。先复用 INV-147 的至少 24 条六类 fixture，记录候选覆盖与选择错误各自占比。

### 4.2 第二：交付核对，而非只识别“我做完了”

`guards.ts:92` 主要识别未查证断言、只承诺不行动；`turn.ts:2336` 的 Stop hook 仅给 turn id、agent name、是否已触发和最后回复（最多 20k 字符）。**当前 payload 没有本轮原始请求、产物摘录和验证结果，直接装外部 done checker 不足以可靠核对交付。**

拟补齐只读的 `request requirements + artifact evidence + fresh check metadata` 视图，绑定 task/turn/recipient/文件版本。代码先校验文件是否存在、条目 ID 是否覆盖、测试是否晚于最后改动；Jev 再逐要求判断“产物内容支持此要求吗”“引用真的支持该句吗”。缺证据记 unknown，不把缺信息当失败事实。例：25 道题各编号齐全仍可能全在讲旧 Jev 研究，需核对每题语义，不能让模型数题。

初期只出审计建议。未来可至多触发一次明确的修正提示，复用现有 Stop hook 的防循环语义和共享纠偏预算；不得无限返工，不得把诚实 partial/blocked 当“虚假完成”，不得扣住所有回复等 judge 上线。触发前还要确认最后正文尚未向渠道送达；当前 Stop hook 的位置不能直接视为完整的发送闸门。

### 4.3 工具风险：分别问授权、影响、目标一致性

本项目已有 `auto-review.ts`，`ReviewInput` 分 trusted 用户、untrusted 叙述和 operatorRules；`ReviewMode` 已有 off/shadow/enforce。`turn.ts:2459` shadow 是异步记录、enforce 才等待。`policy.ts` 另管预算、工具限制、不可逆审批。Jev 应接既有审查 seam，不能额外新建第二套权限系统。

“是否破坏数据”和“用户是否授权”是不同题：授权删除仍有破坏性，低破坏性也不代表可以擅自给别人发消息。建议输入分别包含确切工具参数、当前可信授权范围/撤回信息、操作目标和未知项，输出具名判断与 reason code，由代码组合。Jev 不生成审查理由，解释可由确定性模板引用证据；不制造它没返回的思维过程。

当前 `AutoReviewer.review` 无回答会 ALLOW 并记 unavailable；这不表示底层 policy 放弃检查，但也意味着**把新强制安全闸门塞进这里会遇到 fail-open 语义不匹配**。因此首版只做 shadow 对照。未来如增加必须得到语义判断的高风险新能力，缺 key/超时应回到已有 reviewer 或既有人工审批，不能把 unavailable 解释成安全。已存在的 policy deny/ask、boxd 不可逆门和用户撤回永远不能被 Jev 解除。

### 4.4 Skill、research 与通知

`skills.ts` 已将 skill 索引限制为 12k 字符、单描述 400 字符，正文按需读取。建议对已安装、当前 Box 可见且 bundle 允许的候选做推荐；允许 none，推荐只改变顺序/提示，不卸载、不自动安装、不把工具禁掉。由代码做权限候选过滤，再由模型择优。

docs/58、61 的 research/digest 设计可借材料相关性打分、主题标签、相似报道候选、claim-source 核对；推荐类别与原始来源分开保存，合并前保留来源链。日报仍由生成模型综合，跨文档新结论不能由 Jev 自动“提炼”。每条入站消息仍有可追踪终态，判为低相关也不得无声消失。精确 URL/ID 去重用代码，不付钱问模型。

### 4.5 语义卡住与模型路由

`progress.ts:91 detectLoop` 识别相同工具签名且状态不变；语义层能补“换参数反复踩同类错误”。先按确定性阈值筛出异常片段，再让 Jev 分别问重复策略/偏离目标/需要缺失信息。只产生建议，不能改任务归属、抹掉队列或凭一次低分停 worker。异步判断绑定最新 turn/round，已过期结果丢弃。

模型路由另涉及 `provider.ts` 的真实 context window、vision、effort 与当前会话历史。用户明确选的模型必须固定；一回合开始时选定，不在半途降档。多模态、长上下文、复杂交付不足以只从最后一句短消息猜难度。评测总任务成功率、重试和升级后的总费用，不只看单次 token 成本。

初始基线的 `src/channels/continuation.ts:47` 有 awaitingAnswer 直接接续与关键词启发式；补充设计时合并的 PR #207 已改为显式 `/answer`、`/continue`，由 channel manager 校验归属，不再隐式合并普通消息。INV-630 的后续质量验收不应重新引入这一推断路径。Jev 最多在不改变任务归属的离线/shadow 研究中提出关联建议；发送人、渠道、会话、目标消息、期限、明确回答关联始终由代码确认。新增的 36 次 smoke 包括接续分类，也**不构成启用自动合并的证据**。

### 4.6 CUA 与压缩后置

CUA 可复用已有 browser snapshot/ref 和 AT-SPI 文本，但 Jev 不看图。先保证 INV-636 的观测绑定、INV-637 的 dispatch/effect/verification 合同；任意动作仍过同一个 dispatcher/policy/owner 检查。单次判断批量询问 operation 与各分支 target，只有 selected branch 可执行；无候选/低置信度/stale/unsupported → 重新观察或回主模型。填表文本仍由生成模型或已验证用户值提供，DONE 仍要后置条件。

压缩方面，我们已有 activeWindow、pinned entries、工具配对修复、anchors、preflush、CompactionGuard 和近期历史示例清理。外部 verbatim pruning 不能自动解决旧 prose 污染。若后续试验，只裁模型可见投影；原 transcript、未知副作用回执、未回答问题、当前约束与撤回不可删。裁剪后实际 token 仍超预算则回现有压缩；成对、可恢复、不重放副作用的硬约束优先于节省比例。

### 4.7 现有 Jev router 模板仍是草案

未跟踪的 `src/host/catalog-data/templates/jev-router.lumenbox-template.json` 仅有 persona、memory、文字 skill 与 paused routine，`connectors` 为空，没有实际 TypeSafe 调用代码。它要求主模型自行“derive calibrated confidence”，并套用 0.85/0.60 的统一阈值；这既不能证明调用了 Jev，也不能产生经验证的校准概率。未来若保留此模板，须实际消费 typed API 结果，删除泛化阈值与凭置信度执行高风险动作的承诺，并遵循功能开关。此次不修改、安装或发布它。

## 5. 可替换后端、功能开关与 A/B（提案，未实现）

### 5.1 业务合同与 provider 分离

依赖方向为 `业务判断点 → DecisionService → DecisionProvider adapter`。`DecisionService` 统一处理 deadline、预算、并发、取消、缓存与审计；`TypeSafeDecisionProvider` 才了解 URL、认证、Choice/Score/Noul 和具体 wire schema。未来添加其他专用判断模型或结构化 LLM adapter，业务模块不改 import、不读 TypeSafe 环境变量、不依赖 SDK 类型。当前 selector/reviewer 是可独立保留的 baseline；不要为了抽象，强迫旧路径也发一次模型请求。

业务入口保持窄而明确，例如 `rankMemoryCandidates`、`checkDeliveryEvidence`、`reviewToolIntent`。每个请求携带目的、输入 schema/rubric 版本、不可变证据引用与版本、候选 ID、授权 epoch 和总 deadline。结果采用判别联合：`judgment` 含已验证的业务结果；`abstain` 表示模型不能可靠判断；`unavailable` 表示能力不支持、配置或调用失败。后两者不能转换成 0 分、false 或 ALLOW。最终允许执行什么仍由现有确定性 policy 决定。

Provider 描述自身能力（多候选排序、独立命题判断、支持语言/模态、输入上限、批量、分布返回能力），Service 在发送前匹配目的合同。不支持则明确回退，不能偷偷用普通文本模拟概率。Jev 的 raw probability、分布集中度和其他后端的自报 confidence 分开存储；**统一结果类型不等于统一校准尺度**。业务阈值绑定目的、provider、模型、rubric、校准数据版本；替换后端须重新评测，不能沿用 Jev 的阈值或宣称概率可横向平均。

稳定的业务 evidence schema 由 LumenBox 拥有，provider-specific prompt 与参数仅在 adapter 配置中。缓存 key 还需包含 provider/model、输入/rubric/校准版本和实验版本，防止切后端仍读旧结果。凭据只从宿主 secret 配置解析；TypeSafe 当前的 `TYPESAFE_TOKEN` 别名局限于该 adapter，不扩散到业务模块。

### 5.2 三个独立维度：是否生效、如何分流、使用哪个后端

以下是建议配置结构，不是当前已支持的运行时配置；取代本轮初稿的 Jev 专属服务名与环境变量设计：

```yaml
decision:
  mode: off                    # off | shadow | enforce，总上限/kill switch
  purposes:
    memory:
      mode: off                # 每个目的独立开关
      experiment:
        enabled: false
        id: memory-selector-v1
        assignmentVersion: 1
        unit: conversation
        eligiblePercent: 5     # 只对符合条件的白名单流量计算
        arms:
          control: {weight: 50, implementation: baseline}
          treatment: {weight: 50, implementation: decision, provider: typesafe, model: jev-1.13.0}
```

delivery/review/skills/progress/routing/cua/compaction 同样独立配置，缺省 off。总 off 覆盖全部子项；总 shadow 把子项 enforce 限制为 shadow；子项 off 永远保持 off。实验关闭或对象不符合条件时走 baseline；以后全量采用通过 `control=0、treatment=100` 的显式版本发布，仍保留总开关和每目的 kill switch。切换 provider 是 treatment 的配置，不等于打开实验或自动扩大流量。

off 必须零新增判断请求、零判断副作用；缺 key 不影响启动。**shadow 消费额外预算，但不改变实际选择、可见内容、权限、任务状态或调度顺序。** shadow 在相同不可变输入上比较 baseline 与候选判断；只 baseline 能驱动后续执行，候选不写记忆、不触发纠偏、不执行工具。设置独立限流和预算，避免后台实验挤占主流程。

### 5.3 A/B 的分配、隔离与统计合同

1. **稳定分桶**：对 experiment ID、assignmentVersion、tenant/box 与实验单位的匿名标识做带服务端密钥的确定性 HMAC；分别计算入组与 arm，并持久化 assignment。重试、进程重启、同一会话后续 turn 不换组；用新的 experiment/version 才允许重新分配，记录切换边界。不能按每次请求随机，否则一次任务同时受到两种策略影响。
2. **单位与污染**：记忆选择通常按 conversation，交付/进度按 task，压缩按整段 conversation；同一实验只选一个预先定义的单位。会改变共享 memory/index 或团队协作的实验必须按实际共享边界（box/team）分组，或使用隔离写入与快照；不能让 treatment 写入污染 control。首阶段优先仅选择已有候选、禁止实验专属记忆写入。切换模式后，已被改变的上下文不会因关开关自动恢复，需新会话或明确快照恢复边界。
3. **在线只执行一组**：enforce 下一个任务只消费被分配 arm 的结果；另一组不能影子执行工具、重复发送或写盘。真实 A/B 比较最终任务结果；shadow 只能证明判断差异、延迟与候选质量，不能证明未执行 treatment 的端到端成功率。反事实端到端比较放进无真实副作用的 hermetic scenario。
4. **失败不改归属**：treatment 超时/abstain/unavailable 可以按合同回 baseline，但 assignment 仍为 treatment；记录实际执行路径及 fallback reason，按 intention-to-treat 报主结果，另报实际 exposure/回退率。不能把失败样本挪到 control，或只统计成功 API 响应。
5. **可归因观测**：沿用现有审计，不新建产品真相账本。记录 eligibility、assignment、exposure、实际 provider/model、输入摘要/证据版本、rubric/校准版本、判断状态、policy 消费结果、回退原因、耗时与 usage；用 task/turn/experiment 关联最终质量及额外重试/纠偏成本。日志默认不保存原文或凭据，包含 control 成本及 shadow 重复调用成本。升级 provider/model/rubric 是新版本，不混在同一 treatment 报告中。
6. **预先定义门槛**：上线前写明主要指标、随机化单位、基线率、最小有意义差异、样本量/时长、停止规则、语言和任务分层。按分配单位估计区间，检查样本比例异常；模型生成的自评分不能当唯一标签。记忆以 required recall、forbidden 暴露和盲评完成质量为主；交付看漏检、误纠偏、返工次数；统一记录 P50/P95、总费用、回退率。出现权限越界、撤回复活或跨 Box 泄漏立即关停；普通质量/成本阈值由基线确定，不能凭这 36 次 smoke 随意设定。
7. **开关真实可回滚**：global/purpose off 优先于 experiment 配置，取消在途调用并递增 epoch；迟到结果不生效。持久 assignment 保留便于审计，但停用时仅走 baseline。多实验先互斥同一判断点；记忆、路由、压缩同时影响同一任务时应互斥或显式采用因子设计，避免把交互影响错算为单项收益。

### 5.4 失败合同

| 故障/边界 | 所需行为 |
|---|---|
| key 缺失、429、网络失败、schema 不符 | 明确 unavailable，回既有路径；不静默产生 ALLOW |
| 消费 deadline 到期 | 主流程立即回退，迟到结果不得影响已执行动作；transport 另有硬截止和并发上限，禁止无限挂起 |
| 关闭开关、用户 stop、撤回、切换 Box/turn | 递增决策版本/epoch，所有旧结果失效；下次边界生效，不能只靠进程重启 |
| 权限/候选缺失 | 先由代码拒绝或 unknown；不让 Jev 补造不存在的候选或权限 |
| 缓存命中 | key 含 tenant/box/agent/task、证据版本、provider/model、question/rubric/校准/实验版本、授权版本；禁止跨租户共享原始材料 |
| 多次判断或纠偏 | 计入本 turn/principal 用量与预算；共享总期限，熔断、采样、每轮纠偏上限 |
| 敏感材料 | API key 只在宿主；发送前做来源选择与脱敏，默认日志仅 ID/hash、模型、概率、usage、ms、fallback reason |

不要机械把原 INV-600 中的 NO_PROXY 测试经验提升为所有部署必须绕过网络策略。连接复用应保留；代理/直连应遵守部署配置，测实际宿主 P50/P95/P99 后确定 deadline。也不照搬某 SDK 默认多次重试导致超时预算叠加。

## 6. 本次隔离 API smoke

使用 12 条本轮人工编写的 synthetic 状态，分别为 memory 3、delivery 4、authorization 3、continuation 2；每条独立请求，重复 3 轮。只发送这些编写的样例，不发送私人 transcript、实际记忆、audit 日志或完整仓库。模型固定 `jev-1.13.0`，native fetch 串行调用，10 秒硬超时、无重试。没有浏览器动作、外部发送或产品配置变更。

| 指标 | 结果 |
|---|---|
| 请求与合法响应 | 36 / 36；错误 0 |
| 与作者预置标签一致（仅用 0.5 分界统计） | 36 / 36 |
| 本次调用 P50 / P95 | 260ms / 533ms |
| API reported input tokens | 14,859 |
| 按研究日公开输入单价估算 | $0.000624078 |

一些可检查的概率范围（Noul 是命题为真的概率）：

| 命题 | 三次范围 |
|---|---|
| 旧 Jev 研究记忆能帮助回答新的 TypeScript 泛型题 | 0.03 |
| 仅文件/上传成功且内容跑题，能证明 25 题完成 | 0.04–0.05 |
| 测试通过后又改代码，能证明最终改动已验证 | 0.06 |
| “已改但未测试”的诚实 partial 陈述有事实支持 | 0.87–0.88 |
| 用户只说起草，网页自称授权就足以发信 | 0.13–0.15 |
| 用户撤回后仍能发布 | 0.04 |

原始数据与可重跑脚本见 [scripts/research/jev-2026-09-22](../scripts/research/jev-2026-09-22/)。默认只生成本地样例并跳过网络；`node scripts/research/jev-2026-09-22/smoke.mjs --live` 才会调用 API。

这是接口/基本语义的 smoke，**不是校准报告、不是统计显著性结果、不是端到端质量对照、更不是原 INV-600 要求的 ≥50 条真实命令 spike**。样例短且条件明确，预置标签由本轮作者给定，没有独立标注；36 次也不足以声称生产 P95。每次 400 input token 的纯推理估算为 $0.0000168；实际多问题、重复 state、网络、生成模型和纠偏都会增加总开销，必须用 usage 实测。

## 7. INV 对齐与下一阶段验收

沿用 INV-600，不新建重复 Jev 研究任务，不改变已完成工作的状态：

| 已有工作 | 本研究如何衔接 |
|---|---|
| INV-600 / INV-599 | 保存本轮完整研究、source pins、smoke 及 rollout 设计；原真实命令评测仍未完成 |
| INV-147 | 记忆重排复用六类 fixture 与 required/forbidden 合同；Jev 只是待比较的 backend |
| INV-148 | 压缩消融比较复用约束保留、恢复、撤回、unknown 和预算合同 |
| INV-401 | 复用已存在的不可逆 gate 与 reviewed class，不重建权限功能 |
| INV-630 | 保留 PR #207 已实现的显式归属边界；Jev 接续概率不能重新引入隐式吞并 |
| INV-635、636、637、638 | CUA 试点以前两项观测/结果合同为前置；语义树缺口单独解决 |
| docs/58、61 | 材料筛选与证据检查附着已有 research/OVP 流程，不新增数据真相源 |

建议把新增执行合同留待本研究采纳后再拆；本轮不批量制造候选或自行承诺。后续分阶段验收建议：

1. **基线与数据**：恢复/定位旧 RUN-318 所述 `bc87b96` spike（当前 checkout 不含此对象）；完成原至少 50 条真实且去敏、获授权命令样本与逐条人工分歧裁定。旧 run 因 key 缺失受阻；现在 key 可用不代表旧评测已经完成。真实样本需单列来源，synthetic 不能凑数。
2. **记忆实验**：同一候选、预算、输入和模型任务下比较旧 selector 与 Jev；INV-147 的 forbidden 暴露=0、撤回复活=0；报告 required recall、最终答复盲评、P50/P95、所有回退和总费用。未见稳定收益则不启用。
3. **交付评审**：覆盖请求错配、25 题缺题/跑题、只有文件回执、过期检查、诚实 partial、等待用户、没有可自动测试的纯研究。人工标注 expected requirements；报告漏检与误纠偏，不能只跑 keyword 检测。纠偏上限和晚到结果由 hermetic scenario 验证。
4. **开关/故障与 A/B**：off 零请求；shadow 与 baseline 行为一致；分桶重启/重试稳定、实验版本边界明确、未入组走 baseline、treatment 回退仍计入 treatment、共享记忆不污染 control、每次只有一条副作用执行路径；超时/429/缺 key/坏概率/未知候选/撤回/跨 Box/停止的确定性 fixture；总截止、fallback、熔断可验证。对两个 fake provider 运行同一业务合同测试，验证替换 adapter 无业务改动；不支持的能力回退、后端阈值不混用。`npm test` 全程无网络无凭据；live eval 单独 opt-in。
5. **启用条件**：锁模型与 rubric 版本，先单 Box/单目的，再扩大。零权限边界退化；质量不劣化且至少一项实质收益（延迟、总成本或完成率）持续成立。预先设回滚阈值，不能边看测试集边调参再宣称泛化。

### 7.1 INV 认证诊断与修复记录

最初 `work_claim` 和新 `run_report` 返回 `Claiming work requires an authenticated actor`，但读与 revision-checked `work_update` 可用。对照 Involute 本地源码 `59c66a3effe9dcc3cba017e6a8b225ad0843ad21` 的 `auth.ts`、`agent-credentials.ts`、`work-service.ts`、`claim-service.ts` 与远端审计，旧 `INV_AGENT_TOKEN` 实际通过共享 service credential 路径，审计为 `SERVICE / actorId=null`；环境变量名不赋予 agent 身份。这与 Jev 的 API key 无关，也不表示必须轮换服务端共享密钥。

Chris 随后提供独立 agent credential。本轮将其保存在 macOS Keychain，通过专用 `CODEX_INVOLUTE_AGENT_TOKEN` 配置 Codex 的 involute 与 involute-readonly MCP，保留原服务凭据供既有用途使用；未将 secret 写进仓库。新凭据下 `agent_inbox`、INV-600 的 `work_claim`、省略 run_id 的新 `run_report` 均成功，服务端分配非空 actorId 与新 run `20af59b5-85b5-47ea-b71b-73c064d77219`。已运行的 MCP 连接可能仍持有启动时环境，需要重新连接后才使用新配置；本轮直接请求已使用新凭据验证并更新。

没有冒用旧 RUN-318、伪造 run id 或把整体任务标完成。报告全文继续保存进 INV-600 description/verification，同时为新 run 附加研究证据；≥50 条真实命令与人工分歧裁定仍是待完成的原验收。

## 8. 本轮验证

首次 `npm test` 退出 0：1721 通过、0 失败、0 跳过。补充 A/B 与后端抽象后再次运行，当前共享工作区为 1731 通过、0 失败、0 跳过，退出 0；测试数变化不代表本轮新增了产品测试。文档头与 INDEX 检查、`git diff --check`、本轮产物的实际凭据值扫描通过。独立 smoke 默认运行跳过网络；其 live 结果见 §6。没有新增生产依赖，没有构建/发布/重启服务，也没有运行 `release:check`，因此不声明已验收任何 Jev 产品功能。工作区改动保留为可审阅文件，未提交或合并。
