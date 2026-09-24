<!-- doc: handoff-2026-09-24-context-new
     title: Handoff — 上下文恢复第二项：空闲私聊 /new
     family: handoff
     status: current
     updated: 2026-09-24
-->
# Handoff — 上下文恢复第二项：空闲私聊 /new

## 交付边界

在 `fix/context-recovery`、第一项严格记忆投影提交之后，实现普通 `/new` 的首版机械边界。
它只在有私聊证据的外部独立会话、具备消息 ID、且所有已知责任为空时切换。团队主会话、
群聊、后台 fork、控制台、DingTalk（当前 wire 无可靠私聊标志）、忙会话及 `/new --clean`
都明确拒绝。拒绝不清消息、任务、附件或审批。

上下文 epoch 由 registry 持有；旧 transcript、summary、plan、todos、heard、checkpoint 和
reaction 原样归档。切换具有 prepare/commit、重启恢复、revision/CAS 和消息 ID 幂等语义。
旧二进制会遇到 downgrade fence，不能静默继续读取 epoch 0。普通模型视图只读当前 epoch，
显式 ReadHistory 和 audit export 仍能取回全部历史。

旧 turn、异步摘要和自动记忆提炼携带启动 epoch。晚到正文写入旧 epoch；旧 turn 不在重启后
重放；旧提炼不能写个人或共享记忆，也不能与新 epoch 的交换拼成一个自动学习批次。
长期记忆仍走第一项严格相关性投影，因此 `/new` 不是 clean，也不声称删除污染。

## 已覆盖的破坏输入

- 同一 reset 消息重复送达，且中间已经切过新的 epoch。
- prepare 后进程崩溃，重启完成同一个操作。
- 一个回答运行、两个请求排队时发送 `/new`，三项请求均完成且 epoch 不变。
- 旧摘要、旧计划和旧 todos 反复要求审计；切换后模型输入不含它们，但相关 fact 可用。
- 切换后的第二个追问继续读取新 epoch 第一轮回答。
- 旧 turn、个人/共享 memory writer、单次 extraction 和跨 epoch batching 晚到。
- audit export 同时保存 epoch 0 与 epoch 1；普通 UI 只显示当前版本。
- `/new --clean`、带附件 `/new`、无消息 ID、群聊、main、fork、路径形 conversation 均拒绝。

正式存储与行为合同只维护在 [docs/05](05-data.md)。下一项是严格 clean：最小工具集、禁用
Recall/ReadHistory/镜像绕行和自动学习。当前提交不能作为 clean 或通用任务恢复宣传。
