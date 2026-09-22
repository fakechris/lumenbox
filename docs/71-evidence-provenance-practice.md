<!-- doc: 71-evidence-provenance-practice
     title: 证据与溯源的业界实践（2025–2026）：我们领先在哪、缺在哪
     family: decision
     status: current
     updated: 2026-09-22
-->
# 71. 证据与溯源的业界实践（2025–2026）：我们领先在哪、缺在哪

INV-631 三个卡口合并之后做的一轮外部调研，回答两个问题：这类问题业界有没有成熟解法，
我们的做法和词汇跟外面对不对得上。

**一句话结论**：这个领域已经**命名**了压缩那一半（compaction、condensation、context
offloading），也**发货**了身份那一半（Web Bot Auth、Entra Agent ID），但**保全**那一半
——一份耐久的、可验证的、能按区间定位的「agent 当时到底看到了什么」的记录——**没有标准、
没有格式**，而且在本该有话说的那份规范里，写的是一个字面量 `TODO`。

## 0. 我们的位置

按这轮调研的基线，INV-632/633/634 交付的三样东西里有两样**领先于所有被调查的厂商**。

**完整度信号。** `[read: clipped — 40,000 of 61,606 chars, 57 prose blocks, 576 links]` 作为
结果第一行（`src/host/read-outcome.ts`），是一个可被机器读的截断信号。对照：

| 系统 | 一个被截断的工具结果，消费者能看出来吗 |
|---|---|
| OpenTelemetry GenAI semconv | 没有任何截断、大小或完整度属性 |
| Traceloop | `json_str[:limit]`，代码注释写着「截断可能产生非法 JSON，这是预期的」。无省略号、无标记 |
| Langfuse | 记 metrics，存下来的观测原样不动，注释写明「不携带被丢弃的值」 |
| LangSmith | 硬性 413 拒绝；`inputs_preview` 不带任何「这是预览」的标志 |
| Braintrust | 整批溢出到 `/logs3/overflow`，保真但无标记 |
| MLflow | **唯一像样的**：`mlflow.trace.sizeStats`，超限时 `record_exception` |

OTel 规范里「上传内容到外部存储」那一节的结尾原文是：
`TODO: document a common approach to record references to externally stored content.`
这就是这件事的业界水平。

**账本性质声明。** `record | queue | state | feed`（`src/host/jsonl.ts`，守卫在
`architecture-guard.test.ts`）是一个保留期**类别**声明。ISO 15489 那条线有这套词汇而在运维
遥测里零存在感；OpenTelemetry 与 OCSF 那条线有遥测而零保留期词汇。两边从未见面（实测：
`opentelemetry-specification` 搜 `retention` 只有 1 处且无关，`semantic-conventions` 与
`oteps` 各 0 处）。

最接近的事实标准是 Kafka 的 `cleanup.policy`：`delete` 是队列（`retention.ms` 被规范自己
描述成「消费者必须多快读完的 SLA」），`compact` 是状态，而**「这是一份记录」的表达方式是
把策略列表留空**——用一个值的缺席来表示。这说明这件事被认真设计过多少。

真正编码了「类别」的词汇只有四套，四套都不可用：MoReq2010 的 `DisposalAction`（规范 XSD 已
从网上烂掉，`xs:include` 404）、NARA 的机读 GRS（只管美国联邦）、OASIS CMIS 1.1 §2.1.16
（最强候选，有棘轮规则「仓库必须阻止客户端缩短保留期」，TC 休眠十年）、Azure Monitor 的
`properties.plan`（单厂商）。

**所以想声明「这是记录不是队列」，只能自己定义。** 值得偷的先例是 MoReq 的枚举、CMIS 的
棘轮规则、NARA 的 `Creation_Age | Event_Age` 触发区分。

## 1. 压缩与记录分离

### 已有的名字，别再造第三个

| 名字 | 谁的 | 指什么 |
|---|---|---|
| **Condensation + View** | OpenHands | 最接近真东西：日志保留，视图投影 |
| **Context editing** | Anthropic API | 把分离做成了原语，客户端持有记录 |
| **Restorable compression** | Manus | 这条规则该遵守的**不变量**，也是最好的名字 |
| **Context offloading** | LangChain | 把观测移出去，留一个引用 |
| **Recall memory** | MemGPT / Letta | agent 可查询的已驱逐历史 |
| **Event sourcing / CQRS** | 借来的通用模式 | 正确的一般形式 |

写文档时用 **event log + projected view**（有代码）或 **restorable compression**（规则说得更
准）。不要造第三个。

**OpenHands 是唯一把它写成有代码的具名模式**：压缩不删事件，而是**追加一个 `Condensation`
事件**，带 `forgotten_event_ids`、`summary`、`summary_offset`，`View.from_events()` 再过滤并
插入（docs.openhands.dev/sdk/arch/condenser，arXiv 2511.03690）。

**Manus 的那条规则是这个领域里说得最好的一句**：「我们的压缩策略始终被设计成可恢复的……
只要 URL 被保留，网页内容就可以从上下文里丢掉。」（manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus）

**两个 Anthropic API 要分清，常被混为一谈**：`context editing`（`clear_tool_uses_20250919`）
是分离本身，「你的客户端保有完整未改的对话历史，编辑在服务端应用」；而**按需压缩**
（`compact-2026-09-04`）**按契约就是破坏性的**：「摘要块取代它所概括的消息……被概括消息里的
图片、文档、`container_upload` 块与抓取的 URL，在摘要块替换之后就没了。」反复压缩会对上一
份摘要再做摘要，**没有任何东西给这个复合误差设界**。

### 经验依据

Chroma 的 context rot 报告（18 个模型）：性能随输入长度退化，「即使单个干扰项也会降低表现」，
而且模型在**打乱的**干草堆上比在**逻辑有序的**上面表现更好。trychroma.com/research/context-rot

### 这个领域没有答案的地方

**子 agent 的记录会丢。** Anthropic、Cognition、LangChain 都主张子 agent 上下文隔离
（「每个子 agent 以全新的、隔离的上下文窗口开始」），而**没有任何官方文档说明子 agent 自己
的轨迹被耐久保留并可从父级定位**。父级拿到 1 到 2k token 和一个信任假设。这是这三家已发表
设计里最尖锐的未记录缺口，我们这边的跨 box 交接值得专门查一次。

另：网上流传的「Claude Code 五层压缩级联」是**第三方逆向出来的民间知识**，不是 Anthropic 文档。

## 2. 引文绑定

### 三档，卖的时候都叫「citation」

| 档 | 证明了什么 | 谁 |
|---|---|---|
| 1. URL + chunk，模型自述 | **什么都没证明**，`[1]` 只是模型挑的一个 token | Perplexity、Exa、Brave、Tavily、OpenAI `file_search`、LlamaIndex、LangChain、所有法律厂商 |
| 2. 区间指向**生成的答案** + chunk 指针 | 哪一句**主张**有争议；来源侧仍是整块 | Cohere、Bedrock、Google `groundingSupports`、Glean |
| 3. 区间指向**原文**，由服务端从原文字节抽取 | 那句引文**确实存在于那个偏移**，因为模型根本没打过它 | **Anthropic Citations API**，以及抽取式阅读器 |

**陷阱**：第 2 档里所有的 `start`/`end` 索引的是**模型的答案**，不是文档。当成后者会做出错
的界面。

Anthropic 的保证原文是：「因为 API 解析引用……并直接抽取 `cited_text`，引用被保证包含指向
所提供文档的有效指针。」**要读准：保证的是抽取保真，不是归因正确。** 结构上的证据是
`cited_text` **不计入输出 token**，你伪造不了一段自己从未生成的引文。

对照：**OpenAI 的 `file_citation` 没有原文偏移也没有引文**；**Google 的 `startIndex`/
`endIndex` 是 UTF-8 字节偏移**且 `confidenceScores` 在 Gemini 2.5+ **按文档就是空数组**，
拿它做阈值等于对空数组做阈值；**Cohere v2 的 API 文档说 `start` 是「原始来源文本中的索引」，
这是错的**，每个例子都索引回复。

### 判「这句有没有被支撑」的天花板

**77% 平衡准确率。就这样。** LLM-AggreFact 榜单（2026-09-22 取）：

| 模型 | 分数 |
|---|---|
| Bespoke-MiniCheck-7B | 77.4 |
| Claude-3.5 Sonnet | 77.2 |
| GPT-4o | 75.9 |
| FactCG-DeBERTa-L（0.4B） | 75.6 |
| Llama-3.1-405B | 74.4 |

从 0.4B 到 405B 全挤在 71.8 到 77.4 之间，**规模解决不了**。专家领域（ExpertQA）所有模型
58 到 61，接近抛硬币。榜单本身看起来已经停更（无 2026 条目），引用时说「公开榜单最高项」，
不要说「2026 SOTA」。

区间级更差：LettuceDetect 在 RAGTruth 上 span-F1 0.589，2026 后继者 0.689，但在**代码 agent
的回答上只有 0.172**，零样本 LLM 裁判 0.22。

### 负面结果，这部分多数报告都不写

- **让模型标引用不产生证据。** ALCE：LLaMA-13B 引用召回率 **10.6%**（arXiv 2305.14627）。
- **检索越多引用越差。** 一项 2026 深度研究（14 个模型）：链接有效性 >94%，内容相关性 >80%，
  但**事实核查准确率 39 到 77%，随工具调用从 2 次涨到 150 次下降约 42%**（arXiv 2605.06635）。
- **链接有效 ≠ 引用有效。** 已被接收论文里的 100 条幻觉引用中，66% 是完全捏造，**29% 是
  「标识符劫持」**：链接能打开，指向的是不相关的论文。朴素的链接检查按设计就被绕过。
- **没有判别器能识别「部分支撑」。** ALCE 明说这一条，跨 TRUE、AlignScore、MiniCheck 与
  LLM 裁判都没解决。
- **用合成扰动验证过的检测器等于什么都没验证。** 「语义幻觉」一文：嵌入类方法在合成幻觉上
  95% 覆盖、**0% 误报**，在真实幻觉上**100% 误报**（arXiv 2512.15068）。
- **正确 ≠ 忠实。** arXiv 2412.18004 把这个失败命名为 **post-rationalization**。

### 没人建的那件事

**把模型写出的引文字符串比回原文、比不中就拒绝——没有任何在维护的开源库做了这件事。**
LlamaIndex 的 `CitationQueryEngine` 给 chunk 编号然后相信 `[N]`；LangChain core 没有字符串
校验；ALCE 用 NLI 从不做字符串匹配。代码搜索约 330 个 rapidfuzz+quote+verbatim 仓库，只有
0 到 13 star 的玩具。

与此同时斯坦福 RegLab 量了那些当作「已验证」卖的产品：**Lexis+ AI 17% 幻觉，Westlaw AI-AR
33%**（J. Empirical Legal Studies 22:216 (2025)，arXiv 2405.20362），其中「幻觉」包含**引错源**
——「引用的来源并不支撑该主张……哪怕回答在事实上是正确的」。

闸门本体大约 40 行，`rapidfuzz.fuzz.partial_ratio_alignment` 返回
`ScoreAlignment(score, src_start, src_end, …)`，低于 `score_cutoff` 返回 `None`，拒绝路径库里
就有。工程上必须记住一条：**模型稳定地会吐出差几个 token 的「近逐字」引文**，所以要做模糊
重对齐兜底。

这条对应 **INV-660**。

### 另一条不同的原语

**ContextCite**（arXiv 2409.00729，NeurIPS 2024）：消融上下文来源、从掩码拟合到 logit 概率的
LASSO，量的是**反事实依赖**。它的框架——**contributive 对 corroborative** 归因——是关键想法：
一句被模型编出来的主张，对**每一个**来源的归因都接近零，这就是检测信号，也是唯一能抓住
post-rationalization 的方法。2026 的后继者把成本降了下来（ARC-JSD、AT2、MaxShapley）。

## 3. 只追加的记录与防篡改

### 四套从未汇合的词汇

| 传统 | 关键词 | 来源 |
|---|---|---|
| 流式 | **source-of-truth store**、`cleanup.policy` | Kafka |
| 架构 | **system of record**、event store | Fowler、Young、Azure |
| 存储合规 | **WORM**、`COMPLIANCE`/`GOVERNANCE`、legal hold | S3 Object Lock、Azure、GCS |
| 档案管理 | **record**、**disposition**、`DisposalAction` | ISO 15489、MoReq2010、NARA |

Kafka 值得逐字借的两条保证：「消息顺序始终保持。压缩永远不会重排消息，只会移除一些。」
「一条消息的 offset 永不改变。它是日志中某个位置的永久标识。」

Azure 的 event sourcing 页把不变量说得最准：「快照是一种优化，不是事件流的替代。事件流仍然
是真相之源。」

### 防篡改

学术上的规范词汇是 **Crosby & Wallach 2009**，形式化定义了 **tamper-evident history system**：
history tree、commitment、membership proof、incremental proof。树胜过链的一句话论据：「经典
哈希链要证明一个随机事件在 8000 万条日志里，可能需要 800 MB 的 trace；我们的原型返回 3 KB
的证明。」

**2026 的转向是 tiles 与扁平文件。** Trillian 自己的 README：「Trillian 处于维护模式。下一代
透明日志使用 Tiled API，由 Tessera 更好地支持。」动作发生在 **C2SP**，刻意不在 IETF：
`tlog-checkpoint`（用一个签名 note 取代 STH，正文三行强制字段：**origin、tree size、root
hash**）、`tlog-witness`（**witness** 与 **cosignature**，防分叉视图）。

**IETF SCITT 2026 年发布，给出了标准轨里最干净的词汇**：**RFC 9943**（Proposed Standard，
2026-06）——Signed Statement、**Receipt**、Transparent Statement、Transparency Service、
Append-only Log、Registration Policy、**non-equivocation**；配套 **RFC 9942** COSE Receipts。
（怀疑注记：参考实现已归档，10 star，最后推送 2024-11。）

### 两条常被说错的 EU AI Act

第 12 条要求「在系统生命周期内自动记录事件（日志）」。**不存在第 12 条第 4 款，而且「篡改」
这个词在第 12 条乃至整部 AI Act 里根本没有出现。** 没有完整性、签名或哈希链的要求；它强制的
是一种**能力**，不是一件可验证的产物。保留期在第 19(1) 与第 26(6) 条，至少六个月，且都带
「在这些日志处于其控制之下的范围内」的限定。

**而且日期变了。** Regulation (EU) 2026/1744（Digital Omnibus on AI，2026-07-08 通过）替换了
第 113(c) 条：第三章第 1 到 3 节现在自 **2027-12-02** 起适用（附件三高风险）与 **2028-08-02**
（附件一）。**截至今天，第 12/19/26(6) 条的日志义务尚未进入适用。** 任何在卖「Article 12
合规，2026 年 8 月截止」的，卖的是一个已经不存在的截止日。

顺带一条干净的否定：NIST AI RMF 里搜「agentic」与「AI agent」**零命中**。「NIST AI RMF 要求
审计轨迹」是误引。

### W3C PROV 在 agent 领域：几乎没人用

arXiv 全文搜 `all:"wasGeneratedBy"` → **零结果**。OTel GenAI semconv 仓库里 `prov:`、`PROV-O`、
`wasGeneratedBy`、`audit`、`tamper`、`merkle` 各 **0 次**。活着的地方是科学工作流社区
（PROV-AGENT，ORNL + Argonne，IEEE eScience 2025）。Argonne 2026-08 的论文把 2026 年的分工说
得很老实：「执行细节可以留在 OpenTelemetry。最终的打包可以导出到 PROV-O 或 RO-Crate 标准。」

### 已死或会误导的，标出来

AWS QLDB（产品页 301 到 Aurora）· `google/keytransparency`（2024-10 归档）· Trillian（维护
模式，Map 已移除）· RFC 9162 CT v2（Experimental，未部署）· MoReq2010 的 XSD（404）·
Crosby 的 Merkle aggregation（从未被采纳）· 审计日志上区块链（被当初卖它的厂商自己杀掉）·
OCSF 的 `disposition`（指安全控制的处置结果，假朋友）。

## 4. 网页取证

**标题结论：2026 年不存在 agent 级的抓取取证格式。没人做「给 agent 用的 WARC」。**

**WARC / ISO 28500 是既有方案而且已冻结。** ISO 28500:2017（WARC 1.1）是现行版，**不存在
WARC 1.2**，GitHub 仓库只有一个里程碑、15/15 自 2017-12 起已关闭。同时扩展在未批准的情况下
先行发货（`WARC-Protocol` 自 2018 开着，`WARC-Json-Metadata` **自 2015 开着**）。

两个字段常被混淆：`WARC-Block-Digest` 覆盖整条记录（头 + 体），`Date:` 头一变它就变；
**`WARC-Payload-Digest` 只覆盖载荷，这才是去重键**。而且规范原文说**「不推荐任何特定算法」**
——想靠 WARC 拿到一个规范哈希，没有。

`revisit` 记录的两个规范 profile 在认识论上完全不同，绝不能混：
`identical-payload-digest`（**我核对过字节相同**）对 `server-not-modified`（**服务器说 304，
我根本没见过字节**）。

**WACZ 比 WARC 干净。** `datapackage.json` 列出每个文件的 `hash` 与 `bytes`，并且不像 WARC，
**它固定了算法：`sha256:...`**；`datapackage-digest.json` 再对清单做哈希。两级链
（文件 → 清单 → 清单摘要）给出**一个 32 字节值覆盖整次抓取**。现行版是 **1.1.1**。

### 这个领域最诚实的一句话

WACZ 签名规范（specs.webrecorder.net/wacz-auth/0.1.0/，working draft）原文：

> 「本提案不从提供内容的 web 服务器的视角做出任何保证，因为这在 HTTP/S 下目前不可能。」
> 「这套方法需要信任客户端，以及可能的、为网页存档签名的受信第三方『观察者』。」

原因：**TLS 给的是传输中的机密性与完整性，不是不可否认性**——会话密钥是对称的，所以整份
记录你自己就能伪造。**任何「抓取证明」的说法，要么正面承认这一点，要么在撒谎。** 一次签名的
抓取是一份**证人陈述**，不是一张**收据**。

### 厂商实际返回的「证明」

**没有一家返回内容哈希。没有一家返回签名。多数把发布日期和抓取日期混为一谈。**

| 厂商 | 时间戳 | 哈希 | 原始字节 | 稳定快照 |
|---|---|---|---|---|
| Firecrawl | 仅 `previousScrapeAt` | 无 | 有 | 无 |
| Jina Reader | `publishedTime`，**实测是缓存写入时刻** | 无 | 经 header | 无 |
| Exa | `publishedDate` = HTML 猜测 | 无 | 无 | 无 |
| Perplexity Sonar | 发布日期 | 无 | 片段 | 无 |
| Zyte | 无 | 无 | **base64 原始 body** | 无 |
| Apify | `startedAt`/`finishedAt` | 无 | 看 actor | **有，dataset 文档写明只追加** |

**Anthropic 的 `web_fetch` 返回 `retrieved_at`，一个真正的抓取时刻，比任何抓取厂商给得多。**
但文档同时说结果会被缓存，**且没说明 `retrieved_at` 是请求时刻还是缓存填充时刻**。而
Citations 给的 `char_location` 偏移指向的是**一份你从未拿到字节的文档**。这就是整个缺口的
缩影。

### 缺的是一个 schema，不是一个科研项目

| | 证明什么 | 状态 |
|---|---|---|
| **请求方证明** | 谁在问 | IETF `webbotauth`，已立组（2025-10-23），尚无文档被采纳 |
| **抓取证明** | 服务了什么 | **什么都没有。无规范、无工作组、无产品** |

拼图都已是已发布标准，只是从没被组合过：

1. 签**请求**：RFC 9421 + Web Bot Auth
2. 钉字节：**RFC 9530 `Content-Digest` / `Repr-Digest`**。**`Repr-Digest` 用于去重**（gzip 与
   br 不该改变身份），**`Content-Digest` 用于「我收到了什么」的证明**。多数人想要前者、实现
   了后者
3. 包成 **in-toto Statement**：`subject[].digest` 放那个值，`predicateType` = **一个不存在、
   需要定义的 WebFetch predicate URI**
4. 注册到 **SCITT**（RFC 9943）→ **COSE Receipt**（RFC 9942），可离线验证的包含证明
5. 字节存成 **WACZ 1.1.1**
6. 发 **Robust Links** 属性，让内容漂移可被发现

**第 1、2、4、5、6 步今天都是已发布标准。第 3 步是一个缺失的 `predicateType` URI。** 缺口就
这么大。

### 内容漂移，带数字

Klein 等 2014（PLOS ONE）：STM 论文中**五分之一**存在引用腐坏，在引用网络资源的论文中是
**十分之七**，并把失败拆成 **link rot**（404）与 **content drift**（能打开，说的已经不是那
回事）。Pew 2024：2013 到 2023 年的页面 **25%** 已消失，2013 年的 **38%**，**54%** 的维基
条目至少有一条死引用。

**对 agent 系统来说该担心的是漂移：一条还能打开但已经改了内容的引用，比 404 更糟，因为没有
任何东西会告警。** 修法是三个 HTML 属性（Robust Links 的 `data-originalurl`、
`data-versiondate`、`data-versionurl`），而基本上没有 agent 系统在发。

（一个很妙的自证：Hiberlink 项目自己的域名已经腐坏，现在服务的是一个虚拟数据室的营销页。）

### 不要用

- **IPFS CID 当内容证明。** 超过一个 block 的 CID 是 **DAG 根**的哈希，分块参数是实现选择
  ——Kubo、Helia 与 Singularity 历史上对同一个文件产生过**三个不同的 CID**。RFC 9530 严格更好。
- **C2PA 用于网页抓取。** 结构上不兼容：绑定资产格式，硬绑定被抓取破坏，**没有注册的网页
  抓取动作**，而且到 2026 年中只有两个合规 CA、零个合规相机或桌面应用。
- **zkTLS 作为近期答案。** TLSNotary 自己的 README 在十三年后仍写着「不应用于生产」。

### 一条绝不该被压扁的区分

> 请求的 URL ≠ 到达的端点 ≠ 观察到的 HTTP 响应 ≠ 抓到的确切字节 ≠ 解码后的表示 ≠ 浏览器
> DOM ≠ 渲染的像素 ≠ 回放保真 ≠ 发布者已认证 ≠ 来源属实

一份签名的 WACZ 覆盖第 4 到 8 环。Web Bot Auth 覆盖 1 到 2。**没有任何东西覆盖「来源属实」，
也没有任何格式应该假装覆盖它。** 永远不要把一次抓取压成一个布尔 `verified: true`。

### 值得偷的做法

- **warcprox**：把抓取做成 MITM 代理，任何 HTTP 客户端不改代码就获得抓取能力
- **Browsertrix QA 模式**：唯一实装的「我的存档回放起来和live站一样吗」，而且正确地把**回放
  保真**当作与**抓取正确性**分开的度量
- **CDXJ 的 `filename`+`offset`+`length`**：指向只追加大文件的字节区间指针，在 10 GB 存档里
  O(1) 随机访问单次抓取
- **Save Page Now 的 `if_not_archived_within=<timedelta>`**：服务端按新鲜度去重的原语

## 5. agent 运行的可观测性

### 两个多数文章会漏的事实

1. **规范换仓库了。** `opentelemetry.io/docs/specs/semconv/gen-ai/` 现在是重定向桩，实际位置
   是 `semantic-conventions-genai`（2026-05-05 建）。核心 semconv v1.44.0 里**每一个
   `gen_ai.*` 属性都被标为 Deprecated / Moved**。
2. **没有任何东西是 stable，也没有任何东西可发布。** 每份文档都写 `Status: Development`，
   **零 GitHub release、零 tag**，CHANGELOG 只有 Towncrier 头加 **47 条未发布片段（8 条破坏性）**，
   README 的 Schema URL 一节写的是 **`TODO`**。今天没法 pin 一个 GenAI semconv 版本。

**`gen_ai.system` 已经不存在**，现在是 `gen_ai.provider.name`。

### `execute_tool` span 的实际字段

span 名 `execute_tool {gen_ai.tool.name}`，kind `INTERNAL`，**整个 span 只是 Recommended**。

| 属性 | 级别 |
|---|---|
| `gen_ai.operation.name` | **Required** |
| `gen_ai.tool.name` | **Required** |
| `error.type` | 有条件 Required |
| `gen_ai.tool.call.id`、`gen_ai.tool.description` | Recommended |
| `gen_ai.tool.call.arguments`、`gen_ai.tool.call.result` | **Opt-In** |

`gen_ai.tool.call.result` 的规范 JSON schema 是**空的**：`{"additionalProperties": true,
"type": "object"}`。而且它只在「执行成功时」有定义——一次失败调用的输出**无处可放**。

**这个 span 上关于截断、大小、完整度的属性：一个都没有。**

### 最接近证据指针的七样东西

1. **MCP `ResourceLink`**：`{uri, name, title, mimeType, size, annotations}`。**现存最丰富的
   证据指针**，唯一携带 `size`（文档明说是「用于估算上下文窗口占用」）。但它活在协议载荷里，
   不在遥测里
2. **A2A `Artifact`** + `append`/`last_chunk`：**任何协议里唯一显式的分块完整度标志**；但 A2A
   完全没有可观测性 schema
3. **Weave `weave:///…:{digest}`**：内容寻址、可解引用、**可子寻址**，超过 8 KiB 自动外置
4. **MLflow `mlflow-attachment://<uuid>?size=N`**：**引用自带字节数**，调查过的唯一一个自描述
   指针
5. **OTel PR #490 `gen_ai.*_ref`**（开着）：**不覆盖 `gen_ai.tool.call.result`**，也没有任何
   issue 或 PR 在提
6. **OpenInference `retrieval.documents.<i>`**：最好的检索证据模型，携带实际被引文本；仅限检索
7. **OTel `gen_ai.retrieval.documents`**：只有 `{id, score}`，两者都可空，**没有定义解析机制**

通用 blob 引用这件事**卡了两年**：issue #1428（2024-09 提，仍开着）是整个 OTel 语料里唯一写下
「截断副本 + 指向完整物的指针」的地方；配套 PR #1521 **未合并关闭**，collector 的 Blob Upload
Processor **已关闭**从未发货。**大载荷没有 OTEP。**

### 两个值得抄的已合并设计

- **`gen_ai.conversation.compacted`**：规范里唯一的「你看到的现实是有损的」标志，脚注是对的
  设计：「只在能可靠判定时设为 `true`；**不应**设为 `false`；否则留空。」**三值胜过两值**，
  对不是你写的遥测尤其如此
- **OpenInference 的标注规则**：已结束的 span 不可变，所以事后反馈**必须**用一个新的载体 span
  加恰好一个 OTel Span Link，**不得**使用父子关系

### 一个机会

`semantic-conventions-genai` **没有 `gen_ai.tool.call.result_ref`，也没有任何 issue 或 PR 在提**，
而 issue #45 自 2025-09 开着，规范就在这个位置写着 `TODO`。一份带字段词汇的可用实现，对那场
讨论的价值高于再来一份提案。我们的 `read-outcome.ts` 正好是这个形状。

## 6. 学术上给这整个问题的框架

2026-06 的一篇综述定义了写设计文档时该用的词汇：**execution provenance** 是「一次 agent 执行
的带类型图」，**evidence tracing** 是「它在证据支撑关系上的投影」。它的核心论点正是我们在做的
那条：**一份按时间排的日志能显示 agent 检索了某文档、调了某工具、产出了某答案，但显示不出那
份文档是否真的支撑了那个答案。**

- **From Agent Traces to Trust**（arXiv 2606.04990）。溯源关系：Support、Derive、Depend-on、
  **Contradict**、**Invalidate**、Trigger、Update；粒度：run / step / tool-call / parameter /
  **claim** / token-span
- **LedgerMind**（arXiv 2607.28374）把轨迹当作**受溯源约束的状态机**。账本条目带来源工具、
  认识类型、归一化事实、置信度、**生命周期状态 ω ∈ {Active, Stale, Conflicted, Dropped}**。
  **下游主张只能引用 active 条目。** 它的**命题 1（溯源非放大）**是我们想要的那个不变量的形式
  表述。值得采用的忠实度指标：`UCR_reason`、`GDR`、**`WDG`（看起来有据的错误答案）**

## 7. 排好序的缺口，与对应的做法

| # | 缺口 | 对应做法 | 工单 |
|---|---|---|---|
| 1 | ~~摘要写在文件里，文件 90 天后被删，摘要跟着死~~ **已交付** | 写入时把摘要放进日志条目本身；加校验通道 | **INV-659** ✅ |
| 2 | 没有任何东西把一句主张连到一段字节 | 逐字引文核对闸门（约 40 行，没人建过）；**不要**先上蕴含判断 | **INV-660** |
| 3 | 被裁掉的东西 agent 拿不回来 | 宿主中介、只读、留痕的按 id 回读 | **INV-661** |
| 4 | 摘要不指回它替换的区间；证据指针上限 10 条 | OpenHands 的 `forgotten_event_ids` + `summary_offset` | **INV-662** |
| 5 | 两个第三方都死时谎称 `unavailable` | 退回普通抓取，报 `clipped` 并说明缺什么 | **INV-663** |
| 6 | 抓的是抽取文本不是响应；没有状态码、无重定向链、不可回放 | WARC 请求/响应对 + `WARC-Payload-Digest`；或 WACZ 1.1.1 | 未开 |
| 7 | 同一页抓十次写十份 | `revisit` + `identical-payload-digest` | 未开 |
| 8 | 无防篡改、无校验巡检 | 先做校验巡检；再考虑哈希链 + `tlog-checkpoint` 形状的检查点 | 部分在 INV-659 |
| 9 | 不发 trace，而标识符都已经有了 | 映射到 `execute_tool` span；顺便把我们有而规范没有的两个属性提上去 | 未开 |

### 7.1 INV-659 交付记录（2026-09-23）

指针现在自述目标：`[full page kept: <path> — 61,606 chars, sha256 <64 hex>, kept <ISO>]`，
两个留存库同一形状、同一个正则读回，路径仍是 marker 之后第一个 token，行内仍无 `]`——因为已经
有三个消费者依赖这两条。`verifyKept()` 重读留存文件并拿 frontmatter 的摘要比对正文，
`verifyPointer()` 对单条指针给出 `verified` / `mismatched` / `missing` 三态；审计导出在出口
跑前者，manifest 记 `evidence`，人读的报告在有不匹配时先说坏消息。

两个留存库声明 `KEPT_KIND = "feed"`，这是诚实的标注而不是理想的：它们会 prune，而 `record`
不允许。之所以还站得住，正是因为摘要留在了记录里，过期的产物从「在这儿」退化成「它曾是这样」
而不是退化成空。

**没做的一条，和为什么**：按「它支撑的那件工作何时结束」计的保留期（NARA 的 `Event_Age`，
对应本文 §0 提到的类别词汇）。证据几乎总是要这一种，而我们没有从产物回指「引用了它的那件
工作」的链接。**那条链接才是前提，不是保留规则。** 先建链接，再谈规则。

## 8. 该带走的那一句

每一层都有一个所有人都建、没有人运营的东西：**witness（见证方）**。

一份没有外部承诺持有者的只追加日志，防的是粗心的运营者，不是有动机的运营者——运营者可以对
两方出示两份不同的检查点。`tlog-witness`、SCITT 的 non-equivocation 条款、以及 WACZ 签名规范
承认自己「需要信任客户端」，都是因为这件事。

agent 版的推论来自 Notarized Agents（arXiv 2606.04193）：**「产生活动日志的实体，与活动被记录
的实体，是同一个实体。」** 哈希解决不了这个，只有第二方持有承诺才能。

上面九条都值得做。但文档里要说准每一条挣到了哪个论断，因为这个领域最常见的失败，是一个
`verified: true` 的布尔值压在一串从未被分开的论断上面。
