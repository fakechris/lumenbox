<!-- doc: reference-tools.zh
     title: 参考：内置工具
     family: manual
     status: current
     covers: reference-tools
     updated: generated
     generated: true
-->
# 参考：内置工具

[English](reference-tools.md) · 中文。本页由 `scripts/docs-reference.mjs` 生成，来源：`buildTools()`（src/host/tools.ts）、src/host/side-effects.ts 里的层级、src/host/tool-roster.ts 里的名单和 src/host/catalog.ts 里的目录工具组。
本页与来源不一致时 `npm test` 会失败；改来源，然后运行 `node scripts/docs-reference.mjs --write`。

56 个工具：`buildTools` 在所有可选项都打开时给出的清单——一台 box、视觉、主机执行器、桌面、飞书文档阅读器、模板暂存、一个搜索 key，以及连接器 github、feishu、dingtalk。真实的一轮拿到的更少；**何时提供**一栏写每个工具需要什么。工具说明来自源代码，保持英文。

- **层级**——一次调用对外界做了什么（side-effects.ts）：`observe` 只看，`self` 留在 box 里或只涉及提出请求的人，`reach` 越出 box 行事，`credential` 触及权限。
- **询问**——闸门是否先问人，以及确认卡片上的说法。由主机写，从不由 agent 写。
- **名单**——`resident` 每一轮都带着；`deferred` 通过 `FindMcpTool` 找到、通过 `UseMcpTool` 调用。
- **工具组**——装上一个目录 agent 时，它在哪些目录工具组（desk、web、code、team）里得到这个工具。

| 工具 | 做什么 | 层级 | 询问 | 何时提供 | 名单 | 工具组 | 参数 |
|---|---|---|---|---|---|---|---|
| `AskSecret` | Ask the person for a credential — an API key, a token, a password — by name, without ever seeing it. | self | 否 | 需要一台 box；分支里没有 | deferred | desk, web, code, team | `id`, `description` |
| `AskUser` | Ask the person who gave you this work a question, when you genuinely cannot proceed without their answer — which of two things they meant, a value only they know, whether an assumption of yours is right. | self | 否 | 需要一台 box；分支里没有 | resident | desk, web, code, team | `question`, `options`, `recommended`, `default`, `expires_in_minutes` |
| `bash` | Run a shell command inside your box. | self | 否 | 需要一台 box | resident | desk, web, code, team | `command`, `why`, `desktop`, `cwd`, `timeout_ms`, `background`, `on_end`, `wake_when` |
| `browser_act` | Do one thing to the current page, and get back what it looks like afterwards. | self | 否 | 需要一台 box | resident | web | `action`, `why`, `ref`, `snapshot`, `find`, `expect`, `text`, `key`, `replace`, `commit`, `writePath` |
| `browser_fill_secret` | Type a vault secret into a field on the current page without ever seeing it. | credential | 是: “type a stored secret into a web page” | 需要一台 box | deferred | — | `ref`, `secret`, `snapshot` |
| `browser_open` | Open a URL in your box's browser and get the page back as an outline. | self | 否 | 需要一台 box | resident | web | `url`, `page` |
| `browser_pages` | Your tabs on this desktop, labelled p1, p2, …, with the one you are on marked. | observe | 否 | 需要一台 box | deferred | — | `action`, `page` |
| `browser_read` | Read the current page's prose, without the outline. | observe | 否 | 需要一台 box | resident | web | — |
| `browser_scroll` | Scroll the page and get the outline afterwards. | observe | 否 | 需要一台 box | deferred | web | `direction`, `amount` |
| `browser_snapshot` | Re-read the current page as an outline. | observe | 否 | 需要一台 box | resident | web | — |
| `browser_upload` | Attach a file from your box to a file input on the page, without touching the operating system's file chooser. | reach | 是: “upload a file from the box to a web page” | 需要一台 box | deferred | — | `ref`, `path` |
| `browser_verify_write` | After a commit step whose result you are not sure of, or before pressing one again: read the page (browser_snapshot) and record whether the step took effect — done, not_done or unknown. | observe | 否 | 需要一台 box | deferred | — | `mark`, `verdict`, `evidence` |
| `browser_wait_for` | Wait until the page says something, then get the outline. | observe | 否 | 需要一台 box | deferred | web | `for`, `value`, `seconds` |
| `Checkpoint` | Write down a result the moment you have it, so it survives if this turn stops before you reply — out of rounds, stopped by a person, a crash. | self | 否 | 总是 | resident | — | `name`, `value`, `partial` |
| `ClaimWork` | Take a piece of work so a teammate does not take the same one, or hand it back when you are done with it. | self | 否 | 总是；分支里没有 | deferred | desk, web, code, team | `work`, `release` |
| `computer` | Interact with the Linux desktop in your box: move and click the mouse, type, press keys, scroll, drag, and capture the screen. | self | 否 | 需要一台 box、视觉、桌面；分支里没有 | resident | — | `expect`, `actions` |
| `connector_request` | Call a connected service's API as the person who authorized it: github, feishu, dingtalk. | observe, or reach by call | 否; 按调用 是: “change something in the service as the person who connected it” | 需要任一连接器 | resident | — | `connector`, `method`, `path`, `body`, `headers` |
| `CorrectOrgKnowledge` | Correct an item of the organisation's knowledge, cited by its id (org:…). | self | 否 | 总是；分支里没有 | deferred | — | `action`, `id`, `reason`, `text`, `evidence` |
| `CreateAgent` | Create a new agent — a new teammate — with a name and a persona. | credential | 是: “create a new agent with its own tools” | 总是；分支里没有 | deferred | team | `from`, `name`, `description`, `title`, `tags` |
| `Delegate` | Hand a self-contained piece of work to a specialist engine installed in your box — deep work on a repository, where reading dozens of files and iterating against tests is the job itself. | self | 否 | 需要一台 box；分支里没有 | resident | code | `preset`, `prompt`, `cwd`, `tools`, `session`, `install`, `mode`, `session_id`, `steer`, `cancel`, `close` |
| `DeliverFile` | Mark a file in your box as what a task produced — its deliverable. | self | 否 | 总是；分支里没有 | resident | — | `path`, `note`, `task_id` |
| `DingTalkWrite` | Put work into DingTalk (钉钉) through the connected app. | self, or reach by call | 否; 按调用 是: “share a DingTalk document with other people” | 需要连接器 dingtalk | resident | — | `action`, `name`, `workspace_id`, `operator_union_id`, `summary`, `description`, `start`, `end`, `timezone`, `attendees` |
| `edit_file` | Change part of a file by replacing an exact piece of its text. | self | 否 | 需要一台 box | resident | desk, web, code, team | `path`, `old`, `new` |
| `FeishuWrite` | Put work into Feishu (飞书) through the connected app. | self, or reach by call | 否; 按调用 是: “share a Feishu document with other people” | 需要连接器 feishu | resident | — | `action`, `title`, `markdown`, `document_id`, `folder_token`, `share_with`, `app_token`, `table_id`, `record_id`, `fields`, `contains`, `summary`, `description`, `start`, `end`, `due`, `timezone`, `attendees`, `assignees`, `task_guid` |
| `Forget` | Forget something the person asked you to forget — everywhere it was kept, not just in memory. | self | 否 | 需要一台 box、视觉、桌面；分支里没有 | deferred | — | `action`, `about`, `plan` |
| `Fork` | Hand work to copies of yourself, each with its own fresh context, and get back what each one found. | self | 否 | 需要一台 box；分支里没有 | deferred | — | `briefs`, `background` |
| `Goal` | The goal the person set for this conversation with /goal (docs/74): an objective you keep working toward until a gate you do not own says it is met. | self | 否 | 总是；分支里没有 | resident | — | `action`, `decisions`, `unchecked`, `evidence`, `items` |
| `HandBack` | A person's message in your task's thread was handed to you to decide (it says so at the top). | self | 否 | 总是；分支里没有 | deferred | — | `task_id`, `reason` |
| `HandOverDesktop` | Hand your desktop to the person for something only they can do there — a login, a captcha, a payment — with one instruction they will read on the card. | self | 否 | 需要一台 box；分支里没有 | deferred | desk, web, code, team | `instruction`, `reason` |
| `Jobs` | The background commands you started with `bash` (background: true, or one that ran on past its window). | observe | 否 | 需要一台 box | deferred | desk, web, code, team | `action`, `job_id`, `until`, `timeout_ms` |
| `list_dir` | List a directory in your box, with entry types and sizes. | observe | 否 | 需要一台 box | resident | desk, web, code, team | `path` |
| `NoteSiteLearning` | Keep something you found out about a site, for whoever in this box opens it next — you or a teammate. | self | 否 | 需要一台 box | deferred | — | `url`, `text`, `worked` |
| `NothingToSay` | End this turn on purpose with nothing delivered: the message was not for you, the routine does not apply, the fork's result changes nothing you need to say. | observe | 否 | 总是；分支里没有 | resident | — | `reason` |
| `Orchestrate` | Run the same question over many items — one sub-agent per item, each with fresh context — and, if you give a `reduce` brief, one more that combines their answers. | self | 否 | 需要一台 box；分支里没有 | deferred | — | `brief`, `items`, `prompt`, `expect`, `reduce` |
| `OtherThreads` | List the other conversations in this same chat, and read one. | observe | 否 | 总是；分支里没有 | deferred | desk, web, code, team | `read`, `search` |
| `PackTemplate` | Stage a shareable template of yourself from what you selected, after following the export-template skill. | self | 否 | 需要模板暂存；分支里没有 | deferred | — | `description`, `name`, `title`, `memory`, `skills`, `routines`, `connectors`, `getting_started` |
| `Promote` | Propose that something you already have become part of the organisation's knowledge — what every member's agents (scope 'org') or this box's (scope 'box') may rely on. | self | 否 | 总是；分支里没有 | deferred | — | `memory`, `task_id`, `statement`, `scope`, `evidence` |
| `read_file` | Read a file from your box. | observe | 否 | 需要一台 box | resident | desk, web, code, team | `path`, `start_line`, `end_line`, `values` |
| `ReadFeishuDoc` | Read a Feishu/Lark document (feishu.cn/docx/… or /wiki/… link) as text, using the bot's own workspace identity. | observe | 否 | 需要飞书文档阅读器 | deferred | web | `url` |
| `ReadHistory` | Search or read the recorded history of a conversation — what was actually said, what was called, and what came back. | observe | 否 | 总是 | resident | desk, web, code, team | `search`, `from`, `to`, `epoch`, `around`, `agent` |
| `ReadKept` | Read back the whole of something you already read, when the copy in this conversation was cut. | observe | 否 | 总是 | deferred | — | `call`, `from`, `to` |
| `Recall` | Search everything you have kept, including what the memory section did not show you. | observe | 否 | 总是 | deferred | desk, web, code, team | `search`, `shared` |
| `RememberFact` | Keep something across conversations. | self | 否 | 总是；分支里没有 | resident | desk, web, code, team | `fact`, `scope`, `replaces` |
| `RunOnHost` | Run a command on the person's own computer — the machine LumenBox runs on, outside your box. | credential | 是: “run a command on the person's own machine” | 需要主机执行器；分支里没有 | resident | — | `command`, `why`, `secrets` |
| `RunOperation` | Run a taught operation: a skill whose folder holds operation.json replays its browser (and desktop) steps with no model, and returns its output as JSON. | reach | 是: “replay a taught browser operation” | 需要一台 box | deferred | — | `skill`, `input` |
| `SendToAgent` | Send a message to another of your user's agents. | self | 否 | 总是；分支里没有 | resident | desk, web, code, team | `target_id`, `message`, `priority` |
| `SetPlan` | Write or replace your plan for the work you are doing. | self | 否 | 总是 | deferred | desk, web, code, team | `plan` |
| `SetTodos` | Set out the steps you are about to take, and keep them current as you take them. | self | 否 | 总是 | resident | desk, web, code, team | `todos` |
| `ShowUI` | Show the person a card you compose — a comparison table, a few options with a line of explanation each, a short form, a progress list — when prose would make them squint. | self | 否 | 需要一台 box；分支里没有 | resident | desk, web, code, team | `surface`, `components`, `data`, `patch`, `title`, `close` |
| `Tasks` | The team's task board — work as an object everyone can see, not a message that scrolls away. | self | 否 | 总是；分支里没有 | resident | desk, web, code, team | `action`, `id`, `due`, `goal_area`, `commitment`, `waiting_on`, `blocked_by`, `parent`, `snooze_until`, `reason`, `title`, `description`, `status`, `note`, `level`, `discovery_kind`, `source`, `evidence`, `why_now`, `propose`, `outcome`, `scope`, `constraints`, `acceptance`, `verification`, `options`, `assignee`, `reviewer`, `list_status` |
| `Teammates` | Who you can message: your teammates in this box, by name, from the host's own roster. | observe | 否 | 总是 | deferred | desk, web, code, team | — |
| `UpdateAgent` | Edit another agent's name, description, role label, or teams. | credential | 是: “change an agent's tools or instructions” | 总是；分支里没有 | deferred | team | `agent_id`, `name`, `description`, `title`, `tags` |
| `WaitForControl` | Wait until a person who took over your desktop hands it back. | observe | 否 | 需要一台 box、桌面 | deferred | — | `seconds` |
| `WebFetch` | Read a web page as text. | observe | 否 | 总是 | resident | web | `url` |
| `WebSearch` | Search the web and get back titles, URLs and short descriptions. | observe | 否 | 需要搜索 key | resident | web | `query`, `count` |
| `write_file` | Write a text file in your box, creating parent directories as needed and overwriting any existing file at that path. | self | 否 | 需要一台 box | resident | desk, web, code, team | `path`, `overwrite`, `content` |
