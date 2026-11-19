<!-- doc: approvals
     title: Approvals
     family: manual
     status: current
     covers: approval
     audience: user
     updated: 2026-11-19
-->
# Approvals

What an agent may do on its own, what it has to ask you first, and how you answer.

## What it is

An **approval** is your answer to one request: an agent wants to do something that reaches
past its box, such as posting to an outside service, and it waits until a person answers. A
**tool permission** is set beforehand, per agent and per tool: *allowed*, *ask me*, or *off*.
A **credential check** runs before work starts: if the work needs a secret or a connector that
is not there, nothing starts and a card says what is missing.

"Always" is not a blanket yes: it allows that one exact action, for that agent only, until you
revoke it. Check Settings → Mine → Standing approvals.

A write to a **file that is run later** always asks, whatever the agent's tool permissions: a
git hook, a CI workflow, a script in `package.json`, a Makefile, a shell startup file, a
scheduled job. Such a file is run afterwards by something else, with someone else's rights, so
the card says "This file will be run later" and who runs it. A change to `package.json` asks
only when its scripts change. Your organisation can allow these writes for one project with a
rule ([Rules reference](reference-rules.md)).

## How to do it

### In the app

- **Answer a request:** the card in the chat says "Consent needed — <agent> is waiting", what
  the action is, and what the agent says about it in its own words. Press *Allow once*, *This
  session*, *Always* or *Refuse*.
- **Set what an agent may use:** Configure → Tools. Click a tool to cycle allowed → ask me →
  off; an *off* tool is not offered to the agent at all. The row above sets a whole group —
  Desk, Web, Code, Team, Other — to *allow*, *ask me* or *off*. A dashed chip is one your
  organisation already asks about; hover it to see where that comes from.
- **Revoke an "always":** Settings → Mine → Standing approvals → *Revoke*. The next identical
  action asks again.
- **Fill in what is missing:** a "Before <agent> can start <task>" card lists each missing
  secret or connector, with a button to Settings → Team (secrets) or Settings → Channels
  (connectors). The work starts by itself once they are in place.

### In a chat

- Reply with the whole message `允许` (once), `一直允许` (always), `本次会话` (this session) or
  `拒绝` (refuse). English works too: `allow`, `always`, `session`, `deny`.
- In Feishu the card has three buttons: 允许这一次, 一直允许, 拒绝.
- When something is missing before work can start, the agent replies "<agent> 开始前需要：" and
  one line per item. Once they are set, the task starts by itself; you do not send it again.

### From the command line

- Standing rules for the whole installation are Markdown files in `~/.agentbox/rules`, one per
  rule, each saying what it matches and `allow`, `ask` or `deny`. The
  [rules grammar](reference-rules.md) lists every field.
- `AGENTBOX_TIER_GATE=enforce` makes LumenBox ask before every action that reaches past the box.
  By default it only records them.

## Where to see the result

- Each tool step in the chat carries a mark: `allowed`, `asked you`, `waiting for you` or
  `refused`. Click it to see which rule or setting decided.
- Settings → Mine: your standing approvals, and *Would have asked (last 7 days)* — what
  LumenBox would ask about if the gate were enforced.
- The Tasks tab: a task held for a credential shows "<task> is waiting: before it can start".

## Limits

- A request waits until somebody answers, for at most 24 hours. An expired request counts as
  refused, so a late click cannot run it.
- *This session* lasts until the app restarts.
- An agent's *allowed* never lifts an *ask* or a *deny* your organisation set.
- Some tools that only talk to you are allowed or off, never *ask me*.
- A file that is run later is recognised by its path, and in a shell command when the command
  plainly writes it (a redirection, `tee`, `cp`, `mv`). A program that writes such a file itself
  is not seen. A task at L1 or L2 is refused such a write instead of asking.

## Next

- [Agent](agent.md): where Configure is.
- [Channels](channels.md): answering from Feishu or DingTalk.
- [Automations](automations.md): what happens to a routine that lacks a credential.
