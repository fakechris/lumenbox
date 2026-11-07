<!-- doc: reference-settings.zh
     title: 参考：设置面板
     family: manual
     status: current
     covers: reference-settings
     updated: generated
     generated: true
-->
# 参考：设置面板

[English](reference-settings.md) · 中文。本页由 `scripts/docs-reference.mjs` 生成，来源：`SETTINGS_PANES`（src/web/settings-registry.ts），设置对话框按它渲染标签页。
本页与来源不一致时 `npm test` 会失败；改来源，然后运行 `node scripts/docs-reference.mjs --write`。

8 个面板。**配置**是面板在 `~/.agentbox/config.json` 里改的项；**API** 是它背后的路由。由脚本挂载的面板，在那个脚本加载后才出现。

| key | 面板 | 用途 | 配置 | API | 挂载 |
|---|---|---|---|---|---|
| `model` | 模型 | 模型 provider、模型和它的 key、联网搜索 key、额度用完时的备用 provider、决策模型，以及内置的提示词。 | `provider`, `model`, `baseUrl`, `fallbackProviders`, `env` | `/api/config`, `/api/config/test`, `/api/prompt-parts`, `/api/provider/fallbacks`, `/api/provider/rests`, `/api/jev` | 页面自带 |
| `boxes` | Box | 这台 box 和接入的每台机器、个人 box 限额、在本机执行命令、开机启动、box 镜像更新和资源诊断。 | `boxImage`, `boxCpus`, `boxes`, `personalBoxQuota`, `personBoxQuotas`, `departmentBoxQuotas`, `hostExec`, `startupItem`, `upgradeHour` | `/api/box/up`, `/api/boxes`, `/api/quotas`, `/api/directories`, `/api/box/image`, `/api/diagnostics/resources` | 页面自带 |
| `doors` | 渠道 | 通往这个安装的渠道、接入的连接器，以及在等着被放进来的人。 | `channelAllow` | `/api/channels`, `/api/connectors` | 页面自带 |
| `team` | 团队 | 权限范围、密钥、人员与邀请、MCP 服务器，以及团队的各项上限：暂停的 agent、推送额度、花费上限、反复失败的例行任务、共享记忆审核。 | `mcpServers`, `teamMemoryReview` | `/api/scopes`, `/api/vault`, `/api/principals`, `/api/mcp`, `/api/extensions/reload`, `/api/agents/pauses`, `/api/agents/push-budget`, `/api/agents/spend-limits`, `/api/schedules/runs`, `/api/memory/team-review` | 页面自带 |
| `mine` | 我的 | 属于你的东西：你的 MCP token、你的长期批准、闸门本会问你的事，以及 agent 对你的了解。 | — | `/api/mcp/tokens`, `/api/policy`, `/api/person` | 页面自带 |
| `memory` | 记忆 | 每个 agent 记住了什么、每条记忆从哪里来，以及修改或删除它。 | — | `/api/memory` | 页面自带 |
| `supervision` | 监督 | 看门狗：工作停滞时提醒你；监督者：你给它一个目标，它一直盯到结束。 | — | `/api/supervision` | 由脚本挂载 |
| `organisations` | 组织 | 这个 app 在个人安装之外连接的组织：用地址或邀请链接加入、打开、断开。每个组织也是窗口最左一栏里的一项，显示你在那里的角色和它自己的计数；打开后在这个窗口里显示组织自己的页面。只在桌面 app 里有；每个组织的令牌存在系统钥匙串里。 | — | — | 由脚本挂载 |
