<!-- doc: handoff-2026-09-22-cua-fixes
     title: CUA 修复实施与验收记录
     family: handoff
     status: current
     updated: 2026-09-22
-->
# CUA 修复实施与验收记录

工作树：`/Users/chris/workspace/lumenbox-cua-fixes`，分支 `fix/cua-observation-contract`，基线 `23f51fd`。研究与依赖取舍见 [62-cua-driver-research](62-cua-driver-research.md)；研究记录保留当时事实，本文件记录后续实现。

## INV-636：观测与目标一致性

- 元素引用包含随机观测 ID；新读取（包括失败）、输入、接管、撤销和 owner/epoch 变化使旧引用失效。不得截取引用后缀。
- 点击前重读 AT-SPI，核验窗口 XID、进程启动时间、应用 bus/path、元素身份、名称、几何与 disabled。相同 PID/title 的多个窗口明确拒绝，不挑第一个。
- 最后一次输入或 wait 后重新截图；返回图像时间范围、坐标系、分辨率、已完成前缀。元素树在截图后复核一致，变化时撤回引用。
- 同一桌面的 computer/browser 共用队列，等待结束重新授权；接管与撤销不入队，执行中依旧检查授权。
- 失败保留已执行 action 数、失败位置与 sent/partial/not_started；发送后异常为 unknown，不把整个请求描述成零执行。
- health 增加可选合同能力；既有 host 复制完整 ref 仍可工作。旧 boxd 不获得这些保证。

验证：`npm run release:check` 退出 0，1,729 个 hermetic tests 通过，构建产物启动检查通过。模型 scorecard 明确 SKIPPED，未宣称随机模型任务验收。日志 `/tmp/lumenbox-cua-research/636-release.log`。

真实 GUI：`node --experimental-transform-types scripts/cua-contract-smoke.mjs`，9/9 通过。独立生产层 `agentbox/cua-fixes:6801497745c0`，镜像 digest `sha256:da922259ae1042afd94e3ef51f454f8499f40b8bcebf970af6c6d2bdb02f489b`；测试层 `agentbox/cua-fixes-test:latest` digest `sha256:4c97ca4a23aacbba5cc3959f4afc4404a28ed859c039cad995e43000fbd4c151`。测试容器自行创建并删除，不修改在用盒子或 `agentbox/box:latest`。测试层只增加 GTK GI fixture 依赖，来源 `docker/cua-test/Dockerfile`。

GUI 用应用自己的计数文件作为 oracle：原生树定位、换快照、无树读取后旧引用失效、移动窗口、最终截图、部分批次不重放、wait 中接管、跨桌面引用、同进程同名窗口。最后补入的 wait 刷新图像和截图前授权检查经 hermetic suite/产物检查；本轮 GUI 镜像早于这两个补丁，下轮镜像回归一并验证。日志 `/tmp/lumenbox-cua-research/636-gui.log`。

限制：观测是有时间范围的双重读取，不是 OS 级原子快照；人和 shell 可在两次 native 调用之间改变桌面。窗口/控件不可辨别时拒绝，不能宣称杜绝所有瞬时竞态。

## INV 同步障碍

INV-636—640 已由人提交为 COMMITTED。本会话尝试 `work_claim` 与不带 `run_id` 的 `run_report(running)`，均返回 `Claiming work requires an authenticated actor`。当前连接可读写合同，但无 agent actor，故没有伪造 claim/run，也没有标记 Done。实现证据可写入各项 verification，run 记录需要具备 actor 的连接才能补录。
