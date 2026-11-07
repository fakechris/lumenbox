<!-- doc: reference-rules.zh
     title: 参考：规则文件语法
     family: manual
     status: current
     covers: reference-rules
     updated: generated
     generated: true
-->
# 参考：规则文件语法

[English](reference-rules.md) · 中文。本页由 `scripts/docs-reference.mjs` 生成，来源：`describeGrammar()`（src/host/rules-grammar.ts），src/host/rules.ts 按这份语法解析；语法说明保持英文。
本页与来源不一致时 `npm test` 会失败；改来源，然后运行 `node scripts/docs-reference.mjs --write`。

One Markdown file per rule under ~/.agentbox/rules (AGENTBOX_RULES overrides the directory): `<id>.md`, the file name is the rule's id. Frontmatter between `---` lines, one `key: value` per line, `# comment` allowed after a value; unknown keys are ignored.

## 键

| key | also | value | required | matcher | means |
|---|---|---|---|---|---|
| `name` | — | one value | no | no | What the rule is called on a consent card and in the audit; the file name when absent. |
| `effect` | — | one value | yes | no | One of allow, ask, deny. |
| `tool` | `tools` | comma-separated list | no | yes | Tool names, or * for any tool. |
| `command` | `commands` | comma-separated list | no | yes | For bash / RunOnHost: the command must start with one of these prefixes. |
| `host` | `hosts` | comma-separated list, case-insensitive | no | yes | For a tool whose input carries a URL (browser_open, WebFetch): the URL's host, exact or *.example.com. |
| `path` | `paths` | comma-separated list | no | yes | For a tool whose input carries a path (write_file, edit_file): the path is this directory or under it; `~` is the home directory (INV-1700). |
| `principal` | `principals` | comma-separated list | no | yes | Only while the turn runs for one of these people, by principal id or name (INV-156). A turn nobody is attributed to — a schedule, a webhook, a restart — never matches. |
| `agent` | `agents` | comma-separated list | no | yes | Only for these agents' own calls, by id or name (INV-1664). A call by any other agent, or by nobody in particular, never matches. |
| body | — | text after the frontmatter | yes | no | The standing instruction, in words a person and the reviewer can read. Required. |

## 效果

| effect | what it does |
|---|---|
| `allow` | lifts the operator's own approval lists for the call and tells the reviewer it is standing intent; never lifts a host command, the box's irreversible-action finding or the tier gate |
| `ask` | forces a person's approval, and names the rule on the consent card |
| `deny` | refuses before anyone is asked |

## 一次调用怎么判定

1. A rule with no matcher covers no call; its body still reaches the reviewer.
2. A rule covers a call only when every matcher it states holds.
3. Of the rules that cover a call, the strictest decides: deny over ask over allow.
4. An agent's own setting from its Configure dialog ("ask me" for a tool or a group) is decided on the same path as a rule scoped to that agent; an "allow" there makes no rule, so it never lifts an operator's ask or deny.

## 示例

```markdown
---
name: jira-comments
effect: allow
tool: bash, RunOnHost
command: jira comment
host: *.atlassian.net
path: ~/proj
principal: Chris
agent: Nova
---
Commenting on a Jira issue is routine work here. Creating or transitioning one is not.
```
