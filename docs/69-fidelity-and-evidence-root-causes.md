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

两类，不是三个。

**一、采集失真。** 读取工具把「拿到了什么」交给模型，却不把「拿到的是不是那个东西」交给
模型。x.com 的登录墙经 `htmlToText` 出来是 6,390 字、14 个链接、零段落正文，标题里嵌着推文
文本（2026-09-22 实测，`/tmp/xwall.html` 420 KB）——它长得像内容，而检测拦截页的
`blockedBy` 只看 1,500 字以内的短页（`web.ts:636`），于是放行。根因不在 x.com，在于
**读取结果没有「完整度」这一维**：`fetchPage` 只有 `truncated` 一个布尔，拦截靠短语黑名单，
「是不是正文」没有任何度量，五个读取工具各用各的措辞告诉模型「被截了」（§2）。
换任何一个 JS 壳网站、付费墙、consent 页，同样的 43 个字会再来一次。

**二、证据蒸发。** 系统为「给模型回放」和「给人事后查」用的是同一份记录，而这份记录是按
回放的经济性设计的：tool result 落盘截到 2,000 字（`protocol/index.ts:298`，`turn.ts:764`）；
四个账本在「没有待处理项」时整文件清空（§3）；消息 id 在总线新铸，进门时的渠道 id 不往下传
（`bus.ts:449` 旧版）。根因是**「回放用的窗口」和「发生过什么的记录」没有分开**：凡是为
省上下文而做的裁剪，都同时裁掉了记录。bash 的 spill（`shell-service.ts:149`）是唯一把两者
分开的地方，而它是 bash 自己做的，不是裁剪处做的。任何新工具、新账本都会再次默认「即用
即弃」。

两类问题的共同上位原因：**边界处的默认值是「丢」**。读取边界默认「拿到的就是内容」，落盘
边界默认「模型不需要的就不留」，进门边界默认「下游会自己造 id」。修法不是再补三个特例，
是在三个边界各放一个卡口，让默认值变成「留、并说明白」，并用架构守卫测试让新代码绕不过去。

## 1. 三个洞是怎么同时长出来的

| 洞 | 直接原因 | 上一层原因 | 归类 |
|---|---|---|---|
| X 只读到 43 字 | x.com 是 JS 壳，HTML 没有 `<main>`/`<article>`，`htmlToText` 回退成整页链接；`blockedBy` 只判短页 | 读取结果没有「完整度」维度；模型被告知的只有「rest of page not shown」这种散文 | 一 |
| 页面 turn 后消失 | `storableResult` 截 2,000 字，只有 bash 的 spill 指针被保留 | 裁剪在一处（`storableResult`），保留却分散在每个生产者手里 | 二 |
| 消息 id 断链 | `sendFromUser` 自铸 uuid，`manager.ts:1338` 手里的 `om_` id 没有往下传 | 身份在总线铸而不是在进门处铸；四个账本清空后连时间推断都做不了 | 二 |

它们同时存在不是巧合：2026-08 的 docs/23/24 整个是为「上下文不要爆」做的，裁剪、压缩、
清空都是那一轮的正确决定；它们的副作用是记录跟着一起没了，而当时没有一个消费者需要事后
的记录，所以没人发现。第一个需要记录的消费者（ovp-bridge，docs/61）一出现，三个洞同时
显形。

## 2. 采集失真：现状、根因、复发路径

### 2.1 读取工具今天怎么说「不完整」

| 工具 | 上限 | 告诉模型的方式 | 机器可读吗 |
|---|---|---|---|
| `WebFetch` | 40,000 字（`web.ts:43`） | 文末 `[... rest of page not shown]`；拦截页抛 `WebError` | 否 |
| `browser_read` | 区域文本 | 描述里写「is cut and says so」（`tools.ts:1598`） | 否 |
| `ReadFeishuDoc` | `DOC_CONTENT_LIMIT` | 文末中文「文档过长,已截断:共 N 字」（`feishu-docs.ts:158`） | 否 |
| `read_file` | 2,000 行（`fs-service.ts:39`） | 结果结构里 `truncated: true` | 部分 |
| `ReadHistory` | 每条 600 字、25 条（`history.ts:9,12`） | 描述里说 bounded compact reading | 否 |
| `WebSearch` | 引擎摘要 | 描述里说「descriptions are the engine's」 | 否 |

六种措辞、零个共同字段。模型在系统提示里被告诉的是「blocked, given a consent wall, or
handed a page that is obviously not the content」（`prompt.ts:157`）——「obviously」是留给
模型判断的，而 x.com 那页恰恰不 obvious。

### 2.2 根因

读取结果缺一个维度：**完整度**（`full | clipped | shell | blocked | unavailable`）和它的
依据（拿到多少、缺多少、为什么）。没有这个维度，两件事都做不到：模型无法把「我读了」降级为
「我只看到了壳」；事后的人无法从记录判断 agent 当时核实的是什么。INV-628 给 x.com 加了
`completeness` 字段——但只给了 x.com。

「是不是正文」是可以度量的，不需要黑名单：抽取后的文本里有多少字在链接之外、有多少段落、
文本量相对 HTML 量的比例。x.com 那页是 6,390 字全在导航和链接里，零段落；一篇文章是几千字
段落加几十个链接。这是一个结构信号，对任何网站成立。

### 2.3 复发路径

- 新增任何读取工具（RSS、PDF、Notion、飞书表格）——没有共同契约，作者会再发明第七种措辞。
- 任何网站改成 JS 壳或加登录墙——`blockedBy` 的短语表不认识，短页阈值不覆盖。
- `htmlToText` 的回退规则改动——「没有 main 就取整页」是产生壳内容的机制本身。

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

### 4.1 读取契约（治采集失真）

- `fetchPage` 计算 `completeness`：`full`（有段落正文且未截）、`clipped`（截了，给出总量）、
  `shell`（有文本但链接外的段落文字少于阈值——JS 壳、登录墙、导航页）、`blocked`（拦截页短语）、
  `unavailable`（4xx/5xx）。度量：链接外字符数、段落数、文本/HTML 比。x.com 那页在这个度量下
  是 `shell`，不需要认识 x.com。
- 一个共用的 `readOutcome()` 助手，六个读取工具都用它生成结果的**第一行**：
  `[read: shell — 6,390 chars, 0 paragraphs, 14 links; likely a JavaScript app or login wall; open with browser_open]`。
  第一行而不是末行，因为末行会被 2,000 字的裁剪吃掉（INV-629 的指针之所以活下来，是因为
  `storableResult` 专门捞它）。
- 系统提示的 conduct 里加一条：`read:` 不是 `full` 的结果不能作为「已核实」的依据；引用时要说明
  完整度。
- 落盘的 fetched frontmatter 记 `completeness` 与度量值，事后可查 agent 当时看到的是不是正文。
- **守卫**：架构测试扫描 `src/`，任何工具结果里出现「not shown / 截断 / truncated / cut」字样
  而不经 `readOutcome()` 的，构建失败；`blockedBy` 的短页阈值改为「短页或零段落」。

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
| #202 INV-628 | X 正文 | §2 的一个实例（内容形态问题） | 保留；`completeness` 字段并入 §4.1 的通用契约 |
| #203 INV-629 | 页面留存 | §3.1 的一个生产者自觉 spill | 保留；§4.2 之后其它工具也自动获得同样保全 |
| #204 INV-613 | id 断链、消息记录 | §3.2/§3.3 的实例 | 保留；§4.3 让 `ingress`/`turns` 也成为记录，`messages.jsonl` 不再是唯一可信来源 |

三个 PR 都是必要的，也都是「特例修法」。本文的三个卡口是把特例升为默认。对应的工作项
（2026-09-22 提为候选）：里程碑 INV-631「保真与证据：三个边界各一个卡口」，子项 INV-632
读取契约、INV-633 保全在裁剪处、INV-634 账本性质声明。
