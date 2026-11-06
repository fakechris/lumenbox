<!-- doc: supervision.zh
     title: 监督
     family: manual
     status: current
     covers: supervision
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# 监督

本页讲一直推进到通过检查才结束的目标，以及工作停下来时由谁发现。

## 这是什么

**目标**是处理一个任务的一种方式：agent 先起草一份检查清单，然后一轮接一轮地推进；清单通过就完成，预算用完就暂停。它的状态有 `active`、`verifying`、`paused`、`complete` 和 `cleared`。**看门狗**盯着每个任务，标记那些不再推进的任务；它默认开启。**监督者**是可选的：它是另一个模型，替你启动一个目标，并一直盯到结束。

标记不等于修复：看门狗只指出哪里不对，不改动任何东西。请查看那个任务：标记会作为一行出现在它的历史里，也会作为一项出现在你的“需要你”列表里。

## 怎么做

### 在 app 里

- **设置：** 设置 → 监督。第一次进入时，一个五步向导会带你走完：它能做什么、模型、agent 和预算、第一个目标、启动。
- **修改看门狗：** 在 *看门狗* 一节修改，然后点 *保存监督设置*。
- **启动受监督的目标：** 写下完成是什么样子，然后点 *开始受监督的目标*。这会在你的看板上建一个任务；监督者盯着它期间，任务标有 `supervised`（界面显示为 *受监督*）。
- **查看运行情况：** *监督者运行记录* 一节。

### 在聊天里

在与 agent 的私聊里：

- `/goal <what done looks like>`：启动一个目标；它的第一轮会起草检查清单。`--budget <amount>` 设定预算。
- `/goal`：显示当前目标。
- `/goal pause`、`/goal resume`、`/goal clear`：暂停、恢复或清除目标。
- `/goal replace <text>`：更改目标的内容。

看门狗的标记也会作为一条通知出现在该任务的聊天里。

### 在命令行里

app 会替你运行看门狗和监督者。不用 app、在服务器上时：

```
agentbox watchdog install      # 登录时启动，使用它自己的 token
agentbox watchdog status       # 是否在运行、最近一次标记、最近的日志
agentbox watchdog uninstall    # 停止它并撤销它的 token
agentbox supervise --objective "<what done looks like>" --token-file <file>
```

这些命令暂时还不在 `agentbox --help` 里。token 来自 设置 → 我的 → 你的 MCP token。在桌面端没有人登录时，这份列表属于机主；安装有了更多人之后，属于那位唯一的管理员。监督和看门狗的 token 都在这份列表里，点 撤销 就能停掉其中任何一个。在这种情况下，`agentbox watchdog install` 不需要 `--principal`。

## 在哪里看结果

- 任务：目标的检查清单和状态，以及历史里的看门狗标记。
- 你的“需要你”列表，在侧边栏顶部和 任务 标签页顶部。
- 设置 → 监督 → 监督者运行记录。

## 限制

- 看门狗和监督者都不能把工作标为完成，不能恢复被系统停止的内容，不能提高预算，也不能动 box。
- 看门狗会标记两类情况：手上的工作 60 分钟没有变化；被系统停止的目标 30 分钟没人处理。你自己暂停的永远不会被标记。
- 受监督的目标要花两份钱：监督者的模型和 agent 的模型。
- `/goal` 只在私聊里有效，在群里无效。

## 接下来

- [任务与记录](tasks-and-records.zh.md)：目标所在的看板。
- [自动化](automations.zh.md)：会自己开始的工作。
- [docs/91](../91-watchdog.md)：看门狗的完整说明。
