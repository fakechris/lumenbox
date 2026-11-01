<!-- doc: 87-prompt-parts
     title: Built-in prompt parts: a team's override, and what happens when the default moves
     family: guide
     status: current
     updated: 2026-11-01
-->
# Built-in prompt parts: a team's override, and what happens when the default moves

The persona and the standing files (AGENTS, SOUL, USER, HEARTBEAT) were always the team's.
The built-in rules — how a turn works, how the front agent keeps its turns short, how an
unattended turn behaves — were constants in `src/host/prompt.ts`, so a team that wanted one
rule worded its way had no way but a fork, and a fork loses every later improvement to the
default (INV-1465).

## The parts

| Key | Section | What it says |
| --- | --- | --- |
| `conduct` | *How a turn works* | reply first, work out loud, close the loop; tone; never fabricate; asking; showing |
| `front` | *Your turns stay short* | the agent a person talks to answers within seconds and hands heavy work to a background fork |
| `unattended` | *Nobody is watching this turn* | how a scheduled, listener or wake turn behaves with no person waiting |

Each is registered with its default text (`definePart` in `prompt.ts`) and rendered through
`partText(key)` (`src/host/prompt-parts.ts`), which reads an override on every prompt build:
a change applies to the next model request, no restart.

## The override, and the three answers when the default moves

`~/.agentbox/prompt-overrides/<key>.md`:

```
---
base: 3f1c…            # the hash of the default this was written against
---
# How a turn works
…the team's words…
```

Status, as Settings → Model → *Built-in rules* shows it:

- **default** — no file; the part follows every release.
- **yours** — a file whose `base` is today's default: the team's words are what the agents read.
- **default updated** — a file whose `base` is not today's default: a release changed the
  text underneath. The team's words still apply; the page shows the new default beside them
  and asks for one of three answers: **Keep my text** (re-based on today's default, the mark
  clears), **Use the new default** (the file is removed), or edit and **Save** (a new override
  against today's default). Nothing is merged silently.

Saving words identical to the default removes the file, so the part follows future defaults
again. A file in the directory that names no part is listed as stray rather than ignored.

## What this does not touch

Prompt text only. The policy, the tools, the mandate (docs/22 §2a), the outbound gate
(docs/26) and every other check in code read nothing from here; an override cannot widen
what an agent may do, only how it is told to behave. `AGENTBOX_ABLATE` still withholds a
section for an experiment, override or not.
