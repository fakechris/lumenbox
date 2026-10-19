<!-- doc: handoff-2026-10-19-showui
     title: Handoff — ShowUI：agent 用 A2UI 组装卡片（INV-1269，docs/79）
     family: handoff
     status: current
     updated: 2026-10-19
-->
# Handoff — ShowUI：agent 用 A2UI 组装卡片（INV-1269，docs/79）

分支 `feat/inv-1269-showui`，worktree `agentbox-showui`，四个阶段四个提交。设计在
[79](79-genui.md)，阶段记录在 `IMPLEMENTATION_PLAN.md`。

## 交付结果

- **主机**（`src/host/show-ui.ts`）：`ShowUI` 工具；目录是 A2UI basic catalog 的十个组件
  （Text、Row、Column、List、Card、Divider、Button、TextField、CheckBox、ChoicePicker）；
  校验用 `@a2ui/web_core` 的 `MessageProcessor` 加 `STRICT_VALIDATION`，和页面渲染的是同一段代码；
  目录外组件、未知属性、悬空子节点、`functionCall` 动作都被拒并把原因回给 agent。
  `SurfaceLedger`（`~/.agentbox/surfaces.jsonl`）保存每个 surface 的全量消息。
- **页面**（`src/web/app-html.ts`、`src/web/a2ui-entry.ts`）：`vendor/a2ui.js` 由
  `npm run build:vendor` 从 src/ 打出（不入库，`release-check` 检查它存在），`/vendor/a2ui.js`
  在第一张卡片出现时才加载。同一 `surface` id 原地更新；回放和实时流走同一个 `showSurface`。
  按钮按下发出 `[Action "name" on card id: {...}]`，表单值通过 A2UI 自己的 `{"path": ...}` 绑定带回。
- **渠道**（`src/channels/surface-card.ts`）：同一串 A2UI 消息读成行和按钮；飞书画成互动卡片，
  按钮说出 `@Agent [Action …]`，经打字消息同一条路由到 agent，manager 不需要记任何状态；
  钉钉、Telegram 走文字路径，每个按钮给出该回复的原文。
- **提示词**：conduct 段新增 "Showing, not describing"；`acting-for-them` 技能列出 `ShowUI`。
- **测试**：主机 6、页面/回放 3、渠道 6、scenario 1（fake engine 调 ShowUI → 第二张被目录拒绝 →
  人按下 → 下一轮 agent 看到 action）。`npm test` 2413 通过，`npm run build` 与
  `node scripts/release-check.mjs` 通过。

## 实测

- 静态页面上用真实浏览器（agent-browser）跑过 `vendor/a2ui.js`：十个组件的目录建立，
  TextField + ChoicePicker + Button 的卡片渲染，填名字、选 Plan B、按 Choose 得到
  `[Action "pick" on card plan: {"plan":["b"],"name":"Chris"}]`。
- **网页实测（2026-10-19，主检出从 src 起的 web，MiniMax-M3.1-Flash-Preview，真实 box）**：
  第一轮暴露了一个真问题——MiniMax 的 Anthropic 兼容端把组件对象里嵌套的数组一律编码成
  `{"item": [...]}`，第一次调用还把 `component` 写成 `type`；模型改写 27 轮都过不了校验，
  只有不用 `children` 的卡（Text 根、Button 根、Card+child）画出来了。修复：主机把
  `{item: …}` 展开、`type` 读作 `component`（`normalizeComponent`，有测试），工具描述带一个
  完整四组件例子。第二轮：Column + Row + 两个按钮的卡 `plan2` 画出来，按"方案 B"后 Ada 收到
  `[Action "pick" on card plan2: {"choice":"b"}]` 并回复"收到 plan2 的选择：方案 B"。
  模型自己对失败的解释（"要多包一层 `[[...]]`"）是错的，不要写进任何提示词。
  引擎不是 Claude Code（现场配置是 MiniMax），验收第 5 条按现场引擎走。
- **未做**：飞书点一次。要一个人在飞书里向 agent 要一张带按钮的卡并按下。

## 留给下一手

- 飞书的 ChoicePicker 多选、CheckBox 在卡片里只有文字；钉钉没有卡片模板（`dingtalk-card-ops`
  可以建一个）。
- A2UI 还在 public preview（v1.0 RC）：`@a2ui/lit`、`@a2ui/web_core` 锁在 0.14.0；升级时重跑
  `src/host/show-ui.test.ts` 和静态页实测。
- MCP Apps（`ui://` iframe）是 GenUI 第二层，另立条目。
