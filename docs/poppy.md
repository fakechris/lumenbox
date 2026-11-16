<!-- doc: poppy
     title: Poppy (Personal Agent Protocol) — agentbox 集成指南
     family: guide
     status: current
     updated: 2026-11-16
-->
# Poppy (Personal Agent Protocol) — agentbox 集成指南

## 什么是 Poppy

Poppy 是 Sierra AI 发布的开放协议 (Apache-2.0)，定义个人 agent 如何代表用户与公司交互。协议涵盖发现、身份、OAuth 登录、浏览器协同、agent 对话和电商 (UCP)。

截至 2026-11，16 家公司发布了 `poppy.json`（12 家 Shopify 商家 + Stacktree + Rocket + crosswalk + Clerk）。

## 快速开始

### 1. 启用

Poppy **默认关闭**，要两个条件同时满足才开：`AGENTBOX_POPPY=1`，并且 `AGENTBOX_PUBLIC_URL` 是一个 `https://` 地址（公司要从这个地址取 agent 的公钥来验证签名，没有公网地址就验证不了，开了也没用）。只在 `--public-url` 里写地址不算，要设环境变量。

关着的时候什么都不发生：不生成密钥，不向任何网站要 `poppy.json`，不给 agent 这三个工具。

开着时，agentbox：
- 生成 ES256 密钥对（持久化到 `~/.agentbox/poppy-agent-key.json`）
- 在 `/poppy/agent.json` 和 `/poppy/jwks.json` 发布 agent 元数据（这两个和 `/poppy/callback` 不需要登录，别的都需要）
- 在每次 `WebFetch` 访问新域名时先请求它的 `poppy.json`，支持的站点会收到 `Poppy-Session` header

### 2. Agent 工具

启用后，agent 获得三个工具：

| 工具 | 用途 |
|------|------|
| `PoppyDiscover` | 检查某个域名是否支持 Poppy：通道、OAuth、UCP |
| `PoppyConverse` | 与公司 agent 对话（SSE 流式） |
| `PoppyStatus` | 查看当前 Session、Token、身份状态 |

### 3. 自动行为

- **每个 agent 是一个独立的 Poppy User**：User ID、Session、登录和 token 都按 agent 分开。两个 agent 去同一家公司，公司看到的是两个人；一个 agent 登录拿到的 token 别的 agent 用不到。User ID 存在 `~/.agentbox/poppy-user-ids.json`（0600），重启后不变。
- **Header 注入**：agent 用 `WebFetch` 访问支持 Poppy 的 https 网站时，每个请求自动携带它自己的 `Poppy-Session` JWT + `Poppy-Version`。重定向每一跳都签发新 JWT（因为 JWT 绑定 URL）；JWT 一分钟过期。http 页面不带。
- **Browser Join**：agent 用 `browser_open` 打开 https 网页时，自动检测 Browser Join 支持。每个 agent 首次访问某域名时先导航到 join URL（必须是该公司自己站点上的 https 地址，并再过一遍地址检查），让浏览器加入它的 Poppy Session。
- **Token 自动刷新**：同一个 token 同时只刷新一次；服务器明确说 `invalid_grant` 才删除，临时失败（503、断网）保留，刷新响应没带新 refresh token 时保留旧的。

### 4. OAuth 登录

两种方式：

#### Authorization Code + PKCE（需要浏览器）

```
1. （尚无工具入口）代码调用 manager.startSignIn("allbirds.com", agentId)
2. 返回一个 URL，用户在浏览器中打开
3. 用户授权后，公司的 auth server 重定向到 /poppy/callback
4. agentbox 自动交换 code → token 并存储
```

#### Device Code（无浏览器场景）

```
1. （尚无工具入口）代码调用 manager.startDeviceSignIn("allbirds.com", agentId)
2. 返回 user_code + verification_uri
3. 用户在手机上访问 URL 并输入 code
4. agent 轮询 manager.pollDeviceSignIn(deviceCode) 直到完成
```

Token 持久化在 `~/.agentbox/poppy-tokens.json`（mode 0600）。

### 5. UCP 电商

对支持 UCP 扩展的 Shopify 商家：

```typescript
const ucp = await manager.ucpClientFor("allbirds.com", agentId);
if (ucp) {
  const profile = await ucp.discoverProfile();
  const cart = await ucp.createCart([{ productId: "...", quantity: 1 }]);
  const checkout = await ucp.createCheckout(cart.id);
  const order = await ucp.completeCheckout(checkout.id);
}
```

### 6. 对话与操作审批

```typescript
// 与公司 agent 对话
const ctrl = await manager.converse("allbirds.com", agentId, "我想退货", (event) => {
  if (event.type === "message") console.log(event.message.content);
  if (event.type === "operation") {
    // 公司请求执行某个操作（如退款）
    // 自动映射到 consent card，等待用户确认
  }
});
```

公司要求的 operation（`requires_approval: true`）会在 Policy Gate 上开一张确认卡（`irreversible` → L4，`personalData` → L3，其他 → L2）。agent 不能自己批准：人在卡片上同意或拒绝后，答复由主机直接发给这家公司，再把公司的回应告诉 agent。没有人可问的地方（没有 Policy Gate）不开卡，agent 被告知"未批准"，公司那边什么也不发。等待中的 operation 只在内存里：主机重启后，之前那张卡的答复不会再发给公司。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                      orchestrator                        │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ PoppyMgr │──│  poppy-fetch │──│ withRequestHeaders│  │
│  └────┬─────┘  └──────┬───────┘  └────────┬──────────┘  │
│       │               │                    │              │
│  ┌────▼─────────────────────────────────────▼──────────┐  │
│  │                    web.ts                            │  │
│  │  requestOnce(url, extraHeaders) → RawResponse       │  │
│  └─────────────────────────────────────────────────────┘  │
│       │                                                    │
│  ┌────▼───────────────────────────────────────────────┐   │
│  │                   turn.ts                           │   │
│  │  TurnDeps { webFetch, poppyManager }               │   │
│  └────┬───────────────────────────────────────────────┘   │
│       │                                                    │
│  ┌────▼───────────────────────────────────────────────┐   │
│  │                   tools.ts                          │   │
│  │  WebFetch → context.webFetch (Poppy headers)       │   │
│  │  browser_open → poppyBrowserJoinUrl → box.browser  │   │
│  │  PoppyDiscover / PoppyConverse / PoppyStatus       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  server.ts                           │   │
│  │  GET /poppy/agent.json   ← 公司验证 JWT             │   │
│  │  GET /poppy/jwks.json    ← 公司验证 JWT             │   │
│  │  GET /poppy/callback     ← OAuth 回调（纯文本回答） │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## 安全

遵循 spec 10.1：
- **access token / refresh token / private key** 始终在 PoppyManager 内，永远不进入 model context
- **Session JWT** 由 manager 签发后直接注入 HTTP header，agent 不可见
- **Token 文件** mode 0600
- **Pairwise User ID**：每个 agent 每家公司一个 ID，按公司域名区分（不按 poppy.json 自称的 issuer），跨公司不可关联
- **所有请求走同一扇门**（`src/host/poppy/http.ts`）：只用 https；URL 里不能带账号密码；域名解析和 WebFetch 用同一个受防护的 lookup，内网和本机地址在连接时就被拒绝，字面 IP 在连接前被拒绝；不跟随重定向（发现 `poppy.json` 时例外，每一跳重新检查）；响应体最多 4 MB
- **端点必须在公司自己的站点上**：poppy.json 里的对话、Browser Join、UCP 端点，operation 的答复地址，都必须是该域名或它的子域名。授权服务器的元数据必须声明它被问到的那个 issuer，token / device / revocation 端点必须在 issuer 的站点上
- **token 按"哪个 agent、哪个域名"存**，旁边记着签发它的 issuer；只有这个域名、而且它现在声明的 issuer 和签发者一致时才会用。冒称别家 issuer 的站点拿不到别家的 token
- **`PoppyStatus`** 只显示调用它的 agent 自己的会话和登录；查过哪些没有 Poppy 的域名只给数量，不给列表

## 配置

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `AGENTBOX_POPPY` | 不设（关闭） | 设为 `1` 开启 |
| `AGENTBOX_PUBLIC_URL` | 不设 | agent 的公网 HTTPS 地址（用于 OAuth callback 和 client metadata）；不是 `https://` 时 Poppy 不开 |

## 诊断

- 没有公开的状态地址：会话、token、看过哪些域名都不是公开信息。要看就让 agent 调 `PoppyStatus`
- **日志** — `[poppy]` 前缀输出到 stderr
- **agent 工具** — `PoppyStatus` 让 agent 自查

## 测试

```bash
node --experimental-transform-types --test src/host/poppy/*.test.ts src/host/poppy-fetch.test.ts src/host/poppy-browser.test.ts src/host/poppy-tools.test.ts
```

## 还没有的

- **没有让 agent 发起登录的工具**。`startSignIn` / `startDeviceSignIn` 在 PoppyManager 里，但没有工具调用它们，所以实际上拿不到 token：对话、Browser Join、发现都以匿名 Session 进行。
- **UCP 电商没有工具入口**，只能在代码里调用 `ucpClientFor`。
- **等待中的 operation 不跨重启**（见上）。

2026-11-16 审查列出的问题（INV-1893）：请求不经过地址防护、确认卡不回传、token 按 issuer 存、明文 HTTP 带 header、JWT 无 exp、SSE 解析、刷新竞争、User ID 不持久、对话超时不中止，都已修复，测试在 `src/host/poppy/protocol.test.ts`（整套请求走脚本化的网络，不联网）。
