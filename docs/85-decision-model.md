<!-- doc: 85-decision-model
     title: The decision model: switched judgements beside the cheap profile
     family: guide
     status: current
     updated: 2026-11-01
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
| `memory_judge` | off, shadow, on | the four questions on the cheap profile (`memory-judge.ts`); with the decision model, four type scores per line as well (INV-1472) |
| `answer_review` | off, shadow, on | the reply review (`answer-review.ts`) |
| `memory_select` | off, shadow, on | the per-turn memory selector (`memory.ts`) |
| `memory_sufficiency` | off, shadow, on | — (a check after the selection, INV-1471: enough? anything misleading? drops the misleading, widens the selection once) |
| `auto_review` | off, shadow | the authorisation review (`auto-review.ts`) — compared, never decides |
| `routine_resolve` | off, shadow, on | the routine verdict (`routine-resolve.ts`) |
| `computer_verify` | off, shadow, on | the desktop postcondition check |
| `computer_wait` | off, on | — (new action) |
| `computer_click` | off, on | — (new action) |
| `computer_guard` | off, shadow, on | — (new check before a desktop click) |

**What a memory is like (INV-1472).** `kind` says where a line came from; four scores say what it
is for — episodic, semantic, procedural, preference, each 0..1, asked of every candidate by the
decision model at `memory_judge` and stored on the line (`types`). At `memory_select` the same
four are asked of the message, and the order of the memories that passed the line leans toward the
ones whose profile matches (`leanedByType`: cosine affinity, `AGENTBOX_MEMORY_TYPE_WEIGHT`, default
0.2; at 0 nothing changes). A lean, not an admission: a memory the model scored below the line stays
out whatever its type, and a line without scores — written before, or by the cheap-profile judge —
is neutral. No new switch: it follows `memory_judge` and `memory_select`.

**Enough, and nothing in the way (INV-1471).** The selector stops at its budget whether or not
what it picked answers the message. `memory_sufficiency` asks one more request after
`memory_select`: a noul on whether the chosen memories are enough to reply well, and one per
memory on whether it is unrelated and could lead the reply astray (the review's CONTEXT_BLEED,
seen before the reply). `on`: the misleading are left out of this turn's prompt — never deleted —
and when the rest is not enough and candidates remain, one selection with twice the budget, checked
once more for misleading entries; never a third. `shadow`: what was selected goes in unchanged and
the refinement is logged beside it, so `jev-shadow-report` shows how often the two differ. The
switch follows the rule every switch follows: absent is `off` (the contract asked for `shadow` by
default; a point that makes a remote call nobody switched on would be the one exception, so it is
not one). Read it with the answer review's CONTEXT_BLEED rate over the same days.

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
- `click_target` (`computer_click`): first in its call. One observation takes the window's control
  outline and a frame. With an outline, the decision model *chooses* the control from the clickable
  ones (a `choice` over up to 254 lines of `role "name" [states]` plus `none`, and a `present`
  noul; a first round under 0.5 or `none` gets a second look at the five closest, each with its
  rectangle and neighbours), and the chosen ref is clicked through `click_element`, so the box's
  identity check (docs/49 A1b) stands between the choice and the input. Without an outline — a
  terminal, an Electron app — or when the outline names nothing, the target's box on the frame and
  an ordinary click at its centre, refused below 0.5, as before. The model is never asked for text:
  what is typed is the agent's, verbatim (INV-1479).
  Measured on our own screen (`scripts/eval-click-target.mjs`, 10 targets, one absent, 2026-11-01,
  MiniMax-M3.1-Flash as the main model): box on the screenshot 8/10, choice from the outline 10/10
  (the absent one refused), main model 7/10. The choice's confidences sit low — 0.51 to 0.72, the
  Files tab at 0.51 — and a first round takes 2–11 s against 0.3–2 s for a box, so the threshold is
  the thing to watch, not the hit rate; the outline in that eval is authored from the screen, not
  captured (the web app exposes no tree), so it measures the choosing, not box-ax.
- The guard (`computer_guard`): before a batch whose first write is a click, the boxed control is
  read; send, pay, delete, publish or submit goes to the policy gate as irreversible, as a browser
  click on one does. A failed or unsure reading adds nothing.
- Taught operations may have `desktop` steps — click, type, key, wait, check, by description, never
  coordinates. They run through the same path, a click not marked `commit` that the guard stops ends
  the run, and with the needed switches off the dry run fails, so the operation cannot be published.

Every desktop batch is dispatched once, whatever the mode: comparing two paths would mean clicking twice.
