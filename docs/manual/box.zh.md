<!-- doc: box.zh
     title: Box
     family: manual
     status: current
     covers: box
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# Box

你的 agent 工作用的电脑：怎样得到一台、看着它，以及接管它。

## 这是什么

**box** 是一台 Linux 电脑，每个 agent 有一个桌面，还有浏览器、文件管理器和 shell。默认的 box 在你自己机器上的
Docker 里运行；你也可以接入一台在别处运行的 box。一个 agent 住在一个 box 里，它的记忆、文件和登录状态都留在那里。

box 在运行不等于 agent 在工作：box 开着的时候，所有 agent 都可能空闲。到侧边栏查看：底部显示 box 的状态，每个
agent 的那一行显示它正在做什么。

## 怎么做

### 在 app 里

- **启动 box：** 设置 → Box → *启动 box*。第一次启动要拉取镜像，有几百 MB。
- **添加 box：** 按顶部 box 栏里的 `+ box`，或者用设置 → Box → *接入*来驱动另一台机器上的 box。
- **看着一个 agent：** 选中这个 agent，然后打开右侧的*桌面*标签页。
- **接管：** 在*桌面*标签页上按*接管*，自己使用鼠标和键盘。用完后按*交还*。

### 在聊天里

- `桌面`（或 `desktop`）：agent 回复一个链接，指向它的实时桌面，可以观看或接管。
- `屏幕`（或 `screen`）：桌面此刻的一张截图。不会运行任何一轮。

### 在命令行里

```
agentbox box up            # 启动 box，并等它的桌面就绪
agentbox box status        # 容器状态、端口和健康情况
agentbox box list          # 每个 box，以及哪些 agent 住在里面
agentbox box attach <name> <url> --token-file <file>
agentbox box down          # 停止它；在你重新启动前它一直保持停止
agentbox box shot out.webp # 保存一张桌面截图
```

## 在哪里看结果

- 侧边栏底部：*box 在线*或 *box 不可用*，以及有几个 box 开着。
- box 栏：每个 box 一个标签，已连接时带一个绿点。
- 设置 → Box：每台机器，以及接入的 box 最近一次的错误。

## 限制

- agent 的 box 只选一次。要在另一个 box 上工作，就在那里新建一个 agent。
- 本地 box 需要 Docker Desktop 或 OrbStack。第一次启动可能要 10 到 40 分钟。
- 共享的 box 就是共享的：每个能打开它的人都能看到它的屏幕、读到它的文件。不要在上面登录你自己的账号。
- 如果 LumenBox 之外的东西停掉了本地 box，LumenBox 会重新启动它。你用 `agentbox box down` 停掉的 box 会一直保持停止。

## 接下来

- [Agent](agent.zh.md)：谁在 box 里工作。
- [渠道](channels.zh.md)：人们怎样找到 agent。
- [docs/37](../37-onboarding.md) §3：得到 box 的三种方式。
