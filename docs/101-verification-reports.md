<!-- doc: 101-verification-reports
     title: 带录像的验证报告：场景与断言两级、时间轴、结论，在对话里是一张卡
     family: decision
     status: current
     updated: 2026-11-20
-->
# 101. 带录像的验证报告

INV-1925。回答“凭什么相信它做完了”：成员按计划逐条验证，每条断言有结果、看到的事实和时间，配一段能播放、
能按断言跳转的录像，最后写一段结论。人在对话和“需要你”里看到一张卡，点开是报告页。

## 1. 问题

桌面录制（`src/boxd/record-service.ts`，INV-1949 起有保留期与权限）和结果检查（`result-check-*`）各自存在，
但没有合成给人看的证据：录像里不知道哪一段在验证什么，检查结论没有对应画面。人只能从头看录像或者相信一句“通过了”。

## 2. 决定

- **一个成员工具 `Verify`**，按顺序走：`plan`（标题、所验证的版本、场景 → 断言，断言写要观察的事实）→
  `start`（在该成员自己的桌面开始录制）→ 每条断言一次 `check`（通过 / 失败 + 观察到的事实）→
  `finish`（停止录制、写结论、发卡）。`abandon` 放弃一份没写完的报告并停掉录制。
  先计划再录，是为了让断言在执行前就写下来，不是看完结果再编。
- **时间由 host 记**，不由模型报：`start` 拿到录制开始时刻，`check` 的时间戳是 host 收到调用的时刻，
  `offsetMs` = 它减去录制开始。模型给不出、也改不了一个断言在录像里的位置。
- **box 只负责录**，沿用 `/record/start`、`/record/stop`，不改 box 镜像。
  步骤名叠在画面上由报告页按数据绘制，不烧进视频。缩略图用页面里的 `<video>` 停在第一处失败（没有失败就停在开头），不另做截图。
- **一张卡，一个家**：对话里的卡是 ShowUI 目录里的一个新组件 `VerificationReport`（props 只有报告 id，数字从报告读，模型给不了），
  飞书 / 钉钉降级为结论文字 + 通过 / 失败数 + 报告页链接。“需要你”里是 attention 的新类型 `verification`，
  给任务的请求人，报告有失败时排在前面。

## 3. 数据模型

```ts
interface VerificationReport {
  id: string;                 // "vr-" + 8 位
  agentId: string; conversation: string; taskId?: string;
  title: string; version: string;      // 所验证的提交或构建标识
  state: "planned" | "recording" | "finished" | "abandoned";
  createdAt: string; startedAt?: string; finishedAt?: string;
  recording?: { file: string; display: number };   // box 里录像文件名，经 INV-1949 的 /recording?agent= 读取
  scenarios: { id: string; name: string; assertions: Assertion[] }[];
  conclusion?: string;        // 先说通过了什么，再说失败的是什么、看到了什么
}
interface Assertion {
  id: string; fact: string;   // 计划时写下要观察的事实
  result?: "pass" | "fail"; observed?: string; at?: string; offsetMs?: number;
}
```

计数（通过、失败、未检查）总是从断言算，不存。未检查的断言在 `finish` 时如实显示为“未检查”，不算通过。

## 4. 存储与保留

- 报告：host 上 `<agentbox home>/verification-reports/<agent id>/<report id>.json`，每次变化整文件重写（几 KB）。
  每个成员保留最近 200 份，更早的删除。
- 录像：留在 box 的 `/home/box/work/recordings/`，跟着 INV-1949 的保留期走（默认 14 天、每 box 2 GB，不进卷备份），
  读取经过成员与 box 的权限判断。录像被清理后报告还在，报告页写明“录像已按保留期清理”，断言和结论照常可读。
- 磁盘：录像约 1.5 MB/分钟（docs/38 实测），一次 5 分钟的验证约 7.5 MB，2 GB 的上限约放得下 270 次。
  报告本身每份几 KB，200 份不到 1 MB。

## 5. 报告页

`GET /verification/<id>?agent=<成员>`，与 `/recording` 同一套判权（不认识的成员 404，不是这个 box 的人 403）。

- 左：录像，当前步骤名叠在画面上方。
- 下：时间轴按场景分段，每条断言一个刻度，失败的刻度与其所在区间标红。
- 右：通过 / 失败 / 未检查计数、结论、场景 → 断言两级清单；点一条，录像跳到它的 `offsetMs` 前 2 秒。

## 6. 不做

- 录像压缩、裁掉空闲、自动缩放（本项范围外）。
- 把录像复制到 host 或钉住不让保留期清理：要的话另开一项，那时再说磁盘。
- 报告的版本对比、跨报告检索。

## 7. 验收

- `Verify` 工具与报告存储的单元测试；`scenario.test.ts` 一条：脚本模型执行两个场景、其中一条断言失败，
  断言报告的计数、失败项文字与时间戳顺序。
- 报告页测试：点断言后播放位置跳转；失败段着色。
- 在隔离的真实 box 上走一遍，PR 附报告页截图与录像。`npm run check` exit 0。
