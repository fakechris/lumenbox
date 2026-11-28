<!-- doc: channels
     title: Channels
     family: manual
     status: current
     covers: channel
     audience: user
     updated: 2026-11-28
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
- **Let an organisation's people in:** on an organisation installation, Settings → Team → People
  → *Directory* shows the departments synced from the channel, closed, with a head count each.
  *Sync the directory now* reads it again; it also refreshes daily. Open a department to see its
  people and where each stands: *Listed*, *Asked to join*, *Active* or *Left*. Choose a role and
  press *Activate* beside a person, or *Activate the N listed now* for a whole department, with
  its sub-departments if you tick that. The person is on the team at once: a message from them in
  the channel is theirs, their own computer is made with one assistant in it if their limit allows one (a
  few computers start at a time when a department is activated), and they sign in through the
  channel whenever they come. When a computer made at their activation is ready, their assistant
  writes to them in the channel with the address to open; a computer made when they first open
  the page sends nothing, since they are already there. A department's press first says how many computers it
  starts and how much memory that asks of the cluster, and starts nothing until you confirm.
  *Computers made at activation* then counts them as ready, starting, queued and failed, with the
  platform's reason; *Retry* starts a failed one again, and *Tell them again* writes to somebody
  the channel could not reach. Somebody who signs in before being activated sees "Your request to join is with the
  Admins" and waits under *Asked to join*, here and in Settings → Channels. Somebody the
  directory lists who writes to the channel directly before being activated is told the same and
  is the same request; somebody it does not list is told so, and makes none.
- **Connect a service:** Settings → Channels → Connectors → *Connect* links an outside service,
  such as Notion, for the agents to use.

### In a chat

- `bind <code>` (or `绑定 <码>`) — join with an invite code.
- `@name <message>` — talk to one agent you can reach; any other message goes to the default
  agent, or, in an organisation, a direct message goes to your own agent.
- `/help` — list every command this chat understands.
- `看板`, `团队`, `定时` — the board, the agents, and what runs by itself.

### From the command line

There is no channel command yet: channels are set up in Settings → Channels, which saves their
credentials in `~/.agentbox/config.json`.

## Where to see the result

- Settings → Channels: each channel and whether it is connected.
- The chat itself: in a Feishu group, the reply is a thread under your message.
- Settings → Team: each person and their role — viewer, driver or admin. On your personal
  installation, the desktop app on your computer, the one person is you, the Owner (机主).

## Limits

- Being listed in the directory lets nobody in, and activating a department is done once, for
  the people it lists at that moment: somebody who joins it later is *Listed* until an Admin
  activates them.
- When a sync no longer lists somebody who was let in by activation, the sign-in through that
  channel ends and they are shown as *Left*. Somebody who also signs in another way keeps that
  and their role; somebody with no other way in can no longer sign in. Their computers and files
  are kept until an Admin decides in the People list. People let in another way, and the only
  Admin, are never signed out by a sync.
- A sync that would end many sign-ins at once changes nobody: when it lists nobody, lists fewer
  than half the people the last one did, or would end more than 5 people and more than a tenth
  of those activated. The Directory block then says "The directory no longer lists N activated
  people; nothing was changed" with their names, and an Admin presses *They have left* or *The
  list is wrong; change nobody*.
- A department is activated as *Gives work* or *Watches*. An Admin is made one person at a time.
- A channel's id is chosen once; it becomes part of the name of everyone it lets in. Its
  display name and default agent can change at any time.
- *Add channel* offers Feishu and DingTalk.
- Signing in to the web page with a chat account works for Feishu and DingTalk channels, only on an
  installation with a public address (`AGENTBOX_PUBLIC_URL`), and only for an account already let
  in or activated by an Admin; anyone else has asked to join and waits. For DingTalk, only members of the organisation the app
  belongs to can sign in, and the app needs `<public address>/auth/<channel id>/callback` as its
  login redirect address and the permissions to read a member's contact profile and member
  information. WeCom has no channel yet.
- A personal installation has only you. Inviting a person, letting someone in who wrote,
  adding a person by hand and syncing a directory are all refused there, with the sentence
  "This is your personal installation; it has only you. To work with others, join or create
  an organisation." People are let in on an organisation's installation, where Admins
  (管理员) run them.
- Each Feishu app gives the same person a different id, so you are a new id in every Feishu app
  you talk to, and in DingTalk and each browser too. On a personal installation, Settings → Team
  → *Code for another account of mine* makes a code; send `bind CODE` from the other account, or
  sign in with it in a browser, and that account is you, the Owner. Nobody is added.
- A desktop installation from before personal installations may list you several times, once
  per app. Settings → Team then shows *See whether these are all me*: each entry with its
  channel and when it last wrote, and what a merge would change. Merge only if every one is
  you; the app restarts, and you are the Owner with every account. Nothing changes until you
  confirm.
- If they are not all you, answer *These are not all me*. Nothing changes and nobody is
  removed; Settings → Team then says that several people use the installation on this computer,
  and that people work together in an organisation installation, which runs on a server with its
  Admins. Moving is up to you; nothing is moved for you.
- In DingTalk, an approval arrives as a card only when a card template is set up. Without one,
  you answer by typing the reply word.

## Next

- [Approvals](approvals.md): answering a request from a chat.
- [Tasks and records](tasks-and-records.md): what a chat request becomes.
- The [chat commands](reference-commands.md) reference: every command, generated from the code.
