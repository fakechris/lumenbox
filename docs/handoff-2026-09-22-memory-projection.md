<!-- doc: handoff-2026-09-22-memory-projection
     title: Handoff — 上下文恢复第一项：严格记忆投影
     family: handoff
     status: current
     updated: 2026-09-22
-->
# Handoff — 上下文恢复第一项：严格记忆投影

## 本次交付范围

用户批准在新 worktree 逐项实施上下文恢复，并明确允许本轮本地实施。
工作目录为 `/Users/chris/workspace/lumenbox-context-recovery`，分支 `fix/context-recovery`，
起点 `cc71f8223138a010b70c2e211cf739fa3a7ac57c`。没有修改运行中的 box 或主工作区的未提交研究。

第一项修复个人/共享记忆的自动准入：

- 预算以内也筛选；选择空集合就不注入，选择子集不再回填其他内容。
- 被拒绝的记忆不进入正文，也不从省略索引重新出现。
- 没有查询时不注入；筛选不可用时只回退到词面相关的 fact，先处理撤回记录。
- prompt 默认路径遵守同一限制；共享记忆不再绕过筛选；续轮复用同一投影。
- 正文预算允许零条，超长的已选记录只进入受限索引。
- turn ledger 增加个人/共享筛选方法、正文/索引候选哈希及排除数量，不再复制记忆正文。

正式语义只维护在 [docs/05](05-data.md)，本文件记录交付证据，不另立规范。

## 证据与复审

`memory-projection.test.ts` 最初四个反例在旧实现上全部失败，修复后通过。
新增场景让真实 registry、bus、turn 读取个人与共享的旧审计式习惯，分别模拟空选择和
筛选服务离线，验证模型实际收到的 system 文本没有这些习惯，并完成当前技术问答。
脚本模型验证的是上下文边界，不是实际模型的语言质量。

`npm run release:check`：typecheck、lint、全量 1740 项测试、构建和产物启动检查通过。
lint 仍有仓库原有 warning/info，未顺手改动。真实模型场景未跑，scorecard 的 model 为
SKIPPED，因此总体为 INCOMPLETE，不能据此声称实际 Nova 的表达问题已彻底解决。
本地执行日志：`/tmp/lumenbox-context-recovery-release.log`。

复审接受的取舍：

- 拒绝“只在预算超限时筛选”：短记忆同样能污染回答。
- 拒绝“空选择回退评分”：这会撤销筛选决定；失败也不代表全部相关。
- 保留低层 score-only recall 给存储/评估；生产 prompt 走严格投影，避免偷偷改掉其他用途。
- 失败时相关 fact 仍可能错误，词面匹配也可能漏掉同义事实。这不是事实真伪判定器。
- 每个非空记忆层可能多一次筛选调用；两层并发，续轮不重选。
- 记忆哈希是诊断标识，不是秘密匿名化。当前清单是记忆选择记录，不是完整上下文来源清单。

## 未交付边界和下一项

本提交没有实现 `/new`、`/new --clean`、`/recover`、上下文 epoch、旧后台写入隔离、
来源撤回/禁止重新提炼或自动恢复。没有更换模型，也没有删除已有记忆。
正常工具仍可显式读取 Recall、历史和 box 镜像；已有聊天、摘要、模板也可能继续影响回答。
因此不得把这一项称为“干净会话”或“全部根治”。

下一项按已批准方案实现闲置个人会话的上下文切换，再接严格 clean 与同任务恢复。
必须保留旧记录和未完成请求，忙时拒绝切换而不是清队列；不同渠道调用同一 host 服务。
epoch 与 channel incarnation 分开，后台旧结果不能写进新上下文。

## INV 记录

已先搜索，新增候选 [INV-653](https://involute.lumenopen.com/)（属于 INV-142，关联 INV-147），
明确这是已交付记忆质量工作的后续准入缺陷，不重复其原验收合同。
当前 MCP 能写候选，但 claim/run report 均返回缺少 authenticated actor。
用户已明确允许本地实施；没有伪造 claim/run，也没有将事项标成 Done。
身份链路恢复后再补执行记录及提交证据；无须用户把 token 再贴进聊天。
