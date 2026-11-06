<!-- doc: skills
     title: Skills
     family: manual
     status: current
     covers: skill
     audience: user
     updated: 2026-11-06
-->
# Skills

What an agent knows how to do, written down so it does it the same way next time.

## What it is

A **skill** is a `SKILL.md` file in a box, under `/home/box/work/skills/<name>/`: a description
of when it applies, and the steps. An agent reads a skill when a request matches its
description. Agents write skills themselves when they work something out; every box also starts
with a set of starter skills. A skill with a `schedule:` or a `trigger:` is a routine (see
[automations](automations.md)).

An imported skill is not an installed one: `agentbox skills import` makes each skill a teaching
draft, and a person publishes it. Check *Teaching drafts* at the top of the app.

LumenBox also ships a skill for *other* coding agents: `agentbox skill install` gives Claude
Code or Codex a skill that drives LumenBox through its MCP endpoint.

## How to do it

### In the app

- **See the skills:** type `/` at the start of the chat box. A menu lists the skills in this
  agent's box; picking one writes "Use the … skill." in the chat box for you to send.
- **Review imported skills:** press *Teaching drafts* at the top of the app.

### In a chat

There is no skill command in a chat. Ask for the work; the agent uses the skill whose
description matches. To make a new skill, ask the agent to write one down once it has done the
work.

### From the command line

```
agentbox skills import <dir> [--agent <name>]           # each skill becomes a teaching draft
agentbox skills improve <skill-dir> --material <dir>    # propose a better version from examples
agentbox skill install [--claude] [--codex]             # the LumenBox skill for Claude Code / Codex
```

`skill install` copies the skill into `~/.claude/skills/lumenbox/` (Claude Code, the default)
or `~/.codex/skills/lumenbox/` (Codex), and prints the MCP line to add. It never edits that
client's configuration. The line needs a token: Settings → Mine → *Your MCP tokens* → *Issue*.
The app must be running.

## Where to see the result

- The `/` menu in the chat box.
- The agent's *Files* tab, under `skills/`.
- The [skills that ship](reference-skills.md) reference: every starter skill, generated from
  the code.

## Limits

- A skill lives in one box. Agents in another box do not see it.
- A starter skill is updated by a release only if nobody changed it.
- An MCP token is shown once. Copy it when you issue it; revoking it stops it at once.

## Next

- [Automations](automations.md): a skill that runs by itself.
- [Templates](templates.md): skills travel with a saved agent.
- [Memory](memory.md): facts, as opposed to how-to.
