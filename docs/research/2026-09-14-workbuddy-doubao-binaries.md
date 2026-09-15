# WorkBuddy 与豆包 Work：从 binary 看跟进机制

2026-09-14，本机静态检查（不运行 app），为 docs/51 的对照补空。两家都没有源码，
下面只写从 bundle 里读到的字符串，路径与原文照抄，推断只到字符串本身为止。

## WorkBuddy 5.5.6（腾讯，Electron 37 / Node 22）

`/Applications/WorkBuddy.app/Contents/Resources/app.asar`（约 298 MB，~23k 文件，
`/cli/dist/` 下是打包进去的 CodeBuddy coding-agent CLI + Monaco + i18n JSON）。不用
解包，`rg -a` 直接能读到字符串。

**没人答的审批：到点自动拒绝，并两头通知。**

- `DEFAULT_APPROVAL_TIMEOUT_MS = 120 * 1e3`（2 分钟）。
- `handleApprovalTimeout(pending)` 旁边的注释：*「文本审批超时：自动拒绝，并同步通知
  agent 与 IM」*，实现是 `executor.rejectPermission(..., "Approval timed out")`；
  这条 reject RPC 自己有 `CLAW_PERMISSION_DISPATCH_TIMEOUT_MS = 15e3`。
- 多处配置 `autoRejectOnTimeout: true`：沉默 = 拒绝是内建默认，不是"按默认继续"。
- `SANDBOX_APPROVAL_TIMEOUT_CANCEL_REASON = "sandbox_approval_timeout"`，
  UI 文案 `SANDBOX_APPROVAL_TIMEOUT_TEXT = "授权超时未确认"`。

**无人值守时不提问，直接跳过。** `onQuestionRequest` 先看
`readIsBackgroundAutomation(session._meta)`，是则 `cancelQuestion(toolCallId, "后台定时
任务无人值守，无法回答交互式提问（AskUserQuestion），已自动跳过。请调整任务或专家提示
词，使其在无人值守运行时不依赖向用户提问。")`。另有一处把发布流程的 10 分钟超时当成
"用户看到「卡死」"来避免，超时以 `registry.answer({kind:'cancelled'})` 收场。

**定时任务是一等功能。** i18n：`automation.tab.scheduledTasks`（定时任务）、
`automation.modal.schedule`（执行频率）、`automation.datasource.syncMode.scheduleDesc`
（*按固定时间自动拉取外部数据，批量创建待办*）、
`automation.permission.fullAccessDesc`（*定时任务会在本地客户端无人值守执行…任务可能中断*）。

**due 有，老化没有。** 待办有 `dueDate`：`collab.plan.fields.dueDate`（截止日期）、
`collab.activity.mine.dueDateChanged`、`collab.task.todo.dueDateUpdateFailed`，子待办也
有各自的 due 与排序。**没有**找到跟待办绑定的"逾期/overdue"徽标、
`autoArchive`/自动归档、或老化提醒字符串；"过期"命中的是 license 与云存储
（`settings.storage.policy`：任务保留 30/60/90 天或永久，*过期会清理任务对话记录*）。

**结论**：WorkBuddy 在"没人答"这一维上与 Hermes/OpenClaw 同构，且取的是**更保守的一端**
（超时=拒绝，且告诉 agent 与 IM 两边），并把"无人值守就别问人"写成了硬规则；在"挂着的
工作"这一维上只有 due，没有我们 INV-527 那种到期推送与归档。

## 豆包 Work（DoubaoWork.app，字节）

不是常规 Electron/asar：`/Applications/DoubaoWork.app` 是 ~1 MB 的原生壳，外挂整套
Chromium（`RunningChromeVersion 147.0.7727.149`，`Default/`、`Service Worker/`、
`GPUCache` 的标准 profile 结构）+ 字节的 saman 更新器；`manifest.json` 表明它本质是
指向 `doubao.com` / `cici.com` / `dola.com` 的站点化浏览器，界面与逻辑都从远端取。

本地没有可搜的 JS/i18n bundle。对 Service Worker 的 `CacheStorage`/`ScriptCache`
（~17 MB 缓存响应）做了同一套关键词扫描，命中的提醒/过期/超时/归档/cron 全部来自无关的
缓存内容（百度云 BOS 的 API 文档页、Unicode/HTML 实体表），不是豆包自己的逻辑。

**这不是"它没有这些机制"的证据**，只是这些机制（若有）在服务端渲染，不落盘，静态、
不运行的检查够不到。要下结论得换方法（抓运行时流量或拿到可核对的产品文档），本文不下。
