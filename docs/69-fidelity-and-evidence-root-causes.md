<!-- doc: 69-fidelity-and-evidence-root-causes
     title: 采集失真与证据蒸发：两类问题的根因、复发路径与卡口
     family: decision
     status: current
     updated: 2026-09-22
-->
# 69. 采集失真与证据蒸发：两类问题的根因、复发路径与卡口

2026-09-22。INV-628 / 629 / 613 三个 PR 修掉了三个具体的洞：X 链接只读到 43 个字、抓到的
页面 turn 一结束就没了、一条消息的 id 在门和总线之间丢掉。本文回答三个问题：这三个洞
为什么会同时存在；它们是几类问题；以后哪些改动会再把同一类问题挖出来，卡口放在哪。
每一条判断都有源码或实测出处；推测标明推测。

## 0. 结论

> **2026-09-22 更正。** 本文第一版把两类问题并列，并称 agent 读 x.com 时「只拿到 43 个字」。
> 实现 §4.1 时对真实页面做了测量，这句话是错的，据此推出的「壳检测」也是错的。更正见 §2；
> §0 与 §1 按更正重写。被推翻的判断保留在 §2.4，因为它是下一个人不要再提同一条规则的理由。

三个洞（X 只读到导航、抓到的页面 turn 后消失、消息 id 断链）**只有一个共同根因**：
**为「给模型回放」而做的裁剪，同时裁掉了「发生过什么」的记录**，而两者用的是同一份数据。

tool result 落盘时截到 2,000 字（`protocol/index.ts:298`，`turn.ts:764`）。截的是**头部**，
而一个网页的头部是导航。实测（§2.2）：x.com 的一个状态页给出 6,434 字文本，其中含它所链
Article 正文的 82%，但前 2,000 字是「Log in / Sign up」。于是模型当场读到了正文，而**记录
里只剩登录提示**——事后没有任何人能知道它核实的是什么，压缩之后连它自己也不知道。

同一个根因的另外两个出口：四个账本在「没有待处理项」时整文件清空（§3.2），消息 id 在总线
新铸而不是在进门处铸（§3.3）。都是「为当下够用而设计的存储，被当成了记录」。

所以卡口只有一条主线：**裁剪谁做，保全谁负责**；派生出两条：**边界谁跨，身份谁铸**，以及
**读取结果要自带一行可被机器读的形状**，让被保留下来的那 2,000 字的开头说的是「这次读到了
多少」，而不是「登录 / 注册」。

## 1. 三个洞是怎么同时长出来的

| 洞 | 直接原因 | 归类 |
|---|---|---|
| X 链接读到的是导航 | 页面确实带正文，但正文在导航之后；落盘只留头部 2,000 字 | 记录被裁剪 |
| 页面 turn 后消失 | `storableResult` 截断，只有 bash 的 spill 指针被保留 | 记录被裁剪 |
| 消息 id 断链 | `sendFromUser` 自铸 uuid；四个账本清空后连时间推断都做不了 | 记录被清空 |

它们同时存在不是巧合：2026-08 的 docs/23/24 整轮是为「上下文不要爆」做的，裁剪、压缩、
清空在当时都是对的决定。副作用是记录跟着一起没了，而当时没有一个消费者需要事后的记录，
所以没人发现。第一个需要记录的消费者（ovp-bridge，docs/61）一出现，三个洞同时显形。

## 2. 采集失真：这一节是被更正的一节

### 2.1 读取工具今天怎么说「不完整」

| 工具 | 上限 | 告诉模型的方式 | 机器可读吗 |
|---|---|---|---|
| `WebFetch` | 40,000 字（`web.ts:43`） | 文末 `[... rest of page not shown]` | 否 |
| `browser_read` | 区域文本 | 描述里写「is cut and says so」（`tools.ts:1598`） | 否 |
| `ReadFeishuDoc` | 30,000 字 | 文末中文「文档过长,已截断」（`feishu-docs.ts:158`） | 否 |
| `read_file` | 2,000 行（`fs-service.ts:39`） | 结果里 `truncated: true` | 部分 |
| `ReadHistory` | 每条 600 字、25 条（`history.ts:9,12`） | 描述里说 bounded compact reading | 否 |
| `WebSearch` | 引擎摘要 | 描述里说「descriptions are the engine's」 | 否 |

六种措辞、零个共同字段，而且**全部写在结果末尾**——也就是落盘时第一个被丢掉的地方。
这一条是成立的，也是 §4.1 要修的。

### 2.2 更正：x.com 那页到底给了什么

2026-09-22 用产品自己的 UA 抓了 `x.com/<handle>/status/<id>` 并用 `htmlToText` 抽取
（证据：`src/host/fixtures/read-shapes/extracted-text.json`，三个真实页面的抽取结果）：

| 度量 | x.com 状态页 | 维基百科条目 | 个人博客文章 |
|---|---|---|---|
| 抽取文本 | 6,434 字 | 61,606 字 | 2,928 字 |
| 链接 | 14 | 576 | 57 |
| 链接外 ≥40 字的段落 | 29 | 57 | 3 |
| 文本 / HTML | 1.7% | 24.6% | 17.1% |

把 FxTwitter 取回的 Article 正文按空白与标点归一化后逐行比对：**45 行中 37 行出现在
x.com 页面里（82%）**。所以：

- **「只拿到 43 个字」是错的。** 43 字是 FxTwitter API 里那条推文自己的 `text`（一个 t.co
  链接），从来不是 `WebFetch` 的返回。第一版把两者混为一谈。
- **那页不是「空壳」。** 它带着所要文章的绝大部分正文。
- **真正丢失的发生在落盘**：前 2,000 字是登录furniture，落盘只留这些。

### 2.3 那 INV-628（改用 FxTwitter）还成立吗

成立，但理由要换。不是「否则只有 43 个字」，而是：正文埋在导航之后、没有线程、没有作者、
没有日期、帖子消失时没有原因，且 HTML 结构随时会变。API 把这些一次给全，并且给出可核验的
`completeness`。已合并的 #202 保留，issue 描述里那句理由是错的，已在 §5 记下。

### 2.4 被推翻的设计：用结构判「壳」

第一版打算让 `fetchPage` 用结构信号判定 `shell`（JS 应用返回导航而非内容）。上表否定了它：
按「链接外段落密度」，**x.com 那页比维基百科更像文章**（每千字 4.5 块 vs 0.9 块），而那篇
三段的博客文章会被判成壳。唯一能分开的是文本/HTML 比（1.7% vs 17–25%），但它度量的是页面
怎么搭的，不是这次读到了什么，遇到内嵌大 JSON 的正常页面就会误伤。

**结论：不发布这个判定。** 读取契约只报数，不评级。这一段连同 fixture 一起留着，是为了让
下一个人不要再提同一条规则（测试 `read-outcome.test.ts` 把这组数字钉死）。


## 3. 证据蒸发：现状、根因、复发路径

### 3.1 裁剪在一处，保留却各自为政

`storableResult`（`turn.ts:731-790`）是所有 tool result 落盘前的唯一入口：截到 2,000 字，
剥掉图片，**只在文本里已经有「full output kept:」指针时把指针带过去**（`turn.ts:765`）。
谁负责产生指针：bash（boxd 的 spool，`shell-service.ts:149`）、INV-629 之后的 WebFetch、
INV-628 之后的 X 解析器。其余全部读取工具——`browser_read`、`ReadFeishuDoc`、`read_file`
的内容、MCP 工具、`computer` 的文本——超过 2,000 字的部分落盘即丢。裁剪处知道自己在丢，
却把「留」交给生产者自觉。

### 3.2 八个会「压缩」的账本，四个压掉的是记录

| 账本 | 压缩时保留什么 | 实际性质 | 压掉了什么 |
|---|---|---|---|
| `inbox.jsonl` | 只留 pending（`inbox.ts:219`） | 队列 | 无（应有的行为） |
| `deliveries.jsonl` | 只留 owed（`deliveries.ts:143`） | 队列 | 无 |
| `ingress.jsonl` | 只留 open 的 arrival（`ingress.ts:161`） | **记录**（「每条到达及其命运」） | 全部已决的到达与命运 |
| `turns.jsonl` | 无中断即清空（`resume.ts:303`） | **记录**（turn 的生命周期；`autonomy-metrics` 与审计导出读它） | 全部已结束的 turn |
| `conversations.jsonl` | 重写为当前映射 | 状态 | 无 |
| `sent-roots.jsonl` | 重写为当前映射 | 状态 | 无 |
| `cards.jsonl` | 重写为存活卡片 | 状态 | 已关闭卡片（可接受） |
| `activity.jsonl` | 保留最近窗口 | 信息流 | 旧事件（设计如此） |

`ingress` 和 `turns` 是被当成队列写的记录：它们的头注释说的是「every message that arrived
and what became of it」「picking a turn back up」，一半是记录、一半是恢复队列，压缩规则
按后者写，于是前者随之消失。INV-613 加的 `messages.jsonl` 之所以要新开一个文件，正是
因为没有一个现成的账本能被信任为记录。

### 3.3 身份在错误的层铸造

`om_` id 在进门处（`manager.ts:1338`）可见，uuid 在总线（`bus.ts:449`）铸造，两者之间隔着
`ask` 的九个参数。INV-613 把铸造点挪到进门处并往下传。这类问题的通式是：**外部身份进入
系统的那一层没有立即给它一个内部身份并附上外部身份**，后面的层只能靠时间和文本前缀猜。
同类的边界还有：webhook 触发（`webhooks.ts`，请求 id）、MCP face 的调用（route id）、
teammate 的 `SendToAgent`（bus.send 已有 id，但 transcript 只记 `causedBy`）。

### 3.4 根因

「回放窗口」与「发生过什么」是两种需求，被一份数据结构承担。压缩、截断、清空都是回放
需求的正确优化，落到同一份数据上就变成记录的损毁。bash 的 spill 是唯一把两者分开的例子，
但它分开的方式是「生产者自己另存」，不是「裁剪者负责保全」，所以不可推广。

### 3.5 复发路径

- 任何新工具返回超过 2,000 字的结果——`storableResult` 照截，没人提醒作者去 spill。
- 任何新账本按 `inbox.ts` 的样子写 `compact()`——模板本身就是「清空」。
- 任何新的外部入口（新渠道、新 webhook 类型）——若在自己的层新铸 id，链又断。
- `DURABLE_RESULT_CHARS` 调小、`COMPACT_AT` 调小——记录损毁的幅度直接变大，没有任何测试
  会红。

## 4. 卡口：三个边界各放一个，默认值改为「留、并说明白」

原则一句话：**裁剪谁做，保全谁负责；边界谁跨，身份谁铸；读取谁给，完整度谁报。**

### 4.1 读取契约：报数，不评级（治「记录里只剩导航」）

- 每个读取结果的**第一行**是一行可被机器读的测量（`src/host/read-outcome.ts`）：
  `[read: clipped — 40,000 of 61,606 chars, 57 prose blocks, 576 links; …]`。
  第一行而不是末行，因为落盘只留头部——这正是本文的根因。
- `completeness ∈ full | clipped | blocked | unavailable | summary`。`clipped` 只表示
  **我们**截了它；`summary` 是 WebSearch，表示这根本不是一次文档读取。**没有 `shell`**，
  理由见 §2.4。
- 六个读取工具全部改用同一个助手；X 解析器原有的 `partial` 映射为 `clipped`。
- conduct 增加一条：不是 `full` 的读取不能算「已核实」，引用时要说明完整度。
- 落盘的 fetched frontmatter 记 `completeness`、`prose_blocks`、`links`。
- **守卫**：架构测试扫描 `src/host` 与 `src/channels`，出现手写的截断措辞而文件里没有
  `readOutcome` 的，构建失败（已验证会变红）。


### 4.2 保全在裁剪处（治证据蒸发之一）

- `storableResult` 在截断时，若结果里没有 `kept:` 指针且没有 `recordAs` 的保密要求，把全文
  写到 `~/.agentbox/results/<yyyy-mm>/<turnId>-<tool_use_id>.txt`，追加
  `[full output kept: <path>]`。裁剪者负责保全，生产者不用自觉；bash 与 WebFetch 已有的指针
  照旧优先。保留期与 `fetched/` 共用 `AGENTBOX_FETCHED_RETENTION_DAYS`；审计导出带走。
- **守卫**：`storableResult` 的单测断言「任何超限结果都带指针」；架构测试断言
  `DURABLE_RESULT_CHARS` 只在 `storableResult` 与 boxd 的 spill 两处被引用，别处不得自行裁剪
  tool result。

### 4.3 账本声明性质（治证据蒸发之二）

- 每个账本在文件头以常量声明 `LEDGER_KIND: "record" | "queue" | "state" | "feed"`；
  `record` 的 `compact()` 不得丢行——要么不压缩（`ingress` 一天 30 行，压缩本无必要），要么
  把已决行滚动到 `<name>.<yyyy-mm>.jsonl` 归档文件而不是删除。`ingress` 与 `turns` 改为
  `record`。
- **守卫**：架构测试枚举所有含 `private compact()` 的文件，要求每个都声明 `LEDGER_KIND`，且
  `record` 类的 `compact()` 体内不得出现「只写 open/pending/owed」的模式（用一个必须调用的
  `archiveSettled()` 助手来表达，测试检查调用存在）。新账本不声明就编译不过。
- 进门身份：`bus.sendFromUser` 若被渠道路径调用而没有 `messageId`，`manager` 的测试已断言；
  再加一条架构规则：`manager.ts` 之外不得 `import { randomUUID }` 用于消息 id（把铸造点钉在
  进门）。

### 4.4 不做

- 不把 2,000 字的回放上限调大：那是 docs/23 的教训，回放窗口的经济性是对的。
- 不给每个网站写专用解析器：X 是因为 Article 正文只在 API 里才有，是内容形态问题，不是
  完整度问题；完整度度量反而是让「下一个 x.com」被识别出来的办法。
- 不回填历史：压缩已经清掉的 `ingress`/`turns` 行找不回来，2026-09-20 之后的 `messages.jsonl`
  是新的起点。

## 5. 与已合并三个 PR 的关系

| PR | 修的洞 | 在本文的位置 | 卡口落地后它变成什么 |
|---|---|---|---|
| #202 INV-628 | X 正文 | §2.3：结论保留，**issue 描述里「只拿到 43 字」的理由是错的** | 保留；其 `partial` 并入 §4.1 的 `clipped` |
| #203 INV-629 | 页面留存 | §3.1 的一个生产者自觉 spill | 保留；§4.2 之后其它工具也自动获得同样保全 |
| #204 INV-613 | id 断链、消息记录 | §3.2/§3.3 的实例 | 保留；§4.3 让 `ingress`/`turns` 也成为记录，`messages.jsonl` 不再是唯一可信来源 |

三个 PR 都是必要的，也都是「特例修法」。本文的三个卡口是把特例升为默认。对应的工作项
（2026-09-22 提为候选）：里程碑 INV-631「保真与证据：三个边界各一个卡口」，子项 INV-632
读取契约、INV-633 保全在裁剪处、INV-634 账本性质声明。
