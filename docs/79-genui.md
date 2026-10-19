<!-- doc: 79-genui
     title: ShowUI：agent 用 A2UI 组装卡片，网页渲染，飞书/钉钉降级
     family: decision
     status: current
     updated: 2026-10-19
-->
# 79. ShowUI：agent 用 A2UI 组装卡片，网页渲染，飞书/钉钉降级

INV-1269。来源：2026-10-18 的 GenUI 框架调研（研究正文留在本地 research/，不入库）。

## 1. 问题

面向人的卡片只有三种，而且每种都是一个工具：`AskUser`、`AskSecret`、`HandOverDesktop`
（`src/host/tools.ts` 的 `PERSON_FACING_TOOLS`）。它们的外观写死在 `app-html.ts` 的六类聊天项里
（[41](41-chat-grammar.md)），飞书再各画一张卡。agent 想给人看一张对比表、一组带说明的选项、
一个有几个字段的小表单，只能退回 Markdown——网页上勉强能看，飞书里就是一段字。

每多一种卡片就多一个工具、三处渲染、一条回路。这条路不能再走。

## 2. 决定

**一个工具 `ShowUI`，输入是 A2UI v0.9 的组件列表，宿主只认一个小目录。** 三端共用同一份
JSON：网页用 `@a2ui/lit` 的 `<a2ui-surface>` 渲染；飞书把目录子集翻译成互动卡片；钉钉和
Telegram 退化为文本。人的操作以 A2UI 的 `action` 回到 agent，走和 `AskUser` 回答相同的路：一条
新的用户消息。

选 A2UI 的理由（调研结论）：声明式 JSON、组件来自宿主白名单、官方 Lit 渲染器不依赖
React、Apache-2.0 与 GPL-3.0 相容。不选的：React 系 SDK（前端是 vanilla JS）、自由 HTML
（无法降级成卡片、要开 iframe 沙箱）、AG-UI（只是事件信封，我们已有）。MCP Apps 的
`ui://` 另立条目，不在本文。

## 3. 目录

`src/host/show-ui.ts` 从 `@a2ui/web_core` 的 `BASIC_COMPONENTS` 里取十个，组成
`https://lumenbox.dev/a2ui/catalog.json`（协议 v0.9）：

| 组件 | 网页 | 飞书 | 文本 |
|---|---|---|---|
| `Text`（variant h1–h5/body/caption） | 原样 | `div` + `lark_md`，h 变粗 | 一行 |
| `Divider` | 原样 | `hr` | `---` |
| `Column` / `Row` / `List` / `Card` | 原样 | 按顺序展开为元素序列（Row 也竖排） | 按顺序 |
| `Button`（action.event） | 原样 | `button`，value 带 `surfaceId` + `action` | `/act <surfaceId> <name>` |
| `ChoicePicker` | 原样 | 每个选项一个 `button`（mutuallyExclusive）；多选退化为文本 | 列出选项 |
| `CheckBox` | 原样 | 文本 `[ ] label` | 同 |
| `TextField` | 原样 | 文本："在聊天里回复" | 同 |

不在目录里：`Image`、`Icon`、`Video`、`AudioPlayer`、`Tabs`、`Modal`、`Slider`、
`DateTimeInput`。前四个会把外部 URL 带进页面；后四个在飞书上没有对应物。
`Action` 只允许 `event`，不允许 `functionCall`——目录里也不注册任何函数。

主机校验用的就是 `MessageProcessor` 加这个目录（`STRICT_VALIDATION`），
网页渲染用同一个目录定义。目录外的组件、未知属性、悬空的子节点引用都在主机侧拒绝，
原因原样回给 agent（"Unknown component type 'Image' …"）。

## 4. 工具

```
ShowUI({
  surface: string,          // agent 自己起的 id；同一个 id 再调一次 = 原地更新
  components: Component[],  // A2UI v0.9 组件，必须含 id 为 "root" 的那个
  data?: object,            // 可选的数据模型，组件用 {"path": "/x"} 绑定
  title?: string            // 卡片标题行；缺省用 agent 的名字
})
ShowUI({ surface, close: true })   // 删除
```

主机把它包成 A2UI 消息：首次是 `createSurface` + `updateComponents`（+ `updateDataModel`），
再次只有 `updateComponents`（+ `updateDataModel`），`close` 是 `deleteSurface`。
对外传的、落盘的都是这串消息，工具输入只是给模型的省字写法。

工具结果："Shown in the app" 或 "Shown in Feishu"。**和 `AskUser` 不同，轮次不结束**：
agent 可以接着说话；人的点击会以新消息到达。连问两次的预算规则（`consecutiveQuestions`）
不适用。

`ShowUI` 加入 `PERSON_FACING_TOOLS`（没人在场时不提供）、`DESK_TOOLS`、`ALL_TOOLS`、
`TEMPLATE_SETUP_TOOLS`，`side-effects` 为 `self`，活动短语 "showing you a card / 给你看一张卡"。
fork 的子 agent 不拿这个工具，和另外三个一样。

## 5. 回路

A2UI 的 `action` 载荷是 `{name, surfaceId, sourceComponentId, timestamp, context}`。
无论来自网页还是飞书，都变成一条用户消息：

```
[Action "pick" on card s1: {"choice":"a"}]
```

网页：`<a2ui-surface>` 的 actionHandler → `POST /api/prompt`，文本如上。
飞书：按钮 value `{surfaceId, action, context}` → `card.action.trigger` → `messageHandler`，
文本如上，经 `/act` 续接解析。
`TextField`/`CheckBox` 的值只在网页上有：按钮的 `context` 用 A2UI 自己的绑定取值
（`"context": {"name": {"path": "/name"}}`），渲染器在派发时解析，所以表单的值随按钮一起回去。
这是规范原生的做法，不另造一条"把整个数据模型附上"的路。

卡片在聊天里保留已操作状态：最后一次 action 的名字显示在卡片底部（docs/41 §1 的 card 规则）。

## 6. 持久化与重画

`~/.agentbox/surfaces.jsonl`（`SurfaceLedger`）：每行一个 surface 的**最新全量**消息串
（agentId、conversation、surfaceId、messages、at），`deleteSurface` 写一行 `closed`。
网页回放时，`transcript.ts` 从 `ShowUI` 的 `tool_use` 块里重建消息（与实时流同一段代码），
不读 ledger；ledger 是给飞书 adapter 在重启后重画、以及 attention 面板用的。

## 7. 事件

`OutboundEvent` 新增 `{ type: "surface"; agentId; agentName; surfaceId; messages; conversation? }`。
带 `agentId`，所以通过 `mayReadScopedEvent`。页面上：同 `surfaceId` 的 item 已存在就
`processMessages` 原地更新，不存在就 `pushItem({kind: "surface"})`。

## 8. vendor

`scripts/build-vendor.mjs` 用 esbuild 把 `src/web/a2ui-entry.ts`（web_core 的 `MessageProcessor`
+ lit 渲染器 + 本目录）打成 `vendor/a2ui.js`（IIFE，约 450 KB / 129 KB gz），**提交入库**，
和 `docker/box/markdown-it.js` 一样是静态文件；`vendorPath("a2ui.js")` 解析它，
`/vendor/a2ui.js` 路由提供，Dockerfile `COPY`。页面在第一张卡片出现时才加载脚本。
版本锁死在 `@a2ui/lit@0.14.0` / `@a2ui/web_core@0.14.0`（A2UI 还在 preview）。
NOTICE 记 Apache-2.0。

## 9. 不做

- MCP Apps / `ui://` iframe：另立条目。
- 自由 HTML、图片、外链：不进目录。
- 钉钉互动卡片：没有现成模板，先文本；需要时按 `dingtalk-card-ops` 另建模板。
- 流式局部更新（agent 一边想一边改卡片）：工具是整次调用，每次全量 `updateComponents`；
  A2UI 本身支持增量，等有用例再开。
- 卡片过期：没有 `AskUser` 那样的 TTL；卡片不等人，人不点也没事。

## 10. 验收

见 INV-1269 的 acceptance/verification：主机校验测试、surface 状态机、网页挂载与更新、
飞书 fixture、scenario（fake engine 调 ShowUI → 点按钮 → 下一轮收到 action）、
`npm test`/`npm run check`/`release:check`，真实 box 里网页点一次、飞书点一次。

## 11. 第二阶段（INV-1280，2026-10-19）：网页端是交互面，飞书停在摘要卡

第一层把回路和校验走通后，Chris 的判断：飞书/钉钉只能装"标题 + 行 + 按钮"，真正的交互面是
lumenbox 自己的网页，不然意义不大。于是在同一套 A2UI 上，网页端放开：

**lumenbox 自己的目录**（`src/host/show-ui-components.ts` 的 Zod schema，主机校验与页面渲染共用；
元素在 `src/web/a2ui-*.ts`，随 `vendor/a2ui.js` 打包；按 Chris 定的顺序）：

| 组件 | 做什么 | 飞书里 |
|---|---|---|
| `Table` | `columns` + `rows`（绑定或内联），可排序，`selectable` 时选中的行键绑到 `value`，按钮 context 带回 | 表头行 + 前 8 行文字 |
| `Progress` | `steps`[{label, status}] 或 `value` 0–100，agent 用 `data`/`patch` 原地推进 | `[x]`/`[~]`/`[ ]` 清单 |
| `Markdown` | 走页面自己的 markdown-it（html 关） | 前 12 行 |
| `Code` | 代码块带复制，`variant: diff` 上色 | 围栏代码 |
| `Approve` | 允许/拒绝一对，主机补默认事件 `approve`/`reject` | 两个按钮 |
| `Chart` | `points`[{label, value}]，bar/line，纯 SVG | 一行"label value" |
| `FilePreview` | box 内文件：经 `/api/file` 的链接，文本预览前 N 行，图片直接显示；路径限 `/home/box/work` 下，主机拒绝其它 | 路径一行 |

**放开的 basic 目录**：`Tabs`、`Modal`、`Slider`、`DateTimeInput`、`Icon`。`Image` 按 Chris 的决定不开
（外链是 CSP 与隐私面；box 内图片走 `FilePreview`）。

**局部更新**：`ShowUI({surface, data})` 只发 `updateDataModel("/")`；`ShowUI({surface, patch: [{path, value}]})`
按路径改。两者都不重发组件，页面原地更新（实测：Progress 的 `<ol>` 节点不变、Chart 的柱子重算高度）。
主机把编辑追加到 surface 的全量消息后重放校验，坏的编辑在发出前被拒。

**客户端函数**：`SHOW_UI_FUNCTIONS`（`src/host/show-ui-functions.ts`）——`formatString`、`formatNumber`、
`formatDate`、`formatCurrency`、`pluralize`、`and`/`or`/`not` 和校验函数——在页面上作为表达式求值，
主机与页面从同一份清单建目录。`openUrl` 不在其中：卡片不自己开链接，人开。

**实测记录**（本地静态页 + Playwright）：Table 排序、勾两行、按按钮 →
`[Action "pick" on card files: {"rows":["a.txt","c.txt"]}]`；Progress 数据更新不重建节点；Markdown 转义
`<script>`；diff 上色；Approve → `[Action "approve" on card d: {"env":"prod"}]`；Tabs + Slider +
`formatString` 绑定值 + 路径 patch；Chart 柱/线与 patch 后重算；FilePreview 链接指向 `/api/file`。
真实 app 的 Table + Approve 一次实测在合并、装新版后做（验收第 5 条）。
