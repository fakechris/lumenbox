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

- **Header 注入**：agent 用 `WebFetch` 访问支持 Poppy 的网站时，每个请求自动携带 `Poppy-Session` JWT + `Poppy-Version`。重定向每一跳都签发新 JWT（因为 JWT 绑定 URL）。
- **Browser Join**：agent 用 `browser_open` 打开网页时，自动检测 Browser Join 支持。首次访问某域名时先导航到 join URL，让浏览器加入 Poppy Session（获得 Cookie），后续浏览就是已认证状态。
- **Token 自动刷新**：OAuth token 快到期时自动 refresh。

### 4. OAuth 登录

两种方式：

#### Authorization Code + PKCE（需要浏览器）

```
1. agent 调用 manager.startSignIn("allbirds.com")
2. 返回一个 URL，用户在浏览器中打开
3. 用户授权后，公司的 auth server 重定向到 /poppy/callback
4. agentbox 自动交换 code → token 并存储
```

#### Device Code（无浏览器场景）

```
1. agent 调用 manager.startDeviceSignIn("allbirds.com")
2. 返回 user_code + verification_uri
3. 用户在手机上访问 URL 并输入 code
4. agent 轮询 manager.pollDeviceSignIn(deviceCode) 直到完成
```

Token 持久化在 `~/.agentbox/poppy-tokens.json`（mode 0600）。

### 5. UCP 电商

对支持 UCP 扩展的 Shopify 商家：

```typescript
const ucp = await manager.ucpClientFor("allbirds.com");
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
const ctrl = await manager.converse("allbirds.com", "我想退货", (event) => {
  if (event.type === "message") console.log(event.message.content);
  if (event.type === "operation") {
    // 公司请求执行某个操作（如退款）
    // 自动映射到 consent card，等待用户确认
  }
});
```

Operation 会在 Policy Gate 上开一张确认卡（`irreversible` → L4，`personalData` → L3，其他 → L2）。**但确认的结果目前不会回传给公司**：见下面"还没做好的"。

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
- **Pairwise User ID**：每用户每公司一个 ID，跨公司不可关联

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

## 还没做好的（2026-11-16 审查）

这些是开启前要知道的，修好之前不建议在有真实账号的机器上打开：

- **请求不经过地址防护**：发现 `poppy.json`、对话、Browser Join、OAuth 各端点的请求用的是全局 `fetch`，不走 `web.ts` 的 `guardUrl`；`poppy.json` 里写的端点地址也不检查是否同源、是否公网。一个网站可以让主机去请求内网地址，并把返回内容带进模型上下文。
- **确认卡不回传**：`PoppyConverse` 开出的确认卡是单向的，没有代码调用 `respondToOperation`，确认了也不会告诉公司。
- **token 按 issuer 存**：一个站点在 `poppy.json` 里声称别家的 issuer，就能拿到别家的 token（目前没有发起登录的入口，所以还没有 token 可拿）。
- **明文 HTTP 也会带 header**；Session JWT 没有 `exp`。
- **SSE 解析**跨数据块的事件会丢；token 刷新有竞争，任何失败都会删掉 token。
- **Pairwise User ID** 存在内存里，所有人共用，重启就变。

