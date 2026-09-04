# Multiuser: doors as login, the org as the roster, boxes as the boundary

Status: **charter + design, first version, 2026-09-03.** This is the workstream
the owner's 2026-08-29 ruling was waiting for: docs/22 §7 items 5–6 and docs/18
steps 4–8 are deferred *until a multiuser mechanism exists* — this document is
that mechanism. Written against the tree as of the 2026-09-03 release (1045+
tests, multi-box shipped per docs/30, channel records and incarnations live per
docs/22 items 1–4).

## 0. The four asks, answered in one model

1. **Login via DingTalk / Feishu (Slack later).** The door's app *is* the
   identity provider: the same credentials that receive messages perform the
   OAuth handshake for the web. A person is one Principal whether they arrive
   by chat or by browser — the vendor subject the door mints and the one OAuth
   returns are the same string.
2. **Org structure synced, RBAC on top.** The door's contact APIs become a
   directory: a department tree plus people. The directory never *is* the
   access-control list (it is the vendor's, it changes without an event here —
   docs/22 §5's rule applied to a new source); it *feeds* the two gates that
   already exist.
3. **Resources protected by box membership.** Nothing new in the model — this
   is docs/22 items 5–6 built: `members` enforced at one admission check, grant
   subjects migrated to the box, the enumerated subset finally honest.
4. **References.** QM (yc-software), CloudflareOS, and Multica were read at
   source level; §1 records what each was paid for and what was declined.

## 1. What the references taught, decided one by one

| From | Adopted | Declined, and why |
| --- | --- | --- |
| **QM** | Directory sync with **deactivation on absence** (`recordDirectorySync(removedIds, presentIds)`) — the offboarding story writes itself. **Scopes as addressable strings** (`personal/team/org`) — matches our `ScopeId` seam. **Org-floor security posture that scopes may only tighten** (`dangerous/auto/strict`) — composes with PolicyGate. **Per-person + org budgets** (`BUDGET_USD_PER_WINDOW`) — the relay is our enforcement point (S-5). Secrets shared as **once/standing grants** — our PolicyGate already has exactly this shape. | Their five scope kinds. We have two gates and no third layer (docs/22 §0); a `channel` scope with its own read rules is the door-authority bug in different clothes. |
| **CloudflareOS** | **The verified account key**: any provider yielding the same identity resolves to the same account — we already do this with vendor subjects; the lesson is to keep it when Slack arrives. **Admin allowlist lives in config, not in a session-writable table** ("can't be changed by a compromised admin session"). **Credentials never travel to the agent** — the vault + relay + MCP-face line, reaffirmed. | Capability graph with share links (`build`/`use` roles computed over user + link edges). Our unit of authority is the box, and a share link is a door nobody provisioned. |
| **Multica** | **Role read from the store, cache only membership existence** — honest caching. **Blocked access must not leak existence** of a private resource (their `admission.go` wording) — this is docs/18's "invisible to everyone else", made mechanical for listings. **Last-admin guard, non-admins cannot modify admins** — shipped shape at our control plane already. **Polymorphic actor** (`member \| agent \| system`) on every attribution row. | Their workspace = the only boundary. The box is ours, and it is *hardware-adjacent* (logins, desktops); a workspace cannot promise what a box can. |

The one structural disagreement among them is instructive: Multica puts the
team first (workspace, then agents in it), CloudflareOS puts the person first
(email-keyed, no org at all), QM derives everything from a synced directory.
We keep the box first — the 2026-08-29 ruling — and let the directory *derive
the member sets*, which is the one thing none of them needed and we do.

## 2. Login: the door authenticates the browser

**The channel app is the OAuth client.** A `ChannelRecord` gains
`login?: { enabled: true }` — the credentials are the door's own (a docs/15
decision re-opened only if a tenant objects to one app doing both).

- **Feishu**: `/open-apis/authen/v1/index?app_id=…` → code →
  `authen/v1/oidc/access_token` → `{ open_id, union_id, name, department_ids }`.
  `open_id` is the vendor subject the door already mints (`feishu:<open_id>`).
- **DingTalk**: `login.dingtalk.com/oauth2/auth?client_id=…&prompt=login` →
  code → `oauth2/userAccessToken` → `{ unionId, nick }`; the same `unionId`
  the message events carry.
- **Slack, later**: Sign in with Slack (OIDC) — arrives as a third adapter
  behind the same interface, not a new model.

**Session.** The machinery already exists — `session.ts` redeems an invite
code into a Principal and issues the signed cookie (HMAC key derived from the
UI token, 30-day age, role read from the roster on every request, roster
removal demoting at next use, token rotation killing every session at once).
IM login adds a **second redemption path into the same Principal**: OAuth
returns the vendor subject the door mints, the resolver finds or creates the
Principal, the cookie carries it. Invite codes stay — they are the way in for
a person no door has seen. Multica's rule (identity in the cookie, privilege
from the store) is already the installation's behavior and is kept; the
control plane keeps its own role-in-cookie trade (docs/09 §10), unchanged.

**What this does to the open security item.** "The web has no UI token —
anything reaching :7777 drives the agents" is closed for installations with a
login-enabled door: unauthenticated reach gets a login page, not the state
API. The operator token survives for loopback and bootstrap (auth.ts's
existing rule: no token allowed only on loopback).

**Admission stays one check.** docs/18 step 4's "one session resolver" gains
its data: page, API and the RFB upgrade all resolve to
`{principal, role}` and then run the same `principal ∈ box.members` test the
doors run. A session never carries box authority of its own.

## 3. The directory: synced, derived, never authoritative

**Store.** Per channel, `directory.json` beside the channel records:
departments `{vendorId, name, parentVendorId}` and people
`{vendorSubject, name, departmentVendorIds, title, active, seenAt}`. Sync is
the door adapter's job (`syncDirectory()` on the Feishu/DingTalk contact
APIs), scheduled like every other periodic, and manually triggerable from the
admin surface.

**The honest scope rule.** A Feishu app sees the users its contact scope
grants — sometimes the whole tenant, sometimes only app-visible members. The
directory syncs **what the app can see**, records which case it is, and
absence-deactivation runs only under full visibility. Partial visibility +
silent deactivation = someone loses their box because the app's visibility
narrowed. QM's `recordDirectorySync` boundary, restated as our rule.

**Directory → Principals.** A directory person becomes a Principal **at first
authentication** (login or first message), linked by the existing
knock/bind CAS under the current incarnation. A directory row with no
Principal is a record, not a user — no sessions, no spend, nothing to audit.

**Directory → membership.** A box may bind `members` three ways:

```
{ kind: "everyone" }                                          — today's box
{ kind: "listed", principalIds: […] }                         — the manual set
{ kind: "department", channelId, departmentVendorId }         — the subtree, resolved live
```

The third is the amendment this workstream makes to docs/22 §1 (which allowed
only `everyone | set of ids`): an enumerated set of people goes stale the day
the vendor moves someone; a **department binding resolved at admission time**
cannot. Membership is computed against the latest synced tree; a tree older
than the sync interval is stale by construction and the admin surface says
so. docs/22 §6's amendment rule applies: that file is updated in the same
change that implements this.

**Departure.** The sync's absence-list deactivates the directory person; the
next admission check fails; live sessions for that principal are killed;
caller-less work (schedules, digests) revalidates its creator and produces
docs/22 §2's reported dead letters, never silent runs. QM's shape, our
mechanisms.

## 4. RBAC: the two gates, fed by the org

No third layer is created (docs/22 §0 stands):

- **Outer gate — `Principal.role`:** `viewer | driver | admin`, unchanged as
  concepts. The directory maps *in*, roles do not map *out*: a new
  authentication from the directory enters as the installation's configured
  default role (`driver` recommended — a colleague who cannot prompt an agent
  has no product). Admins are **config-listed** (CloudflareOS's rule: the
  admin list is not writable from a session it protects); the first admin is
  the operator bootstrap.
- **Inner gate — box membership:** §3's three bindings; the same admission
  check at doors, web, RFB, and the caller-less revalidation.

Resource-by-resource, what protects what:

| Resource | Protection | Work |
| --- | --- | --- |
| Agents | `boxId` (immutable, shipped) + admission; cross-box `SendToAgent` **refused by default** (docs/18 §5's open decision, decided here: the oracle is not shippable by accident; an explicit per-target allow can come later) | the refusal + the wake line naming the box (docs/30 Stage C) |
| Secrets / vault | grants migrate to **box subject** (docs/22 item 6's inventory: vault rows, `scopeId`, chat-scope bindings, PolicyGate session/standing; `once` stays consent) | the migration, fail-closed on ambiguity |
| Transcripts, files, tasks, memory | box-scoped already by construction; listing filters by membership and **does not reveal existence** of boxes the caller is not in (Multica's rule, docs/18's ruling) | the listing filters; shared-memory box filter (docs/18 §5's missing piece) |
| Desktop / VNC | the one session resolver + membership | the RFB resolver |
| Spend | per-principal and per-box ceilings enforced at the relay (S-5's designated point) | meters exist; the refuse-on-ceiling is the add |
| Audit | attribution rows carry the principal everywhere (docs/09 §5 shipped this at the control plane; installation transcripts record the resolved principal) | verify every writer |

## 5. Boxes: personal and department, at last

**Personal box.** `members = { kind: "listed", principalIds: [one] }` plus
`visibility: "private"` semantics from docs/18: admission is the check,
**invisibility is the listing filter** (stronger, per the owner's ruling).
Provisioned by policy: `personalBox: "on-first-login" | "on-demand" |
"off"` — recommended `on-demand` for the first cut (an operator accepts the
cost of a container knowingly), `on-first-login` when the org is ready to pay
for everyone. The docs/18 §7 trust statement renders on its surfaces; the
takeover state (docs/18 §6 step 6) and revoke-and-wipe (step 8) are that
document's work, ordered here as consumers of this one's admission check.

**Department box.** `members = { kind: "department", … }` (§3). Doors bind to
it exactly as to any box (`defaultAgent` must be one of its agents — shipped
validation). Its label derives from the resolved set, never from the vendor's
group membership (docs/22 §5, verbatim applied).

**The shared box stays honest.** `everyone` remains a first-class binding —
today's box does not become a legacy case; it is one of three.

## 6. Onboarding, as flows

**The org admin (once per installation).**

1. Doors exist already (settings console). Admin flips **login** on a door
   and grants its contact scopes — the console says what visibility the app
   achieved and what that means for deactivation (§3).
2. First sync runs; the admin surface shows the tree with counts and the
   staleness line.
3. Admin binds boxes: leaves today's shared box on `everyone` or narrows it
   to a department; creates department boxes; sets personal-box policy and
   the default role.
4. Admin lists installation admins (config), announces the URL and the bot.

**The employee, first contact.**

- *By chat*: DMs the bot. Vendor already authenticated them; the subject is
  in the directory under the current incarnation → **auto-link** to the
  directory's principal (the knock-approval ceremony was for a world without
  a directory). Unknown subject → knock as today. First run opens with the
  shipped `[first run]` hello.
- *By web*: opens the URL → DingTalk/Feishu login → the same principal, the
  boxes they are a member of, nothing else visible (§4's no-existence-leak).

**Offboarding** is §3's departure flow plus: personal box of the departed →
operator decision (revoke-and-wipe is docs/18 §4's, when step 8 exists);
department boxes self-heal at the next sync + admission check.

## 7. User stories

Acceptance is measured, not believed (workbuddy's rule). Format:
*story / acceptance*.

**Access**

- **U1 — login** As an employee I open the web URL and sign in with the IM
  app I already have. *Accept:* Feishu and DingTalk each complete the
  handshake; the session resolves to the same Principal my chat messages do
  (one row, two identities); wrong-app users are refused; session dies on
  logout and on deactivation.
- **U2 — first message auto-link** As a directory member I DM the bot and am
  talking to an agent without anyone approving me. *Accept:* subject in
  directory + current incarnation → link, no pending row; subject absent from
  directory → knock, as today; the CAS still rejects a stale-incarnation
  approval (existing tests keep passing).
- **U3 — invisible box** As a non-member I must not learn a private box
  exists. *Accept:* state API, box list, roster verb, agent `@`-resolution,
  and 404-vs-403 wording leak nothing; a member's view shows it (docs/18's
  ruling made mechanical).

**RBAC**

- **U4 — role ceiling** As a viewer I can watch but not drive. *Accept:* read
  routes 200, prompt/abort/takeover 403 naming the role needed (docs/09 §10's
  refusal rule), each refusal audited; a driver promoted mid-session needs no
  re-login (role from the store, §2).
- **U5 — admin list is config** As a compromised admin session I cannot make
  myself admin. *Accept:* role mutations on admins are config-file acts;
  attempts from sessions are refused and audited; last-admin guard holds.
- **U6 — box admission is one check** As a member of department box D I reach
  its agents from web and from my door; as a non-member I do not, from any
  surface. *Accept:* the docs/22 item-6 matrix — every agent in a box yields
  identical drive/secret/policy decisions for every admitted caller across
  channel, web, MCP, VNC; caller-less initiators revalidate.

**Org sync**

- **U7 — sync the tree** As an admin I see the org as the vendor holds it.
  *Accept:* departments and people land with counts; a rename in the vendor
  appears on the next sync; partial-visibility mode is labelled and disables
  absence-deactivation (§3).
- **U8 — membership follows the org** As a person transferred between
  departments I gain and lose boxes without anyone editing lists.
  *Accept:* after sync + next admission, the new department box admits me,
  the old refuses, my schedules in the old box become reported dead letters
  (docs/22 §2), and neither happened silently.
- **U9 — departure** As an admin, when someone leaves the vendor org their
  access ends here too. *Accept:* absence-deactivation kills sessions at next
  use, doors refuse re-link, caller-less work dead-letters; personal box
  handling surfaces as an operator decision, not an automatic act.

**Boxes**

- **U10 — my own box** As an employee I can have a box only I can see.
  *Accept:* on-demand provisioning from the console; docs/18's trust label on
  its surfaces; my agents, my logins, no colleague listing it (U3).
- **U11 — department box** As a department head I get a box my department
  shares. *Accept:* binding by department; label derives from the resolved
  set; door on it routes to its `defaultAgent`; a door from it cannot reach
  another box's agents.
- **U12 — spend ceiling** As an admin I cap what any person or box can spend.
  *Accept:* relay refuses past the ceiling (S-5's point); the in-box gate
  explains it to the agent; usage rows attribute per principal.

## 8. Build items, ordered

1. **Login on a door** (§2): the OAuth face on Feishu and DingTalk, sessions,
   the one resolver, login-page-instead-of-state for anonymous reach. Nothing
   else moves; `everyone` boxes behave identically to today for a logged-in
   principal. *U1, U4's read paths.*
2. **Directory sync** (§3): adapters, the store, the admin tree, the honest
   scope rule, auto-link on known subjects. *U2, U7.*
3. **Membership enforced** (docs/22 item 5): the three bindings, admission at
   every surface, the no-leak listings, shared-memory box filter, the docs/22
   §1 amendment. *U3, U6, U11.*
4. **Grants to the box** (docs/22 item 6): the full inventory migration,
   fail-closed; cross-box `SendToAgent` refused by default. *U6.*
5. **Personal and department boxes** (§5): provisioning policy, invisibility,
   labels; doors bound to them. *U10, U11.*
6. **Departure and ceilings** (§3/§4): deactivation cascade, dead letters,
   relay refuse-on-ceiling. *U8, U9, U12.*

Each stage leaves the tree green and the product honest about what is and is
not enforced — the docs/18 §6 lesson: no stage ships a label its mechanism
does not back (U3's invisibility arrives *with* the filter, not before it).

## 9. Security notes

- This workstream *closes* the pre-launch "web has no UI token" item for
  door-login installations and *keeps* S-3 (control-plane password list)
  open — the control plane is out of scope here (docs/22 §6's two levels,
  unchanged).
- The directory is vendor data and gets no more trust than chatKeys do: it is
  re-synced, never replayed as authority beyond the staleness line.
- Login flow tokens (OAuth code, access token) are secrets in the record
  sense of docs/15 — they live in memory/config-env, never in transcripts.

## 10. Open, for the owner

1. **First vendor for login**: Feishu (two live doors, richer contact API) —
   confirmed?
2. **Default role for directory members**: `driver` (recommended) or
   `viewer`-until-promoted?
3. **Personal-box policy at rollout**: `on-demand` (recommended) vs
   `on-first-login` for everyone.
4. **`on-first-login` cost model**: one container per employee is real money
   — is the personal box Docker-shaped at scale, or does an
   `attached`-to-a-cheap-host shape come first (docs/30's provisioners
   already allow it)?
5. **Cross-box `SendToAgent`**: refused by default as designed here — any
   early need for an explicit allow, or does the refusal stand until asked
   for?
