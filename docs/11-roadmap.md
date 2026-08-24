# Roadmap and backlog

Everything deferred on purpose, in one place, ranked. The ranking lens is the one used
throughout: **(current risk × user impact) ÷ effort**, with hard dependencies noted.
This is a living document — an item moves up when its blocker clears or its risk rises,
and moves out when it ships. Written product-independently; the comparative analyses
that motivated several items live in the (untracked) `research/` directory.

The system today has the framework's five organization objects (conversations, people,
tasks, credentials, workers) and a hardened turn engine. What remains is a last mile of
usability, the reference toolset's still-missing members (web, browser, shell jobs,
edits, questions), a set of honesty surfaces the hardening never finished, one large
security item, and two structural growths.

---

## Tier 1 — small, high value, unblocked

These close loops the recent work opened. Days, not weeks, each.

### R1. The composer respects the viewed conversation
The middle pane can *view* any conversation, but the composer always sends to `main`.
Read a Telegram thread, reply, and the reply lands in the team room instead. Either
send to the viewed conversation, or disable the composer when viewing a side thread
and say why. Small; a correctness gap the conversation viewer created.

### R2. Answer an approval from the chat channel
A channel-driven turn that hits the policy gate pushes a notice to the phone — but the
person still has to open the web UI to allow or deny. A reply of `allow` / `allow always`
/ `deny` on the origin chat should answer it, so the "manage from a phone" story is
actually end to end. Medium-small. Depends on nothing; reuses the policy grant scopes.

### R3. Windows and Linux packaging
`package.json` already carries `win`/`linux` build config, but only `dist:app` (mac,
dir) exists. Add the platform targets and a real installer output, and settle the
macOS app name (packaging fixes the "still says Electron" menu-bar label). Medium.
Makes it a distributable rather than a dev launch.

### R12. Web search and fetch as first-class tools
"What is the current X" and "read this page" degrade today to `curl` through an HTML
stripper, or to pixel-driving the desktop browser — an order of magnitude more
latency and tokens, and it fails outright on JavaScript-rendered pages. A search
tool over a pluggable provider and a fetch tool that can render close the largest
single capability gap for some of the least code. Small. They enter through the same
allowlist / scope / policy surfaces as every other tool.

### R14. An edit tool, not whole-file rewrites
`write_file` re-emits the whole file for a one-line change: tokens scale with the
file, not with the change, and a stale rewrite gets refused by the changed-since-read
guard — which is honest, but still a failed edit. A `str_replace`-shaped tool (old
text, new text, optionally several pairs per call) is small and removes both costs.

### R15. An agent can ask a question mid-task
A turn can only end with a final answer, so an ambiguous instruction forces a guess
carried to completion. An `ask` tool that suspends the turn, pushes the question to
the origin chat as a card (answers as buttons, the words still working), and resumes
on the reply is the approval pipeline wearing different clothes — suspension,
channel push, and one-shot binding all exist today. Small-medium; the payoff is
long-task success rate.

### R19. Host-initiated exec, marked as such
Starter skills and the web UI drive the same `/exec` channel the agent does, so
host-side housekeeping (`mkdir` for a skill) walks the agent's approval and audit
surface. A marker on the protocol request — a label, not a bypass — lets the audit
log say who acted. Small.

### R20. Spill what pruning removes
Every layer of long-output handling truncates honestly — and what it drops is gone
everywhere at once: the omitted middle of a shell result capped at 20k characters
exists nowhere on disk, and the transcript stores only the first 2k of each result,
so even `ReadHistory` recovers a stub of a stub. The reference discipline is prune +
spill: the full text always lands somewhere durable, and the pruned copy carries a
pointer. Smallest full shape: boxd tees exec output past a threshold into a spool
file, and the truncation note names the path and line count — `read_file`'s line
ranges already are the read-back side, no new reader needed; `storableResult`'s cut
gets the same pointer. Small; R13's blood line (a terminal file is a spill), but it
does not wait for it.

---

## Tier 2 — medium, valuable, mostly unblocked

### R4. Grant grows into Scope
The Grant object (holder, resource, expiry) was built as the Scope seed. The growth:
bind `{memory, files, secrets, tools, sandbox, schedule}` into one grantable boundary,
so "this agent, in this project scope" is a single authorization rather than five
separate settings. The framework's largest remaining object. Medium-large; design
first, because the boundary shape is the whole decision.

### R5. Provider per agent
The runtime is a global singleton: changing the model changes the whole installation.
The framework's principle 1 is that agent identity and runtime are separate — an agent
should be able to run a cheaper model without the others knowing. Add an optional
per-agent provider/model override on the profile, falling back to the global default.
Medium. Unblocks "the reviewer runs the big model, the tidy-up agent runs the cheap one".

### R6. Per-principal / per-conversation spend caps
Spend is now attributed per person; the budget gate is still global. A cap per
principal (or per conversation) turns attribution into control — "this channel user
gets $2/day". Medium. Depends on nothing; extends the existing policy budget.

### R11. A semantic browser toolset over the box's own browser
Pixel-driving the desktop works for any GUI app, but for the browser it is the slow
and unreliable path: locating a button in a screenshot misreads coordinates, and every
step costs an image. The reference shape is a page-level toolset — navigate, a
structured snapshot with element refs, click/type/fill by ref, tabs, screenshot —
attached over CDP to **the same visible Chromium the desktop shows**, so semantic
automation, the person's view and the persistent logins are one browser, not two.
Medium-large; pairs with the fork/delegation work (browser snapshots are exactly the
context traffic an isolated sub-conversation should eat). Rider, cheap and immediate:
block UI-automation binaries (`xdotool`, `wmctrl`, `pyautogui`, `playwright`) in the
shell tool — an agent that finds them routes around the audited `computer` tool and
takes the screenshot pipeline blind with it. When it lands, the final-screenshot gate
grows to include the browser tools.

### R13. Shell jobs: background, stream, and await
A command that runs past the timeout is lost, not slow — a dev server, a large
build, a long download are a category of task the box simply cannot do. The
reference shape: `block_until_ms` auto-backgrounds the call, output streams to a
terminal file the agent can read incrementally, and an `await` tool blocks on a
regex over that output. Needs a job field on the exec protocol and per-job state in
boxd. Medium. Rider, nearly free: enrich the box toolchain (`ripgrep`, `gh`, `tmux`,
`uv`) — the agent's own productivity multiplies, and tmux is a substrate jobs can
fall back to.

### R16. Webhook and event triggers
Scheduled skills cover "every morning"; nothing covers "when the build breaks" or
"when an external system pings". An HTTP ingress whose calls arrive as inbound
messages — identity-bound, scoped, through the same gate as every other channel —
turns automations from cron-only into event-driven, and is the entry ticket for the
enterprise direction. Medium; design the identity story first, because a webhook is
a credential.

### R17. A project tier of memory
Memory is self and team today; the third natural boundary is the scope. What was
learned inside a project stays with it, is injected for whoever works there, and
dies with it — the Scope object already exists as that boundary, so this is memory's
third growth rather than a new subsystem. Medium.

### R18. Finish the honest box
Three half-truths the box surface still tells: uploads can land half-written (no
`.part` + rename), health carries a version field that nothing compares (a box on an
older image should say so), and failures arrive as one undifferentiated result when
refused / timed-out / crashed each have a different remedy. Small each, medium
together — the unfinished half of the R-05 lineage.

---

## Tier 3 — large, or needs a design decision first

### R7. Secrets an agent reads land in the transcript in clear (S-1)
The heaviest security item, and heavier now that backups copy the transcript. An agent
that reads a `.env` or a key puts it in its own history in clear. Needs a redaction
design that does not also destroy legitimate content — the hard part is deciding what a
secret looks like without a false positive eating a real answer. Large; design first.

### R8. Per-step checkpoint and resume of side effects
The oldest deferral. Today a turn interrupted mid-batch resumes by re-reading its
transcript and telling the model "the outcome is unknown — look before redoing"; safe
reads now re-run automatically (shipped), but a side-effecting call whose result was
never written is still declared unknown rather than completed. The reference design is
a write-ahead intent record per effect plus provisioned ids (pi harness-v2 §5–7). Large.
The current coarse-boundary approach is honest and tested; this is an upgrade, not a
fix, which is why it has waited.

### R9. Auto-review as a state machine
Two products build a confirm → reviewer → runner → persisted-state machine for
automatic review. The mechanism is clear; the blocker is unchanged — the review
*criteria* must be designed, and no external structure designs them. Medium once the
criteria exist; do not start before they do.

### R10. Gateway hardening for real multi-tenant (S-2, S-3, S-4, S-6)
A batch, only when multi-tenant SaaS is actually the goal: TLS on the gateway (S-2), a
real identity provider instead of a token list (S-3), the box not trusting gateway
identity headers blindly (S-4), and the control-plane key not sitting beside its
database (S-6). Large. The current single-operator model does not need these, and doing
them speculatively is the over-engineering the whole project avoids.

### R21. Agent and skill bundles: export and import
A team's agent (profile, skills, scope shape — never its memories or secrets) packaged
as a file another installation can import. The sharing unit people actually want, and
the seed of any future gallery. Deliberately after the delegation preset work: the
preset's packaging face is this feature's foundation, and building the bundle format
before a second real installation exists would be designing for an audience of zero.
Large-ish; design the boundary (what travels, what never does) first.

---

## Explicitly not now, with the reason

- **Box-side credential delivery.** Weakens the vault's one strong property (a secret
  never enters the box). The host-side path is the honest one.
- **Trash instead of delete.** Three products route deletes through a trash; the box's
  exposure is `/home/box/work`, excluded from backups, and a real implementation
  (intercepting `/bin/rm`) is not cheap while a half-measure (an alias) is decoration.
- **Signed events / federation.** No sovereignty or cross-system-audit requirement has
  appeared. Nothing forecloses it later.
- **The five review deferrals** (docs/07-review.md): OCC non-atomic cross-agent,
  allocation credential split, optimistic recording start, checked-audit fail-open for
  plain allows, wall-clock lease. Each is an edge case documented with its reason,
  behind bigger rocks.
- **Voice, mobile-native, code-mode sandbox, embeddings/CKG retrieval.** Product scale
  or shape the box does not have; the documented retrieval trigger has not fired.
- **Image generation, video-review subagents, a WebAuthn bridge.** Real in the
  reference, but each is a product-shape decision waiting for a user who asks, not an
  architecture gap; recorded so they stop being rediscovered.
