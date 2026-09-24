<!-- doc: 66-awesome-jev-lumenbox-opportunities
     title: Awesome Jev 全域研究：LumenBox 业务角色、运行时与 CUA 的结合点
     family: decision
     status: current
     updated: 2026-09-22
-->
# Awesome Jev 全域研究：LumenBox 业务角色、运行时与 CUA 的结合点

这是 INV-600 的第三轮研究，补充 docs/63、64；CUA 基础合同沿用 docs/62。用户要求先分析、更新 INV，不实施产品功能；未来必须有独立功能开关、A/B 与可替换供应商。以下是建议和待验证假设，不是已启用能力或已承诺的新任务。

## 1. 结论与研究范围

最值得做的是 **host 管理的、用途明确的判断服务**，同时服务两类工作：

1. 产品工作：研究与知识问答、销售和会议、内容与广告、文件与表格的批量筛选、匹配、评分、证据核对。
2. 运行时工作：记忆候选筛选、交付审查、技能发现、工具语义审查、受限 CUA 步骤和失败分流。

Jev router 可以是人能找到的「判断工作台」和评估负责人，但每次小判断都先委派给一个会话 Agent，会多出排队、上下文组装和主模型回合，抵消收益。角色与服务应共用一个实现，不各写一套。

范围与证据分层：

- 站点 `https://awesomejev.com/` 首次读取显示 899 项、浏览器类 77 项；随后固定其源数据仓库 `hellogumbo/awesome-jev@e2014cdb35d7d699795c8ca28904e8f42568bf45`，数据是 **905 项、11 类、浏览器类 79 项**。这是不同快照，不把两组数字混用。
- 完整公开目录保存为 `scripts/research/jev-2026-09-22/awesome-projects.json`，覆盖所有类别。目录描述用于发现方向，不作为性能或安全证明；重复 SDK、相似包装与无关游戏不逐个运行。
- 对 LumenBox 相关模式分组筛选，代表实现核读关键源文件；来源版本和文件见 `awesome-source-review.json`。没有执行这些上游浏览器、手机或桌面操作，也没有复现其性能排行榜。
- 本地基线 `cc71f8223138a010b70c2e211cf739fa3a7ac57c`；核对 host、boxd、CUA、技能与模板目录，尤其新增 `jev-router.lumenbox-template.json`。本机没有找到同名已运行 agent profile，不据此推断远端 box 的部署情况。
- 延续 TypeSafe skill；当前官方 confidence、模型局限、use-case map 与官方替代后端 adapter 一并核对。接口有效不等于语义正确，官方全域校准也不等于我们的中文、多租户、动态候选任务已校准。

## 2. 全目录覆盖，而非只挑 CUA

| 目录类别 | 数量 | 与 LumenBox 的关系与处理 |
|---|---:|---|
| Official | 19 | SDK、原语、概率语义、模型限制、替代 LLM adapter：接口设计依据 |
| SDKs & clients | 72 | 抽象、重试、取消、typed abstention 可借鉴；无必要引入另一语言栈或多个 SDK |
| Integrations | 35 | 已有应用的渐进替换、网关、工作流、邮件、数据库、事件分类 |
| Agent tooling | 192 | 记忆、压缩、审查、路由、技能、检索、停止验证，是运行时主要参考 |
| Browser & computer use | 79 | 浏览器、桌面、移动、聊天副驾、语音、页面裁剪、GUI 测试 |
| Applications | 105 | 文件、线索、会议、内容、搜索、实体匹配、日志等角色工作 |
| Games & simulations | 66 | 借有限合法动作、状态快照、回放、规划与执行分层；不把游戏成功率外推办公任务 |
| Demos & playgrounds | 83 | 判断工作台、分维度评分、实时交互；演示不作为生产成熟度依据 |
| Benchmarks & research | 177 | 校准、候选覆盖、对抗、替代模型与公平对照；作者结果与本地实测严格分开 |
| Other lists | 27 | 导航及交叉发现，不重复计作独立证据 |
| Articles & threads | 50 | 用来找到原项目；速度倍数、推文片段不直接进入验收标准 |

覆盖是目录与模式层面的全域筛选，并非对 905 个项目做了完整源码审计。尤其同名 OpenJev 项目有训练模型、普通 LLM 包装、mock server 等不同成熟度，不能按名称视为等价替代。

## 3. 业务角色：用户实际能得到什么

以下全部先从只读分析或草稿开始。目录里已有的角色是接入载体，不意味着它们背后已经存在确定性的业务流水线；很多能力目前由模板中的 SKILL.md 描述。

| 现有角色 / 工作 | 具体判断单元 | 参考方向 | 预期价值、边界与验证 |
|---|---|---|---|
| Researchy、Cooper、X Brief、last30days | 来源是否相关；是否同一事件；是否提供新证据；两项主张支持/补充/矛盾；引用是否支持一句话 | jev-social、jselect、jlink、citation-verifier、Hermes search | 少读重复来源、更多有效证据；保留少数反例，不能把相似新闻都丢掉。评来源覆盖、引用准确率、跨日新颖性和人审时间 |
| Company Docs Q&A | 对授权检索候选做 relevance Score；来源是否过期；答案每项主张是否有支持 | jev-recall、jselect、invalidate | 提升证据命中；必须先权限过滤，再送模型。与关键词/embedding baseline 比 Recall@K，不能由模型推断访问权 |
| Lead Pipeline Desk、Outbound Prospecting、Pipeline Pulse | ICP 各维匹配；购买意图；缺少下一步；两条 CRM 记录是否同一主体 | cookbook lead-scoring、jlink、hush | 从批量表格生成带原句的候选名单；字段缺失是 unknown，不能当成不匹配。不得据近似姓名自动合并记录或自动联系 |
| GTM Loop Closer、Call Follow-Ups、Meeting Recap Deck | 这句话是承诺、建议、条件承诺还是已完成报告；指向哪个现有任务/人员；新发言是否改变承诺 | transcript-scorecard、extract-by-picking、invalidate | 把“下周可能再看”与真实承诺区分，给 follow-through 提供候选。日期解析、时区、到期计算由代码；创建/关闭任务仍走既有合同 |
| Sales Call Coach | 逐段评需求探索、异议回应、明确下一步等独立维度；选出支撑原句 | transcript-scorecard、composite scoring | 用户可以调权重重算总分，不必重跑模型；不要用一个总分掩盖严重事实错误。用人工 rubric 一致率与错误引用率验收 |
| AI Search Visibility、SEO & AEO Desk、Site Audit | 回答中是否真正推荐本品牌；是比较、否定还是仅提及；搜索意图、内容缺口、广告与落地页一致性 | notra、pagegrade、jev-cookbook | 批量分析回答/段落；HTTP、性能、a11y 硬指标由工具测。品牌提及不等于推荐，不把模型评分叫成真实流量或排名 |
| Ad Spend Watch、Apple Search Ads Review、Paid Media Report Desk | 搜索词业务相关性、负面词建议、异常备注归因、素材与产品匹配 | notra、文件/标签 cookbooks | CPA、ROAS、预算进度由代码算，Jev 解释文本维度。允许提出建议，不因高概率自动停广告或改预算 |
| Event Request Desk、Office Ops Desk、Event Producer | 来件类型、缺什么信息、与活动目标匹配、需要哪类处理 | hush、support-triage、邮件分类 | 从同一输入并行判断，不每题多一次会话；列表保留未处理/不确定项。日期冲突与日程资源检查由代码 |
| Talent Discovery、Recruiting Coordinator | 是否有明确岗位能力证据；来源链接是否重复；面试信息缺失；沟通意图 | recruiter、resume-match、jlink | 辅助检索与证据整理，不复制目录里自动淘汰候选人的做法；只按明确岗位条件，不生成缺失履历。排期和发信仍由现有工具处理 |
| Writing Bot、Copy Humanizer、X Brief、Webby | 草稿违反哪些已选风格规则；新版本是否保留原意和事实；是否遗漏受众要求 | riff、snifftest、mimicry、vibecheck | 主模型写，判断服务指出具体待复核段落；“AI 味”主观且误报高，不对作者身份作结论。限制修订轮数，发文权不变 |
| Clip Bot、Video Edit Desk、下载专家 | 在有时间戳的转写段落中找完整观点、亮点、广告或重复片段；为候选片段打分 | jev-skip、transcript-scorecard | 可以形成「候选时间段 + 原句 + 原因」；ASR、镜头识别、剪辑、字幕同步由专用工具。Jev 1.13 不是直接看视频的视觉模型 |
| Haggle Bot、Deal Hunting、Credit Card Max、Office Ops | 从文件中选金额/日期/订单号候选；费用描述分类；供应商/商品是否同实体 | extract-by-picking、jlink、file-organizer | 先解析/归一化候选，再选择，保留原文位置；计算税费、汇率、积分、合同有效期仍用确定性数据与规则。缺值就缺值，不能编造 |
| Figma Bro、Critiquito、Game Art Director、Imogen、Stills & Clips | 对视觉模型/OCR 已抽取的文字、结构或候选描述做规则检查、排序 | typesafe-computer-use、clarity-judge | 可做文案与结构校验；不能声称 text-only Jev 直接理解像素、配色、视觉层次。视觉分析保留现有模型 |
| Alfred、Dr Eggbot、模板货架 | 根据用户工作需求推荐现有模板、判断重复职责、提示缺少连接器；对模板做多标签索引 | cookbook Grok Bot catalog case、skillranker、mcpmatch | 非常贴合现有 shelfTemplates。先推荐已有角色再考虑新建；不允许推荐即自动安装、开连接器或扩权 |
| Nightly Audit Engineer、工程专家、Lingxi 工程主管 | 文件/失败日志相关性、diff 语义检查、修复证据与交付核对 | pi-warden、Canny、foreman、JevTest | 缩短定位过程和减少无证据完成；测试与验收仍是权威，Jev 不能把红套件判成通过 |

**最具体的一条研究流水线**：当天输入 80 个链接 → 代码做 URL/内容 hash 去重 → 主模型给出少量候选主题和明确纳入标准 → Jev 判断每个原文片段属于哪些主题、哪些是反证 → 代码检查主题至少有两个独立来源且不把转载当独立证据 → 主模型结合原文写综合 → 判断服务逐条核引用。未归类材料保留在附录。与 docs/58–61 的原始源、主题和桥接方向一致；不再建立第二个抓取器或 vault。

**最具体的一条线索流水线**：CRM 导出 → 代码验证列、金额和 ID → Jev 对每条已有文本分别判断业务匹配/购买意图/缺信息 → 本地按可调整权重排序 → 给出带来源的复核列表。相似实体的匹配概率是单独字段，不与商业价值分数混为一个总分。用户未授权合并/联系前仅产出建议。

## 4. 运行时：有明确接缝的机会

| 判断用途 | LumenBox 接缝 | 适用方式 | 不应交给模型的部分 |
|---|---|---|---|
| 记忆相关性 | `src/host/memory.ts`，docs/64 的 chooseRelevant/recall 路径 | 在已有候选中挑/排，输出证据 ID；后续单独研究候选生成 | box/agent 隔离、撤回、预算、存储和确定性屏蔽 |
| 记忆失效/冲突 | 同一 MemoryStore 生命周期 | 新证据是否推翻旧事实，先生成 review 候选 | 不让网页指令成为用户偏好；不引入 invalidate 的第二个 memory DB |
| 交付审查 | `turn.ts`、`progress.ts`、`deliveries.ts`、`scenario.ts` | 请求是否都覆盖、完成话语是否有证据、是否仍在承诺未来行动 | delivery 收件人、请求 owner、任务状态权限与不可变 receipt |
| 工具语义审查 | `src/host/auto-review.ts` 已有 off/shadow/enforce | 对明确代码规则覆盖不了的意图/影响进行补充审查 | shell 解析、路径/权限、明确禁令；语义 allow 不能覆盖 code deny |
| 卡住/恢复 | 既有 turn/progress/任务与预算状态 | 区分同一失败循环、等待外部输入、缺凭证、需升级 | 最大步数、截止时间、重试幂等、停止/取消及任务权属 |
| 技能与工具推荐 | `skills.ts`、catalog、既有工具能力集合 | 从已安装且可用目录中排序，保留 none 和手动发现 | 不自动安装新 skill；用户显式指定的技能不因低分被隐藏 |
| Agent 分工建议 | `src/agents/` registry/bus、`tasks.ts` | 对注册表提供的合资格候选排序，输出建议 agent ID | 团队成员、box 边界、capability、配额、租约；显式点名优先 |
| 模型/effort 路由 | `turn.ts`、`model-relay.ts` 及现有配置 | 在一个完整任务/子任务边界上建议档位 | 用户选定模型、工具协议、上下文缓存、预算硬限制 |
| 上下文压缩 | `compaction.ts` 与 transcript | 先考虑可恢复的长工具输出片段裁剪，再评 history compaction | 原始日志、调用/返回配对、最近请求、否定约束、证据与悬而未决事项 |
| Webhook/通知分流 | `webhooks.ts`、routines 与 deliveries | 验签、限流后判断业务类别/重要性，低优先级进入可见队列 | 验签、事件 ID 去重、接收确认、投递保证；不静默丢用户请求 |
| 教学经验匹配 | `teach.ts`、`teach-drafts.ts`、`boxd/teach-service.ts` | 当前操作与哪份已确认教学相符；缺哪个参数 | 发布流程、用户确认、版本、权限、secret 引用；不另建宏知识库 |
| 可观测性与质量回顾 | 脱敏 trace、scenario、审查 receipt | 对失败段落分型，形成待复核样本与候选 issue | 不过滤原始审计记录，不根据自动评分自己宣布 INV Done |

记忆实测仍沿用 docs/64 的限制：26 个合成场景中 required facts 27 个，现有 scored fallback 命中 18，Jev 与候选池 oracle 均为 26；这说明有希望，也说明缺候选时再聪明的 scorer 无法修复。并且未选条目仍可能补入 recall 正文，相关性筛选不构成注入防线。不能把重复请求当独立样本，也还没完成与生产 generative selector 的公平比较。

技能发现与模板推荐是常被低估的结合点。现有货架角色多、描述长，用户通常按“我要做什么”找能力。先机械过滤设备/连接器/是否安装，再做语义排序；向用户显示“适合做什么、还缺哪个连接器”，不显示难懂的供应商原语。

## 5. CUA：七种不同的结合方式

### 5.1 主模型规划，Jev 做有界浏览器子任务

参考 `browser-use/jev-ultrafast` 的 operation + target 判断，以及 `wy-coliney/jev-browser-use` 的现有执行器桥接。后者源码在每次执行前重新读 AX state，变化就丢弃旧判断；DONE 返回的是 `needs_verification`；有限步骤、时间、重试和连续无进展出口。

LumenBox 可把“在当前订单页筛选已退款订单并读出结果”交给一个短循环：主模型给子目标、可用操作、终止条件和预算；host 生成候选；Jev 选择；现有 boxd 执行；新观测再判断。文本自由生成、复杂页面歧义和跨业务规划交回主模型。

价值来自减少逐次点击触发大模型回合，不只是单次 API 快。保留原生 snapshot/find/expect；不要为了接 Jev 另开 Playwright 浏览器、另维护登录态。网页若提供结构化 connector，仍优先原 connector。

### 5.2 桌面语义目标选择，视觉/执行分开

`awlevin/typesafe-computer-use` 的关键不是便宜点击，而是 OCR + Accessibility 候选、观测缓存、停滞出口，以及动作后失效缓存/重新截图。其 macOS AX/OCR 链不能直接代替 Linux X11/AT-SPI。

LumenBox 先对 AT-SPI/DOM 已有元素排序；目标不仅是 `a1`，还应绑定 observation、agent/display、owner epoch、角色、名称和上下文。没有可靠树时，视觉模型/OCR 提供候选；Jev 不负责凭空生成坐标。桌面原生语义执行属于 INV-638 的问题，不是换决策器自然获得。

### 5.3 有后置条件的动作与 GUI 测试

`tontoko/jev-browser` 区分 native assertions 与语义断言，来源不足保留 inconclusive；源码在 caller 的确定性完成条件为 false 后不把模型的 done 当通过。其验证记录还有一个很实用的教训：执行引用需要 nonce 防陈旧，但把不停变化的 nonce 放进模型历史会干扰进展识别，应给模型稳定语义标签，执行时另做版本校验。

`CorieW/JevTest` 的 `checkOutcome` 要求至少一个确定性成功断言；探索路线可以由 Jev 选择，pass 必须来自 oracle。作者小规模 planted-bug 验证中，确定性 baseline 也全部通过/检出，因此支持“流程可运行”，不证明 Jev 更会发现未知 bug。

适合 LumenBox 验证模板导入、任务回执、连接器状态、设置落盘等多路径流程。Jev 可以指出要观察什么；“修改已保存”“消息已送达”仍需读回真实状态。npm test 保持 hermetic；在线模型评测单列，不使 CI 随 API 波动。

### 5.4 把教学变成可复用动作片段

`jiawei686/jev-ultrafast-mcp` 的宏保存目标语义描述而非一次性的 ref；`macros.resolve` 对当前元素打分，低于阈值或近似并列就拒绝猜测。这适合现有 TeachDrafts：人示范后形成“字段含义 + 参数 + 前置/后置条件”的草稿，审核后发布。

不能照搬整批宏基于一次 observation 解析的假设。跨导航/模态框/提交后必须重观测；提交超时需只读核对是否成功，不能盲目重放。所谓 zero-model replay 只适用于已验证、状态匹配的片段。

### 5.5 聊天副驾与语音控制

`jev-chat/jev-chat-jarvis` 将屏幕/OCR、意图判断、候选回复和填入分开；OverlayController 明确 copy/fill，发不发由人决定。可以借给用户指定的外部应用协助：识别“在问问题/约时间/需跟进”，形成草稿或 task 候选。已有飞书/钉钉/Telegram 正规入口优先用消息事件，不额外截屏监控同一会话。

`moritzkremb/jev-voice-browser` 有语音修订、debounce、取消过期请求、自由文本需等完成，以及危险动作确认。可借其状态版本思想用于用户中途纠正“打开 A……不，打开 B”。先只读导航/预览，支付、发送等动作不因短暂停顿就执行；中文语音和姓名歧义需单独测。

### 5.6 页面裁剪与社交研究

`kitze/unclutter`、各种 adblock/filter/sift 项目体现“对 DOM 块做分类，再由代码裁剪”；`socai-io/jev-social` 的目录模式是受限浏览操作与带引用研究结果。后者本轮是模式参考，未做完整源码审计。

LumenBox 最合适先做 **给模型看的观测投影**：折叠导航、广告和重复块，保留原始快照与可展开来源。不要直接删除用户页面 DOM；错误判断可能删掉 cookie 对话框、错误提示、支付条款或仅有的操作入口。研究检索同时保留反证和少量未命中样本，防止“越来越只看自己认同的材料”。

### 5.7 移动控制和游戏：借模式，暂不扩平台

`droidrun/mobile-jev` 的 Android 元素层和有限动作循环有参考意义；游戏的合法动作枚举、结构化遥测、回放与确定性得分也适合我们的 scenario 思路。但当前 LumenBox 的 Linux box、外部桌面、原生 host 环境不是 Android fleet。不能把装一个 Jev 角色说成支持手机自动化。

手机与跨平台桌面应先在现有 CUA 工作项下明确设备接入、显示归属、取消、执行与验收合同。不是本次判断服务的必需前置；不为了演示扩大产品边界。

### 5.8 当前代码的真实前置条件

在当前 HEAD 再运行 `node --experimental-transform-types scripts/research-cua-probe.mjs`，复现 docs/62 的五项：树读取失败后旧 ref 仍可用；`a1` 在新快照指向别处；先截图后动作的 batch 仍返回旧图；像素改变被标 confirmed；疑似 noop 仍可是 outcome ok。

这是 **真实 executor 控制流 + fake native I/O** 的隔离复现，没有真的点击桌面，不能当 GUI 验收通过。结果保存 `awesome-cua-probe.json`。

所以：INV-636 观测与时序、INV-637 动作/证据/后置条件优先；INV-638 语义执行、INV-639 GUI oracle 验收随后。INV-640 可选 Cua Driver 后端与 Jev 是正交选择。本轮已核到这些任务均 COMMITTED，不重复提案。

## 6. 代表项目的源码发现：哪些值得借，哪些不能照搬

| 项目 / 阅读文件 | 有价值的实现或记录 | 对 LumenBox 的取舍 |
|---|---|---|
| `usenotra/notra` `packages/ai/src/evaluation/client.ts`、`jobs/feedback-classifier.ts` | typed evaluation 服务独立、取消/超时、失败回退；生成标题与分类并行 | 保留服务边界与故障回退。其 flag 缺省启用不符合我们的 default off；该反馈路径仍同时跑 LLM，不能宣称完整节省了生成调用 |
| `nexibeo/jev-cookbook` `recipes/09.../extract.mjs` | 正则解析并归一化候选，Choice 选原文值，none 表示缺失 | 适合账单/会议/表格；候选覆盖率与语义选择准确率分开测，不复制其示例阈值 |
| 同仓库 `docs/case-study-templatesgrokbot.md` | 模板分类实验；明确旧标签来自别的模型，agreement 不等于 accuracy；需排除“所有 bot 都算 AI 类” | 和我们的模板货架直接对应。标题讲 3,267 目录，报告的分类评测样本为 100，不能说全量人工验证 |
| `keltokhy/jselect` `src/jselect/select.py` | 原文片段附 source/line/offset；按预算重切片；本地 relevance/novelty/token packing | 接现有 recall/研究证据；不另建事实权威，不让未选=已无关 |
| `keltokhy/jlink` `docs/dedupe.md`、`src/jlink/cluster.py` | blocking → pair judgment → 本地 resolution；记录未覆盖与失败；链式错误会把大群体误合并 | 新闻事件、CRM、模板去重先输出建议关系。未问的 pair 不能笼统当确定不同，匹配排序/阈值必须本域验证 |
| `chopratejas/invalidate` `engine.py`、`policy.py` | 区分 bearing、still_true、replaces、hypothetical、partial；dry_run；数值阈值集中在 policy | 很适合“假设/建议不覆盖事实”；只吸收判断与审查机制，事实生命周期仍由 MemoryStore 管 |
| `emreozyoruk/hush` `src/triage.js` | 同一输入批量 label/spam/needs_info/possible_duplicate，各自可 abstain | 适合事件和工作候选分流；仅凭前 40 个 title 的重复判断不足以合并 INV。其 confidence 注释不是 TypeSafe 官方定义，应以官方为准 |
| `kerpopule/hermes-jev-skills` `jevkit/skillpick.py` 与 rollout 文档 | disabled skills 在候选生成前排除；真实运行环境可见性；shadow 曾发现路由会过度升级 | 重视配置是否真正生效与真实部署 receipt。其默认 shadow、marker-file 经验不能直接替代 LumenBox 统一配置 |
| `0xShin0221/openpoke-meets-jev` `evals/contamination/FINDINGS.md` | 作者报告：把 injection 检出接到静默丢邮件，反而成为可利用的压制渠道；改成可见隔离 | 我们的消息、待办、研究输入不能按概率静默消失。43,776 请求不是 43,776 独立真实邮件；原始缓存未随仓库发布，本轮未复现 |
| 官方 `typesafe-ai/system-one-adapter-python` | 相同 typed 问题可对照普通 LLM；记录重试及累计 token，可输出离散或概率答案 | 可做离线公平对照参考，不为 TS host 引入 Python 运行时；生成/归一化概率不能冒充原生概率或已校准置信度 |

上述源码/作者记录都不等于 LumenBox 实测。固定 SHA、关键文件和链接存入来源清单，后续实现前还应审查许可证与依赖；本轮不复制上游运行代码。

## 7. 新增 Jev router 角色：定位可以保留，合同需要补齐

当前文件是未提交的新模板，动态 `shelfTemplates()` 会读到它；这只证明本 checkout 货架可发现，不证明发布制品已包含或某个 box 已安装。

检查到 7 条 memory、3 个 prose skill、1 个暂停的 weekly review、空 connectors；没有可执行的 Jev adapter、供应商绑定、调用预算、请求验证或概率 provenance。空 connectors 本身不证明不能通过其他工具调 API，但目前不能从该模板证实任何真实 Jev 调用。

具体问题：

1. **角色让通用 LLM 自己“derive calibrated confidence”。** 这容易得到语气像概率的自评分。只有实际 provider receipt 才能显示“Jev 判断”；未配置应显示不可用并走既有模型，不伪装调用。
2. **把 85% confidence 写成 85% 实际正确率。** 官方 Choice/Score confidence 是分布集中程度，Noul 没有独立 confidence。即使模型跨任务已校准，也不能把单个任务分数等同工作流成功率。
3. **统一 .85/.60 阈值，高风险 .95 自动 Act。** 排序、路由、删除、付款不是一类后果。权限/用户意图先由 host 决定，概率只影响在合法集合里如何建议/升级；.95 不授予发送或删除权限。
4. **候选 agent 用固定示例名称。** 应从 registry 当前 box/team 的合资格成员提供 ID、能力、可用性与 none，执行前再验可用性；不能用名字推断某个角色已安装。
5. **只用用户 override 调阈值。** 只看被纠正样本有选择偏差。需要随机抽样的正确/错误案例、时间分开的校准与 held-out 集、版本冻结；用户反馈进入候选数据，不立即改生产 rubric。
6. **rationale 来源不清。** Jev 返回 typed 判断，不生成其思维解释；输出可以展示来源原句和代码使用的规则。若主模型撰写解释，明确是解释，不冒充 Jev 原生理由。
7. **周报没有实际 decision ledger 合同，时区还冲突。** memory 写 London，routine 用 `{timezone}`/用户本地。先有脱敏 receipt、采样覆盖、成本/错误统计，再能做 review；保留 paused。

建议将此角色定位为：接受批量判断任务、设计 rubric、查看不确定项、审阅 A/B 和质量报告、提出配置变更。执行热路径由共享服务承担。界面可保留 Jev 名称以便当前用户识别，底层 purpose、数据格式、权限和任务编排不绑定品牌。

## 8. 抽象与开关：替换后端不能只换 baseURL

建议沿用 docs/63–64 的方向：

```text
角色 / host 工作流
  → 已有权限与候选生成
  → DecisionService（按 purpose 的稳定接口）
      → schema/state 版本、脱敏、预算、取消、实验分桶
      → DecisionProvider（Jev / structured LLM / local / deterministic baseline）
      → 校验、provenance、abstain/unavailable
  → 本地策略组合
  → 现有执行器或只读建议
  → 实际结果与证据
```

业务接口示意：`rankEvidence`、`checkDelivery`、`classifyInbound`、`matchRecords`、`selectUiAction`。它们共享基础设施，但输入与验收独立；不把所有任务硬塞一个 `askJev(string)`，也不每个角色各建 SDK。

结果至少区分：`judgment`（包括不匹配选项）、`abstain`（证据或判别力不足）、`unavailable`（服务/能力不可用）。保存候选 ID 与 state revision、schema/rubric/policy/provider/model 版本、原始分布、概率来源、校准版本、成本、延迟、回退原因。只有离散答案的后端不应制造 confidence=1；用 `unknown` 并采用该后端经过验证的策略。

Provider capability 要描述：原语/候选与状态限制、是否支持图像、批量、取消、token/cost 会计、概率究竟是原生预测、logprob 归一化还是 LLM 自报。更换 provider 需要同一数据集重评与新实验版本，不继承 Jev 阈值。

凭证由 host 侧已有秘密管理持有；页面、角色 memory、共享模板和日志不带 key。缓存 key 纳入租户/box、purpose、state hash、候选集、rubric 与模型版本；不得跨用户复用 private 判断。CUA 的执行引用与 owner epoch 另行校验，缓存不是可执行授权。

建议配置形状（设计示意，尚未实现）：

```json
{
  "decisions": {
    "enabled": false,
    "purposes": {
      "memory.relevance": {"mode": "off", "provider": "typesafe", "experiment": null},
      "delivery.review": {"mode": "off", "provider": "typesafe", "experiment": null},
      "research.evidence": {"mode": "off", "provider": "typesafe", "experiment": null},
      "cua.nextAction": {"mode": "off", "provider": "typesafe", "experiment": null}
    }
  }
}
```

这是新增判断服务默认 off；现有 AutoReviewer 默认行为不在本轮改变。`off` 不读凭证不调 API；`shadow` 只在允许的数据边界内判断并记录，不改变路由、记忆、提示词或动作；`enforce` 才消费结果。异步 shadow 有独立限流和并发预算，防止挤占主流程。全局 kill 应在消费结果/执行前检查 epoch，撤销在途请求；不能只阻止新请求。

## 9. 真正的 A/B，而非一个开关

**分配单位按干扰边界选择。** 短 CUA 和模型路由按 task/session，消息工作按 thread，持久 memory 改写按 agent/box 且隔离评估存储；不能一轮 A 下一轮 B 然后共用已改变的记忆。离线成对 replay 使用相同脱敏输入与候选，适合先筛方案，但不是线上收益的替代品。

**至少三个离线对照。** A 现有实现；B Jev adapter；C 同 contract 的现有通用模型或可用替代 provider。做完整 episode，而不只统计选择题对错。先比较同 state/candidates 的 scorer，再比较端到端候选生成和最终行为，避免把不同检索器的收益归给 Jev。

**在线 A/B 是冻结版本的稳定分桶。** 固定 experiment ID、salt、assignment 与 config revision；eligible、assigned、called、consumed、fallback 分开记。按最初分桶统计（含超时回退），不能只挑成功调用比较。控制组不得使用 shadow 产物；校准时不偷看最终测试标签；同日近重复文档按源/任务分组划分数据。

| 实验 | 主要收益指标 | 不退化指标 | 前置条件 |
|---|---|---|---|
| Research / 证据筛选 | 每份可接受报告的总成本、人工复核时间 | 引用支持率、反证/主题覆盖、少数重要来源保留 | 有原始源与人工 gold，重复转载标注 |
| Memory relevance | required fact recall / token | 错 box、撤回事实、关键约束漏失、最终任务成功 | 修清 docs/64 的输出消费边界；补独立真实样本 |
| Delivery review | 无证据完成漏报率 | 误拦正常完成、重复打扰、P95 完成延迟 | 请求/证据绑定、脚本 episode 与人工判定 |
| Skills/catalog | 正确能力发现率、首次有效行动时间 | none 场景误推荐、不可用/未授权能力推荐 | 已安装与 enabled/capability 过滤 |
| CUA bounded loop | 同一成功定义下任务耗时/成本 | 错目标、重复提交、取消后动作、错误宣布完成 | INV-636/637、独立后置条件 oracle |
| Tool review | 危险动作漏放、合理动作误拦 | code deny 被绕过、超时行为、用户打扰 | INV-600 至少 50 条真实脱敏 shell 样本，人审分歧 |
| 模型路由 | 每个成功任务总成本 | 成功率、重试/升级数、缓存损失、P95 | 任务边界和当前完整 baseline；晚于前几项 |

上线门槛应由 pilot 预注册非劣界与业务后果决定，不能现在凭空写一个适用于全部 purpose 的 95%。硬不变量如跨 box、取消后执行、绕过禁令应由代码与场景保证，观测到任何违规立即停止相应用途；“样本 0 次”并不证明概率永远为零。

## 10. 建议顺序与本轮交付

**第一组试验**：独立于执行的研究证据筛选/引用检查、memory relevance 与 delivery review 的 shadow、技能/模板推荐。理由是输入输出可记录、真值可复核、失败容易回退，而且覆盖多数角色。业务层先拿一个 Researchy/X Brief 日报和一份线索表做端到端对照，避免只做基础设施没有产品收益。

**第二组**：工具语义审查、通知分流、会议承诺候选、记忆冲突审查。先解决真实标注、消息可见性与状态写入边界。

**第三组**：CUA 有界循环与教学复用。可以与前两组并行研究，但执行接入应等观测/证据合同；先读与导航，再表单草稿，最后才讨论已授权的写操作。

**暂后置**：全局自动模型降级、不可恢复的上下文裁剪、手机平台扩展、用 Jev 替换规划/创作/视觉模型、自动交易/自动招聘淘汰等与当前目标不匹配的目录案例。游戏借测试方法，SDK 借边界设计，不都变成产品需求。

本轮只新增研究报告与公开来源/探针记录，未改 product code、未调整 Jev 角色、未启用模型或实验开关、未对真实页面执行动作。研究证据关联现有 INV-600，CUA 依赖指向已有 INV-636–640，不重复建 issue。原 INV-600 的真实命令样本验收仍未完成，不宣称整个合同 Done。

## 11. 主要来源

- [完整目录与固定数据快照](https://github.com/hellogumbo/awesome-jev/blob/e2014cdb35d7d699795c8ca28904e8f42568bf45/data/projects.json)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence)、[Jev 1.13 局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)、[use-case map](https://docs.typesafe.ai/concepts/use-case-map)
- [TypeSafe 官方 LLM 对照 adapter](https://github.com/typesafe-ai/system-one-adapter-python)
- [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)、[Mac computer use](https://github.com/awlevin/typesafe-computer-use)、[Codex bridge](https://github.com/wy-coliney/jev-browser-use)
- [Grounded browser](https://github.com/tontoko/jev-browser)、[宏与 assertions](https://github.com/jiawei686/jev-ultrafast-mcp)、[JevTest](https://github.com/CorieW/JevTest)
- [聊天副驾](https://github.com/jev-chat/jev-chat-jarvis)、[语音浏览器](https://github.com/moritzkremb/jev-voice-browser)、[Unclutter](https://github.com/kitze/unclutter)
- [Hermes Jev skills](https://github.com/kerpopule/hermes-jev-skills)、[Notra](https://github.com/usenotra/notra)
- [Jev cookbook](https://github.com/nexibeo/jev-cookbook)、[jselect](https://github.com/keltokhy/jselect)、[jlink](https://github.com/keltokhy/jlink)、[invalidate](https://github.com/chopratejas/invalidate)、[hush](https://github.com/emreozyoruk/hush)
- [OpenPoke 对抗研究及限制](https://github.com/0xShin0221/openpoke-meets-jev/blob/main/evals/contamination/FINDINGS.md)

详细固定版本、文件 hash 与阅读范围见同目录研究产物 `awesome-source-review.json`；前两轮源码与实测证据见 docs/63、64。
