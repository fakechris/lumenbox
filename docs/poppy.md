<!-- doc: poppy
     title: Poppy (Personal Agent Protocol) — agentbox 集成指南
     family: guide
     status: current
     updated: 2026-11-16
-->
# Poppy (Personal Agent Protocol) — agentbox 集成指南

## 什么是 Poppy

Poppy 是一个开放协议，规范在 personalagentprotocol.org，我们实现的是 0.4 版。它规定个人 agent 怎样代表用户和公司打交道：

- 公司在 `https://<domain>/.well-known/poppy.json` 里写明它向 agent 开放什么：对话、API、UCP 电商、Browser Join、登录。
- agent 的请求带上签名的 `Poppy-Session`，公司就知道这是一个替用户办事的个人 agent，而不是匿名爬虫。

## 怎么开

**默认关闭**。要两个条件同时满足才开：

- `AGENTBOX_POPPY=1`；
- `AGENTBOX_PUBLIC_URL` 是一个 `https://` 地址。公司要从这个地址取 agent 的公钥和 UCP 平台 profile，没有公网地址就验证不了。只在 `--public-url` 里写不算，要设环境变量。

关着时什么都不发生：不生成密钥，不给 agent 任何 Poppy 工具。

开着也不会改变普通上网：`WebFetch` 和浏览器既不带 Poppy header，也不会去问网站有没有 `poppy.json`。只有 agent 主动用 Poppy 工具时才会碰到 Poppy。

开着时，主机会：

- 在第一次用到时生成 ES256 密钥，存在 `~/.agentbox/poppy-agent-key.json`（0600）。
- 公开四个不需要登录的地址：
  - `/poppy/agent.json`（client metadata）
  - `/poppy/jwks.json`
  - `/poppy/ucp/2026-08-25.json`（UCP 平台 profile，描述 agent 本身，不涉及任何用户）
  - `/poppy/callback`

## Agent 的四个工具

| 工具 | 用途 |
|------|------|
| `PoppyDiscover` | 按需发现一家公司：它的目的地（对话、API、UCP 服务、页面）、Browser Join、登录 |
| `PoppyRequest` | 向公司的**目的地**发一个带签名的 HTTPS 请求；UCP 服务也用它（MCP 的 JSON-RPC 请求体） |
| `PoppyConverse` | 和公司自己的 agent 对话（规范第 8 节） |
| `PoppyStatus` | 这个 agent 在这里的 Session 和登录情况 |

### 目的地

`PoppyRequest` 只发给下面这些地址，其他一律拒绝。拒绝时 agent 改用普通 web 工具，不带签名：

- 恰好在该域名上的页面（`www.` 不算同一个域名）；
- `poppy.json` 列出的端点：对话协议、Browser Join、tasks、扩展端点，以及它们下面的路径；
- `apis` 描述所在的那台主机；
- 公司 UCP profile 列出的服务端点，可以在另一台主机上，比如 allbirds.com 的 UCP 在 myshopify.com 上。

agent 不能自己设 `Authorization`、`Cookie`、`Poppy-*`、`UCP-Agent` 这几个 header。

### 对话（规范 8.2–8.7）

1. 第一条消息 `POST {endpoint}` 开始对话，后续消息发到 `{endpoint}/{id}/messages`。
2. 每个 POST 都带 agent 生成的请求 `id`（重试是安全的），并带 `?wait=`，让回复在同一个响应里回来。
3. `working` 为 true 时，继续读 `{endpoint}/{id}/events?cursor=…&wait=…`，直到它变成 false。
4. cursor 和已经处理过的事件都会记住，继续对话时不会把旧回复再显示一遍。

### Operations（扩展 v3）：需要人批准的操作

公司在执行有业务后果的动作（换货、下单、销户）之前，会先返回一个 operation。三种接口返回的形式不同：

- API：403 `approval_required`；
- MCP 工具：`isError`，operation 在 `structuredContent` 里；
- 对话：消息的 `extensions.operations.operation`。

主机收到后开一张确认卡，卡上写明公司名、operation 和 revision、summary，**以及 terms 本身**（summary 是公司写的，可能和 terms 说的不一样），还有截止时间。agent 不能自己批准。

人在卡上的选择：

- **批准**：主机通过原接口把同一个请求再发一次，带上批准。
  - API：原样重发，加 `Poppy-Approval` header。
  - MCP：同一个工具、同样的参数，批准放在 `_meta["personalagentprotocol.org/approval"]`。
  - 对话：发一条带 `extensions.operations.approval` 的消息。

  之后把公司的回应告诉 agent。
- **拒绝**：什么都不发给公司。扩展里没有"拒绝"这种消息，动作就是不执行。agent 会被告知。

下面几种情况不会发送批准：

- 截止时间已过；
- 问的时候和答的时候不是同一次登录；
- 公司已经 `approval_declined` 过的批准，不会再发。

### UCP 电商

1. 公司在 `poppy.json` 里列出 `ucp` 扩展时，主机读取 `https://{domain}/.well-known/ucp`，不跟随重定向。别的主机上的 profile 不代表这家公司。
2. 每个 UCP 请求都带 `UCP-Agent: profile="…"`。MCP 的 `tools/call` 还会在 `arguments.meta["ucp-agent"]` 里带同一个 URL。这两处都由主机自动加。
3. **没有支付**：结账时把结账的 `continue_url` 交给人，由人自己完成付款。

### Browser Join

只对**已经发现过**的公司进行：用 `browser_open` 打开它的 https 页面时，先打开一次性的 join URL。这个 URL 必须在该公司自己的站点上，并且要再过一遍地址检查。

打开一个从没发现过的网站，不会去问它任何东西。

## 每个 agent 是一个独立的 Poppy User

User ID、Session、委派密钥、登录和 token 都按 agent 分开，并且按公司域名区分，不按 `poppy.json` 自称的 issuer 区分。

User ID 存在 `~/.agentbox/poppy-user-ids.json`（0600），重启后不变。

## 安全

- **同一扇门**：所有 Poppy 请求都走 `src/host/poppy/http.ts`。
  - 只用 https；URL 里不能带账号密码。
  - 域名解析和 WebFetch 用同一个受防护的 lookup：内网和本机地址在连接时就被拒绝，字面 IP 在连接前被拒绝。
  - 不跟随重定向（发现 `poppy.json` 时例外，而且只在请求的那个域名内跟随）。
  - 响应体最多 4 MB，整个请求有截止时间。
- **密钥不进模型**：token、私钥、Session JWT、User ID 都留在 PoppyManager 里，模型上下文里永远看不到。
- **公司说的话是内容，不是指令**：公司返回的一切都按外部内容处理，不会写进 agent 的记忆。
- **只看自己的**：`PoppyStatus` 只显示调用它的 agent 自己的 Session 和登录。

## 还没有的

- **身份托管**：现在要求这台主机有 https 公网地址，普通桌面装不了。如果要让桌面用户也能用，需要一个由我们运营的签名服务，由它持有 client_id 和 jwks，并给每个安装签发 delegation。这件事暂不做。
- **登录**：`startSignIn` / `startDeviceSignIn` 在代码里，但没有工具调用它们，所以现在都是未登录的 Session。另外两处要先改：
  - issuer 还没有按 RFC 9728 从域名的 protected resource 去确认；
  - client assertion 的 `aud` 还是 token endpoint，不是规范要求的 issuer。
- **等待中的 operation 和对话的 cursor 只在内存里**：主机重启后，之前那张卡的批准不会再发出去。
- **Browser Join 的请求格式还没有对照规范第 6 节核对过。**

## 测试

`src/host/poppy/protocol.test.ts` 在脚本化的网络上跑真实的 PoppyManager，不联网。覆盖：

- 目的地；
- 对话；
- 三种接口上的 Operations；
- UCP；
- token；
- Session。
