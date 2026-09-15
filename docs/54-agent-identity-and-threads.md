<!-- doc: 54-agent-identity-and-threads
     title: Agent 身份与在工作项上的对话
     family: decision
     status: current
     updated: 2026-09-15
-->
# 54 · Agent 身份与在工作项上的对话

*2026-09-15。v2：初稿经 codex（gpt-6-astra，high，读了我们的代码）红队后重写了 §3 之后的全部内容；
§6 记录它推翻了什么。Chris 的需求原话：想在一条 INV 上 @ 当初写下这条的 agent，问它"你当时的判断依据是什么"；
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
- **解耦点，也就是 Chris 问的那句"怎么解耦"**：**Linear 不托管 agent**。它只定义三件事——
  一个可寻址的身份、一次对话的信封、一组可观察的活动类型。agent 跑在哪、是什么模型、
  怎么实现，它一概不管。要抄的是这三件事，不是抄它的实现。

## 3. 方案（v2：红队之后）

### 3.0 红队推翻的三个前提，先说清楚

1. **"换 token 就解决了身份问题"——不成立。** 换 token 解决的是**归属记录**，不是**防冒充**：
   只要管理员 bearer 还留在 `~/.claude.json` 或任何进程读得到的地方，agent 随时可以用回它；
   而且同一个 box 内共享文件系统与 passwordless sudo（docs/22 §0、`auth.ts` 自己写着"不是安全边界"），
   同箱的几把 token 互相之间本来就不设防。**所以 P0 的验收不是"发了 token"，而是"agent 的每一条
   执行路径上都不再存在 HUMAN 凭证，且 `work_commit` 对它们返回拒绝"。**
2. **"跟进 rails 可以白拿"——不成立。** `question-expiry.ts` 看守的是 **agent 问人**；
   Chris 要的是 **人问 agent**，方向相反，而且同一个人再说一句话就会清掉该 agent 对他的待答问题
   （`question-expiry.ts` 的 `noteReply`）。人问 agent 的那只钟**必须由 Involute 持久保管**，
   不能挂在某个可能已经关掉的宿主进程里。
3. **"有权提问 = 有权看到回答"——不成立。** 一条 INV 是多人可见的；agent 把私人 box 的 transcript、
   outbox 附件或内部 PR 内容贴回去，等于把入站授权当成了出站受众。**第一版只允许引用已批准的证据，
   不允许自动上传 transcript/outbox**（普通 channel 回合会自动带文件，`manager.ts` 的 deliverFiles）。

### 3.1 真正的骨架（四件事，不是三层）

红队给的替代方案我采纳：**稳定的作者 + 做决定时写下的 receipt + 持久的提问记录 + 可选的消费者**。

1. **稳定作者**：每个 agent 一个 `(workspaceId, actorId)`，handle 只是别名。换 token 不换作者身份，
   删掉再建同名 handle 不继承旧身份（docs/22 §4 的 incarnation 同款理由）。
2. **Decision receipt（这条是整份方案里最值钱的一条）**：**做出判断的那一刻**就写下一条可定位的记录——
   actor、run、audit revision、当时明确写下的理由、引用证据的版本。三个月后要问依据，读的是这条，
   而不是让一个新进程去"回忆"。没有 receipt 时的标准答案是**"无法恢复"**，不是"当时没有依据"。
3. **持久提问**：提问由 Involute 保存，状态是 `未领取 / 处理中 / 投递失败 / 已答 / 过期`，
   带 deadline、取消位、付款 principal。**inbox 游标只是扫描位置，不能代替逐条的 claim/ack。**
4. **可选消费者**：谁来答是一个订阅问题，不是一个 agent 分类问题。webhook 只是"来取吧"的提醒；
   CLI 手动领同一个队列；没人领就显示"未答 + 该找谁"。**原进程不需要复活。**

### 3.2 砍掉：三种 presence 分类

初稿按 always-on / on-demand / service 分类，红队指出它把**进程寿命、传输方式、对话能力**三件不同
的事混成一维，而且立刻会出现第四类（CI 可以按需拉起一个解释器；常驻进程可以只出站轮询）。
**砍掉。**换成 §3.1 第 4 条：actor 上只记"有没有活跃的消费者在领它的队列"，这是**可观测的事实**，
不是预先声明的类别。

### 3.3 lumenbox 侧："另一道门"要先补七个断点

把 Involute 当成 feishu/telegram 那样的 door，是**方向对、成本被低估**。红队逐条对着
`src/channels/` 列出的不匹配，我核对后全部成立：

| 维度 | 照搬会怎样 | 最小修正 |
|---|---|---|
| **作者** | `sendToChat` 没有"以谁的身份发"这个参数；一个 adapter 服务多个 agent，回帖会全署同一个凭证 | 出站带 actorId，选它自己的凭证；系统通知另署系统身份 |
| **线程** | 门假设有 chat/thread/reply anchor；Involute 今天只确认有 comments | 先确认 parent/root 语义；线程失败不许悄悄退回顶层评论 |
| **幂等** | adapter 合约允许重复投递，不承诺 durable processing | 请求账本 + 出站幂等键，拿到 commentId 才标 answered |
| **顺序** | 重试会让旧提问晚于"停下"抵达，把已取消的请求重新跑起来 | 每 thread 序号/版本，取消状态持久化，过时事件拒收 |
| **编辑** | 按 commentId 去重会吞掉新增的 @；按 eventId 去重又会把编辑当新请求 | 明确"编辑算不算新请求、撤回 @ 算不算取消"，存 comment revision |
| **限流/长度** | 飞书那套 8000 字切块和固定退避是飞书的契约，不是 Involute 的 | 用短摘要 + 证据链接，不做任意切块；按 429/Retry-After 排队 |
| **产品语义** | 普通 channel 请求默认开一张本地 Task；"你当时为什么这么判断"会变成第二套工作状态 | 专门的**解释请求**入口：不开任务、不触发通用操作动词 |

### 3.4 并发与预算

一个 agent 被 20 条 INV 同时 @ 是正常的一天。现有机制不管这个：channel 的运行槽按 conversation 分，
policy 检查的是**已经花掉的** token（`policy.ts`），follow-up budget 管的是**每个房间的主动提醒**
（`follow-up-budget.ts`）。所以要加：**每个 actor 一个有界队列，第一版单并发**；请求带 deadline、
取消位、付款 principal；要硬预算就做**费用预留**，不要把"历史支出检查"说成上限。

### 3.5 回声：第一版只认人发起的提问

初稿只禁了"自己 @ 自己"，挡不住 Mia 引用 `@leo`、Leo 又引用 `@mia`。**第一版规则**：
只有 HUMAN 作者的评论会产生请求；AGENT/SERVICE 的回复、引用、代码块一律不产生。
真需要 agent 之间委派时，另设显式动作，带根请求 id、预算和跳数上限。

### 3.6 授权：提问是驱动，按 box 收口

能在 INV 上评论的人 ≠ 能驱动某个 box 的 agent 的人。mention 里的发言 actor 必须映射到已绑定的
principal，然后同时检查 **role + box membership**，并且**执行时重验**（排队期间可能已被撤权）。
顺带：红队在这里找到了一个**现存的洞**——`stop` / `steer` 走的不是 `ask` 那条路，
所以 INV-538 的成员检查没覆盖它们。已修（PR #167），与本文无关但由本文的 review 找出。

## 4. 分阶段（按红队重排）

| 阶段 | 内容 | 判断 |
|---|---|---|
| **P0 先做** | 每个 agent 一把 AGENT 凭证；**从 agent 的每条路径上移除 HUMAN 凭证**并逐入口验证 `work_commit` 被拒；稳定作者归属；**开始写 decision receipt** | 不依赖 Involute 任何新功能 |
| **P1 改了范围** | **持久提问账本、授权、幂等、答复状态**——排在 webhook 之前；原 P4 的最小状态骨架并入这里 | webhook 只是提醒，不是协议的核心 |
| **P2 缩小并延后** | 只做**受限的解释请求消费者**，不照搬通用 channel manager | 见 §3.3 的七个断点 |
| **P3 砍一半** | 砍掉三类 presence 与自动代答；保留统一 inbox、服务端期限、**显式交接**（记录实际答复者） | 代答必须是人点头的动作 |
| **P4 整个砍掉** | 不建 thought/action 活动流与它的 UI | 需要的关联与状态已在 P1 |

## 5. 待核（不能当成已知）

- Involute 的 AGENT actor **能不能作为评论作者**，以及 handle 字段是否已存在——api.md 没有说死。
  这两条是 P1 的前提，要先问 Involute 的维护者（Chris 自己）。
- Involute 评论有没有 thread/parent 语义、长度上限、限流契约。
- 我们这把 token 现在是 `Admin / actorKind: HUMAN`，是**谁**配的、要不要保留一把给人用。

## 6. 红队推翻/修改了什么（2026-09-15）

codex 给了 10 条 + 一张断点表，逐条回代码核对后：**S0 三条全部成立**（HUMAN 凭证仍在、
`stop`/`steer` 绕过 box 检查、出站受众没管），**S1 七条全部成立**（handle 不是身份、
20 条并发没人管、三种"成功"混为一谈、一个工作项一个会话会串问题、agent 之间回声、
离线与永不再运行、"必须引用"只能验格式）。被推翻的自家判断三条：**跟进 rails 不能白拿**、
**三种 presence 是漏的分类**、**换 token 不等于隔离**。采纳率 10/10，其中"decision receipt"
是它提出的、比我原方案更根本的东西——**问题不在于怎么把问题送到 agent 面前，
而在于当时有没有留下够回答这个问题的东西。**

引用：Involute `GET /docs/api.md`、`protocol_get_guide`（2026-09-15 取）、
Linear 开发者文档（agents / agent-interaction / agent-best-practices）、docs/51 §3、docs/52、docs/22、docs/20。
