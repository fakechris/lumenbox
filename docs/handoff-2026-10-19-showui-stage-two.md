<!-- doc: handoff-2026-10-19-showui-stage-two
     title: Handoff — ShowUI 第二阶段：网页端成为交互面（INV-1280）
     family: handoff
     status: current
     updated: 2026-10-19
-->
# Handoff — ShowUI 第二阶段：网页端成为交互面（INV-1280）

分支 `feat/inv-1280-showui-web-components`，PR #363（主体）、#364（Approve 顶层 context）、#365（Table 勾选读取时机）。
设计与目录在 [79](79-genui.md) §11。

## 交付结果

- lumenbox 自己的七个组件（Table、Progress、Markdown、Code、Approve、Chart、FilePreview），schema 在
  `src/host/show-ui-components.ts`，主机校验与页面渲染共用；元素在 `src/web/a2ui-*.ts`，随 `vendor/a2ui.js` 打包（472 KB）。
- 局部更新：`ShowUI({surface, data})` / `{surface, patch}` 只发 `updateDataModel`，页面原地更新。
- 客户端函数（`src/host/show-ui-functions.ts`）：格式化、校验、逻辑；`openUrl` 不开。
- basic 目录放开 Tabs、Modal、Slider、DateTimeInput、Icon；Image 按 Chris 的决定不开。
- 每个组件在 `surface-card.ts` 都有飞书文字降级；页面 CSS；工具描述。`npm test` 2441+ 通过。

## 实测

- 静态页 + Playwright：七个组件各一遍（docs/79 §11 列了每条结果）。
- **真实 app（主检出从 src 起的 web，MiniMax-M3.1-Flash-Preview）**：Ada 画出 `files4`——三行可勾选的 Table
  + Approve（顶层 `context: {rows: {path: "/picked"}}`）。勾选后按 Allow，transcript 收到
  `[Action "approve" on card files4: {"rows":["c.txt"]}]`，Ada 回复"整条链路通了：选中值原样回来了"。验收第 5 条通过。
- 实测暴露并修掉的两处：
  1. 模型第一反应是把 `context` 写在 Approve 顶层，被拒两次后放弃了 context，按下只回来空事件。现在顶层
     `context` 作为两个按钮共同的 context（#364）。
  2. 两次勾选在同一次重绘前发生时，第二次覆盖第一次（脚本里同步点两个框只剩一个）。toggle 改为点击时
     读当前值（#365），静态页验证两次同步勾选都保留。
- Ada 在实测中把早先的限制写进了自己的 AGENTS.md（"Approve 只吃 title 和 detail"），已让她删掉；
  这类"把宿主的临时限制当永久规则记下"的情况值得留意。

## 留给下一手

- FilePreview 的图片预览走 `/api/file`，只在真实 app 里能看，静态页没有验证图片分支。
- Chart 只有柱/线，没有图例和多系列。
- 飞书端的新组件只是文字；要卡片就得做 INV-1271 那类模板工作，Chris 已暂缓。

## 补：视觉与组件补全（INV-1286，同日）

Chris 看到 Mia 的晨报卡"土而且缺组件"。一半是 bug：MiniMax 把 `data` 里的数组也编成 `{"item": [...]}`，
表格是空的（INV-1285，PR #366）。另一半是设计：A2UI basic 元素的默认样式是示例级的，且 agent 没有
表达"状态/指标/键值/提示"的组件。

做了（PR #367、#368）：
- `.surface .sbody` 把 A2UI 主题变量映射到 lumenbox 的 token（字号比例、网格、颜色、圆角、按钮字重），
  basic 元素的 shadow DOM 随页面走，深浅两套主题都过了。
- 五个组件：`Badge`、`KeyValue`、`Stat`、`Callout`、`Link`；Table 列加 `kind`（badge / number / link），
  状态词自己上色（blocked→danger、review→warn、done→ok）。
- 主机再吸收两种 provider 编码：链式 `{item: [A, {item: [B, …]}]}` 展平为列表；`"true"`/`"false"` 在布尔
  属性上读作布尔。Mia 的第二次重画被这两样拒了三次后停手（守了"最后一次"的规矩）；修后第三次一次画成。
- 实测：真实 app 里 Mia 重画 `morning-board-v3`——三个 Stat、8 行带 link/badge 列的 Table、Callout、
  Progress、Approve，一次通过（截图在本地 research/live-board-v3-2026-10-19.png）。验收第 3 条等 Chris 看。

留给下一手：卡片 `title` 与 agent 自己写的 h4 容易重复（工具描述已提示"不要重复标题"）；Chart 没有图例。
