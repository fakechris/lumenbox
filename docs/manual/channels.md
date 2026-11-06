<!-- doc: channels
     title: Channels
     family: manual
     status: current
     covers: channel
     audience: user
     updated: 2026-11-06
-->
# Channels

How people reach your agents from Feishu or DingTalk, and who is let in.

## What it is

A **channel** is one app on a chat platform — a Feishu app, a DingTalk app — that opens into
your box. Once it is connected, a message in that chat is a message to an agent, and the
reply comes back in the same chat. A conversation there is a **group chat** or a private chat.
The same person is one person across every channel, so an approval given in one counts in
another.

A message in a group chat is not always an order: with the group rule *only when addressed*, a
message that names nobody is kept as context and not answered. Check the rule in Settings →
Channels.

## How to do it

### In the app

- **Connect a channel:** Settings → Channels → *Add channel*, choose `feishu` or `dingtalk`,
  and paste the app credentials from that platform's developer console. A channel with its
  credentials in place connects at once, without a restart.
- **Choose who answers:** each channel row has a default agent, the one that answers a message
  that names nobody, and a group rule: *groups: only when addressed* or *groups: answer all*.
- **Let people in:** Settings → Team → *New invite code*. A code works once, for 15 minutes.
  People who wrote before they were let in wait under Settings → Channels → *Waiting to be let
  in*; one click lets them in.
- **Connect a service:** Settings → Channels → Connectors → *Connect* links an outside service,
  such as Notion, for the agents to use.

### In a chat

- `bind <code>` (or `绑定 <码>`) — join with an invite code.
- `@name <message>` — talk to one agent; any other message goes to the default agent.
- `/help` — list every command this chat understands.
- `看板`, `团队`, `定时` — the board, the agents, and what runs by itself.

### From the command line

There is no channel command yet: channels are set up in Settings → Channels, which saves their
credentials in `~/.agentbox/config.json`.

## Where to see the result

- Settings → Channels: each channel and whether it is connected.
- The chat itself: in a Feishu group, the reply is a thread under your message.
- Settings → Team: each person and their role — viewer, driver or admin.

## Limits

- A channel's id is chosen once; it becomes part of the name of everyone it lets in. Its
  display name and default agent can change at any time.
- *Add channel* offers Feishu and DingTalk.
- In DingTalk, an approval arrives as a card only when a card template is set up. Without one,
  you answer by typing the reply word.

## Next

- [Approvals](approvals.md): answering a request from a chat.
- [Tasks and records](tasks-and-records.md): what a chat request becomes.
- The [chat commands](reference-commands.md) reference: every command, generated from the code.
