<!-- doc: handoff-2026-09-15-involute-agent-threads
     title: Handoff — Involute 侧：agent 身份与工作项上的对话
     family: handoff
     status: current
     updated: 2026-09-15
-->
# Handoff — Involute 侧：agent 身份与工作项上的对话

设计在 [docs/54](54-agent-identity-and-threads.md)（v3）。这份是**给 Involute 仓库里另一个
session 的工单**：哪些是白拿的、哪些要建、按什么顺序、验收是什么。所有结论都在
`~/workspace/Involute` 里核对过，带 file:line。

## 0. 结论先行：三件事比想象中简单，一件事比想象中要紧

**白拿（零开发）：**

- `User.actorKind: ActorKind @default(HUMAN)`（`packages/server/prisma/schema.prisma:143`），
  `Comment.userId → User`（`:280`），`commentCreate` 用 `requireAuthentication(context)` 并把
  `viewer.id` 写成作者（`packages/server/src/schema.ts:2359-2369`）。
  **所以"agent 以自己的身份 comment"今天就能做**——只要这个 agent 有自己的 User 行
  （`actorKind = AGENT`）并且用自己的凭证调用。今天看起来"都一样"，是因为我们的凭证挂在
  `Admin`（HUMAN）这个 User 上。
- `AgentCredential.userId → User`（`schema.prisma:163-177`），一个 agent User 可以有多把凭证：
  **换 token 不换作者身份**，这正是 docs/54 §B1 要的。
- 事件基础设施是现成的：`event-outbox.ts` 有 HMAC 签名、`OUTBOX_CLAIM_LEASE_MS`（60s 认领租约）、
  `BACKOFF_SCHEDULE_MS`（5 次退避）、死信与自动停用。**新事件类型只是往 `WORK_EVENT_TYPES`
  （`event-outbox.ts:8`）里加两行 + 在写评论的事务里投递。**

**要紧的那件：**`Comment` 今天**没有 parent**（`schema.prisma:273-286`：id/body/createdAt/
updatedAt/issueId/userId/attachments），所以"一条工作项上多个并行的追问互不串线"需要
**先加 `parentCommentId`**。docs/54 §C 的多轮模型压在这一条上。

## 1. 要建的东西（顺序即依赖）

### B1 · mention 解析成 actorId（不是让 sidecar 匹配字符串）

- 新表 `CommentMention { commentId, actorId, createdAt }`，唯一键 `(commentId, actorId)`。
- 在 `createComment`（`packages/server/src/issue-service.ts:523-548`）的**同一个事务**里解析
  `@handle` → User（`actorKind = AGENT`）→ 写 mention 行。
- 解析规则要明确：代码块与行内 `code` 里的 `@` 不算；编辑评论时按差集补/删 mention；
  撤回 `@` 是否等于取消请求，要在 B3 里写死。
- **理由**：sidecar 匹配字符串的话，两个 sidecar 会重复触发，代码块里的 `@foo` 会变成幽灵请求。

### B2 · 两个事件：`comment.created`、`agent.mentioned`

- 加进 `WORK_EVENT_TYPES`（`event-outbox.ts:8-24`），沿用现有签名/重试/租约，不新起一套。
- `agent.mentioned` 的 payload 至少带：work id/identifier、commentId、rootCommentId、
  发言 actor、目标 actorId、正文、以及**拼好的上下文**（Linear 的 `promptContext` 同款——
  让消费者不用自己去凑：合同、验收标准、最近的 run 与 evidence）。

### B3 · 请求账本（这一条是整件事的地基）

- 新表 `AgentRequest`：`id, workId, rootCommentId, targetActorId, requestedByActorId, body,
  state, deadlineAt, canceledAt, claimedBy, claimedAt, answeredCommentId, payingPrincipal,
  idempotencyKey`。
- **状态机直接借 A2A**（不自己发明）：`submitted → working → input-required → completed |
  failed | canceled`。
- **认领与应答在服务端**：`claim`（带租约，同 `OUTBOX_CLAIM_LEASE_MS` 的思路）→ `ack/answer`。
  两个消费者同时在线**只有一个**能领到；答复写 `answeredCommentId` 之后才算 completed。
- MCP 工具三个：`agent_inbox(since|cursor)`、`agent_request_claim(id)`、
  `agent_request_answer(id, body, evidence[])`。scope 复用现有 `report`/新增 `answer`。
- 过期：服务端计时。**过期文案只说"期限内没有答复"**，不能推断"它没运行"。

### B4 · 线程：`Comment.parentCommentId`

- 自关联 + `@@index([parentCommentId, createdAt])`；`comments(first:)` 支持按 root 取。
- 一条工作项上可以有多条线程；每条 `AgentRequest` 锚在一个 rootCommentId 上。

### B5 · 通知策略从"agent 一律不收"改成"按消费者投递"

- 今天 `docs/api.md` 写着 "Agent actors never receive notifications"。改成：
  有活跃消费者就推（webhook/SSE），没有就留在 inbox 里等人来领，并在 UI 上**显示"未答 + 该找谁"**。
- 顺带把 Linear 那套**说实话的状态**抄过来：10 秒内没有活动显示 `unresponsive`，
  30 分钟无后续进 `stale`（可恢复）。人最需要知道的是"它到底会不会回我"。

### B6 · P3/P4 的两个字段（可以晚做，但现在就定下名字）

- `User.successorActorId`：期限到了由谁接单；答复必须写明代答关系与依据来源，**禁止冒名**。
- `User.agentCardUrl`：A2A 的 Agent Card（`/.well-known/agent.json`）。有了它，
  "接谁"是数据不是代码，换 runtime 不改服务端。

## 2. lumenbox 侧（我来做，不占 Involute 的 session）

- **P0-a（INV-550）**：为每个会写 INV 的 agent 建 User(`actorKind=AGENT`) + credential；
  lumenbox 按 agent 注入；**从 agent 可读的位置移除管理员 bearer**，并验证 `work_commit` 被拒。
- **P0-b（INV-551）**：decision receipt——做判断的当时写下 actor/run/audit revision/理由/证据版本。
- **P2（INV-553）**：受限的解释请求消费者（不开任务卡、出站按受众过滤、以被问 agent 的身份回帖）。
- **P1-b（INV-554）**：每个 actor 一个有界队列，第一版单并发。

## 3. 验收（每条都能跑）

- A1 两个 agent 各写一条 INV，audits 的 `actorId` 不同；agent 调 `work_commit` 被拒。
- A2 一条评论 `@mia` 写进 `CommentMention`，代码块里的 `@mia` 不写。
- A3 两个消费者同时轮询，同一条请求只有一个领到；答复失败时状态不是 completed。
- A4 服务器在"收到"与"答复"之间重启，请求仍在、不重复答。
- A5 同一工作项两条线程并行追问，互不串线。
- A6 期限到了没人答，UI 显示"未答 + 该找谁"，文案不含"它没运行"。
- A7 successor 代答的答复带代答关系与依据来源；以原 actor 身份发帖被拒。

Involute 仓库的门是 `pnpm lint` / `pnpm typecheck` / `pnpm test`（`package.json`）。

## 4. 给新 session 的开场白（可直接粘）

> 我在 `~/workspace/Involute` 做 agent 身份与工作项对话的服务端部分。设计与工单见
> `/Users/chris/source/research/grokbot/agentbox-tier0/docs/54-agent-identity-and-threads.md`
> 与 `.../docs/handoff-2026-09-15-involute-agent-threads.md`（后者有 file:line 与验收）。
> 先读这两份，再读本仓库 AGENTS.md，然后按 B1 → B2 → B3 → B4 的顺序做，一条一个 PR，
> 每条都要有 A1–A7 里对应的验收测试。B3 的状态机照 A2A 的命名，不要自己发明。
> 开工前先 `work_search` 看这些是否已有工单，没有就 `work_propose`（repository
> `fakechris/Involute`），claim 之后再动代码。

## 5. 分工的理由

绝大部分是 Involute 侧（B1–B5 全部），所以**另开一个 session 在 `~/workspace/Involute` 做**是对的：
它需要那个仓库的 AGENTS.md、Prisma、pnpm workspace 与测试门在上下文里；而且我们自己的约定是
**一个 agent 一个 worktree**（`~/workspace` 下已经有 6 个 Involute worktree 在跑别的分支）。
我留在 lumenbox 侧做 §2 的四件，两边在 docs/54 这份契约上对齐。
