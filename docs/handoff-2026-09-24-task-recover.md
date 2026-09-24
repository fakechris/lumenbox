<!-- doc: handoff-2026-09-24-task-recover
     title: Handoff — 上下文恢复第四项：同任务只读 /recover
     family: handoff
     status: current
     updated: 2026-09-24
-->
# Handoff — 上下文恢复第四项：同任务只读 /recover

## 交付结果

私聊中的 `/recover tN` 会为既有任务建立一个新的恢复 attempt 和 `recover` 上下文 epoch，
再从不可变消息账本里的原始请求重答。它不会新建第二张任务卡，也不会把旧答案、旧计划、
长期记忆、skills 或其他会话带进来。

## 机械边界

- 只允许原请求人、原私聊、原 assignee；提案、忙碌会话和来源不完整时拒绝且不改状态。
- 新任务用 `sourceMessageId` 回到 `messages.jsonl`；来源必须仍属于任务记录的 conversation。
- 历史任务仅在 description 未截断时可用，并在 packet 中明确标成 legacy snapshot。
- attempt 以外部消息生成的 operation id 去重，生命周期单向持久化；同一命令不会双跑。
- 首版零工具、零自动学习、零副作用重放。普通 `/new` 退出恢复隔离。

## 验证

场景测试覆盖了事故的核心形态：第一次回答被旧审计框架污染，随后 `/recover t1` 在同一
任务上只看到原始“回答 25 道题”请求，输出修订答案；旧答案不可见，工具列表为空，重复
投递不产生第三次模型调用。单元测试覆盖权限、conversation/assignee 绑定、busy blocker、
缺失与跨 conversation 来源、持久化、幂等和 attempt 状态不可回退。

## 尚未包含

这一阶段只解决“无需外部读取即可重答”的任务。需要重新查网页、读文件或调用连接器的
恢复必须等待后续 provenance/read-only capability 阶段；本实现会明确说未知，不会假装复核。
