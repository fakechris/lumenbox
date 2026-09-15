# 51 · 跟进（follow-through）：问题、承诺与挂着的工作如何不再无声

*2026-09-14。起因是线上一份周报：Q1–Q5 挂了四周没人答，"9/11 前发 reminder"写了没发，t12 该关没关，review 队列四条挂一两周。本文给出我们自己的高层方案，先说别的系统怎么做，再说我们已经落地的四条 rail，最后是把这些拧成一个模型的设计。*

## 0. 一句话

**挂着的东西不是状态，是一种会到期的对象。** 问题、承诺、任务卡、提案，每一个都带一只表；到点没人动，系统按事先说好的默认动作处理并出声，而不是继续挂着等人。人的沉默被解释成三种之一——"按默认"、"跳过"、"不反对"——由对象类型决定，绝不解释成"同意关掉工作"。

## 1. 别人怎么做（本地源码核对，引用见 docs/research/）

| 维度 | Hermes（`~/sdcard/source/hermes-agent`） | OpenClaw（`~/sdcard/source/openclaw`） | Grok Bot（research/GROKBOT-*） | Argus（research/ARGUS-*） |
|---|---|---|---|---|
| 没人答的问题 | `clarify` 3600s 超时，哨兵答案"用你的判断继续"；`timed_out` 区分跳过与走开；批量问题超时即中止其余；无每会话预算，只有 prompt 劝导；headless worker 禁止提问 | `ask_user` 900s（30–3600）到期 `no_answer` 继续；一会话只允许一个待答问题；**用户随便说一句就被当作答案**；审批超时默认拒绝 | 提问 widget 会过期："moved on without responding — treat it as skipped" | 不问人；Reviewer 裁决 |
| 挂着的工作 | SQLite kanban，无 due；只对 running 做租约回收；阻塞超 24h 只在"按需诊断"里出现，不推送；两次同因 block 升级到 triage；不自动归档；agent 无归档工具 | 两套登记（background tasks / workboard），都按 last-update 老化，无 due；staleness 只是被动诊断（blocked 超 24h "needs attention"），不推给人；suggestion 卡 process-local、无老化、重启即丢 | Involute claim 2h 租约 | 任务/检查点/决策全持久化；Reviewer 说 done 才 done，没有"挂着"这个状态 |
| 未来承诺 | 有 cron（自排 reminder/一次性），但让承诺落地的机制是**回合内**的"绝不以承诺结束回合"（stop-nudge，预算 2）；没有把"by Friday"变成 job 的机制，也不事后对账 | 两个显式机制：automations（at/every/cron）与 standing intents（事件触发的前瞻记忆，24h 冷却、最多 3 次、90 天过期）；都靠显式调用，**不从口头承诺生成**；job 的失败有告警/自动停用，但没有"口头承诺是否产生了 job"的检查 | 例程 = skill 文件的 schedule/trigger | Planner DAG + acceptance_check |
| agent 能否提议关闭 / 沉默怎么算 | 只能把工作挪进人面向的 lane（typed block、triage、suggestions）；不能自关；suggestions 永不过期；**沉默 = 一直挂着** | `dismiss_task` 只能撤回自己的 suggestion；workboard 可 complete/block/move 不能归档；"Cancellation is always explicit"；**沉默从不等于同意关闭**；沉默能关掉的只有机器超时（no_answer、审批 deny、task lost） | — | — |

**共同点**：都把"问题超时→按默认继续"做成了硬机制；都**没有** due 日期；都把工作项的老化做成被动诊断而不是推送；都没有把口头承诺对账成 job；都不让 agent 自己把工作关掉。**我们的差异**：我们已经有例程（`schedule:`/`@at`/`trigger:`）、任务板、提问卡、reconcile 这条 rail（docs/29 模板）——缺的正是"对象带表"和"沉默的解释"。

WorkBuddy / 豆包 Work：本地没有源码，我们的 docs/25 workbuddy 程序只覆盖了 crew 与 opencode 委托，不涉及跟进机制；这两家的做法本文不下结论，列为待核（需要拿到可核对的材料再补）。

## 2. 我们已经落地的四条 rail（2026-09-14，PR #145 / #146 / #147）

1. **问题会过期（INV-526）**。每个 AskUser 被看守：默认 4 小时，agent 可设 5 分钟到 7 天；"有人答"= 那个会话里此后有用户发言（从 transcript 读，所以卡片按钮、打字、直接下新指令都算）；到期有默认值 → 唤醒 agent 按默认走并说一句，群里一行"按默认走了：…"；无默认 → "对方已经 moved on，视为跳过，自己决定并说明"。`questions.jsonl` 留痕。和 Hermes/OpenClaw 一样"超时即默认"，比它们多了**群里出声**和**无默认时的跳过 cue**。
2. **任务板 due 与老化（INV-527）**。Task 有 `due`；过期或 7 天没动的活任务，每 48 小时向请求者敲一次（close / downgrade / continue），任何人一动就清零，敲两次没动第三次归档为 dropped 并在 history 写明；提案中的卡不敲。这是别人都只做成"被动诊断"的那一步。
3. **承诺对账（INV-528）**。例程交付的报告里有 `## 下周改` / `## Next week` 块时，宿主逐条对照：要有匹配的任务卡且 due 不晚于该条日期，或有到点前的 `@at` 例程；缺的在同一个群里列出，并给 agent 一个独立回合的 cue 立刻建卡建例程；下一次同例程运行时以"上次承诺现在各自怎样"开头。这是 Hermes 和 OpenClaw 都没有的"口头承诺 → job 的对账"。
4. **assignee 可提议关闭（INV-529）**。bot 可以带理由提议关闭；请求者 48 小时内在看板"Keep open"或动一下卡就是反对；沉默 = 不反对，按提议关闭并注明是谁的提议。请求者自己不能"提议"，直接关。这与 OpenClaw "沉默从不等于同意关闭"的原则不同，但对象不同：这里关的是**别人已经不管的工作**，且可从看板一键撤销，而且每次归档都留痕、出声。

## 3. 设计：一个模型，四种对象，三种沉默

### 3.1 对象与表

| 对象 | 谁创建 | 表 | 到期动作 | 沉默的含义 |
|---|---|---|---|---|
| 问题（Question） | agent 向人 | 4h（可设） | 有默认→按默认；无默认→跳过 | "按默认 / 跳过" |
| 承诺（Commitment） | agent 对自己 | 条目上的日期 | 到期前必须有卡 + 提醒；否则对账时出声 | 不适用（承诺不等人） |
| 任务卡（Task） | 人或 agent | `due`，或 7 天无动 | 敲 2 次→归档 | "不反对归档" |
| 提案（Proposal：关闭 / 自动化建议 / 新工作） | agent 向人 | 48h（关闭）；建议类不过期但有上限 | 关闭提案→生效；建议→留着但不 nag | "不反对"（仅限关闭）/ "留着" |

原则：**每个对象在创建时就把到期动作写死**（问题的默认值、承诺的日期、提案的截止），到期不需要再判断；到期动作一律"做 + 出声 + 留痕"，三者缺一不可；出声的地方是对象来自的那个会话（thread），不是全局面板。

### 3.2 统一的"注意力账本"

现在四种对象各有一份 ledger（`questions.jsonl`、tasks 的 history、`commitments.jsonl`、close proposal 在 task 上）。下一步把它们并成一个视图：**每个 box 一份"挂着什么、几时到期、到期会怎样"的清单**，出现在 Settings/看板和例程的 prompt 里——agent 每回合都看得到自己欠的和别人欠它的。这也是 INV-135（wedge 检测与常驻告警）的自然落点：socket 死了、扫描卡了、任务过期了，都是"到期没动"的同一种事。

### 3.3 例程作为承诺的载体

例程（skill 文件的 `schedule:`/`@at`）是我们唯一能让 agent"在未来某刻动"的机制，所以：

- retro 类例程的输出**必须**有承诺块（模板 skill 里写死格式），否则对账无从做起；
- 承诺块里每条要么自带日期，要么由对账 cue 逼出一个 `@at`；
- 例程的下一次运行以上次承诺的状态开头（已做）——这就是"retro 第一个检查项"的机械化。

### 3.4 边界

- **不做**"从任意口头话里抽承诺"：只认报告里的承诺块。Hermes/OpenClaw 都不从 prose 生成 job，我们也不；不确定的抽取会制造假承诺。
- **不做**自动帮人答问题以外的事：到期按默认是 agent 自己声明的默认，不是系统猜的。
- **不让 agent 归档**：归档只由老化 sweep 或人做；agent 只能"提议关闭"，且每次都留痕、可撤销。
- 沉默永远不等于"同意做某个不可逆动作"：INV-403 的不可逆门不受任何到期规则影响。

## 4. 下一步（候选）

- **A. 注意力账本与 prompt 段**（3.2）：`/api/attention`（按 box）+ system prompt 一段"你欠的 / 欠你的"，替代各自分散的 ledger 视图。
- **B. retro 模板 skill**：把承诺块格式、默认值 yes/no 卡、`@at` 例程写进 catalog 的 retro skill，让 INV-528 的对账有稳定输入。
- **C. 建议类提案的上限与去重**（Hermes suggestions 的 `MAX_PENDING=5` + dedup latch）：agent 提议的新工作/自动化不能变成 nag wall。
- **D. 老化 sweep 并入 INV-135**：一个 sweep，一处出声。
- **E. 真机验证**：让线上那个周报例程按 §3.3 跑一次，看 9/21 retro 的第一段是不是"上次承诺现在各自怎样"。

引用：docs/research/2026-09-14-hermes-follow-through.md、docs/research/2026-09-14-openclaw-follow-through.md、research/GROKBOT-2026-09-07-TEAM-WORKFLOW.md、research/ARGUS-COMPARISON.md。
