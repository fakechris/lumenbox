<!-- doc: agent.zh
     title: Agent
     family: manual
     status: current
     covers: agent
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# Agent

你与之对话的那一位：怎样创建 agent、配置它，以及查看正在运行的是哪个版本。

## 这是什么

**agent** 是一个有名字的 AI，在一个 box 里工作，有自己的桌面、记忆、skill 和工具。几个 agent
组成你的团队：它们互相发消息，也互相交接工作。**团队**是一个标签，把 agent 列在一起；一个 agent
最多可以属于 5 个团队。

保存的配置不等于正在运行的配置：改动从 agent 的下一轮起生效，已经在跑的一轮沿用开始时的版本。到*配置*旁边的
`config vN` 标签查看。

## 怎么做

### 在 app 里

- **创建 agent：** 在侧边栏 *Agent* 旁边按 `+`。可以自己写一个，也可以选*从目录添加*。要从保存过的 agent
  创建，用侧边栏的*模板*按钮。
- **配置它：** 选中 agent，按*配置*。*设置*标签页里有它的名字、*角色标签*、*团队*（用逗号分隔）、box、
  *人设*、工具和*常驻文件*。
- **查看它的版本：** *配置* → *历史*。勾选两个版本后按*比较所选*，或者按*回到此版本*。
- **暂停它：** 设置 → 团队 → Agent → *暂停*。按*恢复*让它重新工作。

### 在聊天里

- `@name <message>`：把这条消息交给那个 agent。
- `团队`（或 `team`）：列出在这里工作的 agent。
- 没有点名任何人的消息，交给这个渠道的默认 agent。

### 在命令行里

```
agentbox agents                      # 列出所有 agent
agentbox agent new <name> [description]
agentbox chat <agent> "<message>"    # 在终端里和一个 agent 对话
```

## 在哪里看结果

- 侧边栏：每个 agent 的那一行显示*运行中*、*等你处理：…*，或一个*已暂停*标签。
- *配置*旁边的标签：`config v3`；新版本等待生效时显示 `config v3 · v4 next turn`。
- 任务标签页上某个任务的详情：*配置版本 vN*，即这项工作运行时用的版本。

## 限制

- 团队：每个 agent 最多 5 个，每个最多 24 个字符，全部小写。
- agent 一直留在创建它的那个 box 里。
- 要停下正在运行的一轮，用*停止*；保存新版本不会让它停下。

## 接下来

- [确认](approvals.zh.md)：agent 不用问就能做什么。
- [Skill](skills.zh.md) 和[记忆](memory.zh.md)：agent 知道什么。
- [模板](templates.zh.md)：保存一个 agent，或从保存的 agent 创建一个。
