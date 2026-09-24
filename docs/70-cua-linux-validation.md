<!-- doc: 70-cua-linux-validation
     title: Linux CUA 回归矩阵与状态验收
     family: guide
     status: current
     updated: 2026-09-22
-->
# 70. Linux CUA 回归矩阵与状态验收

本指南对应 INV-639；执行合同以 [03-architecture](03-architecture.md) 为准，研究和依赖选择见 [62-cua-driver-research](62-cua-driver-research.md)。测试只操作 runner 自行创建的临时容器，结束时删除；不连接现有盒子，不读取宿主 `~/.agentbox/token`。凭据只在本次进程内存和临时容器环境中，不进入报告。

## 构建与运行

在仓库目录执行，先构建生产 Dockerfile，再叠加测试专用依赖。`agentbox/box:latest` 不受影响。

```sh
AGENTBOX_IMAGE_REPO=agentbox/cua-fixes npm run build:image
docker build -t agentbox/cua-fixes-test:latest docker/cua-test
docker build -f docker/cua-test/platform.Dockerfile -t agentbox/cua-platform-test:latest docker/cua-test
npm run test:cua
```

需要固定制品时给第二步传 `--build-arg BOX_IMAGE=agentbox/cua-fixes:<构建输出的 hash>`，第三步给 `--build-arg TEST_IMAGE=<测试基础镜像>`。runner 支持 `CUA_TEST_IMAGE` 和 `CUA_TEST_REPORT`；报告默认写入 `.runtime/cua-matrix.json`。镜像 digest、Linux 架构、实际 GTK/Qt/Chromium/Electron 版本、runner/fixture 内容 hash 与每项耗时进入报告，不能拿不同平台或 fixture 的记录直接比较性能。

GTK GI、PyQt5、Electron 44.3.0 只装在测试层。Electron 二进制在构建时预取，运行 fixture 不再下载安装。HTML fixture 只访问容器本机 HTTP server；没有外部账号、模型调用或付费 API。

## 矩阵合同与 oracle

`docker/cua-test/matrix.json` 是版本化清单，目前声明 17 项。每项标明 toolkit/backend/addressing/delivery/expected/oracle。runner 必须给每项一个结果，少跑一个也不能通过。

| 表面 | 寻址与派发 | 独立状态证据 |
|---|---|---|
| GTK3 | snapshot ref → 坐标；AT-SPI invoke / EditableText | 应用 clicked/changed callback 写出的计数和文本文件；invoke 前后指针不移动 |
| Qt5 | snapshot ref → AT-SPI invoke / EditableText | Qt clicked/textChanged callback 写出的状态文件 |
| Chromium | snapshot/find → CDP input | 容器本机 HTTP server 接到请求后写出的状态文件，与 DOM expect 对照 |
| Electron | 已存在 renderer → CDP input | 同一个 HTTP oracle 的独立 electron 状态，明确不是任意 Electron 应用的原生 AX 支持声明 |
| xterm | 无 AT-SPI 树 | 明确 unavailable；前次元素 token 被撤销；旧按钮计数不变 |

负例覆盖换快照、无树读取后旧引用、移动窗口、同进程同标题歧义、禁用控件、跨 desktop token、等待中人工接管、批次部分失败、动作前截图、浏览器旧 snapshot、无实际写入的 hover/动画。验证既检查回执，也检查应用状态；“原生调用退出 0”“截了图片”或模型自述不作为成功 oracle。

## 如何读结果

- `pass`：本项预期与外部状态相符。拒绝场景的 pass 表示确实没有投递，不表示控件支持该动作。
- `fail`：断言或应用状态不符。
- `environment_error`：启动、连接或 fixture 等基础设施失败；不得解释成不支持后悄悄略过。
- `not_run`：清单声明但没有执行。整个矩阵失败。

所有项 pass 且没有环境错误才返回进程 exit 0。可用 `CUA_CASES=<case id>` 诊断单项；未选项仍记 not_run，整个验收仍失败。`npm test` 只验证 hermetic 的合同、状态投影、撤销/超时和 agent episode，不暗中启动 Docker；发布前显式运行 `npm run test:cua`。

## 范围

这是固定 Linux/X11 应用 fixture 的工程回归，不是随机模型任务成功率或所有 GTK/Qt/Electron 软件的兼容性认证。Wayland、远程断线、锁屏、缩放组合以及 Mac/Windows 不在本版矩阵的通过声明中。真实模型 scorecard 仍需单独执行；用户已将原生跨平台试点 INV-640 暂缓。

## 本次测量

原始报告：[cua-linux-2026-09-22.json](evidence/cua-linux-2026-09-22.json)。Linux arm64，GTK 3.24.49、PyQt 5.15.11、Chromium 152.0.7977.82、Electron 44.3.0；17/17。报告包含每个 case 的耗时、样本和对应镜像 digest。

可加 `CUA_BENCHMARK_SAMPLES=10 npm run test:cua` 取得有限样本的端到端测量；每个动作也检查应用状态。首次读树 312 ms；后续 10 次读树 P50/P95 313/330 ms，native invoke 2340/2357 ms，set_value 2339/2351 ms。这里“冷/热”指应用/总线会话，helper 每次都是新进程；动作包含默认 2,000 ms settle 和最终截图，不是 AT-SPI 单次调用耗时。10 个样本的 P95 接近最大样本，不能外推成生产 SLO。

Docker 报告的生产镜像 Size：第一轮观测修复版 `6801497745c0` 为 1,847,841,422 bytes，原生语义版 `c95faacd900d` 为 1,847,858,068 bytes，增量 16,646 bytes。这两个制品均已包含 Python GI，差额也包含 INV-637 的协议改动，不是 Python/Rust 性能或体积对照。完整测试层为 2,390,093,164 bytes；测试依赖未进入生产镜像。

动作总耗时目前受固定 settle 主导。后续可借鉴上游的事件/状态收敛等待，比较固定任务成功率和 P95 后再调整；本轮没有为了降低数字缩短等待，也没有为尚未测得的性能优势引入外部运行时。

包含最后一项 CDP 后台回调权限补丁的镜像又完成了全矩阵 17/17，见 [最终 GUI 报告](evidence/cua-linux-final-2026-09-22.json)。含延迟样本的前一份报告用于性能记录；两个报告各自保留实际测试的 digest。


## 合并后固定制品验收（INV-639、INV-654）

从 main `e0a1623` 构建并验收后，版本协商检查发现新 host 未消费 capability：旧 box 可能执行混合批次的前缀，再拒绝不支持的动作。修复 `bbe8729` 在 computer 写入或 expect 前检查当前合同和语义能力，缺失时整批拒绝；旧写入失败回执缺少 progress 时保持 unknown。修复前回归明确失败，修复后网络边界测试与完整 agent episode 通过。

2026-09-22 的初次验收生产镜像为 `agentbox/cua-release:7804bf680a75`，image ID `sha256:b9064d88531be92ae2b65ae24732c5e511211afc2c5c85ee83a3e37639c94d18`。测试层为 `agentbox/cua-release-platform:7804bf680a75`。源码、镜像 ID、bundle/helper/runner 校验和及验证范围见 [制品清单](evidence/cua-release-manifest-2026-09-22.json)。这些镜像保存在本次本机 Docker 中，未发布到远端 registry；不同机器需从固定源码重新构建并记录自己的 image ID。

- `npm run release:check`：1754 tests / 0 fail / 0 skip，类型、lint、构建、制品启动通过。
- [GUI 原始报告](evidence/cua-release-gui-2026-09-22.json)：17/17。
- [标准 smoke 报告](evidence/cua-release-smoke-2026-09-22.json)和[逐项日志](evidence/cua-release-smoke-2026-09-22.log)：42 passed / 0 failed，未配置的 egress relay 未覆盖。
- [真实版本组合报告](evidence/cua-release-compat-2026-09-22.json)：4/4，范围为固定历史 BoxClient/outcome 代码与真实 daemon 的 wire 兼容，不代表历史完整 UI/orchestrator 回归。

| 客户端 / 盒子 | 读取 | 写入结果 |
|---|---|---|
| 新 / 新 | 可用 | 没有后置条件的写入为 unknown |
| 新 / 旧 | 可用 | 整批派发前 refused；需要升级盒子 |
| 旧 / 新 | 可用 | 旧结果投影保留新盒返回的 unknown |
| 旧 / 旧 | 旧行为 | wire 可调用，但旧投影仍可能报 ok；不具备新保证 |

独立标准 smoke 使用明确镜像版本，生成随机临时凭据、隔离 AGENTBOX_HOME 和容器，设总期限及输出上限，结束删除临时环境：

```sh
CUA_RELEASE_IMAGE=agentbox/cua-release:7804bf680a75 node scripts/cua-release-smoke.mjs
CUA_RELEASE_IMAGE=agentbox/cua-release:7804bf680a75 CUA_LEGACY_IMAGE=agentbox/box:78bcc14810b0 node --experimental-transform-types scripts/cua-compat-smoke.mjs
CUA_TEST_IMAGE=agentbox/cua-release-platform:7804bf680a75 npm run test:cua
```

第二条命令需要旧镜像确实缺少 desktop contract v1；脚本会验证这一前提。历史客户端固定在 `cc71f82`，仓库必须保留该提交。报告分别写入 `.runtime/cua-release-smoke.json`、`.runtime/cua-compat.json` 和 `.runtime/cua-matrix.json`，可用脚本顶部对应的环境变量改输出路径。

### 部署与回退边界

本轮只做制品验收，未替换在用容器、默认 `agentbox/box:latest` 或用户的主工作树。正式切换时先记录目标容器实际 image ID、当前 host 版本和部署参数，保留旧 image 与对应 host 制品；使用现有 CLI 的 `box up --recreate` 备份/预检流程，明确指定 `AGENTBOX_IMAGE` 和 `AGENTBOX_CONTAINER`，保持原有 with-host、端口及卷配置。升级后检查 health 合同，再做目标环境的业务验收。

回退使用切换前记录的 image ID，不依赖可能已移动的 `:latest`/`:previous`。宿主独立运行的 host 也恢复到匹配版本；若只回退盒子，新 host 对旧盒的 computer 写入会按设计拒绝。自动回退读取 `AGENTBOX_IMAGE_REPO:previous`，采用自定义镜像仓库时需要同时核对该设置，不能假定它指向切换前在用版本。卷备份、用户会话恢复与实际生产切换不在本轮临时盒测试的通过声明里。

用户明确将真实模型评测另排，本轮没有调用模型、运行 20×5 基准或宣称任务成功率。INV-640 的原生跨平台试点继续暂缓。


### 2026-09-24：同步最新 main 后再次验收

上节报告对应合并 `e0a1623` 的制品。仓库后来将本指南从 63 号更名为 70 号，并合入其它工作；本次从当时的最新 main 再构建。基线与源码提交、生产/测试镜像 ID、bundle/helper/runner 哈希见 [最新制品清单](evidence/cua-release-manifest-2026-09-24.json)。生产镜像 `agentbox/cua-release:88ef46b8c7f6` 的本机 image ID 为 `sha256:91b43f3b69fcc3ad1bc355156e991db5a7021e6cc75f21e1c75d5650eb1fa296`，测试层为 `agentbox/cua-release-platform:88ef46b8c7f6`。

- `npm run release:check` 重跑：1848 tests，0 failed/skip，类型、lint、构建与制品启动通过。第一次并行运行有 3 项因测试端口临时占用而失败，端口释放后完整重跑通过；没有改测试或隐藏首轮失败。
- [GUI 逐项报告](evidence/cua-release-gui-2026-09-24.json)：17/17，包含真实 GTK/Qt/Chromium/Electron 应用状态 oracle。
- [标准 smoke 报告](evidence/cua-release-smoke-2026-09-24.json)与[逐项日志](evidence/cua-release-smoke-2026-09-24.log)：42 passed、0 failed；egress relay 未配置，未计覆盖。
- [版本组合报告](evidence/cua-release-compat-2026-09-24.json)：4/4，继续区分旧/旧仅能调用旧协议与新合同保证；旧客户端返回的 `ok` 不代表业务后置条件通过。

所有脚本使用自身创建的临时盒，结束后均已删除；在用 `agentbox-box` 的 image ID 未改变。未运行真实模型评测或生产切换。生产部署及回退按上节边界处理。
