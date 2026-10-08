<!-- doc: 34-extensions
     title: Extensions: the edges you can edit without restarting the core (R36)
     family: decision
     status: current
     updated: 2026-09-29
-->
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

## Talking back to the loop (INV-861)

A tool's `run` may return `{ text, effects }` instead of a string, and a tool may be registered
with `hostOnly: true`. Together they let an extension do things that have a lifecycle without a
line of core code per extension — the shape Manus Cue's addons use (research INV-860), built from
parts this repo already had.

- **Host-only tools** never appear in any agent's list — not the prompt, not `FindMcpTool`, not a
  box's bundle, not the MCP face — and a model that names one anyway is refused. Only the harness
  calls them, as the callbacks below. A configured MCP server gets the same with
  `"hostOnlyTools": ["_sync"]` in its `mcpServers` entry.
- **Effects** are a closed list; anything else is logged and dropped, never interpreted. A
  callback an effect names must be a host-only tool of the same server.

| effect | what the harness does |
|---|---|
| `{ type: "pause_turn", reason, resumeTool, resumeInput? }` | puts `reason` in front of the person as an ordinary approval (card, chat push, grant/deny) and tells the agent to stop. When the person answers, the harness calls `resumeTool` with `{ ...resumeInput, approved }` and delivers what it returns to the conversation. The agent retries nothing. |
| `{ type: "background_job", jobId, resumeTool, brief? }` | records the job. `api.jobDone(jobId, text, ok?)` delivers the result to the agent that started it, once. After a restart the harness calls `resumeTool` with `{ jobId, recovering: true }`; a job whose callback is gone is reported lost. |
| `{ type: "reminder", text, at }` | delivers `text` as a system note at or after `at` (within a year), once, across restarts. |

Every effect is written to the pending-work ledger (`pause`, `ext-job`, `reminder`) before the
agent is told it was accepted, and settled when delivered — the fork ledger's rule. A fork's
effects are dropped: a fork neither asks a person nor outlives its parent's turn. A reminder
months away keeps the ledger from compacting until it fires; the cost is a longer file.

```js
export default function (api) {
  api.tool({
    name: "publish",
    description: "Publishes the site.",
    run: async input => ({
      text: `Staged ${input.site}.`,
      effects: [{ type: "pause_turn", reason: `Publish ${input.site} to production?`, resumeTool: "_publish_resume", resumeInput: { site: input.site } }],
    }),
  });
  api.tool({
    name: "_publish_resume",
    description: "Called by the harness once the person answers.",
    hostOnly: true,
    run: async ({ site, approved }) => (approved ? await goLive(site) : `Left ${site} staged.`),
  });
}
```

Not yet: a cancel callback for background jobs (nothing would call it), and effects from remote
MCP results.

## What it is not

Not a way to change the prompt, the turn engine, the channels or the policy — those are the
core, and "hot" there would mean a half-swapped process. Pi and deepseek-harness reload their
edges the same way; nobody reloads the middle. Channel wire verbs were the other candidate in
R36's list and stay one: they would need the manager to consult an extension per message, which
is a design, not a seam.
