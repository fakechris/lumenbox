<!-- doc: ship.zh
     title: 研发小队：一个产品、一个工程师和一个审查者
     family: manual
     status: current
     covers: crew:ship
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# 研发小队：一个产品、一个工程师和一个审查者

本页给出一个可以照搬的代码工作设计：一个 agent 写规格，一个负责实现，另一个负责审查。

## 架构

`ship` 小队（app 里叫研发小队）从目录添加三个 agent。它们在同一个 box 里，各有自己的桌面和文件。这种分工是实打实的，因为三个 agent 能做的事不同，而不只是描述不同。

| 角色 | Agent | 做什么 | 能碰什么 | 不做什么 |
|---|---|---|---|---|
| 产品 | Mo（产品） | 把一个愿望变成规格：给谁用、怎样算做成、哪些不做 | box 里的文件、飞书文档（`ReadFeishuDoc`） | 写代码 |
| 工程师 | Lin（工程师） | 写代码、跑代码；把大的改动交给编码引擎 | 文件、shell、用 `Delegate` 交给编码引擎 | 决定要不要做 |
| 审查者 | Heng（审查） | 在一个审查文件里检查改动的正确性和安全性 | 文件和 shell；不用外部服务 | 重写它审查的代码 |

```
you ──▶ Mo ── spec in /home/box/work ──▶ Lin ── change + tests ──▶ Heng ── review file
 ▲                                                                       │
 └──────────── the task moves to review; you decide done ◀───────────────┘
```

## 核心设计

### 提示词

每份人设用中文写成，每一轮都会重新读取（`src/host/catalog-data/experts/`）。每份人设都写明自己的交接：Mo 为 Lin 写规格，Lin 交给 Heng，Heng“不修改被审查的代码”。Lin 的规则是：测试失败就不算完成；引擎说的“finished”要等 Lin 重新跑过，才算结果。

### 工具与权限

- Mo 拥有桌面工具（文件、任务、记忆、队友和 box 的 MCP 服务），外加 `ReadFeishuDoc`。
- Lin 拥有桌面工具外加 `Delegate`，没有浏览器：仓库由编码引擎去读。
- Heng 拥有桌面工具，但不含 MCP 服务，因为服务的工具可能会写入。
- 在 配置 → 工具 里把每个工具设为放行、问我或关闭。任务卡片上的*把关*一行统计每一步：已放行、已问你、等你确认、已拒绝。

### Skill

skill 随每个 box 一起提供，所以人设只需说明什么时候读哪一个：Mo 读 `grill-me`、`market-researcher` 和 `deep-research`。Lin 读 `diagnose`、`fullstack-dev`、`grill-me` 和 `code-review`。Heng 读 `code-review`、`diagnose` 和 `fullstack-dev`。

### 记忆

每个 agent 都有自己的记忆。规格、代码和审查都是 `/home/box/work` 下的文件，所以它们比对话活得久，下一个 agent 也从那里读取。要和整个团队共享一条事实，就用团队记忆；由一个人在 设置 → 团队 → 团队记忆 里确认。

### 凭据

这个小队本身不需要任何密钥。编码引擎通过 LumenBox 的模型连接运行；`engine-check` skill 会在 box 里装好一个。私有仓库需要在 box 里放一个 deploy key 或 token。用 设置 → 团队（密钥）保存它，这样会由一张“Before Lin can start”卡片来要它，而不是让 agent 做到一半失败。

## 配置：最小与日常

| | 最小 | 日常 |
|---|---|---|
| Agent | Mo、Lin 和 Heng，在小队给它们放的 `ship` 团队里 | 还是这三个 |
| Box | 默认的 Docker box | 一个在 `/home/box/work` 下检出了仓库、并装好引擎（`engine-check`）的 box |
| 工具 | 保持目录给的设置 | Heng：`edit_file` 关闭；Lin：在你信任它之前，`bash` 设为问我 |
| 审查 | 你自己读 Heng 的审查文件 | 一个以 Heng 为审查者的任务：Lin 的 `done` 把它移到 `review`，Heng 的结论关闭它 |
| 渠道 | 只用 app | 一个飞书或钉钉群，Mo 是默认 agent |
| 花费 | 不设上限 | 在 设置 → 团队 里给每个 agent 设每日上限 |

## 运行成本

**依据：**本安装自己的记录（`~/.agentbox/usage.jsonl` 和 `turns.jsonl`），对象是从 `catalog:heng` 安装的 agent，共 93 轮，时间从 2026-11-03 15:24 到 2026-11-04 02:46 UTC。模型是 MiniMax-M3.1-Flash。金额使用本安装 `config.json` 里的费率，每百万 token：输入 0.30，输出 1.20，缓存读取 0.06，币种就是 `agentbox usage` 打印为 `$` 的那一种。费率表里这些费率登记在 `MiniMax-M3.1-Flash-Preview` 名下。每一行都标着 `cache_unknown`，所以 `agentbox usage` 本身不给出这些轮次的金额。下面的数字假设没有缓存写入，提供商报告的也是 0。

| 项目 | 时间 | 模型调用 | 输入 | 输出 | 缓存读取 | 金额 |
|---|---|---|---|---|---|---|
| 一次审查回复（轮次 `809ab446`） | 478 s | 28 | 83,068 | 70,807 | 2,824,704 | 0.28 |
| 一个典型的审查轮次（71 个正常结束轮次的中位数） | 34 s | 1 | — | — | — | 0.016 |
| 这 71 轮里最贵的一个审查轮次 | — | — | — | — | — | 1.43 |
| 全部 93 个审查轮次（71 个正常结束，13 个停在 60 次调用上限，9 个中止） | 10.8 h | — | — | — | — | 23.73 |

还没有测量的：整个小队完成一个任务。这个安装上没有装 Lin。Mo 唯一的一轮在 2026-09-08，是它的设置轮次，它的用量记录在 48 小时后被压缩掉了。测量方法：安装这个小队，交给 Mo 一项改动去写规格。让 Lin 实现、Heng 审查，并把 `AGENTBOX_USAGE_RETAIN_HOURS` 设得足够长。然后在该任务上运行 `agentbox usage --task tN`。

## 搭一个最小版本

### 在 app 里

1. 点 *Agent* 旁边的 `+`。在*从目录添加*下，点 `研发小队`。
2. 在预览里看一遍三个成员，然后点*创建这 3 个，放到 <box>*。它们会进入 `ship` 团队，侧栏把它们列在 SHIP 下面。
3. 选中 Mo，写下愿望：给谁用，怎样算做成。
4. 规格写进 box 之后，让 Lin 去实现，并把结果交给 Heng。

### 在聊天里

1. 在 设置 → 渠道 里，把群的默认 agent 设为 Mo。
2. 在群里把愿望发给 Mo。后面的步骤分别发 `@Lin` 和 `@Heng` 消息。
3. 发 `看板` 查看任务；任务等你处理时，发 `可以` 接受它。

### 在命令行里

```
agentbox agents                                  # 安装后会列出 Mo、Lin 和 Heng
agentbox chat Mo "给团队写一页说明：……给谁用、怎样算做成、明确不做哪些。"
agentbox usage --task t12                        # 这个任务有了轮次之后，看它花了多少
```

这个小队只能从 app 添加，或者由某个 agent 用 `CreateAgent` 加 `from: ship` 添加；没有安装命令。

## 运行监控

- **侧栏：**每一行显示 `Running`（运行中），或者在 agent 需要人时显示 `Waiting for you: …`（等你处理：…）。这发生在它提问、需要确认、把桌面交给你、碰到花费上限或等待模型提供商的时候。
- **任务 标签页：**健康的任务会从 `doing` 走到 `review`。“turn ended; not closed because …”表示它停下了但没有经过验证；由你决定。
- **卡住：**在 `turns.jsonl` 里以 `incomplete` 结束的一轮，碰到了每轮上限（默认 60 次模型调用）。任务上出现看门狗的一行“flagged for a person: …”，表示一小时没有变化。
- **任务卡片：***交付物*、*配置版本 vN*（这项工作运行时用的设置）、Lin 把工作拆成分支时的*分工*，以及*把关*一行。
- **花费：**顶栏里今日 token 数字可以打开 用量 视图。

## box 之外

- 由你决定 `done`。审查者的认可会推进任务；除你之外，谁说了都不能关闭它。
- 仓库的访问权限：deploy key 或 token，以及谁可以 push。
- 合并和发布：小队写出改动和审查，由一个人来合并。
- 如果小队在群里工作，需要一个在该平台控制台注册的飞书或钉钉应用。

## 扩展

- 工作需要有来源支撑的数字时，添加 `xi`（分析师）。
- 建一个例行任务，让 Heng 每晚审查每一项新改动（自动化 → *+ 新建*）。
- 把调好的 Lin 存成模板（配置 → *让它起草模板*），留给下一个 box 用。
- 为 Claude Code 或 Codex 安装 LumenBox skill（`agentbox skill install`），从你自己的编辑器把工作交给这个小队。

## 本页依据的那次运行

- 成本：一个安装的记录，即 `turns.jsonl` 和 `usage.jsonl` 里的轮次 `809ab446-1ebf-4884-a063-29790ca09ae6` 及同一 agent 的其余 92 个轮次，于 2026-11-06 读取。算法已在上面写明，可以重算。
- 最小版本：2026-11-06 在一个全新的空 home 里复现。它运行 `agentbox web --no-box`，使用一个没有密钥的脚本化模型（`AGENTBOX_PROVIDER=custom` 指向一个本地桩）。*在 app 里* 的第 1–3 步跑通了：小队被添加，出现了三个 agent（自 INV-1680 起在 `ship` 团队里），Mo 回复并产生一条用量记录（`in 1,200 out 60`），`agentbox usage` 打印了它。由于没有 box，每个成员都记录了“cannot install its recipe; it will start blank”。没有复现的部分：第 4 步（需要 box 和模型）、聊天里的步骤，以及任何成本。
- 设计：[docs/94](../../94-catalog.md)（目录），[docs/75](../../75-cost-per-accepted-task.md)（为什么成本按被接受的任务计算）。
