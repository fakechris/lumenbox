<!-- doc: templates
     title: Templates
     family: manual
     status: current
     covers: template
     audience: user
     updated: 2026-11-20
-->
# Templates

Make an agent from a saved one, or save an agent so somebody else can make it.

## What it is

A **template** is a saved agent: its persona, skills, routines and conventions — never its
history, never the people it worked with. Stamping a template makes a new agent in a sandbox. The
shelf has ready-made templates; you can also stamp one somebody shared with you. A **crew** is
a catalog entry that adds several agents at once, as one team.

Importing a template is not a working agent: the new agent installs its recipe on its first
turn and then asks for what it needs. Check its chat for a "Before … can start" card that names
each missing secret or connector.

## How to do it

### In the app

The app opens in the new view. There, templates live in the agent forms:

- **Make an agent from one:** press `+` on the first sandbox heading in the sidebar and open *Or start
  from a template* at the bottom of the form. Type in *Find a template…* to narrow the list,
  which groups *Ready-made*, *Roles*, *Crews (several at once)* and, once you have saved
  some, *Made here*; press *Create from it*.
- **Use one somebody sent:** in the same list, open *A template somebody sent*, choose the file
  or paste the template, and press *Import and create*.
- **Add a crew:** a crew is a row under *Crews (several at once)* in the same list.
- **Share an agent:** open the agent and press its name at the top of the chat to open its
  settings. Open *Make a template of it* and press *Ask … to draft one*. The agent writes the
  draft in its chat; when it is staged, the same section shows it with a *Download* link.

The classic view still has the template dialog. Press *Back to the classic view* at the bottom
of the sidebar to reach it (and *Back to the new view* to return):

- **Stamp one:** press *Templates* at the bottom of the sidebar. Choose the sandbox under *Stamp
  into*, find a template under *Ready-made agents* (type in *filter* to narrow the list), and
  press *Preview* to read it or *Stamp* to make the agent. To stamp a shared one, press
  *Paste or link…* in the same dialog and paste the template or its link into the form it
  opens.
- **Share an agent:** open Configure on the agent and press *Ask it to draft a template*.

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

- The sidebar: the new agent appears in the list, in the sandbox you chose.
- The new agent's chat: its first turn installs the recipe and asks its questions.
- The agent's settings → *Make a template of it* (Configure → *Share as template* in the classic
  view): the latest staged template and its download link.

## Limits

- A template carries no history and no people; the new agent starts with only what the
  template holds.
- A template that needs a connector or a secret waits for it. The work starts by itself once
  it is in place.
- The name is the template's own; if an agent in that sandbox already has it, a number is added.

## Next

- [Agent](agent.md): configure the agent you made.
- [Skills](skills.md): what a template's skills are.
- The [template shelf](reference-templates.md) reference: every ready-made template, crew and connector.
