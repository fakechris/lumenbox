<!-- doc: handoff-2026-09-22-nova-incident
     title: Handoff — Nova 请求混入旧任务与研究叙述复播的运行调查
     family: handoff
     status: current
     updated: 2026-09-22
-->
# Handoff — Nova 请求混入旧任务与研究叙述复播的运行调查

工作记录：INV-630（候选，关联 INV-611；不视为已承诺或验收）。

## 结论与边界

本次直接检查运行记录，没有用旧 review 代替现场证据。两个输入都被同一个确定性路由
缺陷吞进旧任务：「别」在全文中做子串匹配，把「区别」「分别」当成禁止/纠正指令。
「带到了，Nova 接着做」来自渠道路由回执，不是接待 agent 转交另一个 agent 的证明。

25 题有执行，也生成了含 Q1–Q25 的文件，文件在 sent/。但它没有自己的任务回合，最终
聊天回复偏向旧 Jev 研究及 FDE 分工。文件存在和传输成功不代表内容满足请求。

另外发现旧研究叙述通过 pinned 工具示例进入后续上下文的机械放大路径。该路径可以修复，
但不能据此宣称已经证明所有难读回复都由它造成，也不能以脚本模型测试证明自然语言质量
已经恢复。现场所见模型一直为 MiniMax-M3，没有模型切换证据；promptHash 随动态上下文
变化，不等于发生了提示词版本变更。

## 本次运行证据

证据保留在本机，本文只记录定位信息和必要短摘录，不复制整份私有聊天或任何秘密。

- Nova 的 agent id：`d08328be-7e80-4b3d-997b-be190d144643`。
- transcript：`~/.agentbox/agents/<id>/conversations/feishu-personal-oc_d99f329dc01493cee8b0ba5c34168eea.jsonl`。
- 模型、构建和回合：`~/.agentbox/turns.jsonl`；入队：`~/.agentbox/inbox.jsonl`；
  交付记录：`~/.agentbox/deliveries.jsonl`。
- 时间以下均为 UTC；本地显示加 8 小时。检查发生于 2026-09-22，运行发生于 2026-09-20。

| 事件 | 证据 | 观察 |
|---|---|---|
| TypeSafe skills 研究开始 | turn `9a6c72bb-4e21-4199-9e8e-d63ef155c319`，00:33:21 | MiniMax-M3，build `6597460` |
| WeVisDoc 输入 | transcript 第 330 行，00:33:32 | 插入上一个 turn；旧分类器首个命中为「分别裁出来」中的「别」 |
| WeVisDoc 回复 | transcript 第 337 行，00:35:09 | 开头是「17 个核心事实」「1:1 核完」，该 turn 随后结束 |
| manish_fp 研究开始 | turn `72152c4e-45e1-4fae-b022-9970924960e7`，00:42:40 | about 是旧 X 链接，MiniMax-M3，build `6597460` |
| 25 题入队 | inbox seq 41，message `42a4aad9-2881-4b33-a8be-7ffb37fd75fa`，00:43:15 | 没有 `steerable:false`，随后 started |
| 25 题进入旧回合 | transcript 第 379 行，00:44:06 | 第 14 题「长短记忆的区别」触发旧分类器；没有独立 begin |
| 写答案文件 | transcript 第 380–381 行，00:45:15 | write_file 及结果存在，正文有 Q1–Q25，混入大量旧 Jev 分析 |
| 最终聊天回复 | transcript 第 382 行，00:45:19 | 偏为 FDE 分工与旧研究 caveat；旧 turn 以 done 结束 |
| 文件交付迹象 | 容器 `agentbox-box` 对应 chat 的 sent/ | `2026-09-19_agent_25_interview_questions_reply.md` 和两份 WeVisDoc 文件存在；这是本地交付记录，不是远端用户已读证明 |

代码对照：`src/i18n/messages.ts` 的 `run.steered` 是回执来源；
`src/channels/manager.ts` 在 `isContinuation` 为真时走 steer 并返回该回执。
因此本案不应沿「SendToAgent 是否成功」方向排查。

## 哪次改动引入了什么

### 路由缺陷：6597460（2026-09-19）

INV-611 本意是新请求排队、明确追加才 steering，但 `src/channels/continuation.ts`
把 `别(?!的)` 等词放在不限定位置的正则中扫描全文。用现场完整输入重放，25 题与
WeVisDoc 都判为 continuation；能直接定位首个命中字符。运行构建与该提交相符。

修复：长于 200 字符或多行的歧义消息默认新任务；短消息只接受开头的控制短语，或明确
的短目标编辑形式（如「毛利改成百分比」）。「别」只在祈使句开头识别。保留明确选项、
短确认及既有等待回答路径。代价是长篇追加可能等待自己的回合，但不会再静默覆盖旧任务。
这仍是保守词法路由，不宣称能够理解所有自然语言意图。

### 旧叙述复播：449270c / 7c0fb0f（2026-08-30，本地时间）

工具参数示例保留机制在选择成功调用/结果对时，使用整条 assistant blocks，非 tool_use
的文字原样保留。后续参数截短也未移除相邻文字。其目的是防止压缩后工具 schema 用法丢失，
但实际把旧答案叙述当成示例一同保留。

现场 transcript 第 357 行的 summary.pinned 携带 2,218 字 assistant text，开头是
「事实链全部 1:1 核完」。第 321、401、421 行等也携带「立场稿」「主轴」叙述。
这是本次观察到的上下文放大路径；第 357 行晚于第一份 WeVisDoc 回复，不能倒推为该回复
的起因。此前长篇回复和摘要已出现同样框架，现有记录不足以将其唯一归因于这项机制。

修复：选择新 exemplar 和重放旧 summary.pinned 时共用 `sanitizePinnedEntry`，只保留
tool_use 和截短的参数；保留调用/结果配对、用户原话和原始 transcript。没有新增风格提示词，
没有清空记忆，也没有未经对照切换模型。

## 验证合同

- continuation 单测覆盖区别、识别、特别、正文中的控制词、长文、多行及正常纠正。
- scenario 覆盖两类输入在旧研究运行中到达，经真实 ChannelManager → AgentBus → runTurn
  得到两个任务、两个回合，新结果关联新消息。模型是脚本，不用它衡量答案内容质量。
- compaction 单测验证新 exemplar 不保存相邻叙述。
- scenario 验证已有旧摘要在真实模型请求组装时不再复播叙述，工具调用仍成对、原始记录仍在。
- 检查命令：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、
  `node scripts/release-check.mjs`。具体结果以本次执行记录为准。

2026-09-22 执行 `npm run release:check` exit 0：全量 1,721 项测试通过，类型检查通过，
lint exit 0（仍有仓库其他位置的 warnings / infos），CLI 与 box daemon 构建并加载通过。
日志：`/tmp/lumenbox-incident-release.log`。生成的 scorecard 位于
`~/.agentbox/scorecards/2026-09-22T08-29-21-470Z-34d720e.json`，标为 INCOMPLETE：
确定性与产物检查通过，真实模型场景未运行，且工作区未提交。不能把 release 命令 exit 0
解释为线上质量验收或部署完成。

## 尚不能声称完成的部分

源代码修复不等于正在运行的进程已加载它；本文不记录未发生的部署或重启。
现有长篇回复、摘要正文及提取记忆仍保留，不因过滤 exemplar 就自动消失。自然语言输出
改善需要同模型、固定输入与历史快照的隔离对照，检查是否答全、限制是否相关、是否还堆砌
旧主题，而非再加几条「说人话」提示。没有真实对照结果之前，只能确认上述确定性故障已修，
不能承诺实际文风已恢复。未自动重发旧答案，避免用户未要求的渠道消息。
