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

## INV-637：派发、变化和后置条件分离

- 原生像素差和 DOM 变化只返回 `observed_change`；保留 legacy `confirmed` 的解析能力，但 host 不再将它视为验证成功。
- protocol 中唯一的 `actionOutcome/computerOutcome` 投影供 boxd/host 共用。无后置条件的已发出输入为 unknown；明确回读不匹配为 failed，同时保留 sent，不能由此重放。
- computer 新增可选 expect（精确窗口标题/唯一控件 role/name/states）；browser 的现有 expect 返回结构化 verification，而非丢掉派发状态后抛错。目标读失败不证明 gone，空 expect 不算验证。
- 请求过期 ref 的浏览器调用必须提供 snapshot，或改用当前 find。scroll/open/switch 不再归为可自动重试的读取；CDP 每次发送重验权限，撤销后只允许释放本次已按下的键/鼠标。
- 两个真实 stack 的 scripted agent episode 验证模型看到 unknown、已完成前缀和先观察指引。它们验证合同传达，不代表真实模型行为成功率。

`npm run release:check` 退出 0，1,736 tests + 产物启动检查通过；日志 `/tmp/lumenbox-cua-research/637-release.log`。原始五项 research probe 全部 reproduced=false。GUI 10/10，镜像 `agentbox/cua-fixes:f522c557d1de`，测试层 digest `sha256:4d4a5fbfd47eb3659ec94fad774227cb8f5248989317423443c0b0f25292beff`；日志 `/tmp/lumenbox-cua-research/637-gui.log`。这次已回归 INV-636 最后两个补丁。最后追加的 browser recovery/CDP authority 改动经过新增单测和全套检查，下一轮 GUI 镜像一并验证。真实模型 scorecard 未执行。

## INV-638：原生语义与隔离 driver 边界

- boxd 依赖 `DesktopDriver`；现有 X11/AT-SPI 实现声明平台/前台限制/语义操作能力。native ref 仍由既有观测与权限合同管理，没有第二套业务 session。
- AT-SPI 树按具体控件返回 operations；`invoke_element` 调用 Action，`set_value` 调用 EditableText 并在 helper 内比较回读值。未声明能力、disabled、旧目标明确拒绝；不隐式降级坐标点击。数字 spin/slider 与密码框不声明文本 set_value。
- 树读取和原生操作均在独立 helper 中，截止时间、输出大小、撤销时 SIGKILL、下一次干净进程都已验证。值仅走 stdin；回执不包含输入值、stderr 或异常内容。
- 真实 GTK 测试发现 GI 的 Text 方法名分派不能按对象便利接口猜测；改为显式 `Atspi.Text.get_text` 后，通过中英文文本回读与应用 changed callback 写出的状态文件交叉验证。

`npm run release:check` / 1,739 tests 与构建启动检查通过。GUI 最终 13/13，生产层 `agentbox/cua-fixes:c95faacd900d`，测试层 digest `sha256:ab696f8031ec43d4b6f86345984434faa564ee25c91c2da7577e113711f22551`，日志 `/tmp/lumenbox-cua-research/638-gui-final.log`。新测试证明 native invoke 不移动鼠标且应用计数增加；set_value 的 GTK 状态文件与回读匹配；旧 ref/禁用控件不派发。曾失败的中间镜像不作为通过证据。

### Python helper 与 accessibility-core 的取舍

同源参考固定在 research 的 `f64c0369`：`packages/accessibility-core/src/platform/x11.rs` 的 `do_action` 和 `set_value`。它通过 Rust atspi/zbus/x11rb，支持先尝试数值 Value、再 EditableText；LumenBox 当前 helper 复用镜像已装的 Python GI/AT-SPI，通过进程隔离获得相同的文本语义通路。此次没有复制上游源码或引入 crate/npm 运行时依赖。

选择现有 helper 是部署增量较小、既有窗口/权限合同可直接复用，且所需 vertical slice 已有真实状态证据。没有运行 Rust helper 的同环境性能对照，所以不声称 Python 更快或覆盖更广；Rust 异步总线和更多平台仍是候选。若以后引入，须让它实现相同快照/回执、超时/撤销、未知不重试合同，再在同一 fixture 比较 p50/p95、错误恢复与能力。数值 Value 目前明确不支持，避免把 spin 控件可见文本误判为已提交数值。

## INV-640：用户调整范围

用户明确选择「暂不扩原生平台，先完成 Linux 盒内方案」。不实施 Mac/Windows 试点，不安装 Cua Driver，不将两个上游设为默认依赖；已将该范围同步到 INV-640。
