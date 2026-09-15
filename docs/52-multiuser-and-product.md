<!-- doc: 52-multiuser-and-product
     title: 多用户与产品面：一次对账与打磨
     family: decision
     status: current
     updated: 2026-09-14
-->
# 52 · 多用户与产品面：一次对账与打磨

*2026-09-15。起因：读完 Octop（TencentCloud 的自托管多用户 assistant）之后，Chris 说
"我们的多用户设计以及产品面的确需要详细打磨一次"。*

**这不是一份新设计。** 设计已经有三份：docs/22（域模型，规范）、docs/36（企业版与阶段计划，
2026-09-03）、docs/50（企业原语，六透镜）。本文只做三件事：

1. 把那些设计和**今天运行中的代码**逐条对账（file:line）；
2. 修掉对账里暴露出来的**自相矛盾**——设计说退休了、代码还在 gate 的东西，以及两套并存的角色词表；
3. 给一个能执行的顺序、每步的验收，外加产品面的打磨清单。

对账里最重要的一条先说：**我们今天有认证，没有授权边界。** 任何通过飞书 OAuth 或邀请码
登录的人，浏览器里拿到的是**安装级那个万能 token**（`server.ts:2620`、`server.ts:3183`
都写 `agentbox_ui=<token>`）。角色降级只在带着 session cookie 的请求上生效
（`server.ts:2829-2846`）；同一个人从 DevTools 里把 token 抄出来、用 `Authorization: Bearer`
直接打 API、不带 session cookie，`callerOf` 会判定成 **owner**（`auth.ts:68`），`refused()`
一律放行。`auth.ts` 自己写着"这是防事故，不是安全边界"——那句话对 box 内的 agent 成立，
但**对"两个人"这件事，它意味着我们目前只有防事故**。多用户的第一步因此不是成员、不是目录，
而是**每个人有自己的凭证**。

---

## Part A：多用户对账（设计 → 代码事实 → 差距）

| # | 设计怎么说 | 代码今天怎么做 | 差距 |
|---|---|---|---|
| A1 认证 | docs/36 §1 Scene 0–1：`agentbox serve` 起来打印 bootstrap code，第一个人凭它成为 admin | 没有 `serve` 子命令；没有 bootstrap code。web 起来打印**安装 token**，谁拿到谁是 owner | Stage 0 未建 |
| A2 登录 | docs/36 §4 Stage 1 "landed" | 确实有：`/auth/<door>` 飞书 OAuth（`server.ts:2522`）+ 邀请码 `/api/login`（`server.ts:3130+`），都要求 identity 已在 roster | ✅ 有，但**发的是安装 token**（见上） |
| A3 授权 | docs/22 §0：权限只在 box 一层收口，agent 之间不分权 | `refused()` 查 roster 角色（`server.ts:2829`）；secret 授权走 `agent.profile.scopeId`（`tools.ts:2946, 3405`）；policy 授权按 agent 指纹 | **docs/22 §3 列的两个洞原样还在** |
| A4 角色词表 | 一套 | **两套**：`owner\|member\|viewer`（`auth.ts:41`，来自 control-plane header）与 `viewer\|driver\|admin`（`principals.ts:49`）。桥接是 `refused()` 里的一段 ad hoc 降级 | 必须合一 |
| A5 成员 | docs/22 §5：标签由 `members` 推导；docs/36 Stage 3 成员校验 | `Box.members` 字段存在（`box/boxes.ts:38`），**永远是 `"everyone"`**，没有任何校验点（`box/identity.ts:10` 自己写着"membership machinery comes later"） | 未建 |
| A6 可见性 | docs/22 §3：per-agent `visibility` **已退休**，`ownerUserId` 只作归属 | `refusalToDrive()` 仍以 `visibility === "private"` + `ownerUserId` 做 gate（`auth.ts:107-119`） | 设计与代码相反，必须二选一 |
| A7 投递归属 | —（我们没写过） | 例程/定时投递只认 chatKey，不校验接收者是不是该 box 的人。Octop 的 `delivery.py:72-75` 是 `session.user_id != command.user_id → raise` | 多人之后是洞 |
| A8 审计 | docs/22 §4、docs/47 | 事件带 principal 的地方不少（任务 requester、memory-audit、policy），web 侧部分动作只记 "web" | 补齐即可 |
| A9 降级 | docs/36 §0：个人版 = 多用户模型的退化情形（一个 admin、一个 box、members everyone） | 今天就是这个形状 | **任何一步都不能让单人安装变复杂** |

### A10 把矛盾定死（本文的决定）

1. **可见性之争按 docs/22 判**：`visibility`/`ownerUserId` 退出授权，只留归属显示。
   `refusalToDrive` 里那段删掉，改成 box 层的 members 校验。理由：两套 gate 并存时，
   "谁能驱动"有两个答案，而 docs/22 是规范文件。
2. **角色词表统一到 `viewer | driver | admin`**（principals 的那套），因为它是人的词表，
   而 `owner|member|viewer` 是 control-plane 的传输格式——后者降级为 header 到前者的映射函数，
   只存在于 `callerOf` 里。
3. **安装 token 从"人的凭证"降级为"机器/引导凭证"**：登录成功发的是**每人一张的会话凭证**，
   token 只在 (a) 首次引导、(b) CLI/脚本、(c) 没有 roster 的单人安装 这三种情形下有效。

---

## Part B：顺序（M1–M5），每步一条可跑的验收

与 docs/36 §4 的阶段一致，按今天的代码事实重排——**先关门，再分地方**。

**M0 · 已修（本文同批，PR 见下）**：登录不再下发安装 token，只发一张属于这个人的
session；`admit()` 把"有效 session 且 roster 仍认识这个人"当作一种认证方式，token 保留给
脚本、CLI 与没有 roster 的单人安装。回归测试 `src/web/session-credential.test.ts` 钉住三件事：
登录只 set 一个 `agentbox_who`、viewer 带 session 驱动是 403、不带 session 又没 token 是 401。

**M1 · 人的凭证（已做，PR 见下）**
- 角色词表统一到 `viewer | driver | admin`；control-plane 的 `owner|member|viewer` 只是传输
  格式，在 `callerOf` 一处翻译（owner→admin、member→driver、viewer→viewer），此外无人知道它。
- `callerOf` 在没有 header 时返回 `role: undefined`——"没人声明"是关于这个请求的事实，
  不是"全权"；由服务端决定它意味着什么（今天：持有安装凭证的操作者 = admin）。
- 按人踢下线：会话 cookie 带一个 generation，`~/.agentbox/session-epochs.json` 记每个人
  当前的代数，`POST /api/principals/logout` 把某个人的代数 +1——他的所有浏览器下一次请求
  即失效，别人不受影响。以前唯一的办法是轮换 token，等于把所有人一起踢下线，所以从没人用。
- *验收*（`session-credential.test.ts`）：三条入口 × 三种角色的矩阵；viewer 无论从哪条入口
  都是 403；踢下线后该人 401、别人照旧。

**M2 · 地方的成员（已做，PR 见下）**
- `mayEnterBox(box, principalId)` 是唯一的判定（`src/box/membership.ts`），三处收口：
  `GET /api/boxes` 只列自己在的（不在的连名字都不出现——列出来又打不开，等于告诉他它存在）、
  web 的 `refused()`、聊天入口的 `ask`（同一套判定，否则"成员"就成了"你走哪道门"的属性）。
- `everyone` 是默认且不变，所以个人安装察觉不到任何变化；空集是关着的箱子，不是开着的；
  **admin 不自动在每个房间里**——要进去就把自己写进成员集合，留在文件和日志里。
- 安装自身的凭证（CLI、脚本）不是 roster 里的人，因此不受成员制约——否则机器把自己锁在外面。
- UI：box 行下面一行由成员推导的标签（docs/22 §5），admin 多一个 Members 按钮，按名字改集合。
- *验收*（`session-credential.test.ts`）：改成 Dana 的箱子之后，Mia 列不到、驱动 403 且拿到
  指名道姓的理由、driver 不能自己改成员（403）、操作者凭证照常。

**M3 · 授权主体迁移（docs/22 §3 的两个洞）**
- secret 授权主体从 `agent.scopeId` 迁到 box；policy 的 session/standing 授权指纹去掉 agentId，
  改为 box 主体；`once` 保持逐次询问。
- *验收*：同一个 box 里两个 agent 对同一 secret、同一 `RunOnHost` 动作得到**逐字节相同**的决定，
  用矩阵测试钉住；迁移对旧 grant 是 fail-closed（读不懂就重新问）。

**M4 · 投递与例程归属**
- 例程/定时/webhook 投递前校验：目标会话属于这个 box，且发起人有权驱动它（Octop 那道门的等价物）。
- *验收*：把一个 box 的例程 deliver 指到另一个 box 的群，启动时报错而不是投出去。

**M5 · 审计与降级**
- web 侧每个改变状态的动作都带 principal（今天有一部分记成 "web"）。
- 单人安装的"没有变复杂"作为一条验收：全新安装到第一条消息的步数与 M0 前相同。

**不在这五步里**（docs/36 的其余阶段，维持原顺序）：目录同步、个人 box 配额、
Electron 连接到远端安装、部门树。它们都要等 M1–M3 落地才有意义。

---

## Part C：产品面

### C1 今天有什么

web 六个视图（chat / tasks / memory / audit / boxes / settings）、~100 个 API 路由、
CLI 30+ 子命令（box/agents/template/bundle/host/chat/control/egress/mcp/usage/audit…）、
Electron 壳、MCP face、webhook、模板与 bundle 的装卸、跟进 rails（问题/任务/承诺/提案）。

### C2 缺口，按"一个人头十分钟"排序

1. **首次运行仍是 CLI 与 web 的混合**。docs/37 把路径写清楚了，但装 box、连门、建第一个 agent
   分散在三处，没有一条"下一步做什么"的主线。**这是产品面最贵的一条。**
2. **没有"我"的视角**。今天的页面是"系统有什么"，不是"我该管什么"。跟进 rails 刚好把数据备齐了：
   我欠的（我被问的问题、我是 requester 的过期卡、等我裁决的关闭提案）、别人欠我的。
   一个 `/api/attention?me` 就能渲染——这也是 docs/51 §3.3 缩小后留下的那块。
3. **语言两张皮**：后端对人说中文（`channels/strings.ts`），web UI 是英文。同一个人在飞书里
   看到中文卡片，点进 web 看到英文按钮。Octop 的做法（bundle + domain + locale 解析 + 前后端
   key 对齐测试）是成熟解，抄结构不抄实现。
4. **飞书里做不完的事没有清单**。哪些必须回 web？没人列过。列出来才知道要补哪几个卡片。
5. **空状态与错误**：没有 box 时、没有 agent 时、门没连时，页面是空的而不是有指引。

### C3 不做（明确，省得反复讨论）

- 知识库/OCR/文档解析：Octop 有一整套，我们不做——box 里有真机器，agent 自己读文件就是我们的答案。
- 插件市场：我们有 catalog + 模板货架 + bundle，不另起一套。
- 移动端 App：飞书就是我们的移动端。

---

## Part D：Involute 候选（等 commit）

M1–M5 各一条，产品面 C2.1/C2.2/C2.3 各一条，外加 docs/22 §3 的矛盾清理一条。

引用：docs/22-domain-model.md（规范）、docs/36-enterprise.md §0/§1/§4、docs/50-enterprise-primitives.md、
docs/37-onboarding.md、docs/39-ui-objects.md、docs/45-teams.md、docs/51-follow-through.md §3.3、
docs/research/2026-09-14-octop-follow-through.md。
