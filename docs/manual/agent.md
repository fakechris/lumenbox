<!-- doc: agent
     title: Agent
     family: manual
     status: current
     covers: agent
     audience: user
     updated: 2026-11-06
-->
# Agent

The one you talk to: how to make an agent, configure it, and see which version is running.

## What it is

An **agent** is a named AI that works in one box, with its own desktop, memory, skills and
tools. Several agents make your team: they message each other and hand work to each other. A
**team** is a label that lists agents together; an agent can be on up to 5 teams.

A saved configuration is not the running one: a change applies from the agent's next turn, and
a turn already running keeps the version it started with. Check the `config vN` chip beside
Configure.

## How to do it

### In the app

- **Make an agent:** press `+` beside *Agents* in the sidebar. Write one, or pick one *From
  catalog*. To make one from a saved agent, use the sidebar *Templates* button.
- **Configure it:** pick the agent and press *Configure*. The *Settings* tab has its name, role
  label, Teams (comma separated), box, persona, tools and standing files.
- **See its versions:** Configure → *History*. Tick two versions and press *Compare ticked*, or
  press *Go back to this version*.
- **Pause it:** Settings → Team → Agents → *Pause*. *Resume* lets it work again.

### In a chat

- `@name <message>` — give the message to that agent.
- `团队` (or `team`) — list who works here.
- A message that names nobody goes to the channel's default agent.

### From the command line

```
agentbox agents                      # list the agents
agentbox agent new <name> [description]
agentbox chat <agent> "<message>"    # talk to one agent from the terminal
```

## Where to see the result

- The sidebar: each agent's row shows `Running`, `Waiting for you: …`, or a `paused` tag.
- The chip beside Configure: `config v3`, or `config v3 · v4 next turn` while a new version waits.
- A task's detail on the Tasks tab: *Configuration vN*, the version the work ran on.

## Limits

- Teams: at most 5 per agent, each at most 24 characters, lowercase.
- An agent stays in the box it was made in.
- To stop a turn that is running, use Stop; saving a new version does not stop it.

## Next

- [Approvals](approvals.md): what an agent may do without asking.
- [Skills](skills.md) and [memory](memory.md): what an agent knows.
- [Templates](templates.md): save an agent, or make one from a saved one.
