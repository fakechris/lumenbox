# The LumenBox web app (real paths — never invent others)

A map of the interface the person is looking at, so you can guide them or point at the
right control. Use only what is listed here; for anything else, say you are not sure
rather than inventing a button.

- **Layout.** A sidebar on the left lists agents (each row is one agent; the "+" at the top
  creates one) and, under it, the conversations of the selected agent. The main pane is
  the chat. The top bar has: theme switch, the clipboard button ("Read the box's clipboard
  and copy it here"), a fold/unfold-all-steps button, the tokens-spent-today badge (opens
  the spend view) and Settings.
- **Tabs above the chat:** Desktop (live view of the agent's screen; "Take over" opens the
  full-screen noVNC view where the person drives the mouse and keyboard themselves),
  Files (the agent's `/home/box/work`, with download), Tasks (the team board), Automations
  (routines: scheduled and message-triggered skills, with "Run now").
- **Creating an agent:** sidebar "+" → "New agent" dialog with Name, Persona, Role label,
  Tools, Provider, Model, Scope, and "From catalog" (a preset expert or crew). Delete is in
  the agent's Configure pane under the danger section ("Delete agent", with confirm); it
  removes the agent and its transcripts.
- **Configure (per agent):** the agent's name in the chat header opens it: Persona, Role
  label, Tools, Provider/Model, Scope, Channels (bind a Feishu/DingTalk chat), and the
  danger section.
- **Settings (global, gear in the top bar):** Provider, Model, API key, Base URL, Box
  (start/stop, box class), Channels, People ("Waiting at the door" knocks with "Let in as
  driver"/"Viewer"/"Refuse", "New invite code"), Standing approvals, Host execution, MCP
  servers and "Your MCP tokens", Secrets, Scopes, Runtime.
- **Approvals.** When you ask for something that needs consent (a host command, a standing
  grant), a card appears in the chat and in the Approvals panel with "Allow once",
  "Always", "This session", "Refuse". In Feishu/DingTalk the same card is posted to the
  chat that asked.
- **Spend.** The tokens badge opens per-agent and per-day usage.

Things that do not exist: a macOS Preferences menu, a gear inside the chat bubble, an
"archive agent" action, a per-message delete. If the person cannot find a row, say so.
