<!-- doc: 64-jev-memory-evaluation
     title: Jev 第二轮研究：记忆实测、召回边界与可替换判断接口
     family: decision
     status: current
     updated: 2026-09-22
-->
# 64. Jev 第二轮研究：记忆实测、召回边界与可替换判断接口

延续 [docs/63](63-jev-integration-research.md) 与 INV-600。本轮只做研究脚本、隔离 API 评测和设计补充，不修改产品代码、依赖或运行时配置。本文补充实证，不替代 docs/63 的场景排序、默认 off、A/B 与 provider-neutral 约束。研究代码基线为 `cc71f8223138a010b70c2e211cf739fa3a7ac57c`。

## 1. 结论：记忆选择值得继续，但不能直接许诺消除污染

项目已有 24 条 memory fixture，其中 20 条适合比较 selector，另 4 条是 registry 的跨 Box 边界测试。将前 20 条接到真实 Jev API 后，**每轮必需事实从确定性 scored recall 的 16/21 提升至 21/21**；Noul、Score 各跑三轮，最终召回一致。加上 6 条新压力样例后，每轮整体从 18/27 提升至 26/27；未找到的那条根本没有进入候选池，按答案选择的 oracle 也只能到 26/27。

这支持“优先实验记忆选择”，但不是上线结论：比较对象是现有确定性回退，**没有运行当前线上生成模型 selector，不能声称 Jev 优于现用 LLM**；样本为开发 fixture 与人工压力样例，不是独立留出集，不是生产任务成功率。三轮重复不是三倍独立样本量。

更关键的发现是现有接口的职责：`chooseRelevant` 做的是**候选提升**。它既不删除模型不推荐的记录，也不把排序原样传给下游。未来接入前，必须明确产品要改善的是“有用事实进入预算”，还是“无关内容不进入上下文”；后者需要单独的投影合同及验证，不能默认为替换 API 即可获得。

## 2. 实验如何保证可比较

研究脚本：[memory-eval.mjs](../scripts/research/jev-2026-09-22/memory-eval.mjs)。它导入现有 `memory-fixtures.ts` 与真实 `chooseRelevant/recall`，保持原候选生成、去重、撤回、预算和最终渲染。模型只收到 query 与已生成的候选，不收到 fixture 的 required/forbidden、oracle 选择或正确答案。

四条比较路径：

| 路径 | 做什么 | 能证明什么 |
|---|---|---|
| scored recall | 不调用模型，使用现有确定性回退 | 可复现的低成本基线，不等于线上 LLM selector |
| oracle | 只从实际候选中挑 fixture.required | 当前候选生成与预算允许达到的上界 |
| Jev Noul | 每候选独立判断“是否直接有用”，一批发送；以 0.5 为本次描述性分界 | 二元相关性是否足够完成这些选择 |
| Jev Score | 每候选四级相关性，一批发送；以 ≥2 为本次描述性分界 | 分级判断在相同消费逻辑下有无增益 |

每种 Jev 路径最多提升 8 条。模型、rubric、阈值在调用前确定，未根据结果重调；这些阈值仍未校准。两种路径在重复轮次交换先后顺序，调用串行、10 秒硬超时、无重试，模型固定 `jev-1.13.0`。只在现有代码确实发生候选选择时调用 API：26 条里 18 条触发，8 条未超预算，直接返回原 recall。

为了评估真实消费语义，研究脚本从现有 selector prompt 提取候选，把 typed 判断转换为既有选中 ID 格式交回 `chooseRelevant`。**这只是测试适配层，不是建议上线的接口**。产品仍应按 docs/63 引入 typed seam，包含稳定候选 ID、日期/来源、证据版本；不让业务长期依赖解析 prompt 文本。研究桥接保持现有 prompt 能提供的信息，不偷偷增加日期等优势。

原始 API 响应、三轮逐例结果、6 条新样例、脚本及源文件 SHA256 保存在 [memory-results.json](../scripts/research/jev-2026-09-22/memory-results.json)。`--replay` 核对请求哈希并用保存响应重走真实召回，最终结果须逐项相同，不再次访问 API。默认运行无网络；只有显式 `--live` 才调用。

## 3. 结果与实际费用

下表按一轮的不同事实计数；三轮重复的召回结果相同。required 不覆盖所有“可接受但非必需”的事实，因此不将这些数字称为 precision 或整体正确率。

| 集合 | required | scored recall 命中 | oracle 命中 | Noul 命中 | Score 命中 |
|---|---:|---:|---:|---:|---:|
| 原 20 条项目 fixture | 21 | 16 | 21 | 21 | 21 |
| 新 6 条压力样例 | 6 | 2 | 5 | 5 | 5 |
| 合计 | 27 | 18 | 26 | 26 | 26 |

原 fixture 的改善集中在 region、database、中文密码存放位置、发版方式/签字人四例，共补回 5 条事实。其余原 fixture 不退化。新压力样例覆盖旧 Jev 主题与新 TypeScript 请求、研究阶段禁止实施、候选中的诱导指令、没有相关记忆、候选池漏召回、预算压力下的冲突事实。

| API 指标 | Noul | Score | 合计 |
|---|---:|---:|---:|
| 请求数 | 54 | 54 | 108 |
| 合法响应 | 54 | 54 | 108 |
| 问题数 | 483 | 483 | 966 |
| input tokens | 98,559 | 110,634 | 209,193 |
| P50 | 327ms | 327ms | 327ms |
| P95 | 418ms | 539ms | 426ms |

分位数采用 nearest-rank；合并 P95 不是两个分组 P95 的平均。研究日[官方单价](https://docs.typesafe.ai/models)为输入 $0.042/Mtoken、输出免费，本轮估算总费用 **$0.008786106**，未计其他模型、网络或返工成本。本轮 Score 比 Noul 多约 12.3% 输入 token，却没有增加 required 命中，因此下一阶段可优先以 Noul 做最小实验，Score 保留为独立候选 arm；这不证明其他数据上 Noul 更优。

这些批次大多很小，只有候选池漏召回样例达到 60 个候选。没有测并发吞吐、冷启动对照或生产长尾，不把此 P95 当 SLA，也不从“批内并行”推出成本不随问题数增长。官方 [fan-out](https://docs.typesafe.ai/patterns/fan-out)适合减少往返，但问题必须相互独立，state/问题总预算及实际 usage 仍要核算。

## 4. 真正限制收益的三个边界

### 4.1 候选遗漏不是判断模型错误

`stress-candidate-retrieval-miss` 有 101 条记录：100 条近期归档信息与一条较旧的生产发布否决人信息。查询使用不同说法，词法召回没有触及那条旧记录；top-by-score 60 也没有它。两种模型三轮均无法找回，oracle 同样失败。

这只证明一个可复现盲点，不是应立刻购买向量库的证据。后续数据报告必须同时列 `candidate required recall` 与 `selection required recall`。如果真实错误主要在候选池，需要单独比较词法扩展/查询改写/embedding 等召回方案，不能不断调 Jev 阈值解决不存在的候选。

### 4.2 不推荐不等于不曝光

`stress-untrusted-injection` 中，两种模型都只提升真正的数据库事实，没有提升诱导片段；但最终 `renderMemory` **仍包含诱导片段正文**。原因是 `recall` 先放 preferred，再用原排序填剩余预算。未进入正文的内容还可能以短摘录进入 memory index。

`stress-none-relevant` 中，两种模型都返回空提升列表；`chooseRelevant` 按既有合同回 scored recall，最终仍显示两条无关正文及其他记录的索引。这是现有设计，不应把它标作模型误判。

本轮 forbidden 零泄漏仅对应原 fixture 的明确撤回边界；大部分撤回例根本没有触发 API，4 条跨 Box 用例仍由真实 registry 的 hermetic 测试验证。**不能据此宣称模型能防跨租户泄漏、能过滤注入，或已经消除旧主题复播。** 如果另做“仅展示相关记忆”实验，须分别约束正文、索引、手动 Recall 和恢复路径，并区分“有记忆但本轮无相关内容”与“从未保存记忆”的展示语义；保留原记录，不按模型评分删除数据。

### 4.3 现有消费者不保留模型完整排序

`chooseRelevant` 将选择转换为 `Set`。`recall` 在原分数排序上做 preferred/non-preferred 稳定分区，选中记录内部仍按原分数抢预算，最终正文按时间排序。因此 Score 的细粒度排序只影响进入最多 8 条提升名单，不能完整决定正文优先级。

后续候选接口建议显式区分 `promote(ids)` 与 `rank(ids)`：首个实验只替换 promotion selector，保持消费语义，减少混杂；真正按新排名装箱需独立实验版本，不能把“更换模型”与“改变预算装箱”一起上线再把收益归给 Jev。

## 5. 新增上游源码研究：借用合同，不引入另一套框架

继续从 [Awesome Jev](https://awesomejev.com/)定位项目并阅读固定提交。没有运行上游应用或采用其效果宣传。

| 固定来源 | 代码里的具体做法 | 对本项目的取舍 |
|---|---|---|
| [Vercel Eve evaluate](https://github.com/vercel/eve/blob/dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9/packages/eve/src/ai/evaluate.ts) 与 [auto model](https://github.com/vercel/eve/blob/dea2ced59e8c7ed5a41b9a1c432f5fcd080999d9/packages/eve/src/models/auto.ts) | evaluator 可传实例/ID；路由把 evaluator 与备选模型描述做 fingerprint，按 turn 缓存，传递取消信号 | 佐证判断层可以独立于聊天模型。借用版本指纹与 turn 固定选择；其路由只看有限文本窗口，不能替代我们的 vision、上下文容量和用户指定模型约束，也没有在该函数里实现本项目所需的 fallback 合同 |
| [zod-jev judge](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/judge.ts) 与 [semantic](https://github.com/jomatsu/zod-jev/blob/700bd256fe94541a2d21044027cc2dbf5036b396/src/semantic.ts) | 结构验证后做窄语义检查；独立条件批量问；rejected、uncertain、unavailable 分开，取消继续抛出，回调记录 usage/延迟 | 可借给交付逐要求核对；不把远程语义调用混进所有普通 schema parse。默认 0.95 和字符≈token 的估算不迁移，尤其中文不能以固定字符倍数保证 API 预算 |
| [decido core](https://github.com/yairshy/decido/blob/1137a45a24526d8570371d2dd550822e666f5826/src/decido/core.py) 与 [runtime](https://github.com/yairshy/decido/blob/1137a45a24526d8570371d2dd550822e666f5826/src/decido/runtime.py) | 独立 DecisionProvider、capabilities、typed distribution；区分 native / elicited / heuristic_score，校准声明需 evidence；校验返回 ID/选项集合 | 和我们的可替换后端要求一致，可借语义 provenance 与能力检测。它是小型 Python 项目，不引入宿主依赖；将 binary/ordinal 降为 Choice 只保证接口可表达，仍需验证概率与业务阈值是否适用 |

API schema 也复核了：Score 的 probabilities 是以等级字符串为 key 的 map，不是数组。研究 runner 对模型 ID、回答类型、范围和分布做本地校验；HTTP 200 本身不算成功证据。该校验属于研究脚本，没有新增产品 adapter。

## 6. 对 A/B 和交付核对方案的具体修订建议

**记忆实验只动一个变量。** Control 应是固定版本的当前生成模型 selector，另列 scored recall 成本下界；Treatment 是 Jev Noul promotion。Score 放到下一独立 treatment，不把 provider、候选生成、promote/rank 和渲染过滤同时更换。按 conversation 固定分桶；涉及共享 memory 写入时按真实共享边界分组或隔离。global/purpose off、shadow、fallback、kill switch 按 docs/63 执行。

实验曝光日志要在三个边界采集：候选池（eligible IDs、required coverage）、判断结果（选中/弃权/不可用）、最终上下文投影（正文与索引 ID、完整渲染成本）。如果只记录模型选中了谁，会漏掉本轮已复现的“模型没选，但消费者仍展示”。同时记录 assignment、实际 provider 与回退；回退仍计入 treatment，不丢弃失败样本。

**交付核对先有逐要求证据视图。** 确定性代码负责 request/task/recipient 归属、产物 digest、检查是否在最后修改之后、题号是否覆盖；Jev 只问“该段证据是否支持该条要求”。将 `observed / missing / contradicted / insufficient` 的业务结果与概率/模型错误分开。仅有上传回执时只能证明发送，不证明内容回答了问题。25 题分成 25 个独立问题可以批量判断，但每题必须有自己的题意与证据，缺证据不得让模型脑补。无需对已经可以精确判断的计数、日期、ID 额外付费。

暂不新增强制纠偏或拦截：现有 Stop hook 的 evidence 输入和发送时机仍不足以承担完整的交付闸门。之后的离线评测应同时测漏检与误纠偏，包含诚实 partial、纯研究、没有自动化测试的任务；最多一次纠偏只是上限，不是发现低概率就必须返工。

## 7. 原真实命令验收的现状

只读检查本机 `~/.agentbox/policy.jsonl`：494 条事件，其中 17 次 shell 检查、16 条不同命令；13 次 ls、3 次 grep、1 次 curl。这里只代表一个本机 host 日志，未搜索所有 Box。未导出或发送命令正文，只保存了[聚合清点](../scripts/research/jev-2026-09-22/audit-inventory.json)与源文件哈希。没有足够代表性的风险操作与授权/撤回配对上下文，因此不为这些明显偏读的样本付费生成“准确率”。

原 INV-600 的 ≥50 条真实命令及逐条人工分歧裁定仍未完成，也不能用本轮 108 次 API 请求替代。后续采样须记录真实来源、原工具、事件时间范围、脱敏方式与授权上下文是否齐全；不执行被评估的命令。分别比较 `needsReview` 的粗筛、PolicyGate 的确定性 allow/ask/deny 与模型的语义判断：三者问题不同，简单数一致率会把“代码允许但未验证语义授权”误算为模型错误或正确。

## 8. 复现与验收边界

```sh
# 无网络：现有 scored recall 与 oracle 上界；不伪装有模型结果
node --experimental-transform-types scripts/research/jev-2026-09-22/memory-eval.mjs

# 无网络：保存的响应重放，核对请求哈希与逐例最终结果
node --experimental-transform-types scripts/research/jev-2026-09-22/memory-eval.mjs --replay

# 仅显式请求才运行；消耗 API 配额，覆盖 memory-results.json
node --experimental-transform-types scripts/research/jev-2026-09-22/memory-eval.mjs --live
```

本轮 dry、live、replay 均退出 0，live 108 个合法响应、0 错误，重放结果一致。最终仓库门禁结果另见 [round2-validation.json](../scripts/research/jev-2026-09-22/round2-validation.json)。没有运行在线 A/B，没有生产用户结果盲评，没有证明优于现有 LLM，也没有验收 provider 切换产品功能。研究完成不等于 INV-600 整体 Done。
