---
name: involute-inbox
description: "Answer the questions people put to you on Involute work items. Poll your own inbox, claim one request, read the work item, answer in the thread with citations — or say plainly that the record does not show why. Use when somebody @-mentions you on a work item, or when you are asked to check your Involute inbox. Triggers: 'involute inbox', 'check my mentions', '有人在 INV 上问我', 'answer the mention'. Requires: the involute MCP server, configured with your own inv_agent_ credential."
description_zh: "回答别人在 Involute 工作项上 @ 你的问题：认领、读上下文、带出处地回答"
description_en: "Answer @-mentions on Involute work items: claim, read, answer with citations"
version: 1.0.0
allowed-tools: mcp__involute__agent_inbox, mcp__involute__agent_request_claim, mcp__involute__agent_request_answer, mcp__involute__work_get_context, Read, Grep
---

# Involute inbox — 回答别人 @ 你的提问

这是**会话型 runtime**（Claude Code、Codex、或任何一次性跑起来的 agent）接入 docs/57 那份
消费者合同的方式。常驻宿主（lumenbox）由宿主进程自动做这件事，你不需要这个 skill；
**你需要它，是因为你这个会话结束之后就不存在了，没有进程替你轮询。**

前提：`involute` MCP server 已经挂上，并且用的是**你自己的** `inv_agent_…` 凭证
（不是安装的管理员 token）——否则你答出来的东西会署成别人的名字。

## 步骤

1. **看有什么问我的**：`agent_inbox`（`first: 10`）。返回的每一条都是点名给你的请求，
   带 `id`、`work_identifier`、`body`、`deadline_at`、`state`。
   **读不等于占位**——没认领之前，别人随时可能拿走。
2. **挑一条，先认领**：`agent_request_claim({ id })`。
   - 被拒（已被别人持有）→ **安静跳过，换下一条**。这是正常情况，不是错误。
   - 一次只做一条。二十条同时 @ 你，不代表要同时开二十个回合。
3. **读它问的是什么**：`work_get_context({ id: work_identifier })` 取合同、验收标准、最近的
   run 与 evidence。如果问题指向某个 PR、run 或文件，**去读它**，不要靠印象。
4. **回答**：`agent_request_answer({ id, body, state })`
   - `state: "completed"` — 你回答了。
   - `state: "input-required"` — 你需要对方先给材料；把要什么问清楚，请求会保住位置。
   - `state: "failed"` — 你确实做不了这件事；说明原因，不要沉默。

## 回答的规矩（这部分比流程重要）

- **带出处**：run id、PR、测试、记录里的哪一行，链接出来。
- **拿不出出处就直说**：「当时的记录里没有写为什么」，然后给出你**现在**重新推导的结论，
  并标明这是重新推导的。**不要编一个听起来对的理由**——被问"你当时为什么这么判断"时，
  一段流畅的虚构是最容易给出、也最坏的答案。
- **不要汇报状态**：对方看得到看板。回答他问的那一个问题。
- 答案会以**你的身份**出现在那条线程里，别人能看到。写成你愿意署名的样子。

## 做完之后

`agent_inbox` 再看一眼：还有没有点名给你的。没有就结束——**不要**去认领没有点你名的请求，
也不要替别的 agent 回答（第一版里，agent 之间不互相开请求，这是刻意的）。
