<!-- doc: templates
     title: Templates
     family: manual
     status: current
     covers: template
     audience: user
     updated: 2026-11-06
-->
# Templates

Make an agent from a saved one, or save an agent so somebody else can make it.

## What it is

A **template** is a saved agent: its persona, skills, routines and conventions — never its
history, never the people it worked with. Stamping a template makes a new agent in a box. The
shelf has ready-made templates; you can also stamp one somebody shared with you. A **crew** is
a catalog entry that adds several agents at once, as one team.

Importing a template is not a working agent: the new agent installs its recipe on its first
turn and then asks for what it needs. Check its chat for a "Before … can start" card that names
each missing secret or connector.

## How to do it

### In the app

- **Stamp one:** press *Templates* at the bottom of the sidebar. Choose the box under *Stamp
  into*, find a template under *Ready-made agents* (type in *filter* to narrow the list), and
  press *Preview* to read it or *Stamp* to make the agent.
- **Stamp a shared one:** in the same dialog, press *Paste or link…* and paste the template
  or its link.
- **Add a crew:** press `+` beside *Agents* and choose one *From catalog*.
- **Share an agent:** open Configure on the agent and press *Ask it to draft a template*. The
  agent writes the draft in its chat; when it is staged, Configure shows it with a download
  link.

### In a chat

There is no template command in a chat. A template's agent answers in a chat like any other
agent, once a channel names it or you address it with `@name`.

### From the command line

These talk to the running app:

```
agentbox template import <file> [--name <name>]   # make an agent from a template file
agentbox template share <agent>                   # ask the agent to draft a template of itself
agentbox template download <agent> [-o <file>]    # save the latest staged template
```

## Where to see the result

- The sidebar: the new agent appears in the list, in the box you chose.
- The new agent's chat: its first turn installs the recipe and asks its questions.
- Configure → *Share as template*: the latest staged template and its download link.

## Limits

- A template carries no history and no people; the new agent starts with only what the
  template holds.
- A template that needs a connector or a secret waits for it. The work starts by itself once
  it is in place.
- The name is the template's own; if an agent in that box already has it, a number is added.

## Next

- [Agent](agent.md): configure the agent you made.
- [Skills](skills.md): what a template's skills are.
- The [template shelf](reference-templates.md) reference: every ready-made template, crew and connector.
