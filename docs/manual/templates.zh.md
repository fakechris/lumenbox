<!-- doc: templates.zh
     title: 模板
     family: manual
     status: current
     covers: template
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# 模板

本页讲怎样用保存好的 agent 新建一个 agent，或者把一个 agent 保存下来让别人也能新建。

## 这是什么

**模板**是保存下来的 agent：它的人设、skill、例行任务和约定，从不包括它的历史，也从不包括和它共事的人。套用一个模板，就会在 box 里新建一个 agent。模板架上有现成的模板；你也可以套用别人分享给你的模板。**小队**是目录里的一个条目，一次添加多个 agent，组成一个团队。

导入模板不等于得到一个能干活的 agent：新 agent 在第一轮安装它的配方，然后询问它还需要什么。请查看它的聊天里有没有一张“要让 … 开始”卡片，卡片会列出每个缺少的密钥或连接器。

## 怎么做

### 在 app 里

- **套用模板：** 点侧边栏底部的 *模板*。在 *套用到* 下选择 box，在 *现成 agent* 下找到一个模板（在 *筛选* 里输入可以缩小列表），然后点 *预览* 阅读它，或点 *套用* 新建 agent。
- **套用别人分享的模板：** 在同一个对话框里，点 *粘贴或链接…*，粘贴模板或它的链接。
- **添加小队：** 点 *Agent* 旁边的 `+`，选择一个 *从目录添加*。
- **分享一个 agent：** 打开这个 agent 的 配置，点 *让它起草模板*。agent 会在它的聊天里写草稿；草稿暂存好后，配置 里会显示它和下载链接。

### 在聊天里

聊天里没有模板命令。由模板新建的 agent 和其他 agent 一样在聊天里回答，前提是某个渠道指定了它，或者你用 `@name` 叫它。

### 在命令行里

这些命令与正在运行的 app 通信：

```
agentbox template import <file> [--name <name>]   # 用模板文件新建一个 agent
agentbox template share <agent>                   # 请这个 agent 为自己起草一个模板
agentbox template download <agent> [-o <file>]    # 保存最新暂存的模板
```

## 在哪里看结果

- 侧边栏：新 agent 出现在列表里，在你选的那个 box 下。
- 新 agent 的聊天：它的第一轮安装配方并提出问题。
- 配置 → *分享为模板*：最新暂存的模板和它的下载链接。

## 限制

- 模板不带历史，也不带人；新 agent 开始时只有模板里的内容。
- 需要连接器或密钥的模板会一直等着。东西就位后，工作会自己开始。
- 名字是模板自己的；如果那个 box 里已有同名 agent，会在名字后加一个数字。

## 接下来

- [Agent](agent.zh.md)：配置你新建的 agent。
- [Skill](skills.zh.md)：模板里的 skill 是什么。
- 参考页 [模板架](reference-templates.zh.md)：每个现成的模板、小队和连接器。
