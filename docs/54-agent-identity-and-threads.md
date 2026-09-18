<!-- doc: 54-agent-identity-and-threads
     title: Agent 身份与在工作项上的对话
     family: decision
     status: current
     updated: 2026-09-18
-->
# 54 · Agent 身份与在工作项上的对话

*2026-09-15。v2 经 codex 红队重写；v3 按 Chris 的四条方向改成长期、解耦的形态，并补了
"发起的 agent 下线之后谁来答"的调研（Linear 的答案很明确，见 §D）。§7 记录每一版被推翻了什么。Chris 的需求原话：想在一条 INV 上 @ 当初写下这条的 agent，问它"你当时的判断依据是什么"；
但 API 里看不出是哪个 agent 干的，角色都长一样；Involute 本身没有 agent 对话能力；Linear 是怎么把
agent 能力和工作项解耦的；还有一种情况是 Codex / Claude Code 直接操作 INV，这种怎么 @ 回来——
是不是需要一个 agent 协议，谁都来符合它、挂上监听。*

---

## 0. 先把最要紧的一条说了：我们今天是以"人"的身份在写 INV

用我们现在这把 token 问它自己是谁：

```
POST /graphql { viewer { id name email actorKind } }
→ { "id": "4fcdec6e-…", "name": "Admin", "email": "admin@involute.local", "actorKind": "HUMAN" }
```

INV-538 的 audits 也是同一个：`actorKind: HUMAN`、`actorId: 4fcdec6e-…`，无论是 mcp 还是 graphql 写的。

两个后果，第二个比第一个严重：

1. **看不出是谁干的**——所有 agent 共用一把管理员 bearer，所以 Chris 的观察完全正确，但**原因不是
   Involute 缺能力**（见 §1）。
2. **"agents propose, humans commit" 今天没有被强制**。`work_commit` / `work_reject` / `work_review`
   不看 scope，只看 `actorKind` 是不是 HUMAN——而我们这把 token 就是 HUMAN。也就是说，一个 agent
   现在可以自己 commit 自己提的候选、自己 accept 自己的活。我一直没这么做是因为约定，不是因为拦得住。

**这一条不需要任何新设计，今天就能修：给每个 agent 发一把自己的 `inv_agent_*`。**

## 1. Involute 今天已经有什么（核对过，不是猜）

| 能力 | 状态 | 证据 |
|---|---|---|
| 每个 agent 一把独立 token | **已有** | `agentCredentialCreate(input: {team, name, scopes})`，明文 token 只显示一次；Settings → Agents；可 `agentCredentialRevoke` |
| actor 种类 | **已有** | `viewer.actorKind ∈ HUMAN / AGENT / SERVICE`；audits 带 `actorKind` + `actorId` |
| scope 分权 | **已有** | read / propose / update / link / claim / report；`work_commit` 按 actorKind 而不是 scope |
| 评论 | **有，但只当人用** | `commentCreate`，`comment.user`；api.md 原话："Comments are a human observation surface, **not an agent heartbeat**" |
| Webhook | **已有** | 13 种事件、HMAC 签名、事件 id 去重、指数退避重试、连续失败自动停用 |
| @mention | **没有** | 事件表里没有 comment 或 mention |
| agent 收通知 | **明确不做** | api.md 原话："**Agent actors never receive notifications.**" |

所以缺口是清楚的三件事：**agent 不能作为评论的作者、没有 mention、agent 收不到任何东西**。

## 2. Linear 怎么做的（查证过，附出处）

- **身份**：OAuth 时带 `actor=app`，装进某个 workspace 就得到一个该 workspace 内唯一的 app user id。
  两个可选 scope：`app:mentionable`（能被 @）、`app:assignable`（能被指派）。
  关键细节：**指派给 agent 是 delegate，不是 assignee——人保留 ownership。**
- **入口**：被 @ 或被 delegate 时，Linear **自动建一个 AgentSession**（挂在 issue 上，带一条 comment
  thread），并发 `AgentSessionEvent` webhook：
  - `created`：带 `agentSession`（issue、comment、上下文），其中 `promptContext` 是**已经拼好的**
    上下文字符串——agent 不用自己去凑。
  - `prompted`：人回复了，内容在 `agentActivity.body`。"停下"也走这个事件，带 `signal: "stop"`。
- **输出**：agent 发 **AgentActivity**，类型 `thought` / `action` / `elicitation` / `response` / `error`。
  **要求 10 秒内先发一条 thought**，表示接住了。session 的状态由 activities 自动推进，
  "No manual state management is required"。
- **说实话的状态机**：session 有 pending / active / error / awaitingInput / complete / **stale** 六态，
  由活动自动推进。**10 秒内没有活动就显示 unresponsive**；后续活动可以持续 30 分钟，之后进入
  stale，**stale 可恢复**。webhook 接收端必须 5 秒内应答，所以真正的工作一定是异步的。
  设了 `externalUrls` 的新 session 不会被标成 unresponsive。
- **没有"转交活着的会话"这个原语**（§D 详述）：agent 不响应时的做法是换 delegate，
  于是**开一个新 session**，上下文由评论与 `promptContext` 重建。
- **解耦点，也就是 Chris 问的那句"怎么解耦"**：**Linear 不托管 agent**。它只定义三件事——
  一个可寻址的身份、一次对话的信封、一组可观察的活动类型。agent 跑在哪、是什么模型、
  怎么实现，它一概不管。要抄的是这三件事，不是抄它的实现。

## 3. 长期形态（v3）：Involute 是记录，agent 在外面，中间是一个小协议

Chris 的四条方向定了骨架：**agent 能以自己的身份说话**；**Involute 是基础数据与基础设施，
给人和 agent 留足接口**；**讨论是多轮的**（人↔agent、agent↔agent、同步或异步）；
**发起的 agent 可能已经下线，别的 agent 要能接手**。下面按这四条写，顺序是依赖顺序。

### A. 分层：谁拥有什么

```
Involute（系统 of record）        桥（一页协议）           runtime（谁都行）
─────────────────────────       ──────────────         ─────────────────
actor registry + 能力卡片   ←→   认领 / 应答 / 事件   ←→   lumenbox box agent
work / comment / thread                                  Codex CLI、Claude Code
事件 outbox + 订阅                                        CI、别人的 agent
请求账本（claim/ack/期限）
decision receipt
```

**Involute 不该知道任何 agent 是怎么实现的**，就像 Linear 不托管 agent 一样；它只欠三样东西：
**一个可寻址的身份、一条可追加的线程、一份带期限与认领的请求账本**。反过来，
**runtime 不该假设自己是唯一的消费者**——同一个 actor 的队列可以被换一个进程来领。

### B. 三张表（Involute 侧的最小基础设施）

1. **Actor registry + 能力卡片**。每个 agent 一个 `(workspaceId, actorId)`，handle 只是别名；
   actor 上挂一张**能力卡片**（A2A 的 Agent Card 就是这个东西：`/.well-known/agent.json`，
   写明 name、version、skills、auth scheme）。**卡片让"接谁"变成数据而不是代码**——
   Involute 不需要认识 lumenbox 或 Codex，只需要知道这个 actor 的卡片在哪、支持什么。
2. **Thread + 请求账本**。评论属于线程；**提问是一条有状态的请求**：
   `submitted → working → input-required → completed / failed / canceled`
   （直接借 A2A 的任务状态机，不自己发明），带 deadline、取消位、付款 principal、目标 actorId、
   被问的 audit revision。**认领与应答在服务端**（claim/ack），所以两个 sidecar 同时在线不会重复回答。
3. **Decision receipt**。做判断的当时写下 actor、run、audit revision、当时明确写下的理由、
   证据版本。v2 的结论不变，而且在 v3 里它有了第二个用途：**接手的 agent 读它**（见 §D）。

投递方式**三种都要有，且是同一份账本的三个取法**（A2A 的做法）：轮询、SSE、
以及往消费者自己的 URL 推。谁用哪种是部署决定，不是 agent 的类别。

### C. 多轮讨论：线程是单位，同步/异步是请求的属性

- 一条线程里可以有**多个并行的请求**（两个人问两个不同的历史判断）；每条请求有自己的 id、
  目标 actor、状态与期限。**不要一个工作项一个会话**——v2 已经记了这个坑。
- **agent 反问**是一等状态（`input-required`），不是失败：它要材料、要授权、要澄清，
  线程上就停在那里等人，期限照走。
- **agent↔agent** 用同一条线程与同一套状态，但**第一版只允许人发起**（回声风险，v2 §3.5）；
  开放时按"显式委派动作 + 根请求 id + 预算 + 跳数上限"放行。
- **同步与异步是同一件事的两种取法**：有活跃消费者就是几秒钟内有 thought，没有就是队列里等着。
  **Linear 把这个做成了可见状态**（10 秒内没有活动 = unresponsive；30 分钟没有后续 = stale，
  且 stale 可恢复）。我们照抄这个"说实话的状态机"，因为**人最需要知道的是"它到底会不会回我"**。

### D. 发起的 agent 下线了，谁来答（调研结论 + 我们的规则）

**Linear 的答案很明确：不迁移会话。** 它没有"把这个活着的 session 转给另一个 agent"的原语；
遇到 agent 不响应，做法是**换 delegate——于是开一个新 session**，新 agent 的上下文由
**工单评论 + `promptContext`（Linear 自己拼的摘要）** 重建。生态里讨论过的 in-place harness swap
（换 Claude/Codex 继续同一个活）也明确**不做 transcript 迁移**——不同 harness 的格式不一样，
可移植的东西是"**语义交接 + 仓库里的持久事实**"。

我们的规则，三条：

1. **能回答问题的是记录，不是进程。** receipt + 线程 + 证据是可移植的；
   transcript 不是（会被压缩、格式各家不同）。所以"接手"= **读记录后以自己的身份回答**。
2. **接手必须显式，且署自己的名。** 答复里写明"**我不是 @codex-chris-mac，我根据
   RUN-245 与 PR#475 代答**"。**禁止冒名**：这既是审计要求，也是因为代答者不可能知道
   当时那个进程脑子里想的事。
3. **每个 actor 可以声明一个 successor**（它所在 box 的常驻 agent，或它的宿主人），
   期限到了由 successor 接单；没有 successor 就显示"未答 + 该找谁"。
   **过期文案只说"期限内没有答复"**，不能推断"它没运行"——v2 已经定死这条。

原 agent 之后又回来了怎么办：**请求已经 completed 就不再重开**，它的补充作为线程里的新评论，
不是第二个答案。（Linear 的 stale 可恢复，说的是会话，不是同一个请求的两份答复。）

### E. 与 Involute 侧那份 sidecar 方案的关系：采纳，三处修正

他们提的 sidecar（轮询/监听含 @ 的评论 → `work_get_context` → LLM → `commentCreate`）
**形状是对的，就是 §A 的"桥"**，而且是 P0 就能跑起来的最小闭环。三处要改：

1. **`@` 的识别要在服务端解析成 actorId**，不能靠 sidecar 匹配字符串——否则代码块里的
   `@foo`、编辑、撤回 @ 都会变成难缠的边界，而且两个 sidecar 会重复触发。
2. **认领要在服务端**（claim/ack + 幂等键）。他们的方案里 sidecar 是单点；一旦有第二个
   （我们必然会有：lumenbox 一个、Codex 一个），没有 claim 就会出现两份回答。
3. **回帖必须以被问 agent 的身份**（AGENT actor + 它自己的凭证），不是 sidecar 的身份；
   否则又回到"所有事都是同一个人干的"。

他们给的 token 签发与 MCP 配置步骤（`agent:create --scopes ...` + 每个 agent 自己的
`Authorization`）正是我们 P0 要做的，直接照做。

### F. 分阶段（v3，带验收）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 每 agent 一把 AGENT 凭证；拔掉 agent 路径上的 HUMAN bearer；**开始写 decision receipt** | agent 调 `work_commit` 被拒；两个 agent 的 audits actorId 不同；transcript 压缩后 receipt 仍可读 |
| **P1** | 服务端：mention 解析成 actorId、事件 outbox、**请求账本（状态机 + claim/ack + 期限 + 幂等）**、AGENT 作为评论作者 | 宿主在"收到"与"答复"之间崩溃，重启后不重复答；两个 sidecar 只有一个答 |
| **P2** | 桥：受限的**解释请求**消费者（不开任务、不触发通用动词、出站按受众过滤、带自己的凭证） | 一次解释请求不产生任务卡；私有 box 的 transcript 不出现在多人工作项里 |
| **P3** | 多轮：`input-required`（agent 反问）、线程内多请求并行、**successor 接手 + 出处署名** | 两人同时问两个历史判断不串；代答的答复写明依据来源与代答关系 |
| **P4** | actor 能力卡片（A2A Agent Card）+ 三种取法（轮询 / SSE / 推送） | 换一个 runtime 接同一个 actor，不改 Involute 一行代码 |
| **不做** | thought/action 活动流的 UI；agent↔agent 自由发起（先只放显式委派） | — |

**顺序的理由**：P4 的卡片看起来最"协议化"，但**没有 P1 的账本，卡片只是装饰**；
而 P1 没有 P0 的身份与 receipt，答出来的东西不可信。

## 4. 核过的三条（读 `~/workspace/Involute` 源码，2026-09-15）

上一版里"待核"的三件，现在有答案，其中第一条改变了 P0 的成本估计：

- **AGENT 能不能作为评论作者：能，而且零开发。** `User.actorKind`
  （`packages/server/prisma/schema.prisma:143`）、`Comment.userId → User`（`:280`）、
  `commentCreate` 用 `requireAuthentication` 并把 `viewer.id` 写成作者
  （`packages/server/src/schema.ts:2359-2369`）。**今天看起来"都一样"，只是因为凭证挂在
  `Admin`（HUMAN）这个 User 上。** 而且 `AgentCredential.userId` 是多对一（`:163-177`）：
  **换 token 不换作者身份**，正是 §B1 要的。
- **thread / parent：没有。** `Comment` 只有 id/body/时间/issueId/userId/attachments
  （`:273-286`）。§C 的"一条工作项上多条并行追问互不串线"压在加 `parentCommentId` 这一条上。
- **事件基础设施：现成。** `event-outbox.ts` 已有 HMAC 签名、60 秒认领租约、五次退避、
  死信与自动停用；新事件只是往 `WORK_EVENT_TYPES`（`:8`）加两行 + 在写评论的事务里投递。
- 仍待核：评论长度上限与限流契约。

落地工单（谁做什么、按什么顺序、验收是什么）见
[handoff-2026-09-15-involute-agent-threads](handoff-2026-09-15-involute-agent-threads.md)。

## 5. 我们这侧落地了什么（2026-09-15）

**W2（INV-553）消费者已建**，`src/host/involute-inbox.ts`：

```
agent_inbox → agent_request_claim → 一个回合 → agent_request_answer
```

四条不显然的规则，每条都来自 review：

- **先认领再决定**，包括决定拒绝：账本拒绝一个不持有 claim 的调用来答复，而**拒绝本身也是一种答复**。
- **每个 agent 同时只跑一条，而且等待是看得见的**。一个人一早上可以 @ 同一个 agent 二十次。
  INV-554 之后这是一个真正的队列：单并发、有容量，容量之外**用话拒绝**而不是静默排队——排在
  十九条后面等着错过 deadline，比当场说"晚点再问我或者问别人"更糟。撤回的请求（从 inbox 里消失
  就是唯一的信号）会被记住，重投同一个 id 不会把它救活。
- **跑不出东西要说出来**，报 `failed` 加一句原因，而不是放着等它超时——看着线程的人不该靠等一个
  deadline 才知道什么都没发生。
- **反问是 `input-required` 而不是失败**：那一轮里 agent 自己开了问题（INV-526 的 watch 看得到），
  请求保住位置。

配置在 `config.involute`：每个 agent 一条 `{agentId, handle, secretId}`——**secretId 指向 vault 里
那个 agent 自己的凭证**，不是安装的；三者缺一不可（缺了就退回进程手里的那把 token，正是要终结的
共享身份）。谁可以问，由 roster 回答（INV-575，2026-09-18）：对面的 actor 是本安装一个人的又一个
身份 `involute:<actorId>`，在 Settings → People 里链接，和 `feishu:`/`telegram:` 同构、同一套
incarnation 规则；然后问平常那两个问题——role 至少 driver，且是该 agent 所在 box 的成员
（`src/host/involute-askers.ts`）。拒绝一律说人话：viewer 被告知需要 driver，不在 box 的被指名道姓
拒绝，没链接的人拿到的是"让管理员把 `involute:<actorId>` 链到你"而不是一串 UUID。`askers` 白名单
只剩过渡作用：有链接时以人为准（哪怕 id 还在名单上），只对没人链接的 actor 才查名单，日志写明用了哪条。

轮询而不是 webhook：这台机器在多数网络里没有入站端口，而两边看的是同一份账本——webhook 也只是
叫我们过去取而已。

## 6. 现场验证与 decision receipt（2026-09-15 晚）

**端到端跑通了。** Iris 与 Enzo 各拿到自己的 `inv_agent_*`（handle `@iris` / `@enzo`，scope 含
`answer`，token 进 vault），`config.involute` 配好，宿主日志 `involute: answering for @iris, @enzo
every 30s`。在 INV-553 上以 Admin(HUMAN) 身份 `@iris` 提问，59 秒后线程里出现了
**Iris(AGENT@iris)** 的回复，账本 `state: completed`，`answeredCommentId` 已写。

**这次测试最有价值的结果是那条回答本身**：Iris 说它手上没有 INV-553 的任何记录、也拿不到这条
工作项，所以**拒绝凭印象回答**，列出了需要什么（链接 / PR / run id / 指明是哪个集成）才能给出
带出处的答复。规则起作用了——**而它暴露的正是 §3.1 第 2 条**：当时没人写下来，所以现在读不回来。

于是 **INV-551 落地为 `src/host/receipts.ts`**：

- 一条 receipt = `subject`（`task:t12` / `inv:INV-553` / `question:q3` 这种**可查的键**）+
  `decision`（一句话）+ `because`（**当时写下的理由**）+ `evidence`（还能解析的指针）。
- **`because` 缺失本身是事实**：`describeReceipts` 会打印"（当时没有写下理由）"，
  而不是把它省略掉——"有理由"和"没记理由"的区别，就是"答案"和"猜测"的区别。
- 自己的 append-only 文件：transcript 会被压缩、任务 history 有上限，**receipt 必须比两者活得久**。
- 已接上的判断点：close proposal（理由就是当时写的那句）、老化归档（理由是触发的规则）、
  沉默关闭（提案 + 谁没反对）、问题到期（按默认走了什么，或自己决定了）。
- 回答那一侧也补齐了：消费者在跑回合之前，**用 agent 自己的凭证读 `work_get_context`**，
  把合同、验收与最近的 run 连同 receipts 一起放进 prompt，并告诉它"你在 Involute 上就是 @handle"。

## 7. 每一版被推翻了什么

- **v1 → v2（codex 红队）**：换 token ≠ 隔离；跟进 rails 不能白拿（`question-expiry` 是
  agent 问人）；三种 presence 是漏的分类；"必须引用"只能验格式——所以核心换成 **decision receipt**。
- **v2 → v3（Chris 的四条方向 + Linear/A2A 调研）**：
  - 补上 **agent↔agent 与多轮**：状态机直接借 A2A（`submitted/working/input-required/completed/failed/canceled`），不自己发明。
  - **"接手"有了明确答案**：Linear 不迁移会话，换 delegate 开新会话，上下文从评论与 promptContext 重建；
    生态里的 in-place swap 也明确不迁移 transcript，只做"语义交接 + 持久事实"。我们据此定了
    §D 的三条规则（记录可移植、接手署自己的名、successor 显式声明）。
  - **Involute 的定位收紧**为"三张表 + 事件"，agent 逻辑一律在外；投递的三种取法是部署决定。
  - 采纳 Involute 侧的 sidecar 方案作为 P0/P1 的最小闭环，但把 **mention 解析、认领、署名**
    三件事挪到服务端——否则第二个 sidecar 上线的那天就会有两份回答。

引用：Involute `GET /docs/api.md`、`protocol_get_guide`（2026-09-15 取）、Involute 侧 agent 的 sidecar 方案（2026-09-15）、
Linear 开发者文档（agents / agent-interaction / agent-best-practices / coding-sessions changelog）、
A2A Protocol v0.2.5 与 1.0 说明（Linux Foundation）、docs/51 §3、docs/52、docs/22、docs/20。

## 接手与出处（INV-556，2026-09-16）

调研结论（2026-09-15）先说清楚：**能回答问题的是记录，不是进程**。Linear 没有"把活着的 session
转交给另一个 agent"这个原语——不响应就换 delegate、开新 session，上下文由评论与 `promptContext`
重建；生态里的 in-place harness swap 也明确不迁移 transcript，只做语义交接加仓库里的持久事实。

所以接手不是"恢复会话"，是**另一个 agent 读同一份记录、署自己的名回答**。落地的三条：

1. **声明**：`config.involute.agents[].successor`——`@handle` 是本安装的另一个 agent，其他文本是人。
2. **不替它认领**：被问的 agent 跑不了时（`canRun` 为假），请求不会以它的名义 claim。认领是"这件事
   我在做"的意思；替一个做不了的 agent 说这句话，等于把问题从能答的人手里拿走。
3. **署自己的名**：接手人用自己的凭证 claim + answer，正文开头先说"我不是 X"，结尾带
   `— Iris (@iris), standing in for @ada. Based on …`。`standInCheck` 是结构性的拒绝而不是约定：
   发帖的凭证必须属于答复署名的那一位。

没人接手时：**"期限内没有答复"** 是事实，**"它没在运行"** 是对别人机器的猜测，只写前者；再加一句
该找谁。这条会留在 attention 页上（`kind: "unanswered"`），因为日志会滚走，而那头有个人在等。

**服务端补上了，但形状和我们猜的不同（INV-589/596，2026-09-17）**，消费侧按它改（INV-582，
2026-09-18，`src/host/involute-inbox.ts`）：

- **claim 属于一次执行，不属于 actor。** `agent_request_claim` 返回 `claim_token`，答复和续租都必须带它，
  同一 actor 的另一个会话拿旧 token 会被拒。租约 60 秒，一个回合通常比这长，所以消费者在回合进行中
  每 25 秒续租一次，`session_id` 一并写进审计。没有这一条，新服务端上每一条答复都会被拒。
- **交接是账本做的，靶子是新请求。** 到期未答的请求被 `failed`（理由只写"期限内没有答复"），并在
  同一线程新开一条发给 `successorActorId` 的请求，用 `handedOffFromId`/`rootRequestId` 链起来；
  跳数上限 3、链总期限一个，越界直接给人。**successor 永远不能认领原请求**——所以我们原先"代答者去
  claim 别人的请求、被拒就记下"的路径按协议不可能，已删除。
- **因此"跑不出东西要说出来"改了说法。** 有 successor 时，被问的 agent 用自己的凭证 claim，然后以
  `input-required` 发一句"这边不会有答复；到期后账本交给 @iris"——`input-required` 会把 claim 交回、
  请求保持开放，账本到期才有东西可交；若答 `failed`，请求就关了，谁也接不到。没有 successor 时照旧
  `failed` + 该找谁。
- **接手人在自己的收件箱里收到交接来的请求**，以自己的名义、从记录出发作答，正文带
  `standing in for @ada`。账本目前的 `agent_inbox` 行**没有**带 `handed_off_from`，所以交接来的问题在
  消费侧读起来和新问题一样；消费侧已按可选字段 `handed_off_from_id` / `handed_off_from_handle`
  实现，等服务端露出这两个字段（已提候选）。
- `config.involute.agents[].successor` 现在只决定线程里那句话点谁的名；真正交给谁由账本上该 actor 的
  `successorActorId` 决定，两处应写同一个人。

