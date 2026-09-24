<!-- doc: handoff-2026-09-24-answer-review
     title: Handoff — 上下文恢复第七项：回答偏航影子门
     family: handoff
     status: current
     updated: 2026-09-24
-->
# Handoff — 上下文恢复第七项：回答偏航影子门

## 交付结果

新增独立回答评估器，只看本次原始请求与最终回复，判断为直接回答、没有回答、过程盖过结果、
上下文串入或无法判断。默认对稳定的 5% 样本异步 shadow，不延迟也不修改回复；记录只保存
消息 id、分类、置信度、理由、耗时和两段正文的 SHA-256，不复制正文。

## 放行边界

- `AGENTBOX_ANSWER_REVIEW=off|shadow|suggest`，默认 shadow。
- 只有 suggest 模式、被采样且失败类别置信度至少 0.85，才追加 host 标识的 `/retry` 提示。
- 坏 JSON、超时或调用失败一律 `UNKNOWN` 并 fail-open。
- 分类器永不自动执行 `/new`、`/retry`、`/recover`、记忆撤回或任何工具。
- 带附件和恢复中的回答不评估，避免在看不到材料或请求其实是 host packet 时误判。

## 验证

测试覆盖 typed parser、窄输入 prompt、稳定采样、不可用 fail-open、shadow 不阻塞、suggest
阈值、审计导出，以及完整事故场景中“转交 + 五维核验”被提示而正常重答不再被评估。
从 shadow 切 suggest 仍需要人用真实 👎 样本确认 precision，代码不会自行放行。
