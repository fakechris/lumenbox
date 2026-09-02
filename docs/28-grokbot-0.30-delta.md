# What Grok Bot 0.30.0 changed, and what it says we should change

Status: **written 2026-09-01** from a source-level re-analysis of the installed app and
the public box image (the in-box host itself, not inferred). The full write-up and the
archived artifacts live outside this repository at
`research/grokbot/versions/0.30.0/GROK_BOT_0.30.0_ANALYSIS.md`; this file is the part
that is ours to act on, ranked by (our measured pain × their evidence).

## The shape of the shift

Their harness left the app and lives in the box; the laptop became a *provider* the agent
can reach. Prompts were sectioned and A/B'd for size. Memory became greppable files with a
recall tool and background synthesis. Safety moved from gates to a per-call LLM classifier
with an explicit-intent rule. Routines gained event listeners and a "be aggressive about
routines" mandate. The box grew a browser-identity stack. Details in the analysis; here is
only what changes our backlog.

## Ranked

**1. Auto-review as a classifier, shadow first.** Their per-tool-call LLM review decides
from *trusted user intent for outcome, target and side effects*, with two rules we lack:
content from a webpage/MCP result/document/another agent never authorises anything, and
"draft it" never authorises "send it". Our policy gate is budget and allow-list; our
audit #2 (a skill file taken as authority) is precisely an untrusted-origin failure.
Ship it in shadow mode first (log the verdict, enforce nothing) exactly as they roll it
out, then enforce on the outbound/binding class. Files: `src/host/policy.ts`, a new
classifier beside `src/host/audit.ts`.

**2. Reply first; ack ≠ delivery.** Their persona's first rule: a person-opened turn
starts with a one-line reply before any tool call, and the turn must end with the result
delivered. We have the structural half (owed deliveries, `EMPTY_REPLY_NOTE`) and none of
the prompt half — which is why Ada answered the weekly-report follow-up with a wall of
questions and why long silences read as "ignored" in Feishu. Add the section to
`src/host/prompt.ts` verbatim in spirit, including "the internal word box is never said".

**3. Routines with event listeners, and the mandate to create them.** Ours are cron-only
scheduled skills. Theirs fire on Slack/GitHub/Linear/Sentry/PagerDuty events and the
prompt says "the moment a request is recurring or a 'let me know when X' need, create a
routine instead of doing it once". Our equivalents: a Feishu/DingTalk message-match
listener as a trigger kind in `src/host/schedule.ts`, and the prompt mandate in the
skills section. Gate on the provenance fix from audit #2 first — a listener that fires an
agent-written skill is the same escalation with a wider trigger.

**4. Memory the agent can grep.** Their `profile.md` + `log/YYYY-MM.md`, one dated fact
per line, one shard per assistant, and a prompt line that says "read or grep those files
with Read and Shell". The alwyzon incident had Ada searching the box for memory files
that do not exist there; their design makes that search *correct*. We keep the ledger
(retractions, dedupe, decay) and add a rendered, read-only projection of the live view
into the box at `~/work/memory/<agent>/profile.md` + `log/`. Also their
`update_state forget <exact text>` is our `replaces`, and their `RecallMemory` scopes
`agent|user|all` is the fix we shipped today for Recall's tier blindness — the design
converged; keep it.

**5. Freeze the memory block across a compaction epoch.** `resolveFrozenMemoryPrompt`
snapshots the rendered memory per compaction epoch so the prompt prefix stays byte-stable.
We re-render memory on continuation (audit #6) and MiniMax caches implicitly at 20% of
input price — a stable prefix is money. One snapshot keyed by compaction count in
`src/host/turn.ts`.

**6. Prompt-size discipline as a product decision.** A slim-prompt A/B, a flag that
removes 3.3K duplicated tokens, a conversation-bundle GC with a turn-start hard cap. Our
system prompt has no budget and audit #4 (an unbounded skill description) is the same
class. Measure our system prompt in tokens per turn, print it in the startup log, and cap
the skill index (audit #4's fix) — then decide what a slim variant would drop.

**7. Per-window owner tokens for desktops.** We made the display lease per-display today;
they went further: every forked desktop is bound to an unguessable owner token, the
window router refuses a mismatch, and the incident it cites — "one agent landed on
another agent's browser after a slot was reused" — is exactly the class our lease was
catching by accident. When desktops are reassigned (agent deleted, index reused), mint a
token and check it in boxd's display routing.

**8. A read-only shell classifier, from a real parser.** tree-sitter-bash feeding
allowlist/denylist/`isReadonly` with escalation. We approve `RunOnHost` by hand and gate
`bash` in the box by nothing. Start with the read-only class (so an approval can say
"this only reads") — the same tree-sitter-bash package is what they vendor.

**9. Hooks, in Claude Code's dialect.** Twenty lifecycle steps with a
`PreToolUse/Stop/PreCompact → step` mapping so Claude Code hook files run unchanged.
Our R36 hot-extensions direction has no shape yet; adopting the Claude Code event
vocabulary makes every existing hook script portable to us for free.

**10. Cross-tool skill discovery.** They read `.claude/skills`, `.codex/skills`,
`.cursor/skills`, `.grok/skills`, `.agents/skills`. Our skills dir plus the opencode
projection is half of this; scanning the other roots on the box is a loader change in
`src/host/skills.ts`.

**11. Persisted browser identity.** Their chrome-profile volume plus cookie import from
the user's Chrome is the answer to our "recreate loses the scs login" — a profile volume
we already have the shape for (config volume), and a one-time import we would need
consent UX for. Their UA/fingerprint/web-bot-auth stack is beyond our remit.

**12. Two prompt sections we should copy nearly verbatim.** "Never fabricate data" (the
alwyzon lesson as prompt, including "never attach a real-sounding source to invented
figures") and "Asking for decisions" (a question widget phrased as a natural question,
never a menu). Our `AskUser` tool exists; the phrasing rule does not.

## Explicitly not for us

Egress tunnel (box traffic exiting through the user's laptop — clever, wrong tenancy for
us), voice calls, Stripe virtual cards, iMessage read/send, Temporal-hosted turns, bot
marketplace. Also: they do **not** delegate to Claude Code/opencode — `codex` in the
bundle is a model prompt version — so our Delegate line (docs/25) is a genuine difference,
not a lag.
