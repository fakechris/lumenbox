# 34 — Extensions: the edges you can edit without restarting the core (R36)

**Status: built 2026-09-03.** The third and last seam R36 asked for, after hooks (Claude Code's
dialect, 0.30) and the MCP reload (2026-09-02). Small by design: what it hot-loads is a plugin
layer, never the core.

## The contract

A file in `~/.agentbox/extensions/` — `.mjs`, `.js` or `.ts` — default-exports a function of one
argument:

```js
export default function (api) {
  api.tool({
    name: "ticket_lookup",                    // becomes ext__ticket_lookup in every agent's list
    description: "Looks a ticket up by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: async input => JSON.stringify(await lookup(input.id)),   // text out, like every tool
  });
  api.on("tool_end", event => { /* every turn event of this type; "*" for all */ });
  api.log("ready");                          // to the web log as [extensions] <file>: ready
}
```

- **Tools** arrive through the same in-process server surface an MCP server's tools use
  (`VirtualServer` in `mcp.ts`, named `ext`), so everything downstream applies unchanged: the
  profile's and the scope's allowlists, the lookup pair when the list is over budget, the fork
  fence (a fork child gets none), the MCP face (a delegated engine may be lent one by name), the
  policy gate and the `[conduct]` record. A tool name is `[A-Za-z0-9_-]{1,40}`; a name a later
  file registers again is refused and reported, never silently replaced.
- **Listeners** get the orchestrator's turn events after the UI does. A listener that throws is
  logged and the turn is untouched.
- **Reload** — `agentbox extensions reload`, `POST /api/extensions/reload`, or the button in
  Settings beside the MCP one — tears every registration down and imports every file afresh with
  a cache-busting URL. Routes the MCP face minted against the old tool list are revoked, as on
  an MCP reload. Old module instances stay in memory until the process ends; that is what a
  reload costs and it is the operator's to spend.
- **Loaded at start**, before recovery, so the first prompt has the tools.

## The security face

An extension is the hooks file under another name: code run with the process's authority from a
mutable file in the state directory. The same rule applies (docs/10 S-9): a file that is group-
or world-writable, or owned by another uid, is refused with a log line and skipped; the rest of
the directory still loads. A file that throws, or does not default-export a function, is a
problem line in the settings page and the reload's answer, not a failed start.

## What it is not

Not a way to change the prompt, the turn engine, the channels or the policy — those are the
core, and "hot" there would mean a half-swapped process. Pi and deepseek-harness reload their
edges the same way; nobody reloads the middle. Channel wire verbs were the other candidate in
R36's list and stay one: they would need the manager to consult an extension per message, which
is a design, not a seam.
