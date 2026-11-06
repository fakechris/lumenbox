<!-- doc: box
     title: Box
     family: manual
     status: current
     covers: box
     audience: user
     updated: 2026-11-06
-->
# Box

The computer your agents work on: how to get one, watch it, and take it over.

## What it is

A **box** is a Linux computer with a desktop for each agent, a browser, a file manager and a
shell. The default box runs in Docker on your own machine; you can also attach a box that runs
somewhere else. An agent lives in one box, and its memory, files and logins stay there.

A running box is not an agent at work: the box can be up while every agent is idle. Check it in
the sidebar, where the footer shows the box and each agent's row shows what that agent is doing.

## How to do it

### In the app

- **Start the box:** Settings → Boxes → *Start the box*. The first start pulls the image, which
  is hundreds of megabytes.
- **Add a box:** press `+ box` in the box bar at the top, or Settings → Boxes → *Attach* to
  drive a box on another machine.
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

- The sidebar footer: `box online` or `box unavailable`, and how many boxes are up.
- The box bar: one tab per box, with a green dot when it is connected.
- Settings → Boxes: every machine, and the last error of an attached box.

## Limits

- An agent's box is chosen once. To work on another box, make a new agent there.
- The local box needs Docker Desktop or OrbStack. The first start can take 10 to 40 minutes.
- A shared box is shared: everyone who can open it can see its screen and read its files. Do not
  sign in to your own accounts on it.
- If something outside LumenBox stops the local box, LumenBox starts it again. A box you stopped with
  `agentbox box down` stays stopped.

## Next

- [Agent](agent.md): who works in the box.
- [Channels](channels.md): how people reach the agents.
- [docs/37](../37-onboarding.md) §3: three ways to get a box.
