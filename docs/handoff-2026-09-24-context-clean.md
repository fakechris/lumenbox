<!-- doc: handoff-2026-09-24-context-clean
     title: Handoff — 上下文恢复第三项：严格 /new --clean
     family: handoff
     status: current
     updated: 2026-09-24
-->
# Handoff — 上下文恢复第三项：严格 /new --clean

## 交付边界

在持久 context epoch 之上增加 `normal | clean` 模式。`/new --clean` 只沿用普通 `/new`
已经落地的私聊、权限、空闲责任、消息幂等和崩溃恢复边界，不扩大到群聊、main、fork、
控制台或当前无法证明私聊性质的 DingTalk。

clean 模式不载入个人/共享长期记忆、技能、任务、plan/todos、heard 或其他会话提示；首版只
接受文字，工具清单为空，dispatcher 对伪造工具调用再次拒绝。附件在渠道写盘前拒绝，自动
提炼、summary 学习、episode 和 pitfall 不写入长期或共享记忆。安全/权限策略、配置的 agent
身份及 clean epoch 内的新消息仍保留，所以它不是无痕模式、权限提升、删数据或换模型。

普通 `/new` 会进入新的 normal epoch，并明确提示长期记忆和工具重新按正常相关性与权限
规则启用。旧 epoch 仍在 audit/history 的显式读取面中；正常 prompt 只读当前 epoch。

## 验证过的破坏路径

- 重启后 clean 模式仍然生效；旧 state 文件缺少 `mode` 时按 normal 读取。
- 私人记忆、共享记忆、旧 transcript、plan 和技能名均未进入 clean 模型请求。
- 模型在工具清单为空时伪造 `RememberFact`，dispatcher 返回 clean 拒绝，记忆文件不变。
- clean 会话中的个人与共享 memory writer 被 registry 写入门拒绝。
- clean 中带附件的后续消息在存储和模型 turn 之前拒绝。
- 从 clean 发普通 `/new` 后，相关记忆和正常工具恢复；clean 的工具拒绝仍保留在跨 epoch
  审计场景中。

正式合同只维护在 [docs/05](05-data.md)。本切片没有实现 clean 附件的受控读取；需要附件
时先退出 clean，后续若增加只读导入，必须维持无同目录浏览、无任意路径和无自动学习。
