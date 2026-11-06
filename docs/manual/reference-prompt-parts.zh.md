<!-- doc: reference-prompt-parts.zh
     title: 参考：提示词片段
     family: manual
     status: current
     covers: reference-prompt-parts
     updated: generated
     generated: true
-->
# 参考：提示词片段

[English](reference-prompt-parts.md) · 中文。本页由 `scripts/docs-reference.mjs` 生成，来源：`parts()`（src/host/prompt-parts.ts），由 src/host/prompt.ts 登记。
本页与来源不一致时 `npm test` 会失败；改来源，然后运行 `node scripts/docs-reference.mjs --write`。

3 个内置片段。每一个都可以由团队覆盖：`~/.agentbox/prompt-overrides/<key>.md`，它的 frontmatter 记下写它时所依据的**默认哈希**；新版本改了默认内容时，覆盖会被标成 *default updated*，不会悄悄合并。只是提示词文本：任何片段都碰不到策略、工具或闸门。片段的标题和说明来自源代码，保持英文。

| key | 标题 | 用途 | 默认开头 | 默认长度 | 默认哈希 | 团队可覆盖 |
|---|---|---|---|---|---|---|
| `conduct` | How a turn works | Reply first, work out loud, close the loop; tone, never fabricate, asking, showing. Every rule is the prompt form of an incident. | **Reply first.** On a turn a person opened — a message, a burst of them, a ping while you work — your first action is a short plain reply to them, before any t… | 50 行 | `3632edc47d74f4c0` | 是 |
| `front` | Your turns stay short | The agent a person talks to answers within seconds and hands heavy work to a background fork of itself. | You are the one the person talks to, and a new message must get an answer within seconds even while heavy work is in flight. | 21 行 | `7b523c7c0c66cfff` | 是 |
| `unattended` | Nobody is watching this turn | How a scheduled, listener or wake turn behaves with no person waiting. | This turn was started by a timer, a webhook or a matched message, not by a person, and no one will read your questions or stop you mid-way. | 19 行 | `90b6a7dab39e1904` | 是 |
