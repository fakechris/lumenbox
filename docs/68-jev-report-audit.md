<!-- doc: 68-jev-report-audit
     title: Jev 研究报告复核：证据边界与只读引用审查合同
     family: decision
     status: current
     updated: 2026-09-22
-->
# Jev 研究报告复核：证据边界与只读引用审查合同

INV-600 第五轮，承接 docs/66–67。此次把已经写出的真实研究报告作为审查对象，复算实验数据，核对十条源码主张，并收敛下一步实现合同。没有修改产品代码、角色模板、生产配置或开启 A/B；没有新增模型调用。以下接口、实验与验收均为建议，不能视为已实现或已承诺的工作。

## 1. 结论与复核范围

**第一接入点仍建议选 Researchy / 每日研究综合 / 知识问答的只读引用审查。** 它最容易产生用户能复核的结果：报告中哪句话、引用哪份原文、原文是否支持、哪里缺证据。Jev router 适合提供这个工作台、维护评测和解释失败；实际判断走 host 管理的服务，不为每条引用再启动一次角色会话。

这次没有发现需要改写 docs/67 数值表的错误，但有三处边界必须带入实现：

1. 24/24 与 22/24 是作者标签一致率。两个模型都没有把那 16 条无支持主张误放为支持，不能据此说 Jev 的放行更安全。
2. 片段里找不到引文只能记为 `quote_not_located`；不能据此认定整个来源伪造。旧实验植入案例及其 `fabricated` 标签保持原样，不追改历史成绩。
3. “本机没找到同名运行 profile”缺少当时检查范围、时间和脱敏结果的持久快照。旧报告已经明确不推断远端；本轮也不把这句话提升为部署审计结论。模板文件可见、货架可发现、已安装、已实际调用是四种不同证据。

复核产物位于 `scripts/research/jev-2026-09-22/report-audit/`。这是原研究 agent 的有目的抽查，**不是独立评审、全报告覆盖率或模型准确率评测**。不能把十条选中的源码主张称为“真实报告 100% 正确”。数字用代码复算；语义与范围由本次源码阅读记录。

## 2. 数字从原始记录重建

`verify.mjs` 校验上一轮 validation 记录的 11 份产物 hash；调用原研究 runner 离线重建全部引用、资料筛选和线索结果，再独立汇总 API 行、模型名、用量和延迟。主实验与后验诊断保持分开，价格沿用当时记录的假设，不宣称重新查询现价或得到实扣账单。

| 对象 | 复核结果 | 能支持的结论 |
|---|---|---|
| 固定 Awesome Jev 目录 | 905 项、11 类，类别分布一致 | 目录元数据覆盖；不是 905 个项目完整代码审计 |
| 主实验 Jev | 42 调用、0 接口错误；P50 299 / P95 619 ms；40,291 input | 本机本轮调用表现；不是报告端到端耗时 |
| 主实验 DeepSeek | 42 调用、0 接口错误；P50 493 / P95 927 ms；27,399 input | 相同 common 问题下的对照；tokenizer、封装不同 |
| 成本估算 | Jev $0.001692222；DeepSeek 峰 $0.0093489 / 谷 $0.00467445 | 基于原用量和原价格假设的估算 |
| 后验诊断 | 每家 3 调用、0 接口错误；单独重放一致 | 输入补充能改变判断；不是新独立测试集 |
| 模型记录 | Jev 返回 `jev-1.13.0`；DeepSeek 返回 `deepseek-flash` | 后者仍是 alias，不能补造不可变权重版本 |

因此“值得试点”的依据是具备可验证的小任务、候选成本和延迟；还没有真实人审节省时间、生产召回率或安全收益的证据。

## 3. 十条实际报告主张逐条追到来源

`claims.json` 保存原报告 hash、原句与行号、固定源码 commit、文件 hash、所读片段及位置、证据类型和范围说明。以下均只声称所读版本、文件或作者记录提供对应证据，不推广为整套系统的运行保证。

| ID / docs/66 原主张 | 复核依据 | 对 LumenBox 的具体启发 |
|---|---|---|
| c01 Notra flag 缺省启用 | `isFlagEnabled()` 对 unset 返回 true | 借服务边界，使用我们自己的 default off 配置 |
| c02 Notra 标题生成与分类并行 | `classifyAgentFeedback()` 的 `Promise.all` | 不把小判断调用替换误算为整个生成调用消失 |
| c03 宏保存语义目标 | `describe()` 保存 role/name/context | TeachDrafts 保存可解释目标；执行时重新绑定观测 |
| c04 宏弱匹配/并列退出 | `resolve()` 有低分与近似并列的异常分支 | 歧义时退回，不把最高候选必然当可执行目标 |
| c05 Jarvis copy/fill | Overlay 回复卡按钮复制或调用 `onFill`，展开输入供检查发送 | 外部聊天辅助以草稿/填入为边界；不是整应用“绝无发送能力”的证明 |
| c06 jselect 来源位置 | `render_item()` 带 source、line、record ID、chars | 每条建议都可返回原句，来源位置不等于来源支持 |
| c07 Hermes disabled 过滤 | `discover()` 在加入候选时排除 skip 集合 | 机械过滤在排序之前；还需证明调用者传入了实际配置 |
| c08 caller 条件失败不接受 done | `runner.ts` 在提供 `options.until` 时保留未验证并退出/继续 | CUA 完成合同来自调用者；不能只问模型“做完了吗” |
| c09 JevTest 成功断言 | `checkOutcome()` 声明 passed 需要至少一个成功断言 | 探索由模型建议，验收由 oracle 给出 |
| c10 两种策略检出全部植入 bug | 作者 validation 表格及其局限说明 | 是作者报告，未独立重跑；不证明 Jev 更擅长发现未知 bug |

来源使用 [Notra](https://github.com/usenotra/notra)、[宏实现](https://github.com/jiawei686/jev-ultrafast-mcp)、[Jarvis](https://github.com/jev-chat/jev-chat-jarvis)、[jselect](https://github.com/keltokhy/jselect)、[Hermes skills](https://github.com/kerpopule/hermes-jev-skills)、[grounded browser](https://github.com/tontoko/jev-browser)、[JevTest](https://github.com/CorieW/JevTest)；可复核的固定版本链接逐项保存在 claims.json。没有执行上游 GUI，也未复制其运行实现。

这里最有价值的共同点是：**证据定位、候选过滤、状态版本、完成检查由代码承担，语义判断提供局部建议。** 官方 [citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check) 也先定位再判支持关系；其示例阈值与示例成绩不作为本项目验收标准。[Confidence 定义](https://docs.typesafe.ai/confidence) 不能转换成自动发信、执行或验收权限。

## 4. 第一条产品路径及抽象草案

具体入口：现有 research/digest 或问答流程生成草稿并给出原始来源；在原有任务里附一个“引用待复核列表”。每条显示原文结论、证据位置、缺失条件和判断来源。第一次只增加审查建议，不自行修改正文或改变交付状态。保持既有原始资料与主模型上下文可回查。

建议输入合同：

| 输入 | 用途 |
|---|---|
| task/report ID、report revision、claim ID/span | 防止草稿改过后把旧判断贴到新句子 |
| source ID、内容 hash、获取时间、源版本、提取范围、完整性 | 区分过期、截断、缺失和相同 URL 的不同内容 |
| 引文原句、位置；是否为直接引文 | 代码定位文字；转述没有逐字引文也可进行支持性审查 |
| claim 与必要上下文、source excerpt | 模型判断所需证据；不要夹带 expected 或原评审标签 |
| purpose/rubric/schema/policy 版本、预算、取消信号 | 可回放、可切 provider、可限制等待与成本 |

`DecisionService.checkCitation(input)` 是业务用途；`DecisionProvider` 只负责受限问题与响应。版本化的规范枚举与结果校验归 host，Jev 原生 Choice 和其他模型的结构化 JSON 各自映射。外部网络或解析失败不伪装为 `insufficient`，离散模型也不补造 confidence=1。

至少保留三个正交维度，避免又把不同问题塞进一个单选：

| 维度 | 示例状态 | 决定者 |
|---|---|---|
| 证据获取与定位 | available / unavailable；complete / excerpt / unknown；located / not_located / not_applicable | 获取与解析代码；known complete 只针对具体来源版本 |
| 语义关系 | supports / contradicts / insufficient；abstain / unavailable | provider 判断及接口校验；不足证据不强选 supports |
| 处理结果 | suggestion / needs_review / stale / cancelled | host 根据当前 revision、策略与运行状态组合 |

部分支持采用 `insufficient` 并保留待拆分的 claim；后续若需要字段级定位，再版本化增加小问题，不能悄悄改变旧 rubric。数值、单位、时间换算先用确定性检查；来源说了什么和它本身是否可靠分别记录。代码片段支持实现意图，也不能证明线上路径真的执行。

调用链仍为现有 workflow → host 判断服务 → provider → 现有交付/建议面。provider 不拥有 registry、MemoryStore、权限、INV 状态或执行器；角色也不能再持有第二套凭证/阈值/路由实现。host 持有凭证，缓存与记录遵守既有租户/box 可见性；跨租户不能仅凭内容 hash 共享缓存。

## 5. A/B 与功能开关如何做到可回退

建议按 purpose 配置，而不是一个 `JEV_ENABLED` 控制所有场景。`citation_check` 的开关和实验不自动影响记忆、线索、agent 路由或 CUA。配置进入既有配置体系，禁止在各模板私设 env 或 marker file。

| 阶段 | 用户可见行为 | 必须留下的证据 |
|---|---|---|
| off，默认 | 完整保持既有交付路径；不发 provider 请求 | 请求计数为零；缺 key 不改变旧功能 |
| shadow | 可预算抽样调用，结果仅进入受限评测记录 | 原答案未变；覆盖 eligible、分桶、尝试、完成、超时和回退 |
| A/B 只读建议 | A 使用现有流程；B 加 Jev 审查列表；C 加另一个 provider 的同类列表 | 展示规则一致；完整报告稳定分桶；实际用户收益与失败均入统计 |
| 停用/回退 | 后续任务回到既有流程，当前待返回结果不能生效 | configuration epoch、取消标记、迟到结果丢弃原因 |

A/B 的单位应是完整 report/task，同一报告的多次重试和修订保持同组，不能每条引用或每次调用随机。离线配对供应商可读相同输入；线上对照不能让同一报告先看 B 的意见再把 A 的人审结果叫盲评。如果修改预算、rubric 或展示方式，开启新 experiment version。

第一轮主指标建议是**每份报告人工复核时间与无支持结论的遗漏**，另记不必要警报、可用证据覆盖、API/端到端 P95、成本、超时和回退。分母保留全部入组报告，不能只保留成功调用。报告/来源内的多句高度相关，统计按报告聚合，不能把 24 个相关句子当作 24 份独立报告。

影子阶段中“现有流程没有 checker 输出”不是模型分类 baseline；应该比较真实流程是否漏掉问题，以及检查列表对复核时间的影响。旧 quote-only baseline 仍仅作诊断。阈值先在校准集选择，最终保留集按报告/来源切分并独立标注；需要人工裁决标签争议。现有 24 条自拟主张不足以选自动放行阈值。

建议的实现验收情节：off 不发请求；缺 key/超时/无效枚举回退；provider 替换不改变业务调用方；取消与报告改写后旧结果失效；重复引文位置有歧义；截断/缺来源不判伪造；B/C 相同输入与相同展示规则；关闭实验期间迟到结果不进入正文或任务状态。正常功能验收保持 hermetic，真实 API 和人审测量单列。此处不新增自动放行阶段。

## 6. 与其他结合点及 INV 的关系

| 工作 | 归属与次序 |
|---|---|
| Researchy / digest / Docs Q&A 引用审查 | 本研究建议的首个只读业务入口；具体实现仍需匹配已有合同、由人承诺 |
| 资料与技能筛选 | 接入同一基础设施的独立 purpose；先 promote-only，未选候选仍可见 |
| 新 Jev router 角色 | 判断工作台与评测维护入口；未来调用同一服务，以真实 receipt 显示供应商与模型 |
| 线索/会议/通知 | 独立字段与 rubric；拒绝联系状态不能被 fit 或 intent 总分冲掉，执行仍走既有授权 |
| CUA | INV-636/637 的观测与动作证据在前；INV-638/639 的语义执行与 GUI oracle 随后；INV-640 后端选择不等于 Jev 接入 |
| OVP | 查询到 INV-643 已 COMMITTED：Rust 的 DecisionClient、Jev 适配、cassette；属于 `fakechris/obsidian_vault_pipeline`，不在 TS host 复制 OVP 抓取/vault 流程 |
| Involute | 查询到 INV-647 已 COMMITTED：语义建议适配与可回退 A/B；属于 `fakechris/Involute`，不授予模型状态机或验收权限 |

可跨项目共享的是数据合同概念、错误类别、版本与评测案例约定，不强求 Rust/TS 共用一个运行包，也不把 INV-643/647 当成 LumenBox 已经有的适配器。任务状态以服务器 `commitment` 为准；INV-647 的 constraints 文案仍残留候选描述，本轮只记录差异，不修改其他项目任务。

INV-600 原验收中的 **≥50 条真实脱敏命令、与现有 gate 的对照及人工裁决**仍未完成。本次引用复核不能替代该验收；研究报告与回放证据附回同一任务，不新建重复研究项、不标 Done。

## 7. 验证与交付范围

离线复核命令：`node scripts/research/jev-2026-09-22/report-audit/verify.mjs`。详细结果在 `verification.json`，它不会联网、读取凭证或写产品状态；`--record` 只用于首次记录并拒绝覆盖。

本轮新增报告、审查清单和离线验证脚本，重建 docs/INDEX；docs/66、docs/67 与旧冻结数据均未改写。完整测试结果和本轮产物 hash 记录在同目录 `validation.json`。没有提交或合并，也没有改动其他 agent 的 CUA、上下文恢复或角色模板文件。
