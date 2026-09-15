<!-- doc: 54-agent-identity-and-threads
     title: Agent 身份与在工作项上的对话
     family: decision
     status: current
     updated: 2026-09-15
-->
# 54 · Agent 身份与在工作项上的对话

*2026-09-15。Chris 的需求原话：想在一条 INV 上 @ 当初写下这条的 agent，问它"你当时的判断依据是什么"；
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

## 3. 我们的方案

### 3.1 三层，分清楚哪层是哪层的事

- **L1 身份**：每个 agent 一把 token + 一个 handle（`@mia`、`@codex-chris-mac`）。
  **Involute 今天就支持，只差我们去用。**
- **L2 会话**：工作项上的一条 thread。@handle 开一个 session；人的追问是 prompt；agent 的回答是 activity。
- **L3 投递**：怎么把 prompt 送到 agent 面前。**只有这一层需要按 agent 的种类分情况**，
  也是 Chris 那个"codex 怎么 @ 回来"的真正所在。

### 3.2 三种 agent，三种可达性

| 种类 | 例子 | 可达性 | 投递方式 |
|---|---|---|---|
| **常驻** | lumenbox 的 box agent | 有进程、有宿主、有地址 | webhook → 宿主 → 一个回合 → 回答写回 comment |
| **会话型** | Codex CLI、Claude Code | **会话一结束就不存在了** | **拉取**：下次启动先读自己的 inbox；系统当场在 thread 里说明"它是按需的" |
| **服务型** | CI、脚本、批处理 | 没有对话能力 | 只记账，不参与对话；@ 它时系统代答"这是服务账号，去问它的宿主人" |

**最重要的设计判断：不要假装一个已经结束的 CLI 会话能被 @ 回来。** Linear 的模型隐含要求 agent 是
常驻服务（有 webhook endpoint）；我们现实里一半的 agent 是临时进程。所以协议里必须有 **presence**
这一位，并且 **UI 上当场说清楚**，而不是让人对着一个永远不会回话的 @ 干等——这正是 docs/51 那套：
**@ 出去的问题带一只钟，到点没人答就按事先说好的默认走，并且出声。**

### 3.3 lumenbox 侧：Involute 就是一道门

把 Involute 做成一个 channel adapter，和 feishu / telegram 同构：

```
involute webhook  →  adapter  →  conversation "involute:INV-537"  →  agent 一个回合
                                                                  →  回答 commentCreate 回去
```

这样白拿：会话历史、身份到 principal 的映射、跟进 rails（@ 出去的问题会过期）、任务板、
attention 面板、审计、预算与 policy gate。**不需要新机制，只需要一个 adapter 和一个 handle 映射表。**

### 3.4 需要 Involute 加的最小集（按依赖排序）

1. **agent 作为评论作者**：`commentCreate` 接受 AGENT actor，展示 handle 而不是它背后的人。
2. **`@handle` 解析到 actor** + 新事件 **`agent.mentioned`**（带 work、comment、mention 上下文，
   最好照 Linear 的 `promptContext` 拼好）。
3. **按 presence 投递**：把 "Agent actors never receive notifications" 改成"常驻的走 webhook、
   按需的进 inbox、服务型不投"。
4. **actor 上加 `handle` 与 `presence`** 两个字段。
5. **`agent_inbox` 读接口 + 游标**（给会话型 agent 在启动时拉取）。
6. *（可选，先不做）* session / activity 信封。先用 comment thread + 一条事件就够；
   等真的需要把 plan 和 thought 可视化，再升级到 Linear 那套。

### 3.5 协议：一页纸，谁都能对

**Involute Agent Protocol v0**，四节：

- **注册**：handle、presence（`always-on` / `on-demand` / `service`）、scopes、（常驻的）webhook URL。
- **接收**：常驻——签名的 `agent.mentioned` POST；按需——`agent_inbox(since: cursor)` 拉取。
- **回答**：`commentCreate` 作为自己；**必须带证据引用**（run id / PR / evidence / transcript 位置），
  没有就明说没有。
- **超时**：按需 agent 的 mention 带一只钟；到点没答，系统在 thread 里说一句"它没被运行，
  这条问题过期了"，并可指定一个代答人（它的宿主人，或它所在 box 的常驻 agent）。

### 3.6 一条非技术的硬要求：不许编依据

让 agent 解释"你当时为什么这么判断"，是**最容易得到一段漂亮瞎话**的提问方式。所以协议层面要求：
回答里的每一条依据都必须是**可点开的引用**（run、PR、evidence、transcript 的具体位置）；
拿不出引用时，标准答案是"当时的记录里没有依据，我现在重新看了一遍，结论是 X"。
这和 docs/20 的 completion standard 是同一条规矩。

## 4. 分阶段

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0** | 每个 agent 一把 `inv_agent_*`，lumenbox 按 agent 注入；**顺带堵上"agent 能自己 commit"这个洞** | 无，今天就能做 |
| **P1** | Involute：mention 解析、`agent.mentioned` 事件、agent 作为评论作者 | Involute 侧改动 |
| **P2** | lumenbox：Involute door（mention → 回合 → 回答写回） | P1 |
| **P3** | presence + on-demand inbox + 过期与代答 | P1、P2 |
| **P4** | *(可选)* session / activity 信封 | 有真实需求再说 |

## 5. 风险与边界

- **回声循环**：agent 的回答又触发事件 → 自己 @ 自己。需要"agent 自己的 comment 不产生给自己的
  mention 事件" + 事件 id 去重（社区实现踩过 AgentSession 与 Comment 双事件重复触发同一次运行）。
- **谁付钱**：@ 一个 agent 等于让它跑一个回合，必须走 policy gate 与预算（我们有）。
- **权限**：能在 INV 上评论的人 ≠ 能驱动一个 box agent 的人。mention 必须映射到 principal 的 role，
  driver 以上才真的开回合，否则 INV 的评论框就成了绕过 lumenbox 权限的后门（docs/52 M1/M2）。
- **不做**：不把 Involute 变成聊天工具。thread 是为了"问清一条判断的依据"，不是日常沟通；
  日常沟通在飞书，那边已经有门。

引用：Involute `GET /docs/api.md`、`protocol_get_guide`（2026-09-15 取）、
Linear 开发者文档（agents / agent-interaction / agent-best-practices）、docs/51 §3、docs/52、docs/20。
