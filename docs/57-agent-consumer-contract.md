<!-- doc: 57-agent-consumer-contract
     title: Agent 消费者合同：谁去拉，谁保证，不同架构怎么统一
     family: spec
     status: current
     domain: agent-consumer
     updated: 2026-09-15
-->
# 57 · Agent 消费者合同：谁去拉，谁保证，不同架构怎么统一

*2026-09-15。Chris 的问题：「agent 是主动去拉消息吗？这是一个规范吗？怎么保证 agent 执行？
agent 怎么知道这个规范？claude code / codex / lumenbox 架构都不一样，怎么统一行为？」
这四问是一件事，答案分三层。*

## 0. 一句话

**agent 不去拉消息；跑这个 agent 的 runtime 去拉。** 模型只被递过来一个已经成形的问题，
回答它就行——它不需要知道 Involute 存在。所以"怎么保证 agent 执行"的答案**不在模型那一侧，
在账本那一侧**。

## 1. 模型不需要知道这个协议

lumenbox 的实际路径（`src/host/involute-inbox.ts`）：

```
宿主进程每 30s → agent_inbox（用这个 agent 自己的凭证）
              → agent_request_claim（拿到才动手）
              → 读工作项 + 本机 receipts → 起一个回合，把问题当 prompt
              → agent_request_answer（以这个 agent 的身份写回线程）
```

整条链路里，**模型看到的只有一段自然语言的问题**和它一贯的工具。它不知道有账本、有 claim、
有 deadline，因此也**无法忘记**这些规矩——不是靠它自觉，是它压根不参与。

Linear 是同一个形状：webhook 打到你的服务，你怎么跑模型它不管。**协议是"系统 ↔ runtime"的，
不是"系统 ↔ 模型"的。**

## 2. 保证从哪来：门，不是约定

服务端已经把关键规则做成了**拒绝**，不是文档里的建议（Involute `agent-request-service.ts`）：

| 规则 | 不遵守会怎样 |
|---|---|
| 认领是单语句 CAS + 60s 租约 | 第二个消费者拿不到，**不会出现两份回答** |
| 答复必须持有 claim | 没认领就答 → 被拒 |
| `completed` 必须先有 `answeredCommentId` | 评论写失败 → 状态不会显示成已答 |
| 终态不可离开 | 迟到的答复不会变成第二个答案 |
| deadline + 服务端定时清扫 | 没人接 → 过期，并且只说"期限内没有答复"，不推断原因 |
| 只有 HUMAN 的 mention 开请求 | agent 之间互相 @ 不会引发连锁 |

所以一个行为不对的 runtime 得到的是**错误**，不是"风格不同"。**一致性由服务端的状态机保证，
不由各家 runtime 的自律保证。**

## 3. 三种 runtime 形状，同一份合同

| 形状 | 谁在轮询/接收 | 模型知不知道协议 | 例子 |
|---|---|---|---|
| **常驻宿主** | 宿主进程（或 webhook 接收端） | **不知道，也不需要** | lumenbox；任何有守护进程的服务 |
| **会话型 CLI** | 人启动的那个会话（一个 skill / 一条命令） | **知道**——靠工具描述与 skill 文件 | Claude Code、Codex |
| **服务型** | 没人 | — | CI、脚本：它的请求会过期，由 successor 接手（INV-556） |

**同一份合同 = 四个调用**（`agent_inbox` / `agent_request_claim` / `agent_request_answer`，
外加读上下文的 `work_get_context`）。除此之外三种形状没有任何需要对齐的东西——
不需要统一框架、不需要统一模型、不需要统一提示词。

## 4. 规范怎么到达一个从没读过我们文档的模型

三层，可靠性递减，**都在用**：

1. **服务端语义（强制）**。上面那张表。读不等于占位、没认领不能答——这些是代码里的分支。
2. **工具描述（进上下文）**。MCP `tools/list` 的描述会被任何 runtime 注入进模型上下文。
   Involute 的 `agent_inbox` 描述原文就写着：*"Reading does not reserve anything — call
   agent_request_claim before you start work."* 这是规范到达模型的**主要**途径。
3. **skill 文件（长版本）**。给会加载 skill 的 runtime：我们的 `involute-inbox` skill
   （`catalog-data/skills/involute-inbox/SKILL.md`）把整套流程写成一页，Claude Code / Codex /
   我们的 box agent 都能直接跑。

**一个 runtime 要接进来，需要做的全部事情**是：拿一把属于自己的 `inv_agent_*` 凭证，
把 Involute 的 MCP 挂上，然后要么写十几行轮询（常驻），要么装那个 skill（会话型）。

## 5. 因此"统一行为"不需要统一架构

要统一的只有三件事，而且都在服务端：**身份**（一个 actor 一把凭证）、**状态机**（A2A 的六态）、
**认领**（谁在做这件事）。runtime 内部怎么跑模型、有没有守护进程、是不是同一个厂商，
都不影响结果的正确性——最坏的情况是"没人接"，而那是一个**可见的状态**，不是一次静默失败。

## 6. 还缺的三块（都已立项）

- **一致性自检**：任何 runtime 都能跑的 conformance 脚本（认领前不答、不重复答、尊重 deadline、
  拿不出依据就说拿不出）。目前只有我们自己的 hermetic 测试。
- **successor 接手**（INV-556，2026-09-16 交付）：每个 agent 可以在 `config.involute.agents[].successor`
  里声明接手人——`@handle` 是本安装的另一个 agent，其他文本是一个去问的人。被问的 agent **跑不了**
  （记录不在了、box 不应答）时，请求**不会以它的名义认领**——认领等于说"这件事我在做"，替一个做不了
  的 agent 说这句话，等于把问题从能答的人手里拿走了。接手人用**自己的凭证**认领并署自己的名回答，
  开口先说"我不是 X"，只答记录里有的，推断要标成推断。
  **绝不通过原 agent 的凭证代发**：账本里一条答复的作者就是人们信任的东西，署了缺席者的名比没有答复更糟。
  没有接手人时说的是"期限内没有答复 + 该找谁"，而不是"它没在运行"——后者是对别人机器的猜测。
  **还缺一块在服务端**：当前协议里，一条 request 是发给某个 actor 的，接手人的 claim 会被拒绝。
  我们的实现照样去 claim，被拒绝就**如实报告**（日志写明"账本不允许 iris 替 ada 回答"）并退回
  "没人答 + 该找谁"。要让接手真正生效，Involute 需要一个原语：**被声明的 successor 可以认领/答复
  发给另一个 actor 的 request**（已作为候选提报）。
- **付款方与硬预算**（INV-580）：队列已经在执行前问"这一轮谁付、付得起吗"（`mayAfford`），
  但那个上限住在 relay 里，还没有人设它。先留接缝而不先接一个没人设的数字：一个连着空值的
  闸门，什么都拦不住，看上去却像拦住了。
- **谁能问**（INV-575）：把提问者解析成本安装的 Principal，用 role 与 box 成员回答，
  而不是 `config.involute.askers` 里那串 UUID。

引用：docs/54（设计与红队）、docs/38（运维视角的全流程）、Involute `agent-request-service.ts`、
Linear 开发者文档、A2A Protocol。
