<!-- doc: skills.zh
     title: Skill
     family: manual
     status: current
     covers: skill
     audience: user
     source-updated: 2026-11-06
     updated: 2026-11-06
-->
# Skill

本页讲 agent 会做的事怎样写下来，好让它下次用同样的方法做。

## 这是什么

**skill** 是 box 里 `/home/box/work/skills/<name>/` 下的一个 `SKILL.md` 文件：写明什么时候适用，以及具体步骤。请求与某个 skill 的描述相符时，agent 就会读这个 skill。agent 摸索出做法后会自己写 skill；每个 box 一开始也带有一组入门 skill。带有 `schedule:` 或 `trigger:` 的 skill 是例行任务（见 [自动化](automations.zh.md)）。

导入的 skill 不等于已安装的 skill：`agentbox skills import` 把每个 skill 变成一份教学草稿，由人来发布。请到 app 顶部的 *教学草稿* 查看。

LumenBox 还为*其他*编程 agent 提供一个 skill：`agentbox skill install` 给 Claude Code 或 Codex 装上一个 skill，让它通过 MCP 入口操作 LumenBox。

## 怎么做

### 在 app 里

- **查看 skill：** 在聊天框开头输入 `/`。菜单会列出这个 agent 所在 box 里的 skill；选中一个，聊天框里就会写好 "Use the … skill."，由你发送。
- **审阅导入的 skill：** 点 app 顶部的 *教学草稿*。

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
- 参考页 [自带的 skill](reference-skills.zh.md)：列出每个入门 skill，由代码生成。

## 限制

- 一个 skill 只在一个 box 里。其他 box 的 agent 看不到它。
- 只有没人改过的入门 skill 才会随新版本更新。
- MCP token 只显示一次。签发时就复制下来；撤销后立即失效。

## 接下来

- [自动化](automations.zh.md)：会自己运行的 skill。
- [模板](templates.zh.md)：skill 随保存的 agent 一起带走。
- [记忆](memory.zh.md)：事实，与做事方法不同。
