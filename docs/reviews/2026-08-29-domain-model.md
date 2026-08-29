# Six review rounds: the domain model, v1 → v6 (2026-08-28/29)

Two reviewers, alternating: Grok (interactive session on this repo) and Codex
(adversarial-review jobs). Written up per this repo's rule — findings that stay
only in a transcript get rediscovered — and condensed: each round records the
verdict, the findings that changed the document, and the disposition. The full
texts live in the Grok session and the Codex jobs named below.

The document under review is `docs/22-domain-model.md`. The prompting request was
concrete: a second Feishu bot beside the existing one, with its own agent.

---

## Round 1 — Grok on v1 (channel entity, Channel n..n Agent, audience invariant)

Verdict: direction right, 5 fatal-class findings.

1. The §3 audience-containment invariant compared two sets nothing can enumerate
   (`group` is free text; membership lives in Feishu/DingTalk). **Accepted; the
   invariant died here and never came back in checkable form.**
2. Writing a third answer to docs/18's open `SendToAgent` question while claiming
   not to touch it. **Accepted.**
3. Channel↔Agent n..n grants more than the motivating request needs, and the
   surplus is exactly the cross-box oracle. Proposed Channel n..1 Box. **Accepted
   in v3; became load-bearing.**
4. "Company Feishu" had no entity; second door vs second box unanswered.
   **Superseded by the owner's rule (round 3 disposition): there is no
   enterprise/personal distinction to encode — only same-authority (a door) vs
   isolated-authority (a box).**
5. Channel `name` as identity namespace = the `boxName`-is-a-string hole.
   **Accepted; stable ids in v3, incarnations by v5.**

Also from this round, kept: new same-type apps mint new identities (measured:
the 2026-08-29 DingTalk enterprise switch knocked a linked driver); `agents`
defaulting to "all" is the wrong default for a new door; secrets in
`config.channels` is a docs/15 decision; scope is not orthogonal.

## Round 2 — Codex on v2 (authority moved onto the door binding)

Job `review-mte3cpie-leh7mg`. Verdict: do not ship; 5 high.

1. Door-binding-as-grant cannot express private-box ownership; roles distinguish
   viewing from driving; box needs owner/membership, door is routing only.
   **Accepted — became the two-gate principle.**
2. Immutable `boxName` freezes a stale pointer to a reusable name. **Accepted —
   opaque box ids, retirement on destroy.**
3. "SendToAgent is the only remaining cross-box path" contradicted by the
   document's own exceptions (harness initiators, global scopes). **Accepted —
   claims downgraded to narrowing, holes named.**
4. Stable channel id decorative while mutable name mints identities. **Accepted —
   ids mint identities; name demoted to display alias.**
5. A second door falsifies the free-text audience label. **Accepted — label
   derived, in the end, from the members set.**

## Round 3 — owner decisions (between v2 and v4)

Not a review, but the round that settled the model. Three rulings:

- **Authority lives at the box, once.** No layer above the box carries its own
  permission set.
- **Agents are uniform inside a box.** Division of labour may differ; allowed
  reach may not.
- **"企业" was a placeholder, not a concept.** Any new door raises exactly one
  question: same authority as an existing box, or isolated. Same → second door;
  isolated → by definition, another box.
- **A box corresponds to a set of users.** One member = exclusive; everyone =
  shared; a subset = shared with that subset. Private/shared are cardinality
  descriptions, not types; admission is one check, `principal ∈ members`.

## Round 4 — Codex on v3, Grok on v3 (convergent)

Codex job `review-mte4nkw2-1w88y9` (5 high); Grok in-session (6 high, 8 medium).
The overlap, all accepted into v4:

1. Shared-box admission was still installation-wide `mayDrive`; binding a door
   was still effectively the grant (Grok #2 ≡ Codex #1). → `members` on the box;
   the enumerated-subset gap stated in §2 as undeliverable in items 1–4.
2. Generation was a config field no identity string carried; secret rotation and
   namespace replacement conflated (Grok #3 ≡ Codex #2). → incarnation semantics.
3. Per-agent authority planes live in the running system: `RunOnHost` authorizes
   off the calling agent's mutable `scopeId`; visibility; chat scope (Grok #5/中7
   ≡ Codex #3). → retirement list with the live violations named.
4. Label vs admission mismatch: web/MCP/invite admit people no door saw (Grok 中2
   ≡ Codex #4). → label derived from members, doors as illustration only.
5. docs/18 skew: it mandates `boxName` and `config.boxes[name]`, and its
   `classifyBox` is URL-keyed in attached deployments (Grok 中1 ≡ Codex #5).
   → docs/22 declared normative; docs/18 amendment required in-change.

Grok alone, both accepted: the two-gate restatement (installation role *is* a
layer, so say it is the outer gate rather than pretending there is only one);
bind on a single-member box must link to the member, never mint a Principal.
Grok's "1–4 deliver a second door, same workers — not the original request" was
re-read under the round-3 ruling: that is the definition of same-authority, and
the sentence now says so plainly.

## Round 5 — Codex on v4

Job `review-mte53dc7-bguklh`. Verdict: conceptually intact, 4 spec-level high.
All accepted into v5:

1. Incarnation absent from durable chat references (schedules, digests,
   conversations persist raw chatKeys; delivery picks adapters by prefix). →
   incarnation-stamped ChatRefs, fail-closed, dead letters reported.
2. Bind/relink not linearized (pending knocks carry plain strings; last-write-
   wins duplicates). → `(channelId, incarnation, vendorSubject)` uniqueness;
   observed-incarnation CAS through knock/invite/approval/bind.
3. Grant inventory incomplete (web auth denies on `visibility`/`ownerUserId`
   today; vault accepts `agent:`/`principal:`/`*`). → inventory by enumeration,
   ambiguity fails closed, per-caller acceptance matrix.
4. Items 1–4 required the `boxId` item 5 postponed. → the grandfathered box id,
   backfill, `defaultAgent` validation and the docs/18 amendment moved into
   item 1.

## Round 6 — Codex on v5

Job `review-mte5h8io-z6fewe`. Verdict: ordering fix confirmed closed; 5
implementation-level high. All accepted into v6:

1. Delivery/transcript records omitted from the ChatRef inventory — restart
   recovery sends an old tenant's owed answer through a raw chatKey. → item 2 is
   one atomic migration; crash→replacement→recovery is a named test.
2. Identity-link migration must land *with* incarnations, not after; the bulk
   principal editor writes identities outside knock/bind. → backfill, storage-
   level uniqueness, CAS on every writer, replacement disabled until done.
3. PolicyGate session/standing approvals hash the agent id — agent-scoped
   authority the inventory missed. → decided: reusable grants are box-subject;
   `once` is consent, not authority; policy decisions join the test matrix.
4. Per-channel doc readers make the door an authority selector (each app reads
   only its own granted documents). → document reading is a box capability.
5. Caller-less work (schedules, restart, audit) has no principal to check. →
   created by an admitted principal, admitted later as the box's own, creator
   revalidated at fire time; gone → reported dead letter.

---

## Where this landed

The model core — two gates, members set, doors route, workers uniform — was not
challenged after round 4. Rounds 5 and 6 produced implementation obligations,
now encoded in docs/22 §7's build items, chiefly: item 1 (box identity first),
item 2 (atomic namespace-safety migration), item 6 (authorization by inventory
with a full acceptance matrix). The document loop was closed here by decision:
remaining findings are the kind that are verified as tests against real diffs,
not as prose against prose.
