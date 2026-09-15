# Octop：问题、挂着的工作与定时任务是怎么处理的

2026-09-14 只读检查 `~/sdcard/source/Octop`（TencentCloud/Octop 1.0.0，Python 3.12，
FastAPI + LangChain，自托管、多用户多 agent）。引用是该树里的 file:line。
看它是因为它和我们形状最接近：多人、多 agent、有 IM 通道、有定时任务、有 HITL。

## 1. 没人答的问题：惰性过期，不自动继续，且**问谁就只认谁**

HITL（human-in-the-loop）有自己的一层：`infra/gateway/hitl/{store,coordinator,format}.py`。

- `HitlPendingStore` 是**进程内**的 pending 表，TTL `_DEFAULT_TTL_SECONDS = 30 * 60`
  （store.py:12），状态 `pending | approved | rejected | expired`（store.py:10）。
- 过期是**惰性**的：没有定时器，读的时候顺手判（`get`、`resolve_for_session`、`_gc`，
  store.py:78/118/185）。到期之后**什么都不发生**——不按默认继续，也不拒绝；人晚了再来
  回答，只会看到 `hitl.expired`（coordinator.py:276/449）。终态记录在 TTL 之后被删掉。
- **一会话只允许一个 pending**：`register` 先把同 session 的旧 pending 置为 `expired`
  （store.py:50-53），而不是悄悄覆盖。
- 问题有 id：`pending_id = secrets.token_hex(2)`（store.py:54），`/approve <id>`、
  `get_pending(pending_id, session_key=, agent_id=)` 三者都要对得上（store.py:74-88）。
- 最关键的一条，和我们 INV-533 撞上同一个坑，它的注释直接写着：
  `resolve_ask_pending` *“Returns None … for questions addressed to a different user in
  the same group chat.”*（coordinator.py:156-168，判定是 `record.user_id != user_id`）。
  **群里另一个人说话不算回答。**
- 多问题是一串：`ask_question_index` + `ask_answers`（store.py:27-28，
  `append_ask_answer` store.py:163-171），一次答一个往前走。

## 2. 定时任务：投递是会话里的一个真回合

`infra/cron/{manager,delivery,trigger,job,tools,task_type}.py`。

- `CronTaskType = "text" | "agent"`，默认 `agent`；prompt ≤ 2000 字，名字缺省取 prompt
  首行（task_type.py:7-53）。
- `CronDeliveryService.deliver` 在**目标会话的锁**里跑
  （`gateway.run_in_session`，delivery.py:66-84），并且**先校验归属**：
  `if session.user_id != command.user_id: raise ValueError(...)`（delivery.py:72-75）。
  多用户系统里这是我们还没有的一道门。
- `fresh_thread` 可以把会话重置再跑（delivery.py:68）。
- text 模式把这次投递写成 thread 里的一对规范消息，id 是
  `cron:{delivery_id}:human` / `:assistant`（delivery.py:104-113），历史投影、用量记账
  走和人类回合同一条路。**定时产物不是旁路，是会话里的一条记录。**

## 3. 没有找到的东西

搜遍 `src/octop`（`rg -i "expire|remind|overdue|stale|due_date|archive"`）：**没有**任务
到期/老化/逾期提醒，**没有**自动归档，**没有**把口头承诺对账成 job 的机制。命中最多的
文件就是 HITL 那三个（coordinator.py 20 处）、浏览器安装、邀请码与 SSO 的过期。

## 4. 对我们的三条借鉴

1. **“问谁就只认谁”**是别人踩过并且修过的：我们的 INV-533 与它的 `resolve_ask_pending`
   是同一条判定。它甚至连“同群另一个人”这个具体场景都写在 docstring 里。
2. **一会话一个 pending，且旧的被显式 `expired`**，不是被覆盖——我们的 `superseded` 判决
   是同一个动作。
3. **定时投递校验 session 归属**（`session.user_id != command.user_id`）。我们的例程投递
   目前只认 chatKey，多人之后这会是个洞：记进 multiuser 的待办，不在本轮改。

它在“挂着的工作”这一维上和 Hermes / OpenClaw / WorkBuddy 一样：有 due 的概念也不推送，
没有老化，没有归档。四家全都没做的那一步，仍然只有我们在做——这也是为什么 INV-532
（等待不是弃单）必须存在：别人不做这一步，就不会有别人的经验替我们兜底。
