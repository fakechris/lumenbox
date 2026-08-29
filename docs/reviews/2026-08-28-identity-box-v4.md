# Fourth adversarial review: the identity box v4 (2026-08-28)

Two reviewers, run against docs/18 v4 after steps 1–3 were built. **Written up
2026-08-29 from the 2026-08-28 handoff's §4 record** — the session that received the
full texts ended before this file was written, which is itself the failure mode this
directory exists to prevent; the handoff's capture of the load-bearing findings is
what survives, and it is enough to act on. Dispositions added as of 2026-08-29.

## Claim-verification review: 4 fatal, 9 major

1. **FATAL — the class is keyed by the wrong thing in the deployment that matters.**
   `classifyBox` is called with `provisioner.boxName`, which for an attached
   provisioner is the **URL**. Every in-box orchestrator attaches to
   `http://127.0.0.1:1337`, so every `--with-host` box on every host looks up
   `config.boxes["http://127.0.0.1:1337"]`: the operator's entries are dead config
   there, and the first box anyone marked private would mark all of them.
   **Disposition: fixed 2026-08-29** — a URL never keys the lookup; it falls back to
   the roster's box record name (`src/box/access.ts`, test pinned). The real fix is
   docs/22's migration to box ids with a members set; this makes the label true
   until that lands.
2. **FATAL — §5's shared-memory filter would be installed in the wrong place.**
   `readSharedMemory()` has two more callers besides the prompt assembly: `Recall`
   with `shared: true` and `RememberFact`, both model-facing. A filter at the prompt
   leaves an agent able to query across boxes directly.
   **Disposition: open** — recorded in docs/18 §5; the filter belongs on the pool,
   at every caller, and lands with docs/22 item 5.
3. **FATAL — schedules are keyed by skill slug, not agent id**, so "every store
   keyed by agent id is thereby keyed by box" does not cover them; `defaultAgent()`
   resolves to the alphabetically first agent in the installation.
   **Disposition: open** — the caller-less-initiator rule in docs/22 §2 is the
   design answer; unbuilt. The alphabetical default is dead on the channel path
   (per-door defaultAgent) and still live for schedules.
4. **FATAL — the roster, task board and claims are unfiltered.** Every agent's name,
   id and description render into every prompt; `Tasks list` has no assignee
   filter; claims are keyed by work description.
   **Disposition: open** — box-scoped filtering is docs/22 item 5 work. The
   channel-facing roster verb (2026-08-29) lists by door, which is presentation,
   not the prompt-side fix.
5. **MAJOR — the noVNC "Take over" tab carries no badge and no notice**, and it is
   the surface a person actually types a password into. **Disposition: open.**
6. **MAJOR — `docker/box/hostd.mjs` is a 7.4 MB untracked build artifact**
   containing neither `classifyBox` nor the notice; a `--with-host` box running it
   shows no badge until rebuilt. "Steps 1–3 are done" was true of `src/`, not of a
   running box. **Disposition: open — rebuild and track the artifact's provenance.**
7. **MINOR — `web/server.ts` builds the provisioner outside any `try`**, so the new
   token refusal kills `startWebServer` instead of degrading to "no box".
   **Disposition: open.**

The reviewer verified as **true**: boxd upgrade authentication, per-container
volumes, no `--privileged`, the agent prompt paragraph on both vision paths, and
that no path creates an agent outside `registry.create`.

## Design review: 7 fatal, 5 major, 1 minor

1. **The takeover fence defends a threat §7 defines out of existence.** §3 accepts
   "an agent that deliberately runs its own reader" as residual; §7 says an injected
   agent reaches the box. What remains is an *accident guard*, and calling it
   "fail-closed" borrows authority. **Disposition: accepted — docs/18 §3 must carry
   the honest name when step 6 is built.**
2. **The harness is the leak, not the agent.** `HARNESS_ACTORS`, `mcp:<principal>`
   through the singleton box client, and inbound routing via `registry.list()[0]`
   are initiators with no agent identity and therefore no box. **Disposition:
   partially closed** — inbound channel routing now has per-door defaults; the rest
   is the standing hole docs/22 §6 names.
3. **The shared label names a set the system cannot enumerate** — `group` is free
   text, membership lives in Feishu/DingTalk. **Disposition: superseded by
   docs/22** — the label derives from the box's member set, free text may decorate
   and never narrow.
4. **The class is on the container; the authority is not.** `RunOnHost` executes on
   the operator's machine; vault grants name `agent:<id>` — whichever person is
   driving it; scopes are installation-global and `scopeId` is update-mutable. And
   §7's claim that use-without-seeing "is not offered" is **false**: the vault plus
   `RunOnHost` is exactly that, shipped. **Disposition: the false sentence is
   corrected in docs/18 §7; the grant migration is docs/22 item 6.**
5. **Revoke-and-wipe is unimplementable as written.** The host backup is one
   recursive copy of all of `~/.agentbox` — one owner's archive cannot be handed
   over or deleted separately — and `BoxManager.down({remove:true})` does not pass
   `-v`, so volumes survive. **Disposition: open; docs/18 §4 now says so.**
6. **`boxName` is a string, not an identity** — destroy and recreate under the same
   name and the new box inherits the old world. **Disposition: closed by design and
   partially by code** — opaque box ids exist (`box.json`, 2026-08-29); the class
   and store migrations onto them are docs/22 items 5–6.
7. **`4 → 5 → 7` produces a second container, not a private box** — what makes it
   private is 6, 8, the memory filter and the `SendToAgent` decision, all deferred
   by that sentence. **Disposition: accepted — docs/22 §7 now splits "a second
   door" from "isolated authority" explicitly.**

**The thing the document was avoiding**, per the reviewer: the cheapest resolution
may already be shipped — if credentials that matter live in the vault and reach
their target through the host, the private box's headline use case largely
evaporates, and the comparison was never run. Relatedly: **docs/18 has no user** —
nobody has said who asked for a private box or what they were trying to do.
**Disposition: still true, and now the explicit §7-item-5/6 gate: the product
decision belongs to a person, before the private-box machinery is built.**

**Genuine closures that round**, strictly counted: the `AskUser` correction, and
the shared-box retraction-plus-label. Two rows of §2's table were *reworded*, not
closed — `runArgs` still defeats both "invariant" rows.
