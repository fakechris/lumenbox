<!-- doc: 67-jev-business-pilot
     title: Jev 业务判断实测：引用检查、资料筛选与线索边界
     family: decision
     status: current
     updated: 2026-09-22
-->
# Jev 业务判断实测：引用检查、资料筛选与线索边界

INV-600 第四轮，承接 docs/66。用户同意继续后，在隔离研究脚本中做真实 API 对照；未修改产品代码、角色、运行配置，也未启用线上功能或 A/B。

## 1. 这轮改变了什么判断

**优先做引用审查的只读 pilot；资料筛选只做推荐/提升排序，暂不据此永久排除来源；线索先做好信息缺失和独立的拒绝联系状态。**

Jev 的调用延迟和价格有优势，但本次并不是数量级的速度差。补充源码证据后，有的漏项修复，有的仍未修复，还出现新误选。不能把高 confidence 当成“可以放心过滤”。

两种模型在一条线索上共同给出 unknown，暴露了我们自己标签证据不足的问题。原始标签及结果未改；争议单列。模型输出一致也不是自动真值，下面的诊断只帮助定位下一轮应补什么。

## 2. 方法与数据边界

产物在 `scripts/research/jev-2026-09-22/business/`。

- **引用**：8 份固定 SHA 的公开项目源码/作者记录，人工编写 24 项主张，覆盖支持、矛盾、证据不足；另加 2 个刻意伪造引文和 1 个缺失来源。不是 27 份独立文档，也不是生产日报。
- **资料筛选**：从 docs/66 固定目录取 16 个真实项目简介；6 个中英查询，共 96 个候选判断，12 个作者标注的直接相关项目。检验简介层筛选，不等于论文/长文检索质量。
- **线索**：12 个虚构案例，各判断公司匹配与当前采购意图，共 24 个字段。没有真实 CRM、联系人或销售活动。
- 冻结 fixtures SHA `f8a2a7e17ab04716cb824533235e26982483a7e06954924820022ad0d5654a01`，再调用 API。请求仅含 state/questions，不含 expected、标签理由或 gold IDs。
- A 是确定性诊断基线：引文存在即支持、词汇匹配、简单线索关键词。它不是现有生产语义选择器，尤其 quote-only 只是证明“字面匹配不够”的低基线。
- B 是原生 `jev-1.13.0`；C 是 DeepSeek `deepseek-flash`，关闭 thinking、temperature 0、JSON mode，返回离散类别，不让其自报假概率。官方当前将该名称对应 V4.1 Flash，但本次响应 model 字段只返回 alias，无法宣称获取了不可变权重版本。
- B/C 消费相同 common state、questions、criteria；协议封装、tokenizer 与系统提示不同。每个 provider 42 次调用、144 个问题；合计 **84 次调用，0 接口或结构错误**。一次运行，交错 provider 顺序，并发 2、无重试、每请求 20 秒限时。
- 后续仅追加 3 个输入诊断包 × 2 provider = **6 次调用**，不混入原冻结成绩。总计 90 次调用。

## 3. 原冻结集结果

| 指标 | 确定性诊断基线 | Jev | DeepSeek Flash |
|---|---:|---:|---:|
| 引用语义标签一致 / 24 | 8 | 24 | 22 |
| 不支持的主张被误判为支持 / 16 | 16 | 0 | 0 |
| 加上 3 项代码预检后的标签一致 / 27 | 11 | 27 | 25 |
| 资料筛选命中 required / 12 | 9 | 10 | 11 |
| 资料实际选入项数 | 10 | 10 | 12 |
| 线索字段与冻结标签一致 / 24 | 18 | 23 | 23 |
| API 请求数 | 0 | 42 | 42 |
| API P50 / P95 | 不适用 | 299 / 619 ms | 493 / 927 ms |

**引用审查的结论需要看下游动作。** DeepSeek 的两处不同是 c02（环境开关缺省行为：contradicts vs insufficient）与 c09（移动支付安全性：insufficient vs contradicts）。两者都没有把无支持主张放行。因此不能用 24/24 对 22/24 宣称 Jev 的“安全性更高”；如果产品将两类都送审，它们在本轮放行边界表现相同。

Jev 主实验 40,291 input tokens，按官方每百万 $0.042 估算 **$0.001692**；响应另记录 5,702 output tokens，官方输出免费，不隐藏这项会计字段。DeepSeek 为 27,399 input、941 output、无输入 cache hit；按官方峰/谷价估算 **$0.004674–$0.009349**。这不是账单实扣，不能跨 tokenizer 直接比较输入 token 数。

Jev P50 约快 1.65 倍，P95 约快 1.50 倍；是这台机器、这批小请求、一次交错运行的调用延迟。未测报告生成、网页获取、任务端到端耗时和人审时间，不采纳社区演示的十倍速度作为我们的收益。

来源：[TypeSafe 模型/计费](https://docs.typesafe.ai/models)、[DeepSeek 模型/峰谷计费](https://api-docs.deepseek.com/quick_start/pricing/)、[JSON mode](https://api-docs.deepseek.com/guides/json_mode/)。

## 4. 资料筛选：缺证据与模型漏判都存在

原实验 Jev 漏了两项：

- r03 的 `wy-coliney/jev-browser-use`：目录简介写了 Codex 验证，但未详细说明独立的完成合同；Jev 给 not_relevant，confidence **0.98**，relevant 概率 **0.01**。DeepSeek 同样漏选。作者 required 标签使用了前轮源码阅读背景，严格而言与“只能读简介”的输入范围存在张力。
- r05 的 `y0usaf/pi-jev`：简介中的 tool-call gate 没有被 Jev 纳入工具审查，relevant 概率 **0.38**；DeepSeek 纳入，但也误选了 compaction 项目。

诊断保持原问题和 provider 设置，只给 d09 加上 `DONE → needs_verification` 源码行，给 d14 加上 README 明确描述的执行前 bash/write/edit gate，并单独重跑 r03/r05。两个候选的补充在同一个候选池里一起出现，这不是严格单变量随机实验。

| 诊断 | Jev | DeepSeek |
|---|---|---|
| r03，3 个 required | 仍为 2/3，未恢复 d09 | 3/3 |
| r05，2 个 required | 2/2，但新误选 d09 | 2/2，仍误选 compaction |

结论不是继续调低一个阈值就能解决：**补充来源能改变结果，但也可能改变其他候选的选择。** 这批请求不足以区分所有变化与采样波动；还需要多任务、原始全文及固定 rubric 的独立验证。

对 LumenBox：

1. 首轮采用 promote-only：把明确相关材料前移，未选来源保留原列表/附录，不静默删除。
2. 需要声明严格属性时，从简介升级到关键源码或文档，再作判断。缺证据与不相关要在产品记录中区分。
3. 扩充评测时按来源/任务切分，包含反证、转载、跨语言表达和冷门重要来源。原实验只有 6 个任务，不能依靠百分比的小差距选供应商。
4. 研究筛选与引用验证是两个用途，不共享一个“相关性高就可信”的判断。

## 5. 线索：标签争议比 23/24 更值得关注

l07 原文是“我是企业软件公司的工程师，转发别人想约演示的帖子；我本人没有表达采购意向”。作者预设 fit=yes、intent=unknown。两种模型都输出 fit=unknown、intent=unknown。

**unknown 有合理依据**：目标要求“当前销售自有软件给其他企业”，原句没有充分证明商业模式、产品所有权和销售对象。“企业软件公司”是线索，不是所有必需事实。不能直接把这一行当作确定的模型错误。

补充“我们公司当前开发并销售自有企业软件给其他公司”之后，两种模型都给 yes/unknown。保留原始 23/24 冻结标签一致率，不追改成满分，也不把这个后验诊断当成新 held-out 数据。

另一个设计缺口是 l04：它同时表示“仅做研究”与“请勿营销联系”，原分类只允许 intent 单选。两种模型选 research 符合冻结标签，但单个 intent 字段不能完整携带 opt-out。

未来应拆为：

- company fit：yes / no / unknown；
- commercial intent：采购评估、信息研究、未知等；
- do-not-contact：独立状态，不能被其他分数抵消；
- source/provenance：发言主体、原句、时序，第三方转述和过期采购意向不能覆盖当前状态。

现有研究脚本只输出 draft_demo_or_quote、draft_clarifying_question、no_outreach、retain_for_review，**所有行 side_effect_executed=false**；不调用 CRM、消息或发送工具。未来客户匹配分数也不能授予联系权限。

## 6. 引用 pilot 的实现合同应如何收敛

本轮最有希望的是 `checkCitation`，但只作为只读审查建议，不以这批小样本直接开启自动放行。

输入至少包括 claim、source ID、内容 hash、提取范围、源是否完整、引用片段与位置。代码先校验来源可用性与引文定位，模型再判断 supports / contradicts / insufficient；所有未支持状态都保留证据并进入复核，不自行改写原文结论。

当前 pilot 中两个刻意伪造引文的预检标签叫 `fabricated`，实际检查仅在**提供的 source excerpt** 内匹配。作为已知植入案例成立，但不能迁移成“片段找不到就证明整个原文伪造”：生产接口应返回 `quote_not_located`，完整原文也查不到且来源可信时才有更强结论。source missing 与 source does-not-support 也必须分开。

下一轮独立验收应加入：正确引文被截掉上下文、部分支持、否定/条件作用域、数字单位、旧版本证据、引用位置重复、来源不可访问，以及已经公开的真实研究报告。避免只用三个明显类别的整齐正反例。

## 7. 可替换 provider 与 A/B 状态

这轮研究 runner 用相同问题合同跑通 Jev 与普通模型，分别严格校验 question IDs、枚举、概率分布和完成状态；普通模型不被补造 confidence=1。说明候选/问题/本地消费与 provider 分开在研究层可行，不宣称生产 DecisionService 已实现。

默认运行不联网，`--live` 才调用，记录文件以 exclusive create 防覆盖；`--replay` 验证冻结输入 hash、枚举及最终结果。诊断使用单独文件夹、单独冻结，原观测不覆盖。这里实现的是研究运行控制，不是产品完整 off/shadow/enforce、kill epoch 或线上分桶。

后续产品仍按 docs/66：全局和逐用途开关默认 off；shadow 不能影响行为；按任务/会话稳定分桶；持久记忆实验隔离；比较原始分配全体（含 unavailable/fallback）；更换 provider/rubric 后重新评估。

## 8. 交付与尚未证明的内容

本轮交付：冻结样本、共享研究 runner、90 条真实调用观测、离线 replay、结果摘要、3 个独立存档的输入诊断，以及对标签和分类合同的复审。未安装额外依赖、未改变 Jev router 或运行时。

仍未证明：真实业务报告质量、人审时间、CRM 精度、生产端到端收益、线上 A/B 或本域概率校准。原 INV-600 的至少 50 条真实脱敏 shell 命令与人工分歧裁定也仍未完成，这批业务样本不顶替该验收。

建议下一项具体工作是从现有 Researchy/X Brief 的真实输出中取得经授权的最小评测批，按来源分组冻结人工标签，先只读输出引用审查建议；资料筛选保留未选原文，线索继续先完善合同。没有真实样本前不把本次 pilot 提升为 enforce 依据。

验证记录见 `business/validation.json`。核心命令：

```sh
node scripts/research/jev-2026-09-22/business/evaluate.mjs --self-check
node scripts/research/jev-2026-09-22/business/evaluate.mjs --replay
node scripts/research/jev-2026-09-22/business/evaluate.mjs --diagnostic --replay
npm test
```

官方方法参考：[citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check)、[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe)。各公共源码的固定 URL、文件 hash、截取起始行在 `business/fixtures.json`；目录来源沿用 docs/66 的固定快照。
