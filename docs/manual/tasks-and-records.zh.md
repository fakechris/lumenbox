<!-- doc: tasks-and-records.zh
     title: 任务与记录
     family: manual
     status: current
     covers: task
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# 任务与记录

本页讲正在做的事情所在的看板、工作怎样被验收，以及显示实际发生了什么的记录。

## 这是什么

**任务**是看板上的一件工作：有标题、提出人、负责人、状态和历史。聊天里的一个请求会变成一个任务；你也可以自己添加。状态有 `open`、`doing`、`blocked`、`review`、`done` 和 `dropped`。**交付物**是 agent 在一个任务上交出的文件。**记录**是每一轮实际做了什么：每次工具调用及其结果。记录保存在你的电脑上，与 agent 对自己的描述分开。

一轮结束不等于工作已验收：任务有验收标准、截止日期或外部依赖时，一轮结束会把它移到 `review`，由人来决定 `done`。请查看任务的历史：“turn ended; not closed because … — stopped, not verified”。普通的一次性问题，答完就关闭。

agent 的提议不等于商定的工作：agent 提议的任务带有 `proposed` 标签（界面显示为 *已提议*），在有人点 *立项* 之前，没有人会接手它。

## 怎么做

### 在 app 里

- **添加任务：** 任务 标签页 → 在 *新任务标题…* 里输入，选一个 agent 或保留 `unassigned`（*未分配*），然后点 *添加*。
- **查看需要你处理的事：** 看板把等你处理的事排在最前面。点 `inbox`（*收件箱*）只看 agent 提议的事项；点 *立项* 把一项变成真正的工作，或点 *关闭* 把它关掉。
- **验收工作：** 在任务那一行把状态设为 `done`。如果指定了审核人，负责人设的 `done` 会把任务移到 `review`，由审核人来关闭。
- **打开任务：** 点它的编号或标题。详情里有 *交付物*（每个文件都有 *下载*）、*配置版本 vN*（它运行时用的 agent 设置）、*分工*，以及带证据的历史。
- **跟进分工：** agent 拆分任务时，每一部分作为一个**分支**（fork）运行：分支是这个 agent 的一个副本，带一句话的任务说明。分支折叠在发起它们的对话下面（`▸ 2 forks · 1 done · 1 running`），任务的 *分工* 显示每个分支的链条：sent → started → reported → merged。
- **查看记录：** 审计 标签页显示每次工具调用。*隐藏系统探测* 默认开启。

### 在聊天里

- `看板`（或 `board`）：查看看板；等你处理的任务在 待验收 下面。
- `可以`（或 `收到`、`通过`、`ok`）：验收等你处理的任务。只有任务处于 `review` 时才算数；否则只是普通聊天。
- `停`（或 `stop`）：停止正在运行的工作并撤回它的任务。
- `/continue <task> <text>`：给你的一个正在运行的任务追加一条指示。
- `/recover t<number>`：根据记录重建一个任务并继续（仅限私聊）。
- 交付物会作为文件随回复一起发到聊天里。

### 在命令行里

```
agentbox usage --task t12        # 一个任务在各轮里的总花费
agentbox usage --day 2026-11-06  # 一天的花费
agentbox audit export --box <name> --from <date> --out <dir>   # 一个 box 的记录，密钥已打码
agentbox scan-records            # 记录里有哪些内容看起来像凭据
agentbox backup                  # 不停止任何东西，复制 ~/.agentbox
```

从其他工具通过 MCP 调用时，`fetch_deliverable` 读取一个任务的交付物。

## 在哪里看结果

- 任务 标签页：状态、标签（`due …`、`waiting on …`、`proposed`）和历史。
- 任务详情：交付物、配置版本和分工。
- 审计 标签页和 `agentbox usage`：做了什么，花了多少。

## 限制

- 只有提出人、指定的审核人或负责人可以关闭任务。只有提出人或审核人可以放弃任务；任何人都可以关闭一项提议。
- 一个交付物最大 25 MiB。文件打不开、与文件名不符时（例如不是 PDF 的 `.pdf`），会被拒收，agent 必须重新生成。
- 分支的对话是只读的；你要和发起它的 agent 对话。
- `fetch_deliverable` 最多返回 1 MiB；更大的文件请从任务里下载。

## 接下来

- [确认](approvals.zh.md)：agent 行动前要问什么。
- [监督](supervision.zh.md)：目标，以及谁盯着停下来的工作。
- [自动化](automations.zh.md)：会自己开始的任务。
