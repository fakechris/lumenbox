<!-- doc: box
     title: Sandbox
     family: manual
     status: current
     covers: box
     audience: user
     updated: 2026-11-06
-->
# Sandbox

The sandbox your agents work in: how to get one, watch it, and take it over.

## What it is

A **sandbox** is a Linux environment with a desktop for each agent, a browser, a file manager and a
shell. The default sandbox runs in Docker on your own machine; you can also attach a sandbox that runs
somewhere else. An agent lives in one sandbox, and its memory, files and logins stay there.

A running sandbox is not an agent at work: the sandbox can be up while every agent is idle. Check it in
the sidebar, where the footer shows the sandbox and each agent's row shows what that agent is doing.

## How to do it

### In the app

- **Start the sandbox:** Settings → Sandboxes → *Start the sandbox*. The first start pulls the image, which
  is hundreds of megabytes.
- **Update the sandbox:** Settings → Sandboxes shows an available image update at the top. Choose
  *Apply update* to wait for the agents to finish their work before updating.
- **Add a sandbox:** press `+ box` in the sandbox bar at the top, or Settings → Sandboxes → *Attach* to
  drive a sandbox on another machine.
- **Watch an agent:** pick the agent, then open the *Desktop* tab on the right.
- **Take over:** press *Take over* on the Desktop tab to use the mouse and keyboard yourself.
  Press *Hand back* when you are done.

### In a chat

- `桌面` (or `desktop`) — the agent replies with a link to its live desktop, to watch or take over.
- `屏幕` (or `screen`) — a still picture of the desktop as it is now. No turn runs.

### From the command line

```
agentbox box up            # start the box and wait for its desktop
agentbox box status        # container state, ports and health
agentbox box list          # every box, and which agents live in it
agentbox box attach <name> <url> --token-file <file>
agentbox box down          # stop it; it stays stopped until you start it
agentbox box shot out.webp # save a screenshot of the desktop
```

## Where to see the result

- The sidebar footer: `box online` or `box unavailable`, and how many sandboxes are up.
- The sandbox bar: one tab per sandbox, with a green dot when it is connected.
- Settings → Sandboxes: every machine, and the last error of an attached sandbox.

## Limits

- An agent's sandbox is chosen once. To work on another sandbox, make a new agent there.
- The local sandbox needs Docker Desktop or OrbStack. The first start can take 10 to 40 minutes.
- A shared sandbox is shared: everyone who can open it can see its screen and read its files. Do not
  sign in to your own accounts on it.
- If something outside LumenBox stops the local sandbox, LumenBox starts it again. A sandbox you stopped with
  `agentbox box down` stays stopped.

## Next

- [Agent](agent.md): who works in the sandbox.
- [Channels](channels.md): how people reach the agents.
- [docs/37](../37-onboarding.md) §3: three ways to get a sandbox.
