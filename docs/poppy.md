# Poppy (Personal Agent Protocol) — agentbox 集成指南

## 什么是 Poppy

Poppy 是 Sierra AI 发布的开放协议 (Apache-2.0)，定义个人 agent 如何代表用户与公司交互。协议涵盖发现、身份、OAuth 登录、浏览器协同、agent 对话和电商 (UCP)。

截至 2026-11，16 家公司发布了 `poppy.json`（12 家 Shopify 商家 + Stacktree + Rocket + crosswalk + Clerk）。

## 快速开始

### 1. 启用

Poppy **默认开启**。设置 `AGENTBOX_POPPY=0` 可关闭。

启动后，agentbox 自动：
- 生成 ES256 密钥对（持久化到 `~/.agentbox/poppy-agent-key.json`）
- 在 `/poppy/agent.json` 和 `/poppy/jwks.json` 发布 agent 元数据
- 在每次 `WebFetch` 请求中自动发现 `poppy.json` 并注入 `Poppy-Session` header

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

Operation 自动映射到 Policy Gate 的 consent card：
- `irreversible` → L4（必须用户确认）
- `personalData` → L3（需用户知情）
- 其他 → L2（仅记录）

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
│  │  GET /poppy/callback     ← OAuth 回调               │   │
│  │  GET /poppy/status       ← 诊断                     │   │
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
| `AGENTBOX_POPPY` | `1`（启用） | 设为 `0` 关闭 |
| `AGENTBOX_PUBLIC_URL` | `https://localhost` | agent 的公网 HTTPS 地址（用于 OAuth callback 和 client metadata） |

## 诊断

- **GET /poppy/status** — 返回 JSON：ready、clientId、activeSessions、tokens、negativeCache
- **日志** — `[poppy]` 前缀输出到 stderr
- **agent 工具** — `PoppyStatus` 让 agent 自查

## 测试

```bash
node --experimental-transform-types --test src/host/poppy/*.test.ts src/host/poppy-fetch.test.ts src/host/poppy-browser.test.ts src/host/poppy-tools.test.ts
```
