# AGENTS.md

How agents work on this repository. Written for whatever is reading it — Claude Code, Codex, an
agent inside a LumenBox box — not for a person, though a person should be able to read it.

## The work graph this repo is bound to

| | |
|---|---|
| Involute PROJECT | **INV-96** — `fakechris/lumenbox` (`2ea544a1-f7cd-46c5-98b9-3f3da2993ada`) |
| Team key | `INV` |
| Server | `http://100.114.30.43:4200/mcp` (MCP, bearer `inv_agent_…`) |
| Web UI | `http://100.114.30.43:4201/` |

Everything below INV-96 is a MILESTONE (a delivery phase) or an ISSUE (one independently
acceptable piece of work), linked with `CONTAINS`.

## The loop

1. **Look before you invent.** `work_search` for what you are about to do. A second node for
   work that already has one is worse than no node: two records of one contract is how "各种
   task 都对应不上" happens.
2. **`work_list_ready`** shows what is committed, unblocked and unclaimed. Choose from it, or
   let the person choose. Do not lease what nobody committed.
3. **`work_claim`** the one item you are about to do, and only that one. A claim is a lease, not
   an assignment: it says *this agent is working on this now*, so a second agent does not start
   the same thing.
4. **`run_report`** as you go — `running`, `blocked`, `completed`.
   - **Crucial rule: When starting a new run, OMIT `run_id`.** Do NOT pass `claim.id` or a client-generated UUID. The server creates and assigns the run ID. Only pass `run_id` when updating an existing run.
   - A blocked run says what would unblock it, in a sentence somebody can act on.
5. **`evidence_attach`** a durable URL before you call anything finished: a PR, a commit, a test
   run, a file path in the box. "It works" is not evidence; a link is.
6. **Agents propose, humans commit.** `work_propose` creates a **candidate**. Nothing an agent
   proposes enters the active queue until a person commits it in the Web UI. Never treat your own
   proposal as agreed work.
7. **Agents never mark work Done.** A completed run moves the item to **In Review**. The person
   decides what Done means.

## First-Time Onboarding Blueprint (首次接入黄金规范)

1. **Strict 3-Tier Hierarchy (严谨三层拓扑)**:
   - Root: One `kind: 'PROJECT'` matching `<owner/repo>`.
   - Mid-tier: Delivery phases as `kind: 'MILESTONE'` linked to PROJECT via `CONTAINS`.
   - Leaf-tier: Independently acceptable units as `kind: 'ISSUE'` linked to corresponding MILESTONE via `CONTAINS` (pass `parent_id: <MILESTONE_ID>`). No orphan issues.
2. **Mandatory Rich Structured Chinese Descriptions (强制提供结构化中文详细描述)**:
   - **Absolute prohibition**: `description: null`, empty text, or brief links like `ref docs/foo.md` or `## 状态:待办 docs/09`.
   - Every proposal MUST structure `description` with:
     - `### 1. 目标与架构定位`: Role in system architecture, why it is needed.
     - `### 2. 核心功能与交付范围`: Exact modules, UI components, APIs, behavior changes.
     - `### 3. 验收标准与验证方案`: Concrete test commands, exit 0 criteria, PR checks.
   - **No status tags in titles**: Do NOT prefix titles with `[已交付]` or `[待办]`. Status is strictly tracked by the state machine.
3. **Codebase Reality Alignment (现状与代码真实进度对齐)**:
   - Do NOT leave completed features in `Ready`.
   - For historical features already working and passing tests: immediately after commit, the agent executes `work_claim` -> `run_report(completed)` (omitting `run_id`) -> `evidence_attach` (linking PR/test) to advance them to `In Review`. Only genuinely unstarted work remains in `Ready`.

## Scope guards & Unplanned Work (即时热修自动闭环法则)

Work you discover while doing other work is **not** licence to widen the job:
- If it is a bugfix or unplanned modification touching product code: fix it locally, verify tests, and before responding to the user call `work_propose` with:
  - `kind: 'ISSUE'`
  - `related_work_id: <当前处理任务ID 或 所属父里程碑ID>`
  - `related_work_type: 'DISCOVERED_DURING'`
  - Mandatory 3-part structured Chinese description.
- Do not propose: grep results, a note to yourself, a debugging step, a rename you happened to notice. Involute is a contract kernel, not a scratchpad.

## What this repository is

LumenBox (npm package `agentbox`). A host orchestrator on the operator's machine drives one or
more boxes — Docker locally, or an attached box over a tunnel — each a real Linux computer with
a desktop per agent. Agents are reached from an Electron app, from Feishu / DingTalk / Telegram,
from an MCP face, and from webhook routines.

- `src/host/` — the orchestrator: turns, tools, prompts, policy gate, scheduler, templates.
- `src/agents/` — the registry and the bus. **The registry owns box membership and teams.**
- `src/box/`, `src/boxd/` — the box client and the daemon inside the box.
- `src/web/` — the server and the single-page app (`app-html.ts`).
- `src/control/` — the multi-tenant control plane and the Kubernetes allocator.
- `docs/` — the design record. `docs/11-roadmap.md` is the running one; read it before planning.

## House rules that outrank convenience

- **`npm test` is the gate.** It is hermetic: no credentials, no network, no live `~/.agentbox`.
  Never merge on a red suite. `npm run release:check` builds *and launches* the artifact — a
  green build is not evidence that the thing runs.
- **A conduct fix is not finished until the episode is a scenario.** `src/host/scenario.ts` runs
  a whole multi-agent episode on the real stack with a scripted model and scores it; add one to
  `scenario.test.ts` for every run that went wrong (docs/43).
- **A concept has one home.** A second definition of the same idea in a second file is the bug,
  even when it works. `src/host/architecture-guard.test.ts` fails the build for the ones we have
  already paid for.
- **The Dockerfile is the source of truth for the box.** Fix box problems by changing it and
  rebuilding, never by editing a running container.
- **Verify on the artifact, not in your head.** Print the byte, read the field, take the
  screenshot (`node scripts/ui-shot.mjs`). Sound reasoning has disagreed with reality here more
  than once.
- **Never print or store a token, key or secret** — not in a message, not in a commit, not in a
  transcript. Name it and say where it lives.
- **Another agent may be working in this checkout.** Check the branch, commit only your own
  files, and never `git add -A` across somebody else's work in progress.
