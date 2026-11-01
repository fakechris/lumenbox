<!-- doc: 88-improve
     title: A check-up for one agent: scenarios in isolation, a judged report, a proposal nobody applies
     family: guide
     status: current
     updated: 2026-11-01
-->
# A check-up for one agent: scenarios in isolation, a judged report, a proposal nobody applies

`agentbox improve <agent> [--scenarios 8-12]` (INV-1473, `src/host/improve.ts`).

Three things already judged an agent's replies after the fact — the skill evals, the answer
review (docs/85), the eval cases (docs/83 §8) — and none closed the loop from "what this agent is
told it is" to "what to change". This does, once, on demand:

1. **Read the definition.** The agent's standing files (AGENTS, SOUL, USER, HEARTBEAT), the skills
   its box offers, and its last twenty requests, so the scenarios are in the register people use.
2. **Make 8–12 scenarios.** The cheap profile proposes them as JSON; whatever it proposes, the four
   edges are always present — `empty` (nothing said), `ambiguous` (cannot be done without a question
   back), `out_of_scope` (someone else's job), `must_refuse` (a credential, a destructive act, a
   rule) — with defaults when the model left one out (`ensureBoundaries`).
3. **Run each in isolation.** A `fork/improve-…` conversation of the agent, background lane,
   synthetic, with read-only tools (`read_file`, `list_dir`, `ReadHistory`, `Recall`): nothing it
   says reaches a chat door, nothing it does writes. The agent's own model answers; the box is not
   needed.
4. **Judge twice.** The answer review's category (PASS / NON_ANSWER / PROCESS_OVER_RESULT /
   CONTEXT_BLEED) and a one-line judge scoring 1–5 against what that kind of request calls for. A
   scenario failed when the review says so or the score is 2 or under.
5. **Report and propose.** `~/.agentbox/improve/<agent>/<time>.md`: every scenario with its reply
   and both judgements, the failure modes counted, and — when anything failed — the smallest change
   to AGENTS/SOUL/USER the cheap profile proposes, as a unified diff per file. **Not applied.** The
   standing files are never written; a person applies what they agree with. Failed scenarios are
   also kept as eval cases (docs/83 §8), so `scripts/replay-evals.mjs` can replay them after the
   change.

Bounds: twelve scenarios at most; the cheap profile for generation, judging and the proposal; the
agent's model only for the answers. Each run is a dozen turns of the agent and about three cheap
calls per scenario.

What it does not do: it does not go through the prompt-parts three-way review (docs/87) — those
are the built-in rules; the standing files are the team's, and the proposal is a diff the team
reads. A `/improve` command in the chat is not wired; the CLI is the door.
