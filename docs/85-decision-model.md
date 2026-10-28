<!-- doc: 85-decision-model
     title: The decision model: switched judgements beside the cheap profile
     family: guide
     status: current
     updated: 2026-10-28
-->
# The decision model: switched judgements beside the cheap profile

Some of the host's own judgements are closed questions: is this memory an instruction someone read,
does this reply answer the request, which memories matter for this message, is this screen showing
a confirmation. They used to be put to the cheap profile as prose and parsed back out of JSON. A
typed decision model (TypeSafe's Jev, `src/host/jev.ts`) answers them directly — a yes/no
probability, a distribution over named options, a position on a scale, or a box in an image — all
of a request's questions at once, in about half a second.

## The switches

One per judgement point, `AGENTBOX_JEV_<POINT>`, set in Settings → Model → Decision model (stored
in the config file's env block) or exported in the shell:

| Value | What happens |
|---|---|
| `off` (default) | The point does what it did before. No remote call is made. |
| `shadow` | The point still decides on its own path; the decision model is asked the same question in the background, and both answers go to `~/.agentbox/jev-shadow.jsonl` as summaries — verdicts and hashes, never the text that was judged. |
| `on` | The decision model decides; when it fails, the point's own path decides instead. |

Every request, in any mode, is one line in `~/.agentbox/jev-calls.jsonl`: the point, the model
version, the time, input tokens, how many questions of each type, and each answer as numbers — never
the state, the wording or an image. `node scripts/jev-shadow-report.mjs` summarises both logs.

Without a key (`TYPESAFE_TOKEN`, or `TYPESAFE_API_KEY`) every switch acts as `off`. Calls go
straight to the vendor, not through `HTTP_PROXY`: measured, the proxy quadrupled the latency.

| Point | Modes | Its own path |
|---|---|---|
| `memory_judge` | off, shadow, on | the four questions on the cheap profile (`memory-judge.ts`) |
| `answer_review` | off, shadow, on | the reply review (`answer-review.ts`) |
| `memory_select` | off, shadow, on | the per-turn memory selector (`memory.ts`) |
| `auto_review` | off, shadow | the authorisation review (`auto-review.ts`) — compared, never decides |
| `routine_resolve` | off, shadow, on | the routine verdict (`routine-resolve.ts`) |
| `computer_verify` | off, shadow, on | the desktop postcondition check |
| `computer_wait` | off, on | — (new action) |
| `computer_click` | off, on | — (new action) |
| `computer_guard` | off, shadow, on | — (new check before a desktop click) |

## The rule

The decision model reads literally and has no defence against instructions written into what it is
shown. So it is never the only thing that permits an action: where a judgement guards something,
its answer may only make the outcome more careful — hold a memory, call a result failed, ask a
person — never wave something through that would otherwise have been stopped.

## On the desktop

The desktop points read the screen. The box returns the final frame also as JPEG when asked
(the decision model takes no WebP), optionally with a red box drawn around a point.

- `expect.looks` (`computer_verify`): one sentence about the screen after a batch. A clear no fails
  the batch, even over a native yes; a clear yes is a line of evidence and never turns unknown into ok.
- `wait_until` (`computer_wait`): alone in its call and read-only; a frame every 1.5 s until the
  screen shows the sentence or the seconds run out (unknown).
- `click_target` (`computer_click`): first in its call; the target's box on a fresh frame, an
  ordinary click at its centre, refused below 0.5. Measured on our own screen it was no more
  accurate than a vision-capable main model (7/10 against 8/10, `scripts/eval-click-target.mjs`),
  so it is for models that cannot place a click themselves.
- The guard (`computer_guard`): before a batch whose first write is a click, the boxed control is
  read; send, pay, delete, publish or submit goes to the policy gate as irreversible, as a browser
  click on one does. A failed or unsure reading adds nothing.
- Taught operations may have `desktop` steps — click, type, key, wait, check, by description, never
  coordinates. They run through the same path, a click not marked `commit` that the guard stops ends
  the run, and with the needed switches off the dry run fails, so the operation cannot be published.

Every desktop batch is dispatched once, whatever the mode: comparing two paths would mean clicking twice.
