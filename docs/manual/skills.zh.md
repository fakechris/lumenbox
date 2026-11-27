<!-- doc: skills.zh
     title: Skill
     family: manual
     status: current
     covers: skill
     audience: user
     source-updated: 2026-11-28
     updated: 2026-11-28
-->
# Skill

本页讲 agent 会做的事怎样写下来，好让它下次用同样的方法做。

## 这是什么

**skill** 是 box 里 `/home/box/work/skills/<name>/` 下的一个 `SKILL.md` 文件：写明什么时候适用，以及具体步骤。请求与某个 skill 的描述相符时，agent 就会读这个 skill。agent 摸索出做法后会自己写 skill；每个 box 一开始也带有一组入门 skill。带有 `schedule:` 或 `trigger:` 的 skill 是例行任务（见 [自动化](automations.zh.md)）。

在组织里，管理员可以把一个 skill 发布给所有人：**组织 skill** 在每个 box 里都能用，各处相同，在 box 里只读。

导入的 skill 不等于已安装的 skill：`agentbox skills import` 把每个 skill 变成一份教学草稿，由人来发布。请到 app 顶部的 *教学草稿* 查看。

LumenBox 还为*其他*编程 agent 提供一个 skill：`agentbox skill install` 给 Claude Code 或 Codex 装上一个 skill，让它通过 MCP 入口操作 LumenBox。

## 怎么做

### 在 app 里

- **查看 skill：** 在聊天框开头输入 `/`。菜单会列出这个 agent 所在 box 里的 skill；选中一个，聊天框里就会写好 "Use the … skill."，由你发送。
- **审阅导入的 skill：** 点 app 顶部的 *教学草稿*。
- **把一个 skill 发布给整个组织**（管理员）：设置 → 团队 → *组织 skill* → *发布或更新一个 skill*。选择这台电脑上的 skill 文件夹、模板文件里的 skill，或你能进入的某个 box 里的 skill，然后点 *发布*。发布一个已有的名字就是一个新版本。*撤下* 会把它从所有 box 移除。勾选 *必需*，则 box 里有同名 skill 时也用组织的这一个。

### 在聊天里

聊天里没有 skill 命令。直接提出要做的事；agent 会用描述相符的那个 skill。要新建 skill，等 agent 做完这件事后，请它把做法写下来。

### 在命令行里

```
agentbox skills import <dir> [--agent <name>]           # 每个 skill 变成一份教学草稿
agentbox skills improve <skill-dir> --material <dir>    # 根据示例提出改进版本
agentbox skill install [--claude] [--codex]             # 给 Claude Code / Codex 用的 LumenBox skill
```

`skill install` 把 skill 复制到 `~/.claude/skills/lumenbox/`（Claude Code，默认）或 `~/.codex/skills/lumenbox/`（Codex），并打印需要添加的 MCP 配置行。它从不修改那个客户端的配置。这一行需要一个 token：设置 → 我的 → *你的 MCP token* → *签发*。app 必须正在运行。

## 在哪里看结果

- 聊天框里的 `/` 菜单。
- agent 的 *文件* 标签页，`skills/` 下面。
- 设置 → 团队 → *组织 skill*：每个 skill 的版本、谁在什么时候发布、多少个 box 已是最新，并按名字列出落后、未连接或在 box 里被改动过的 box（改动会被覆盖）。
- 参考页 [自带的 skill](reference-skills.zh.md)：列出每个入门 skill，由代码生成。

## 限制

- 一个 skill 只在一个 box 里。其他 box 的 agent 看不到它，除非管理员把它发布为组织 skill。
- 组织 skill 不能带密码或 key，也不能带定时或触发；这样的发布会被拒绝并说明原因。没连接的 box 在重新连上时拿到它。
- 成员还不能自己把 skill 提交给组织；由管理员从他们的 box 里发布。
- 只有没人改过的入门 skill 才会随新版本更新。
- MCP token 只显示一次。签发时就复制下来；撤销后立即失效。

## 接下来

- [自动化](automations.zh.md)：会自己运行的 skill。
- [模板](templates.zh.md)：skill 随保存的 agent 一起带走。
- [记忆](memory.zh.md)：事实，与做事方法不同。
