# 31 — The turn engine, reviewed against the incident and three references

**Status: plan, 2026-09-02. Nothing here is built yet.** Written after an outside review of
the "reply first" rule, verified claim by claim against the tree at `584927c`, one live
incident in our own transcripts, and three harnesses read at source (Grok Bot 0.30.0's
in-box host, Hermes Agent, Claude Code's documented behaviour). Where the review was right
it is credited; where it was wrong the correct fact is written down so it does not come back.

## 0. The incident, in our own records

Bob, Feishu thread `feishu-zongheng-…-om_x100b660ee12…`, a person-opened turn. The person
described a plan built on "qwen-27B 或 glm-5.3-flash". Bob's whole first response, no tool
call anywhere in the turn:

> 我先说一个可能影响你选型的事：**Qwen 没有 27B**（Qwen3 的稠密档位是 14B / 32B，27B 是
> Gemma 3 的规格），**GLM 目前公开到 4.x（GLM-4.5-Air / GLM-4-Flash），没有 5.3-flash**。

Both models exist; both were released 2026-08-14. The person had to write back "请你用
websearch再讨论，你的知识落后了" before Bob searched — and then Bob's opening line of the
search round, "你说得对，我先查一下，不该凭记忆下结论。", was filed as `kind: "blocks"` and
never reached Feishu. Ada's threads hold the same shape three times ("Thor T5000 不存在" —
it exists; "Qwen 没有 27B" — it does; a "要不要我…" menu after being handed a text to read).

So the failure class is real and recurring: **on a person-opened turn the model asserts a
newer entity does not exist, from its weights, with no search, and the turn ends because
nothing in the engine minds.** That is the thing to fix. The review's account of *why* is
about half right, and the half that is wrong matters for what to build.

## 1. The review's claims, verified

| # | Claim | Verdict | What the tree says |
|---|---|---|---|
| 0 | "Reply first" + `toolUses.length === 0` is a deadlock: the model obeys, replies as text, the engine ends the turn before any search | **Wrong as stated** | The model can and does put text and tool calls in one response; the `[conduct]` line records "opened with a reply (5 tool calls, text first)" in tonight's log. The engine ends a turn only on a response with *zero* tool calls. Bob's incident was a text-only response chosen by the model, not forced by the engine. |
| 1 | Text that accompanies tool calls never reaches a chat channel (`replySince` filters `kind === undefined`) | **Right** | `orchestrator.ts:1438`; `turn.ts:2118` files text-with-tools as `kind: "blocks"`. Only the web trace shows it. The rule "reply first" therefore costs tokens on Feishu and buys the person nothing — the Typing reaction is the only receipt they get. |
| 2 | Tool calls in one response run serially | **Right** | `turn.ts:1976` `for (const toolUse of toolUses) await dispatchTool(...)`. Nothing in the comments says serial was chosen. |
| 3 | No built-in exit gate; `hooks.json` is empty; auto-review is a safety gate, not a quality gate | **Right** | The Stop-hook plumbing exists (`turn.ts` ~1885) and nothing drives it; `~/.agentbox/hooks.json` does not exist on this machine; `auto-review.ts` classifies binding tool calls only. |
| 4 | The recap line "If you showed a claim to be false, give the right figure or say what getting it would take" induces the failure | **Plausible, unproven** | The line exists (`prompt.ts` CRITICAL_RECAP). It presupposes a check happened; a model that "showed" something false from memory reads it as licence. The very next line — "Do not ask permission for a tool you already hold" — was violated in the same breath, so the recap is not being read as a whole. Reword; do not credit it with the whole incident. |
| 5 | 28k of tokens between the conduct rules and the end; attention lost in the middle | **Half right** | Bob's floor is ≈25.6k with 31 tools (measured, docs/handoff-2026-09-02). But the recap is *already* the last block of the system prompt; what sits between it and the latest user message is the **conversation history**, which on a long thread is the larger distance, and on the OpenAI wire the tool schemas are separate objects the provider places where it likes. The fix is a per-turn reminder in the user turn, not moving the recap. |
| — | "Align with Hermes: guidance at the tail" | **Wrong about Hermes** | Hermes puts every behavioural block in the *stable top* tier and ends its system prompt with skills, memory and a date line; it re-injects nothing per turn (its own comment: byte-identical replay for cache stability). The tail-reminder pattern is Claude Code's (`system-reminder` inside the user turn) and Grok Bot's (mid-turn `<system_reminder>` user-role messages). |
| — | "Grok Bot has a Stop hook and an auto-review that catches narrated-but-not-called" | **Wrong** | No main-loop stop hook in the bundle (only `executeSubagentStopHook`). Auto-review classifies tool calls only and treats narration as *untrusted context that authorises nothing*. What catches silence is structural: `isDeliveryOwed` (no `SendToUser` this turn → up to 3 hidden re-drives), `turnEndedOnSilentToolCalls` (ack, tools, then nothing → 1 closing nudge), `StartOfTurnAckReminderMiddleware` (tools before any ack → reminder). None reads the text. |
| — | "Hermes has completion validation" | **Right, as three bounded guards** | Trailing-intent regex (reply ≤400 chars ending "let me now / I'll now…", max 2 per turn), intent-ack continuation (future-tense + action verb + no tool result yet), dropped-tool-call recovery (`finish_reason=tool_calls` with none, max 3). Plus a verification stop-loop that holds a final answer after code edits with no fresh test evidence. |

## 2. What the references actually do that we do not

Read at source; evidence lines are in the two research transcripts summarised in
`research/2026-09-02-coordination-mcp-memory.md`'s sibling notes (Hermes:
`agent/prompt_builder.py`, `agent/conversation_loop.py`, `agent/tool_dispatch_helpers.py`;
Grok Bot: `host-main.cjs` 547954, 676095, 687346, 691370, 696106, 698041).

| Mechanism | Grok Bot 0.30 | Hermes | Claude Code | Ours |
|---|---|---|---|---|
| The person sees the model's opening line while tools run | Yes — `SendToUser` is a tool, plain text is never shown; round 0 is `[SendToUser, tools…]` | Yes — streams text until the first tool call, then emits it as an interim message | Yes — streamed | **No** on chat channels (filed as `blocks`) |
| Silence caught by structure, not text | `isDeliveryOwed` → 3 re-drives; `turnEndedOnSilentToolCalls` → 1 closing nudge; ack-before-tools reminder; obligations survive restart (`ack-obligations.json`) | — | Stop hook | "ended without anything to report" line only |
| Promise-without-action caught | prompt only | trailing-intent regex, intent-ack, dropped-call recovery; max 2–3 per turn; nudges removed from the durable transcript | Stop hook can block | **No** |
| Parallel tool execution | `Promise.all`, started per streamed call, no read-only gate | parallel-safe set (`read_file, search_files, web_search, web_extract, session_search…`) + path-overlap rules; `terminal` never parallel; 8 workers | read-only tools concurrent | **Serial** |
| `tool_choice` forcing | No | No (adapters pass it through, loop never sets it) | No | No — and **neither wire can carry it** (`openai-wire.ts` drops it) |
| Behavioural guidance placement | top of base prompt; reinforcement as mid-turn `<system_reminder>` user messages | stable top tier only | `system-reminder` blocks inside the user turn | CONDUCT at top, CRITICAL_RECAP at the end of *system*; nothing in the user turn |
| Model-family gating of the discipline block | one prompt for one model | `EXECUTION_GUIDANCE_MODELS = (gpt, codex, grok, deepseek, kimi, qwen, glm, minimax, mimo, mistral)`; Claude excluded "because it does not exhibit these failure modes" | n/a | none — MiniMax gets the same words as Claude |
| "Memory describes the user, not the world" | — | in `<mandatory_tool_use>` | — | **No** |
| Empty / thinking-only response | `<system_reminder>Please continue…` retry | one nudge; thinking-only prefill ×2; cost-aware empty retry | — | one line to the person, turn ends |
| Repeated identical failing calls | — | warn at 2 / block at 5 | — | round budget only |
| Tool result caps | — | 100k chars per result, 200k per turn, disk spill with 1.5k preview | — | `SHED_RESULT_LIMIT` on overflow only |

The pattern across all three: **the engine minds what the person sees and whether an action
followed a promise; the prompt is asked to carry less.** Ours asks the prompt to carry all of it.

## 3. The plan — three layers, in the order Chris ruled

Layer 1 is structural and goes first ("方案 B 应该加"). Layer 2 and 3 are prompt work
and are cheap, but each changes model behaviour and must be measured, not asserted. The
bounded guards ("方案 A") go last, and they go in: both references run bounded runtime
nudges, Grok's structural, Hermes's textual. Ours will be structural first.

### Layer 1 — the engine

**1a. The opening line reaches the chat (replaces `SendToUser`).** Grok needs a tool because
its plain text is never shown. Ours is, so the mechanism is smaller: when a person-opened
turn's first response carries text *and* tool calls, the text is delivered to the chat at
once as an *interim* line — a card update if the adapter has a card, a plain message if not
— and filed in the transcript as `kind: "interim"` so `replySince` still excludes it from
the final reply and the extractor does not double-count it. Once per turn (round 0 only);
later narration keeps going to the trace. The channel manager already has `onProgress` and
`deliver`; this is one more event, `interim`, from `turn.ts`.
*Test:* a fake model that says "我先查一下" + WebSearch on round 0 → the adapter's `send`
is called with that text before the tool runs; the final reply does not repeat it.

**1b. Closing the loop, structurally (Grok's `turnEndedOnSilentToolCalls`).** If an interim
line was delivered and the turn's last response has no text (today's "ended without anything
to report"), the engine sends one hidden nudge — "you acknowledged and then ran tools; the
person's last sight of you is the acknowledgement; deliver the result now" — and lets the
model finish. Once per turn. Logged as `[conduct] closing-nudge`.

**1c. Parallel read-only tools (Hermes's set, our names).** In `turn.ts`, split a round's
tool calls into segments in the model's order: a run of calls whose names are all in
`PARALLEL_SAFE` (`WebSearch, WebFetch, read_file, list_dir, Recall, ReadHistory,
OtherThreads, ReadFeishuDoc, Tasks.list`) executes with `Promise.all`; anything else
(`bash`, `write_file`, `edit_file`, `computer`, MCP unless the server opts in) closes the
run and executes alone. Results are returned in the model's order regardless of finish
order. Auto-review still runs per call. Cap 6 in flight.
*Test:* three WebSearch calls with 100 ms stubs finish in ~100 ms not ~300; a bash between
two reads serialises; result order equals call order.

**1d. `tool_choice` on both wires.** Plumb `tool_choice` through `openai-wire.ts`
(`"required"` / `{type:"function", function:{name}}`) and pass it on the Anthropic path
(`{type:"any"}` / `{type:"tool", name}`). Not used by default — it is the lever the guards in
1e pull, and it is the one thing none of the three references have. A forced round is
logged and never repeated in the same turn.

**1e. Bounded guards, structural before textual.** All three: once per turn, logged under
`[conduct]` with the reason, the nudge not written to the durable transcript (Hermes), and
`AGENTBOX_GUARDS=0` to switch off for an ablation.
- *Delivery owed* (Grok's `isDeliveryOwed`): person-opened turn, final text empty and no
  interim delivered → one nudge to reply.
- *Verdict without a check* (the incident): person-opened turn, **zero tool calls in the
  whole turn**, and the reply asserts non-existence or staleness of a named thing
  (`不存在|没有.*版本|尚未发布|目前公开到|does not exist|there is no|not (yet )?released`)
  or offers to check instead of checking (`要不要我(去|现在)?(查|核|搜)|需要的话我(去|就)|
  如果.*我(就|再)(查|核)|want me to (check|look|search)|I can (check|verify|look) if`) →
  one re-request with `tool_choice: required` and a hidden reminder: *you asserted a fact
  about the world from memory; check it with a tool before answering.* If the model still
  answers without a tool, the reply goes out as is, flagged in the log. Two regex families,
  Chinese and English, kept in one file with a test per phrase so they can be tuned from
  the log rather than argued about.
- *Trailing intent* (Hermes): reply ≤ 400 chars ending in a first-person future action
  (`我先|让我|我去|我这就|我马上|let me|I'll now|I will now`) with no tool call → one nudge
  "do it now, in this response". Max 2 per turn, shared counter with the guard above.

Deliberately **not** built: a text classifier for "answered from priors" in general. The
structural signal — zero tool calls on a turn that makes a factual claim about a named,
datable thing — is what both incidents share, and it is checkable without a model.

### Layer 2 — where the words sit, and which words

**2a. Reword the recap line.** "If you showed a claim to be false…" becomes: *"A doubt about
a fact is a search, not a verdict. Only after a tool has checked it may you call a claim
false — then give the right figure."* The permission line stays and moves up one.

**2b. A per-turn reminder inside the user turn, model-gated.** Three lines appended to the
user message on person-opened turns, after the person's text, in the model's language of
the conversation, for the model families Hermes gates on (`minimax, qwen, glm, deepseek,
kimi, gpt, grok`) and never for Claude: *(1) a newer version number or an entity you do not
recognise is real until a tool says otherwise — search first; (2) do not ask whether to use
a tool you hold — use it and report; (3) if you say you will check, the call is in this
response.* Rendered by `buildTurnPrompt`, so steering and continuations get it too. Cost:
~80 tokens per turn, after the cache breakpoint.
*Measure:* the `[conduct]` counters before and after, on a week of Feishu traffic; and the
golden task in §4.

**2c. Prompt floor.** Already an open item (handoff-2026-09-02 #4): measure the per-tool
description sizes and trim the three largest; report the floor before and after. Skills
index budget is the audit's open item. Not new here, listed so the layer is complete.

### Layer 3 — the epistemic line

One paragraph in the memory section of the system prompt, stable so it caches: *"Your
weights and your memory are the past. Memory describes the person, not the world. A model
name, version, product or event you do not know is by default something released after your
knowledge — look it up before you doubt it; never call it fictional, inflated or a typo on
the strength of not having seen it."* Hermes's version is one line of `<mandatory_tool_use>`;
ours says the failure we actually had.

## 4. Evidence gate

- **Golden task `newer-than-you`** (style tier): the Bob message verbatim, with two real
  post-cutoff model names. Pass = at least one WebSearch in the turn before any assertion
  about their existence; fail = an assertion of non-existence with zero tool calls. Needs a
  search key; the golden runner applies config env already.
- **Process invariant**, checked on every golden run: no reply containing a non-existence
  assertion about a named thing on a turn with zero tool calls.
- **Live counters** on the `[conduct]` line: `interim-delivered`, `closing-nudge`,
  `verdict-guard` (fired / model complied / model still answered), `trailing-intent`.
  A week of these decides whether Layer 1e stays on by default.
- **Ablation:** `AGENTBOX_GUARDS=0` and the reminder off, same golden tier, three runs each,
  the way R28 was run.

## 5. Order, size, and what is decided

1. Layer 1a + 1c + 1d (interim line, parallel reads, `tool_choice` plumbing) — M, pure
   engine, hermetic tests, no behaviour change a person could dislike. First.
2. Layer 2a + 3 (recap reword, epistemic paragraph) — S, prompt only; ship with 1 and
   measure together.
3. Layer 2b (per-turn reminder, model-gated) — S to write, a week to judge.
4. Layer 1b + 1e (closing nudge, the three guards) — M; `tool_choice` from step 1 is the
   lever. Structural guards on by default; the textual guard on for the gated model families,
   off for Claude, exactly Hermes's split.
5. Layer 2c (floor) — already open, unchanged.

Decided here rather than left open: the guards are not a patch — both references run them,
bounded, and the incident is the case they exist for. What is *not* decided until the
counters exist: whether the textual guard's regexes earn their keep, and whether the
per-turn reminder is needed once the guards are on.
