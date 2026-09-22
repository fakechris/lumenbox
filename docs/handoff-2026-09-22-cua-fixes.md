<!-- doc: handoff-2026-09-22-cua-fixes
     title: CUA 修复实施与验收记录
     family: handoff
     status: current
     updated: 2026-09-22
-->
# CUA 修复实施与验收记录

工作树：`/Users/chris/workspace/lumenbox-cua-fixes`，初始分支 `fix/cua-observation-contract`（领取 INV 后改用服务器签发的 `feat/inv-636-cua`），基线 `23f51fd`。研究与依赖取舍见 [62-cua-driver-research](62-cua-driver-research.md)；研究记录保留当时事实，本文件记录后续实现。

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

## INV 初始同步障碍（已解决）

INV-636—640 已由人提交为 COMMITTED。本会话尝试 `work_claim` 与不带 `run_id` 的 `run_report(running)`，均返回 `Claiming work requires an authenticated actor`。当时连接可读写合同，但无 agent actor，故没有伪造 claim/run，也没有标记 Done。实现证据可写入各项 verification，run 记录需要具备 actor 的连接才能补录。

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

## INV-639：Linux GUI oracle 矩阵

版本化清单 `docker/cua-test/matrix.json`，runner `npm run test:cua`，复现指南 [63-cua-linux-validation](63-cua-linux-validation.md)。GTK/Qt 原生调用、Chromium/Electron CDP，以及无树 xterm，最终 17/17；应用回调/本机 HTTP server 写出的状态文件是 oracle。结果区分 pass/fail/environment_error/not_run，漏执行或环境失败不能通过，单项诊断也不能伪装成全矩阵通过。

持久原始报告 [evidence/cua-linux-2026-09-22.json](evidence/cua-linux-2026-09-22.json) 同时记录 digest、fixture 内容 hash、toolkit 版本、10 次 cold/warm-session 端到端样本。首次读树 312 ms，热读树 P50/P95=313/330 ms，invoke=2340/2357 ms，set_value=2339/2351 ms；每次 helper 都重新启动。生产制品较第一轮观测修复增加 16,646 bytes，测试 toolkit 依赖只进入测试层。

工程层已验证；20 任务×5次的真实模型层没有运行，不把 scripted episode 或 GUI fixture 当成真实模型的成功率。未来模型评测应按 docs/62 的同模型/prompt/初态/版本约束另行执行。

额外边界核对：native invoke/set_value 与坐标输入共用 host 的写操作分类，均进入已有 auto-review；新动作没有另开权限通道。后续 `59865d7` 与最终断言更新补齐该项。

原有 smoke 脚本同步采用 observed_change 语义；同时修正两处测试问题：xclip 所有者继承输出管道造成无界等待（将裸 xclip 的清理对照限制为 1.5 秒，独立复制场景重定向输出、读取有界）；VNC 修复测试改为观察端口 owner PID 被替换，不再要求在 supervisor 修复之前必须看到端口暂时 down。二者都是测试 oracle/生命周期修正，没有修改 clipboard 或 supervisor 产品实现。

### 最终收口

`npm run release:check` 退出 0：1,740 tests，0 failed，构建与产物启动检查通过；日志 `/tmp/lumenbox-cua-research/final-release.log`。独立干净盒上的原有 `scripts/smoke.mjs` 报告 42 passed / 0 failed，日志 `/tmp/lumenbox-cua-research/639-standard-smoke-complete.log`；其中 egress relay 未配置，该条件项没有实际覆盖，不把它算成外网中继验证。

最后补上长寿命 CDP 对话框回调的权限：请求结束后仍使用最新调用者的 owner/epoch 与桌面控制权检查；人工接管期间的只读观察不能授予后台输入权限，未答复不能报成已答复。hermetic 回归覆盖撤销后回调、只读观察与新授权。包含该补丁的最终镜像再次跑完整 17 项，全部通过：[最终 GUI 报告](evidence/cua-linux-final-2026-09-22.json)。前一份含延迟的报告保留作为测量记录，不混淆两个镜像 digest。

所有测试容器均已删除；工作树内生产代码和可复现测试按 INV 分项提交。没有合并或改写主工作树，也没有更换在用盒子。INV 合同 verification 已写入可审查证据；初次收口时 actor 身份障碍尚在，后续解决过程如下。


### PR 集成与 INV 认证修复

[PR #208](https://github.com/fakechris/lumenbox/pull/208) 汇总 INV-636—639 的分项提交。无冲突合入 main `cc71f82` 后，`npm run release:check` 再次退出 0，1,750 tests / 0 fail / 0 skip，类型、lint、构建及制品启动通过；日志 `/tmp/lumenbox-cua-research/pr-release.log`。GUI 证据仍对应上文所列的实际镜像，未冒称该轮重新运行模型或 GUI 测试。

用户配置的新 agent token 有效，位于 macOS launchctl 的 `CODEX_INVOLUTE_AGENT_TOKEN`；当前会话继承的旧环境缺少该变量，已有 MCP 连接仍使用旧身份。直接读取已配置凭据调用同一 MCP 后，actor 认证通过；未打印或保存凭据。INV-636/637/639 分别登记 RUN-342/343/344，附上 PR 与固定 commit 的 GUI 原始报告后 completed，进入 In Review。

INV-638 的代码已包含在 PR，工程验证已通过；但 INV 要求其依赖 INV-636/637 先经人工验收，故领取返回 `Work is not ready to be claimed`，run_report 也要求有效 claim。没有删除依赖或代替人标 Done。其描述已附交付证据，并提交 In Review；领取与 run 补录等待依赖人工验收。新 agent 身份不允许改写已承诺的 verification 合同字段，旧字段中的认证错误保留为历史，最新描述与 runs/evidence 已明确更正。
