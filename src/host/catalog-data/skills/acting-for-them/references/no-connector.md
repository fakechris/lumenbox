# When a service has no connector

## What a connector is here

LumenBox has two kinds of connected service. You can connect neither one yourself.

- **Doors**: MCP servers that switch on when the operator sets the service's credential on the machine. The built-in ones are Notion, Slack, Linear, Google (Gmail and Calendar), Figma and X. An entry under `mcpServers` in the operator's config adds or overrides one. Their tools appear as `<service>__<tool>`. When there are many, they sit behind `FindMcpTool`.
- **Connected services**: GitHub and Feishu, connected by an admin in Settings → Connected services and granted per agent. You call them with `connector_request`; its description lists the ones you have. The host attaches the token, so you never see it.

## The order to try

1. **Is it in your tool list?** Check the tool names and `connector_request`'s list. If it is there, use it. Prefer exports and raw API results over reading tables off a screen.
2. **Is it there but refusing?** A connected-services call can come back as "not connected for you, or its token cannot be refreshed". That needs an admin, so say so once. Do not repeat the write. Ask the person whether to wait or use the browser instead; do not switch on your own.
3. **Nothing for it?** Then the box's browser is the normal route, not a last resort. This covers webmail, chat apps and dashboards. If they asked for the thing, do not ask whether you may open the site; open it. The only thing to bring them is the sign-in step, by `sign-in.md`. The browser's logins persist, so it is a one-time step.
4. **A command-line tool on their own machine?** Use `RunOnHost`. Each command is shown to the person for approval, and granted vault secrets are placed in its environment for that one run.
5. **Truly out of reach?** For example, a login bound to their own device. Then say what you tried and offer the manual route: an export, a paste, a screenshot from them. Never offer that while the box could still reach it.

## Asking for a connection

Name the service in plain words and say who can add it. GitHub and Feishu are connected by an admin in Settings → Connected services. The doors (Notion, Slack, Linear, Google, Figma, X) are switched on by the operator setting that service's key on the machine. Never write out a link you made up, and never ask for the token in chat. If they want you to use an API key from host commands, ask for it with `AskSecret` (see `sign-in.md`).

## Whose name it posts under

A connector is not always the person speaking. The Slack door posts as the bot's app, and Feishu through `connector_request` acts as the app. When they want something said as themselves, use the browser where they are signed in, or give them the text to send. See `send-on-behalf.md`.

## After a site taught you something

When a site needed an odd step, or something looked like it worked and did not, keep it with `NoteSiteLearning`, whether it worked or failed. The next visit, yours or a teammate's, sees it. Never put a credential in it.
