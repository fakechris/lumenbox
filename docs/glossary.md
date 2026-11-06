<!-- doc: glossary
     title: Glossary and controlled vocabulary
     family: spec
     status: current
     domain: vocabulary
     updated: 2026-11-06
-->
# Glossary and controlled vocabulary

One concept, one word. This page names every first-class concept a person meets in
LumenBox: the word a person reads (English and Chinese), the word the code and the specs use,
how one is identified, the words for its states, and where a person reaches it. A spec may
use the internal word; a page written for a person (README, docs/37, docs/38, and every
`audience: user` page) uses the user-facing word, and `npm test` refuses the deprecated
synonyms listed below (`scripts/docs-lint.mjs`, `lintVocabulary`). Code identifiers are not
renamed: `door`, `worker`, `expert`, `front` stay in the code and the specs.

## Three decisions

1. **Channel, not door.** A person reads *channel* (渠道): Settings → Channels, "Add channel".
   The specs and the code keep *door* (docs/22 §1 already writes "Channel (door)"), because
   "a door grants nothing" is how the authority model is argued. Why channel: it is the word
   the API (`/api/channels`), the source tree (`src/channels/`) and the user guides already
   used, and it is the word other agent products use for an IM connection. A conversation in
   an IM app is a **group chat** (群), never a channel and never a room.
2. **Agent is the only word for an agent.** Not bot, buddy, worker, expert or specialist, and
   in Chinese not 机器人 or 智能体; Chinese copy keeps the English word *agent*, as it keeps
   *box* and *skill*. *Bot* survives only inside a product name (Grok Bot) and as the IM
   platform's own object in a sentence about that platform's console.
3. **Team, crew and front are three different things.**
   - A **team** is a label a person or an agent puts on agents in one box, so they are listed
     together; an agent may be on up to five teams (docs/45).
   - A **crew** is a catalog entry that adds several agents in one step; once added, they are
     an ordinary team named after the crew (docs/94).
   - **Front** and **workers** are internal roles (docs/42): the agent a person talks to keeps
     its turns short and hands heavy work to background runs. A person sees *the default
     agent* (who answers a message that names nobody) and *background runs*; the words
     front agent and worker are not user-facing.

## Concepts

| User-facing name (en / zh) | Internal name (code, specs) | Identifier | State words | Entry points (app · IM · CLI) |
|---|---|---|---|---|
| **box** / box | Box; "room" in docs/22 §1 | box name, e.g. `default`; Docker container `agentbox-box` | running · stopped · unavailable | Settings → Boxes, `+ box` · — · `agentbox box up/attach/list/down/doctor` |
| **agent** / agent | Agent, AgentProfile; "worker" in docs/22 | agent id (lowercase name), e.g. `ada` | idle · working · paused | sidebar `+`, Configure, Settings → Team · `@name` · `agentbox agent new` |
| **team** / 团队 | agent `tags` | lowercase name with hyphens, at most 24 characters | — (a label: on or off an agent) | Configure → Teams field · — · `CreateAgent`/`UpdateAgent` `tags` |
| **crew** / 小队 | `CATALOG_CREWS` (catalog.ts) | crew slug, e.g. `media-desk` | in the catalog · added | New agent → catalog chips · — · `GET /api/catalog` |
| **catalog** / 目录 | catalog.ts: experts, crews, connectors | entry slug | in the catalog · added | New agent → catalog chips · — · `GET /api/catalog` |
| **template** / 模板 | AgentTemplate, `.lumenbox-template.json` | template slug | staged · imported · stamped | sidebar Templates shelf · — · `agentbox template import/share/download` |
| **channel** / 渠道 | door, Channel record (docs/22, docs/53) | channel id, the prefix of every identity it mints, e.g. `feishu-work:ou_…` | connected · not connected · needs a restart | Settings → Channels · the chat itself · — |
| **group chat** / 群 | chat, "room" in channel code | platform chat id, e.g. `oc_…` | group rule `addressed` · `all` | Settings → Channels group rule · the group · — |
| **person** / 人 | Principal, Identity | principal id; identity `<channel id>:<subject>` | viewer · driver · admin | Settings → Team → People · `bind CODE` · — |
| **task** / 任务 | Task, the board | `tN`, e.g. `t12` | open · doing · blocked · review · done · dropped | Tasks tab · `/continue tN`, `/recover tN`, 停, 可以 · MCP `task_status` |
| **goal** / 目标 | pursuit (goal-mode.ts); not `Task.goal`, which is a reminder of a person's aim (docs/74) | the task it lives on, `tN` | active · verifying · paused · complete · cleared | Settings → Supervision · `/goal <text>` · MCP `goal_start` |
| **routine** / 例行任务 | routine: a skill with `schedule:` or `trigger:` (docs/44) | skill slug | off · observe · auto | Automations tab · reports to a group chat · `agentbox routines` |
| **skill** / skill | Skill, `SKILL.md` | folder slug under `/home/box/work/skills/` | — (present or absent in a box) | `/` in the chat box lists them · — · `agentbox skills import/improve` |
| **engine** / 引擎 | preset, `Delegate`, ACP session (docs/81, docs/84) | preset name, e.g. `claude`, `codex`, `self` | running · finished · failed | background run on a task · — · `Delegate` tool |
| **background run** / 后台运行 | worker, `Delegate` preset `self` (docs/42) | the job id on the task | running · finished · failed | task detail steps · progress card · — |
| **extension** / 扩展 | extension module (docs/34) | file name in `~/.agentbox/extensions/` | loaded · failed | Settings → Team → Reload extensions · — · `agentbox extensions reload` |
| **memory** / 记忆 | MemoryRecord; own tier and team tier (docs/24) | record id | live · held · waiting for approval · approved · rejected | Settings → Memory · — · `RememberFact`/`Recall`/`Forget` |
| **record** / 记录 | ledgers, transcripts, audit (docs/05) | ledger file and line | — (append-only) | Audit tab · — · `agentbox usage`, `agentbox audit export` |
| **approval** / 确认 | policy gate, consent, side-effect tier (docs/22 §5) | the request id on the card | waiting · allowed once · always allowed · refused | approval card in the chat, task detail → Gate (each step's verdict and why) · reply 允许 / 一直允许 / 拒绝 · `~/.agentbox/rules` |
| **tool permission** / 工具权限 | ToolPermissions (tool-permissions.ts) | tool name or tool group | allowed · ask me · off | Configure → tool chips · — · agent profile `toolPermissions` |
| **configuration version** / 配置版本 | ConfigVersion (agents/config-versions.ts, INV-1669) | `vN` per agent, numbered from 1 | in effect · saved, applies from the next turn | Configure → History, the `config vN` chip beside Configure, task detail → Configuration · — · agent `config-versions.jsonl` |
| **connector** / 连接器 | connector, OAuth credential, MCP server (docs/53) | provider id, e.g. `notion` | connected · not connected | Settings → Channels → Connectors · — · config `mcpServers` |
| **MCP endpoint** / MCP 入口 | MCP face, side door (docs/33) | the endpoint `/mcp` and its token | token valid · revoked | — · — · `agentbox mcp` |
| **watchdog** / 看门狗 | watchdog (docs/91) | — (one per installation) | on · off | Settings → Supervision · alerts in a chat · `agentbox watchdog` |
| **supervisor** / 监督者 | outside supervisor (docs/90) | the goal it watches | idle · watching · stopped | Settings → Supervision · — · `agentbox supervise`, `agentbox supervision` |
| **deliverable** / 交付物 | `DeliverFile`, task deliverables (INV-1663) | file digest on the task | delivered · held back (broken file) | task detail → Files · the file in the chat · `DeliverFile` tool |
| **bundle** / bundle | Bundle (docs/22 §8) | bundle name | — (attached to a box or not) | — · — · `agentbox bundle migrate` |

## Deprecated synonyms

`npm test` refuses these words in user-facing pages. Text inside backticks, code blocks,
link targets, HTML attributes and URLs is not checked, so a command or a file name may keep
its spelling.

| Deprecated synonym | Use instead | Note |
|---|---|---|
| `door`, `doors` | channel | The specs keep *door*. |
| `bot`, `bots` | agent | Except inside an allowed name below. |
| `buddy`, `buddies` | agent | |
| `worker`, `workers` | agent, or background run | docs/42's sense is a background run. |
| `expert`, `experts`, `specialist`, `specialists` | agent | A catalog entry for one agent is an agent. |
| `front agent` | the default agent | |
| `room`, `rooms` | box, or group chat | docs/22 used *room* for a box. |
| `team room` | team chat | |
| `机器人`, `智能体` | agent | |
| `箱子`, `工作机` | box | |
| `一道门`, `这道门` | 渠道 | |

## Allowed names

A proper name keeps its spelling even when it contains a deprecated word.

| Name | Why |
|---|---|
| `Grok Bot` | A product name. |

## Writing rules

1. One sentence says one thing.
2. Use the active voice: say who does it. "The agent opens the file", not "the file is opened".
3. One concept, one word: the user-facing word in the table above, every time.
4. Write the step before the reason: the thing to press, then why.
5. Name the place: "Settings → Channels", not "the settings".
6. A boundary is one sentence in a fixed form: "X is not Y: … check it at …". Example: "Run
   complete is not work accepted: a person decides Done on the Tasks tab."
7. Use a number, not "several" or "a few".
8. Do not use a word the reader has not met on the page or in this glossary.
9. Keep commands, paths and identifiers in backticks, exactly as typed.
10. Prefer short words; a sentence of more than 25 words is two sentences.
