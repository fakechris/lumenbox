<!-- doc: README.zh
     title: LumenBox 使用手册
     family: manual
     status: current
     covers: manual
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# LumenBox 使用手册

[English](README.md) · 中文

怎么用 LumenBox：你会遇到的每样东西各占一页。安装请先看 [docs/37](../37-onboarding.md)；想知道某样东西是什么、在哪里找，就来这里。

每一页的结构都一样：它是什么，在 app 里、在聊天里、在命令行里分别怎么做，在哪里看结果，它的限制，以及接下来读什么。用词遵循[术语表](../glossary.md)。设计记录说明*为什么*；这本手册说明*怎么做*。

## LumenBox 是什么

你自己的一支 AI agent 团队，每个 agent 都有一台真正的电脑可用。你可以从桌面和聊天 app 找到它们，随时接管，并且凭记录而不是凭它们自己的话来相信它们。下表是 [docs/02 §1.1](../02-product.md#11-how-it-differs) 的简写版，那里写明了每一行靠什么来问责。

| | LumenBox | 单个编程 agent CLI | 托管 agent 平台 |
|---|---|---|---|
| **电脑** | 一台 Linux box，每个 agent 一个桌面，比任何会话活得都久 | 你自己的电脑，只用于一次会话 | 每次会话一个沙箱，会话结束就没了 |
| **在哪里找到它** | app，以及飞书、钉钉等聊天 app；同一个人在所有地方都是同一个人 | 启动它的那个终端 | 一个 API 和一个控制台 |
| **团队与接管** | 有名字的 agent 互相发消息、互相委派；你随时可以接管一个桌面 | 只有一个 agent；接管就是打断它 | agent 是 API 对象；没有共享屏幕 |
| **记录** | 每一轮的工具调用和结果，都保存在你的电脑上 | 一台笔记本上的一份对话记录 | 由厂商保存的会话历史 |
| **谁来说“完成”** | 你，凡是有人要检查的工作都由你决定 | agent 自己，在它停下的时候 | 运行的状态 |
| **在哪里运行** | 默认在一台电脑上；控制平面可选 | 开发者的电脑 | 厂商的云 |

## 你会遇到的一切

每个概念一行。**在聊天里**是指你在飞书或钉钉聊天中输入的内容。短横线表示那里暂时还没有入口。

| 概念 | 在 app 里 | 在聊天里 | 命令行 | 状态词 | 页面 |
|---|---|---|---|---|---|
| box | 设置 → Box；box 栏里的 `+ box` | `桌面`, `屏幕` | `agentbox box up`, `box list`, `box status`, `box attach` | box 在线 · box 不可用 | [box](box.zh.md) |
| agent | 侧栏 `+`；配置；设置 → 团队 → Agent | `@name`, `团队` | `agentbox agents`, `agentbox agent new` | 运行中 · 等你处理 · 已暂停 | [agent](agent.zh.md) |
| 团队 | 配置 → 团队；侧栏里的 `teams` | `团队` | — | 在或不在某个 agent 上 | [agent](agent.zh.md) |
| 小队 | 新建 agent → 从目录添加 | — | — | 在目录中 · 已添加 | [模板](templates.zh.md) |
| 模板 | 侧栏 模板 → 套用到 | — | `agentbox template import`, `share`, `download` | 已暂存 · 已套用 | [模板](templates.zh.md) |
| 配置版本 | 配置 → 历史；`config vN` 标签 | — | — | 生效中 · 从下一轮起生效 | [agent](agent.zh.md) |
| 工具权限 | 配置 → 工具 标签 | — | — | 允许 · 先问我 · 关闭 | [确认](approvals.zh.md) |
| 渠道 | 设置 → 渠道 → 添加渠道 | 聊天本身；`bind <code>` | — | 已连接 · 未连接 | [渠道](channels.zh.md) |
| 群 | 设置 → 渠道，群规则 | 这个群 | — | 仅在被点名时 · 全部回答 | [渠道](channels.zh.md) |
| 连接器 | 设置 → 渠道 → 连接器 | — | — | 已连接 · 未连接 | [渠道](channels.zh.md) |
| skill | 在聊天框里输入 `/` | — | `agentbox skills import`, `skills improve` | 在某个 box 中存在或不存在 | [skill](skills.zh.md) |
| 给 Claude Code 和 Codex 用的 LumenBox skill | 设置 → 我的 → 你的 MCP token | — | `agentbox skill install` | — | [skill](skills.zh.md) |
| 记忆 | 设置 → 记忆 | — | `agentbox backup` 会复制它 | 有效 · 已撤回 | [记忆](memory.zh.md) |
| 团队记忆审核 | 设置 → 团队 → 团队记忆 | — | — | 等待中 · 已批准 · 已拒绝 | [记忆](memory.zh.md) |
| 任务 | 任务 标签页 | `看板`, `可以`, `停`, `/continue`, `/recover` | `agentbox usage --task tN` | open · doing · blocked · review · done · dropped | [任务与记录](tasks-and-records.zh.md) |
| 交付物 | 任务详情 → 交付物 | 文件出现在聊天里 | MCP `fetch_deliverable` | 已交付 | [任务与记录](tasks-and-records.zh.md) |
| 分工 | 任务详情 → 分工；分支挂在各自的线程下 | — | — | 已发出 · 已开始 · 已隔离 · 已汇报 · 已合并 · 已放弃 | [任务与记录](tasks-and-records.zh.md) |
| 记录 | 审计 标签页 | — | `agentbox usage`, `audit export`, `scan-records` | 只追加 | [任务与记录](tasks-and-records.zh.md) |
| 确认 | 聊天里的确认卡片；设置 → 我的 | `允许`, `一直允许`, `本次会话`, `拒绝` | `~/.agentbox/rules` | 等待中 · 已允许 · 已拒绝 · 已过期 | [确认](approvals.zh.md) |
| 凭据检查 | “开始前需要”卡片 | `… 开始前需要：` | — | 缺失 · 即将过期 · 已就位 | [确认](approvals.zh.md) |
| 例行任务 | 自动化 标签页；设置 → 团队 → 例行任务 | `定时` | `agentbox routines runs <slug>` | 关闭 · 观察 · 自动；已暂停 | [自动化](automations.zh.md) |
| 目标 | 设置 → 监督 | `/goal <text>` | MCP `goal_start` | 进行中 · 验证中 · 已暂停 · 已完成 · 已清除 | [监督](supervision.zh.md) |
| 看门狗 | 设置 → 监督 → 看门狗 | 任务聊天里的一条提醒 | `agentbox watchdog` | 开 · 关 | [监督](supervision.zh.md) |
| 监督者 | 设置 → 监督 → 开始受监督的目标 | — | `agentbox supervise` | 排队中 · 运行中 | [监督](supervision.zh.md) |
| MCP 端点 | 设置 → 我的 → 你的 MCP token | — | `agentbox mcp` | token 有效 · 已吊销 | [skill](skills.zh.md) |
| 机主（Owner） | 设置 → 团队 → 人员：Owner · 机主 | — | — | 机主，唯一的人 | [渠道](channels.zh.md) |
| 管理员（Admin） | 设置 → 团队 → 人员：角色 admin | `bind <code>` | — | 观察者 · 操作者 · 管理员 | [渠道](channels.zh.md) |

## 边界

每一条都是“看起来像另一样东西”的一样东西，以及到哪里确认你手上是哪一种。

- **box 在运行，不等于 agent 在干活：** box 可以开着，而每个 agent 都闲着或已暂停。看侧栏：底部显示 `box online`，每个 agent 那一行显示运行中、等你处理或 `paused`。
- **一轮结束，不等于工作被验收：** 带有验收标准、截止日期或外部依赖的任务，在一轮结束时会进入 `review`，由你来决定 `done`。在任务标签页查看该任务的历史：“turn ended; not closed because … — stopped, not verified”。
- **agent 的提议，不等于已经认定的工作：** agent 提议的任务带着 `proposed` 标签，直到有人按下立项。在任务标签页打开 `inbox` 查看。
- **导入模板，不等于有了一个能干活的 agent：** 导入会新建一个 agent，它在第一轮安装自己的配方，并索要它需要的东西；群只能通过渠道找到它。在这个 agent 的聊天里找“开始前需要”卡片，并在设置 → 渠道查看它的默认 agent。
- **观察模式只报告、不行动：** 处于观察模式的例行任务只记录“本来会运行”，实际什么都不运行。在自动化标签页查看：“would have run N times”。
- **保存的配置，不等于正在运行的配置：** 改动从 agent 的下一轮起生效。看配置旁边的标签：`config v3 · v4 next turn`。
- **机主不是管理员：** 机主是你的个人安装（你电脑上的桌面应用）里唯一的人；管理员管理组织，组织是另一个独立的安装。个人安装永远不会让第二个人加入。在设置 → 团队 → 人员查看：它显示 Owner · 机主，或者显示角色，不会两者都显示。
- **“一直允许”不是一揽子同意：** 它只允许那一个确切的操作，只对那一个 agent，直到你撤销为止。在设置 → 我的 → 长期确认查看。

## X 和 Y 有什么区别？

**团队、小队和默认 agent。** *团队*是给同一个 box 里的 agent 贴的标签，让它们列在一起；一个 agent 最多可以在 5 个团队里。*小队*是目录里的一个条目，一步添加多个 agent，作为一个团队。*默认 agent* 负责回答渠道里没有点名任何人的消息；你在设置 → 渠道里为每个渠道分别设置它。

**目标和任务。** *任务*是看板上的一项工作，有状态和历史。*目标*是处理一个任务的一种方式：`/goal <text>` 先起草一份检查清单，一轮接一轮地推进，到预算时暂停，检查通过时完成。每个目标都挂在一个任务上；大多数任务没有目标。

**skill、模板和目录 agent。** *skill* 是 box 里的一个 `SKILL.md` 文件：请求匹配时 agent 会读的说明。*模板*是一个完整保存下来的 agent——人设、skill、例行任务和约定——套用它就会新建一个 agent。*目录 agent*（代码里叫 `expert`）是目录里的一个条目，对应一个带有一组工具和 skill 的 agent；添加它就会建出那个 agent。

**看门狗和监督者。** *看门狗*默认开启，只负责提醒：工作停滞不动了，或者系统停掉的某个目标没人去看。*监督者*是可选的：另一个模型替你启动一个目标，并一直盯到结束。两者都不能把工作标为完成，不能提高预算，也不能碰 box。

**渠道和 box。** *渠道*是人找到 agent 的途径：聊天平台上的一个应用，比如一个飞书应用。*box* 是 agent 干活的地方：一台 Linux 电脑，每个 agent 一个桌面。渠道通向一个 box；一个 box 可以有多个渠道。

**回忆和档案。** *回忆*是 agent 用来搜索自己记得的内容的工具，按字词也按含义搜索。它的*档案*（box 里的 `profile.md`）是同一份记忆的只读副本，由主机重写；在那里做的修改会丢失。agent 对*你*的了解在设置 → 我的 → 关于我。

**确认和工具权限。** *工具权限*在工作开始前设定：agent 能不能用某个工具，或者用之前必须先问。*确认*是对某一次请求的当场回答。“先问我”权限是会弹出确认卡片的原因之一。

## 团队

可以照搬的完整设计：谁做什么，一次真实运行花了多少、是怎么测的，怎么搭出最小版本，以及运行时该盯什么。

| 团队 | 用来做什么 | Agent | 记录在案的成本 | 页面 |
|---|---|---|---|---|
| ship（研发小队） | 代码：一份规格、一次改动、一次由别人做的评审 | Mo, Lin, Heng | 一个评审者的几轮 | [ship](teams/ship.zh.md) |
| media-desk（内容小队） | 内容：一份素材变成一篇文章、一条笔记和一份脚本 | Jian, He, Jing | 尚未测量 | [media desk](teams/media-desk.zh.md) |
| 入门团队 | 你的群的第一联系人、调研、机器操作和检查 | Ada, Rex, Ops, Vera | docs/83 测量过的几次运行 | [入门团队](teams/starter.zh.md) |

## 页面

概念：[box](box.zh.md) · [agent](agent.zh.md) · [渠道](channels.zh.md) ·
[模板](templates.zh.md) · [skill](skills.zh.md) · [记忆](memory.zh.md) ·
[任务与记录](tasks-and-records.zh.md) · [确认](approvals.zh.md) ·
[自动化](automations.zh.md) · [监督](supervision.zh.md)。

团队：[ship](teams/ship.zh.md) · [media desk](teams/media-desk.zh.md) · [入门团队](teams/starter.zh.md)。

参考，由代码生成：[聊天命令](reference-commands.zh.md) ·
[设置面板](reference-settings.zh.md) · [工具](reference-tools.zh.md) ·
[随附的 skill](reference-skills.zh.md) · [模板架](reference-templates.zh.md) ·
[规则语法](reference-rules.zh.md) · [提示词组成部分](reference-prompt-parts.zh.md)。
