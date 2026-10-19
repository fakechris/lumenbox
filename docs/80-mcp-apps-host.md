<!-- doc: 80-mcp-apps-host
     title: MCP Apps 宿主：网页把 MCP 工具自带的 ui:// 界面装进第二 origin 的沙箱（spike 结论）
     family: decision
     status: current
     updated: 2026-10-19
-->
# 80. MCP Apps 宿主：网页把 MCP 工具自带的 ui:// 界面装进第二 origin 的沙箱（spike 结论）

INV-1272。GenUI 第二层；第一层是 [79](79-genui.md) 的 ShowUI。spike 的原始记录、宿主代码和运行日志留在本地
research/（不入库）。

## 1. 这是什么

MCP Apps（SEP-1865，规范 2026-01-26 stable；`@modelcontextprotocol/ext-apps` 2.0.3）：MCP 服务器的工具用
`_meta.ui.resourceUri: "ui://…"` 声明一个配套界面，宿主用 `resources/read` 取到一份 HTML
（MIME `text/html;profile=mcp-app`），放进沙箱 iframe；界面经 postMessage 上的 JSON-RPC 向宿主发
`tools/call`、`ui/message`、`ui/open-link`、`ui/update-model-context`，宿主向界面发 `tool-input`、`tool-result`。
它和 ShowUI 的差别：界面是服务器开发者写好的代码，不是 agent 组装的数据；能做网页能做的一切；
不能降级成飞书/钉钉卡片。Claude.ai、ChatGPT、VS Code、Goose 已是宿主；Claude Code 作为引擎只透传
`ui://`，不渲染，所以在 lumenbox 里宿主只能是我们的网页。

## 2. spike 做了什么（2026-10-19）

用发布版示例服务器 `@modelcontextprotocol/server-basic-vanillajs`（Streamable HTTP，:3001），写了一个
不依赖 React 的最小宿主：宿主页在一个 origin，沙箱代理页在另一个 origin（`127.0.0.1:8767`），代理页由
服务器按规范的严格默认 CSP 下发（`default-src 'none'`，未声明域一律不通，`frame-src 'none'`、
`object-src 'none'`、`base-uri 'self'`），`AppBridge` 走 `PostMessageTransport`。

一次运行里走通了全部回路：代理页就绪 → 送入 HTML → 界面 `ui/initialize`/`initialized` → 宿主发
`tool-input`、`tool-result`，界面显示结果；再在界面里按四个按钮：`tools/call get-time`（SDK 自动代理，
结果回到界面）、`ui/message`、`notifications/message`、`ui/open-link` 都到达宿主。沙箱自检
（`window.top` 不可达）通过，控制台无 CSP 违规。

## 3. 进入 lumenbox 要改什么

| 处 | 现状 | 要做 |
|---|---|---|
| `src/host/mcp.ts` | 手写 JSON-RPC，只有 `tools/list`、`tools/call`；`McpTool` 丢掉 `_meta` | 保留 `_meta.ui`；加 `resources/read`（stdio 与 HTTP 两条管道同样的一个方法） |
| `src/web/server.ts` | 单端口 | 第二个监听器（`port + 1`，只服务 `sandbox.html`/`sandbox.js`，按 `?csp=` 下发 CSP 头）；一条 `GET /api/mcp/resource?server=&uri=` 只读路由；一条宿主侧 `tools/call` 路由，经现有 PolicyGate 与 auto-review（docs/33 §1：和 agent 调工具同一道门） |
| `src/web/app-html.ts` | `work` 项里有每次工具调用 | 工具调用带 `ui.resourceUri` 时在该调用下挂一个 `app` 项：外层 iframe 指向第二 origin，`AppBridge` 连接，`tool-input`/`tool-result` 从这次调用的输入输出来 |
| vendor | `a2ui.js` | 再打一个 `mcp-apps.js`（`@modelcontextprotocol/client` + `ext-apps/app-bridge`，约 1.3 MB 未压缩） |
| `ui/message` | — | 变成一条用户消息进入当前会话，前缀 `[From app <server>: …]`，和 ShowUI 的 action 行同一条路 |
| `ui/open-link` | — | 不直接打开；在聊天列里显示链接，人自己点 |
| 可见性 | SDK 不校验 | `_meta.ui.visibility` 不含 `"app"` 的工具，宿主拒绝界面发起的调用（规范第 401 行；SDK 不做） |

安全面，必须写明：
- 界面运行在**人的浏览器**里，不在 box 里。box 的出网策略（docs/10、docs/15）管不到它；它唯一的
  闸是 CSP，所以 CSP 只能由服务器头下发（不能用 meta 标签），且只放服务器声明的域。
- 界面与沙箱代理页同 origin（`document.write` + `allow-same-origin`）：那个 origin 上不能放任何别的
  东西，没有 cookie、没有 token。
- 界面发起的 `tools/call` 经宿主 → 网页服务器 → McpManager，凭据仍只在宿主（docs/33 的规则不变）。
- 经 MCP face 跑在 box 里的引擎（Delegate）看到 `ui://` 只会透传；界面只在网页上出现，这一层和
  引擎无关。

## 4. 决定

**机制已证实可行，代价明确（约两天的产品改动），但现在不做第二步。** 原因只有一个：今天接入的
MCP 服务器（Involute、Linear、Notion 托管端点）没有一个带 `ui://` 资源，做了也没有东西可显示。
触发条件：第一个真实接入的、带 `_meta.ui.resourceUri` 的 MCP 服务器出现时，按 §3 的表立项，
以本地 research/ 里的 spike 宿主为起点。到那时再核对 ext-apps 的版本（2.0.3 时规范已 stable，
但 SDK 仍在变：`AppBridge` 的自动代理绕过 `client.callTool`，观察点要放在 `client.request`）。

## 5. 不做

- 自由 HTML artifact（agent 写 HTML 放 iframe）：和 MCP Apps 共用沙箱机制但没有可见性与 CSP 声明，
  仍不做。
- 飞书/钉钉：MCP App 没有卡片形态，只能给"在网页打开"的链接。
