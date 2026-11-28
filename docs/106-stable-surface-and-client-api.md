<!-- doc: 106-stable-surface-and-client-api
     title: What stays stable: release lines, the stable list, remote access, and the client API
     family: spec
     status: current
     domain: compatibility
     updated: 2026-11-28
-->
# What stays stable: release lines, the stable list, remote access, and the client API

Until 0.4.9 everything outside our own app was internal by default, and nothing said so. That is
fine for one person on one machine. It is not fine once somebody else builds on LumenBox: runs it
for a company, shows its work board to their own customers, or opens it from a phone. This
document says what such a party may depend on, how we keep it true, and in what order it is built.

**Nothing here is built yet unless §8 says so.** Each section is the target; §8 is the state.

## 1. Three tiers, and every interface is in exactly one

| Tier | Meaning | Who may depend on it |
|---|---|---|
| **Stable** | Changes only by addition inside a release line; removal only across lines, after a deprecation | Anyone |
| **Preview** | Shipped and documented, may change in any release, listed as preview where it is discovered | Anyone who accepts that |
| **Internal** | No promise at all | Our own app and daemons only |

An interface is Stable only if §3 names it, and Preview only if it is listed where it is
discovered (`meta.preview` for the client API, the release notes for anything else). Everything
else is Internal. That sentence is the rule that stops a promise being made by accident.

## 2. Release lines

- **main** stays as it is: 0.N.z, moving fast. Its only promise is the one every release note has
  made: data from the previous release loads.
- A **stable line** is a branch `stable/0.N`, cut from a main release that passed the acceptance
  run, tagged `0.N.z`. It receives fixes only: security, data loss, crashes, and a Stable
  interface that stopped working. No features, no prompt or behaviour tuning.
- A stable line is maintained for **12 months** from its cut. When the next one is cut is decided
  case by case; the two overlap for at least three months, so there is always time to move.
- Every promise in this document is made for stable lines. The version stays 0.N: a new N is a
  new line. 1.0 is not needed to make these promises and is not implied by them.

## 3. The stable list

| # | Interface | Inside a line | Across lines | Kept true by |
|---|---|---|---|---|
| S1 | Data in the installation's home (profiles, conversations, memory, work, ledgers, vault, credentials) | Loads unchanged | Upgrades in place from the previous line, automatically, after a backup. Downgrade is refused with a message, never attempted | §6 home format + upgrade fixture |
| S2 | Box volumes (work, browser profile) | Kept across update and rollback | Same | Existing update path (docs/12) + fixture |
| S3 | `config.json` keys, and the environment variables `agentbox help` lists | Not renamed, removed or re-meant | A removed key is still read for one line and reported at start | Surface snapshot (§7) |
| S4 | CLI commands for running an installation: `box up/down/status/upgrade/rollback/logs/attach/detach/list`, `backup`, `web`, `chat`, `agents`, `agent new`, `template import/share/download`, `mcp`, `usage`, `audit export`, `control up/status` | Names, flags, exit status. Printed text is not a contract; files written by `audit export` are | One line of warning before removal | Surface snapshot |
| S5 | The MCP side door (`/mcp`): its tools, terminal states, idempotency key, capability map | Additions only | Removal after one line of deprecation | `mcp-contract.ts` + snapshot |
| S6 | Webhook routines (`POST /hooks/<id>`): authentication headers, `?wait`, status codes | Unchanged | Same | Snapshot |
| S7 | Files a person writes: template format `lumenbox-template/1`, skill frontmatter, rule files | A file that loaded keeps loading and meaning the same | A new template format number; the old one still imports | Format check + snapshot |
| S8 | App and box image of the same line work together in any combination of `z` | Yes | Upgraded together | `BOXD_PROTOCOL` check (docs/12 R3) |
| S9 | The Kubernetes manifests in `deploy/kubernetes/`: object names, labels, environment | Unchanged | Changes listed with the steps to apply them | Snapshot |
| **S10** | **The client API, `/api/v1`** (§4) | Additions only | `/api/v1` keeps working for at least one full line after `/api/v2` exists | OpenAPI document + contract tests |

**Internal, said out loud:** every `/api/*` route that is not under `/api/v1`; the page; the
protocol between the host and the box daemon and `/etc/lumenbox/contract.json`; prompts, tool
definitions, and what an agent or a model does; undocumented environment variables; CLI text
output. **Third-party, pinned per line and not promised:** delegated engines, model providers,
Feishu / DingTalk / Telegram.

A commercial build carries one delegated engine (pi). The others are installed by the operator
under their own licences; the image contract already allows an engine to be absent.

## 4. The client API (`/api/v1`)

One HTTP API for every client that is not our own page: a phone app, a company's own screen that
shows the work board to its customers, a script. Our page keeps the internal routes for now and
moves to `/api/v1` feature by feature; a feature a second client needs is built in `/api/v1` first.

### 4.1 Shape

- **Its own module** (`src/web/client-api/`). A handler never returns an internal object: it
  builds a documented resource from it. This is what lets the inside keep changing.
- **Pure default-deny routing, `404` outside visibility**: a pure route table lists every allowed
  method and path; anything unlisted is refused. A resource (`agent`, `work`, `conversation`,
  `deliverable`) outside what the caller may see answers `404`, not `403`, because whether another
  person's box or department project exists is itself not the caller's business.
- **One schema file is the source**: the resources and operations are declared once; the OpenAPI
  document (`docs/api/v1.openapi.json`), the request validation and the contract tests all come
  from it. A generated client is what a phone app imports, over an abstract transport so the same
  client runs directly over HTTPS or over the multiplexed encrypted relay channel (docs/110).
- **Conventions**, the same everywhere:
  - JSON, camelCase, opaque string ids, RFC 3339 UTC timestamps.
  - Lists: `?limit=` (≤100) and `?cursor=`; the answer is `{ items, nextCursor }`.
  - Errors: `{ code, error, requestId }`. `code` is from the existing stable error codes
    (INV-1686) and is what a program reads; `error` is a sentence in the reader's language.
  - Every `POST` accepts `Idempotency-Key`; a repeat within 24 hours returns the first answer.
  - `429` with `Retry-After`; `ETag` / `If-None-Match` on reads, so a phone polls cheaply.
  - A client ignores fields it does not know and treats an enum value or discriminated union kind
    it does not know as "other" (rendering the summary sentence and pointing to the web or desktop
    when an action is unknown). That rule is what makes "additions only" safe, so it is in the
    contract and enforced in code generation.
- **Versioning**: the major version is in the path. `GET /api/v1/meta` answers
  `{ api: "1.<revision>", server, installation, capabilities, preview: [...] }`; the revision goes
  up with every addition. A deprecated operation answers with `Deprecation` and `Sunset` headers
  for a full line before it goes. Preview operations are named in `meta.preview` and nowhere
  promised.

### 4.2 Resources in v1

| Area | Operations | Scope needed |
|---|---|---|
| Discovery | `GET /meta`, `GET /me` | any |
| Auth & devices | `GET /auth/providers`, `POST /auth/oauth/start`, `POST /auth/oauth/exchange` (PKCE `S256`), `POST /auth/pair`, `POST /auth/refresh`, `POST /auth/logout`; `GET /devices`, `DELETE /devices/{id}`; `PUT /devices/self/push`, `DELETE /devices/self/push` | any for `/auth/*`; `devices:manage` (own devices) |
| Agents | `GET /agents`, `GET /agents/{id}` | `agents:read` |
| Work (All work) | `GET /work` (filter by state, agent, top-level work, "waits on me"), `GET /work/{id}`, `GET /work/{id}/history` | `work:read` |
| Board | `GET /board` — the same work as columns and ordered cards, the projection the page shows | `work:read` |
| Decisions | `GET /inbox` (all discriminated decision kinds waiting on this person: tool approvals, outbox drafts, questions, close proposals, pauses, exceptions), `GET /notifications/{seq}` (summary for wake-only push, docs/110 §5), `POST /work/{id}/decisions` (count as done, put off, stop), `POST /approvals/{id}` (allow `once` or `session`, deny; requires a server-verifiable biometric step-up proof bound to `(approvalId, decision)` when `stepUpRequired` is true, docs/110 §4), `POST /inbox/{id}/answer` (questions, outbox drafts, secret prompts to vault) | `work:decide` |
| Conversations | `GET /conversations`, `GET /conversations/{id}/messages`, `POST /conversations/{id}/messages` (`clientMessageId` + `attachmentIds`), `POST /conversations/{id}/card-actions` (structured `ShowUI` actions), `POST /conversations/{id}/stop`, `POST /uploads` (scoped image, file and voice attachments) | `chat:read`, `chat:write` |
| Results | `GET /deliverables/{id}`, content by a link that expires in minutes | `files:read` |
| Live changes | `GET /conversations/{id}/stream` (ephemeral live turn deltas while a conversation is open), `GET /events` (resumable SSE for durable changes), `GET /changes?since=<durableSeq>` (ledger-backed incremental sync for a phone waking from background sleep, independent of the in-memory SSE ring) | as the resource |
| Desktop | `POST /desktops/{agentId}/tickets` → a link valid for one use within 60 s, `view` or `control` | `desktop:view`, `desktop:control` |

Not in v1, on purpose: administration (people, quotas, settings, provider keys), skills and
routines authoring, anything about the box itself, and standing (`"always"`) approval grants from a
device credential (docs/110 §4). They stay with the page until somebody needs them from elsewhere.
Outbound webhooks ("this work changed") are the first Preview candidate, because a company's own
back end wants to be told rather than to poll.

What v1 never returns: a secret or vault value, a prompt, a raw tool input, a policy record,
another person's private conversation. A message list is what the page shows that person.

### 4.3 Who is calling: three kinds of credential

| Credential | For | How it is obtained | Lifetime |
|---|---|---|---|
| **Device credential** | A person's phone or desktop client | Pairing: a signed-in page shows a one-time code (QR), valid two minutes; or mobile OAuth + PKCE against an organisation's configured sign-in channel (docs/109, docs/110) | Access token 15 min (memory only); refresh token in non-migratable device keychain, rotates on every use (idempotent retries with the same `Idempotency-Key` and concurrent refreshes within a 30 s overlap window do not revoke the family; out-of-window reuse of a spent refresh token revokes the whole device family); revocable per device |
| **Personal token** | A person's script | Minted on the page, shown once | Chosen at minting (≤ 1 year), revocable |
| **Service token** | A company's back end, e.g. one that renders the board for its customers | Minted by an admin for a named integration | Chosen at minting, revocable; carries a **view** |

- Stored as a hash, never the token (the store the MCP tokens already use, extended with scopes,
  expiry and last use). Tokens carry a recognisable prefix so a leaked one can be found by a scan.
- **What a call may do = the person's role ∩ the token's scopes ∩ what that person may see.** A
  token never raises anything.
- A service token's **view** names what it may read: which top-level work, which agents, and
  whether conversation text is included. Default: titles, states and results, no conversation
  text. The company's customers never hold our token: their browser talks to the company's back
  end, which talks to us. Cross-origin browser calls are refused unless an origin is listed.
- The shared installation token and `?token=` in an address remain for loopback only.

## 5. Remote access: what must be true off loopback

An installation declares where it is reachable — **local** (loopback, today's default),
**private** (a tailnet or a company network), **public** (the Internet) — and refuses to start in
a configuration weaker than that level requires. A weak deployment that starts is the failure;
one that refuses and says why is the product.

| # | Requirement | local | private | public |
|---|---|---|---|---|
| R1 | HTTPS (own certificate or a declared trusted proxy); `Secure` cookies; HSTS | – | required | required |
| R2 | No shared installation token, no token in an address | allowed | refused | refused |
| R3 | Every person signs in as themselves; credentials per §4.3 | optional | required | required |
| R4 | Sign-in is rate-limited per address and per account, with back-off; failures audited | – | required | required |
| R5 | State-changing requests and socket upgrades check `Origin`; cross-origin denied by default; a content security policy on the page | required | required | required |
| R6 | A desktop stream opens only with a one-use ticket (§4.2) bound to person, agent and mode; view-only unless the role allows control; idle streams close; who watched and who drove is recorded | cookie suffices | required | required |
| R7 | Host to box: the box's certificate is verified or pinned; the box token can be rotated without re-attaching; the box daemon is never published to the Internet (docs/30 stands) | – | required | required |
| R8 | An audit record of sign-ins, tokens minted and revoked, desktop sessions, and decisions made through the API; exported by `audit export` | required | required | required |
| R9 | Security backlog items S-2, S-3, S-4 (docs/10) closed | – | S-2 | all three |
| R10 | An outside security review of the remote surface, a published contact for reports, a list of third-party components per release | – | – | required before the first public deployment is sold |

Today (0.4.9): the desktop stream is reachable only through the box daemon behind the box token,
the daemon is published on loopback, and the web server picks the driving or the view-only stream
from the person's role. That is sound for **local**. For **private** and **public**, R1–R4 and
R6–R7 are not met: the server speaks plain HTTP, the cookie is not `Secure`, one shared token
opens everything, and the host does not verify the box's certificate.

**Built since (INV-2204, part 1): the level, R1 and R2** (`src/web/exposure.ts`; how to set it is
docs/06 "The exposure level"). The level is derived before it is declared: a loopback bind is
local, any other bind is private, and `AGENTBOX_EXPOSURE` overrides either — `local` on a wider
bind is an operator's statement, repeated at every start. R1: private and public do not start
without an `https://` public address (the terminator in front is the declared proxy; the server
handles no certificate), cookies are `Secure` and responses carry HSTS, and `X-Forwarded-Proto`
is believed from nobody. R2: off local the installation token is refused in an address, ignored
as a cookie, and accepted as a bearer header only from the server's own machine or, on a tenant's
box, from the control plane's gateway.

**Part 2: R4 and R5** (`src/web/sign-in-limits.ts`, `src/web/browser-guard.ts`; docs/06 "Sign-in
limits and what a browser is held to"). R4, off local: every way a credential is tried asks one
limiter, by address and by account, with back-off to a ceiling, `429` and `Retry-After`; tries
that did not get in are recorded without the credential and exported by `audit export`. The
address is the last `X-Forwarded-For` entry, the one the declared proxy appended. R5, at every
level: where a request that changes something, or a socket upgrade, names an origin (`Origin`,
else `Referer`), it must be this installation's own; a request with a bearer credential, one
that names no origin at all (a program, not a browser) and a webhook are not asked; no
cross-origin header is ever sent; the page
has a content security policy whose `script-src` still allows inline script, which is the part
of R5 not met; a door's sign-in state is bound to the browser that started it.

**Part 3: R6, and R8 for sign-ins and desktop sessions** (`src/web/desktop-streams.ts`; docs/06
"Desktop streams"). Off local the desktop's socket opens only with a ticket — one person, one
desktop, one mode, one use, sixty seconds — issued by redirecting the desktop page to itself with
the ticket where noVNC reads its socket's path; the mode is the lower of what was asked and what
the roster role allows; a stream nothing moves on for fifteen minutes is closed; a stream whose
holder's access ends is closed at once. At every level each stream's opening and closing, and
each sign-in that worked, is recorded and exported by `audit export`. Of R8, tokens minted and
revoked and decisions made through the API are not recorded yet. R7 is not built.

**Part 4: R7, and the rest of R8** (`src/box/box-tls.ts`, `src/box/token-rotation.ts`,
`src/boxd/token-store.ts`, `src/web/token-ledger.ts`; docs/06 "The host and its boxes"). The box
daemon speaks plain HTTP; what identifies the box is decided per kind:

| Box | How the host reaches it | What identifies the box |
|---|---|---|
| This machine's Docker box | HTTP to a port published on loopback | loopback: nothing else can answer there. No TLS |
| A personal box (Docker) | the same | the same |
| A tenant's or a personal box on Kubernetes | HTTP to the pod's ClusterIP; the gateway → tenant hop likewise | the NetworkPolicy that admits only the control plane's pods. No TLS |
| An attached box over a tailnet or an SSH forward (docs/30) | HTTP | WireGuard's peer keys, or SSH's host key. No TLS: docs/30 stands |
| An attached box behind a TLS terminator | HTTPS | its certificate: verified when an authority vouches for it for that name; otherwise its public key is pinned on first use (`box-pins.json`) and a different one is refused, before anything is written to the connection, with what to do (`box attach … --replace`) |

Before this, the desktop page and socket accepted any certificate while the box client accepted
only authority-vouched ones. A box's token can be rotated from Settings → Computers or
`agentbox box rotate-token <name>`: the box accepts the new token from the moment it is named and
the old one until five minutes after the host confirms the switch, across a restart of either
side; nothing is re-attached and no agent stops. Tokens minted, revoked and rotated are in
`tokens.jsonl`, approvals answered through the API or the Outbox name who answered them
(`user:<person>`) in `policy.jsonl`, and `audit export` carries both.

Where else a box is started from is changed with it (INV-2299):

- **A personal box on Kubernetes**: its Secret is re-written from the host's token file once the box
  accepts the new token and the host holds it, before the switch is confirmed. A pod restarted
  before that takes the new token from its config volume; one re-created after it boots with it. A
  Secret that cannot be written is said, and the next start from this installation writes it again.
  The box's daemon keeps its rotated token across a start whose `BOXD_TOKEN` is any token it has had
  (a Secret one or more rotations behind), and obeys only one it never had.
- **A tenant's box on the control plane**: an account holder asks `POST /api/admin/box/rotate-tokens`
  on the control plane, not the tenant's box — the tokens are in the control plane's store, which the
  gateway reads on every request, and in a Secret the box cannot write. Both the box token and the
  UI token are fixed in the pod's environment, so the pod restarts with new ones (its volumes are
  kept), in this order: the Secret takes the new tokens and the old UI token with the time it ends
  (the restart's timeout plus five minutes); the pod is re-created and takes both; the store takes
  the new ones; the Secret drops the old one. The gateway's token is accepted at every step, and
  after the time only the new one is. Asked and done are both rows in the control plane's audit
  table; neither carries a token. The compose and static allocators say they cannot.

## 6. Upgrades that can be promised

- **One home format number.** `home/FORMAT` holds an integer. Changes to stored data are numbered
  migrations run in order at start, after a backup, each recorded. Today's one-off migrations
  become migration 1…n. A binary that meets a higher number than it knows stops with a message
  naming the version to install: the downgrade fence docs/05 has for one file, for all of them.
- **An upgrade fixture per line.** A home and volumes written by the last release of the previous
  stable line are kept as a test asset; the suite upgrades them and reads everything back. The
  acceptance run gains "install the previous line, use it, upgrade, check".
- **Clients.** A `/api/v1` client keeps working for the life of v1. `meta` lets a client see what
  the server can do instead of guessing from a version.
- **Config.** A deprecated key is read and reported for one full line.

## 7. How it stays maintainable

- **One surface snapshot** (`surface-baseline.json`, checked by `npm run arch`, the same shape as
  the prompt ratchet): CLI commands and flags, config keys, documented variables, MCP tool
  schemas, webhook headers, frontmatter keys, and the OpenAPI document. An addition updates the
  snapshot and needs a line in the release notes. A removal or a changed type fails unless the
  item is in the deprecation list and its line has passed.
- **One deprecation list** in code: what, since which line, what replaces it. The start-up
  report, the `Deprecation` header and the release notes read from it.
- **Contract tests** run the OpenAPI document against a real server: every operation, every
  documented error, and each scope refused without its scope.
- **The architecture guard** refuses an import of an internal route's body type into
  `client-api/`, and a second definition of a resource.
- **Fixes flow one way**: merged to main first, then picked to the stable branch; a stable branch
  has its own `npm test`, release check and acceptance run before a tag.

## 8. Order, and where each part stands

The first party to build on this is an organisation: the server on their Kubernetes, members
signing in with DingTalk, one box per member, our own page and desktop app as the clients
(docs/109). That fixes the order: remote access at the **private** level is needed before the
first delivery; the client API is needed only when they show the board on a screen of their own.

| Step | Contents | State |
|---|---|---|
| 1. Stable line | §2 branch and release process; §6 home format, migrations, upgrade fixture; §7 snapshot and deprecation list; single-engine image gate | Not built. `BOXD_PROTOCOL`, the template format check and the update/rollback path exist |
| 2. Organisation onboarding | docs/109: DingTalk sign-in, activation that makes the person, their box and their agent, the first chat, organisation skills | Not built. Feishu sign-in, the directory sync, roles, quotas and personal boxes on Kubernetes exist |
| 3. Remote access, private level | §5 R1–R8 at **private**, and R9's part for that level (S-2 of docs/10 closed); a cluster rerun of what 0.4.8 fixed (sessions across a restart, Admins managing every member's box) | Part built (INV-2204 parts 1–3): the declared level and its start-up check, R1, R2, R4, R5 (except a strict `script-src`), R6, R7, R8, and S-2 closed for private. Not done: the kind pass through a TLS Ingress. Role-chosen view-only stream, per-person hashed MCP tokens and the audit export exist |
| 4. Client API, read slice | `/meta`, `/me`, `/agents`, `/work`, `/board`, `/events`, `/changes`; pure default-deny route table; service and personal tokens with scopes and views; OpenAPI + contract tests | Built (INV-2213, three parts): `/meta`, `/me`, `/agents`, `/work` (with history), `/board`, `/changes`, `/events`, the route table, personal and service tokens, the OpenAPI document on the surface ratchet, the contract tests and the Swift and Kotlin generation check — §8.1. The page has no form for the tokens yet (INV-2316); minting asks for a sign-in in the last ten minutes (INV-2318, §8.1) |
| 5. Client API, the rest; remote access, public level | Auth & device credentials, polymorphic decisions, conversations & uploads, deliverables, desktop tickets; R9–R10 | Part built (INV-2214 parts 1–2): auth and device credentials; decisions, the inbox and step-up, §8.1. Conversations, uploads, deliverables and desktop tickets, R9–R10: not built |
| 6. Shared storage for an organisation; mobile apps | Shared storage: a design of its own. Native iOS and Android clients, encrypted relay and wake-only push: docs/110 | Decided in docs/110; not built |

### 8.1 The client API as built (INV-2213)

**Where it is.** `src/web/client-api/`: `schema.ts` declares every operation, resource, scope and
error once; `openapi.ts` builds `docs/api/v1.openapi.json` from it; `routes.ts` is the pure route
table and the parameter check; `frame.ts` runs every request in one order — route, credential, limits,
scope, parameters, handler — and answers in one shape; `handlers.ts` builds each resource field by
field; `mount.ts` wires it to the server, which mounts it in two lines before the page's gate. A
`POST`'s first answer is kept 24 hours for its `Idempotency-Key`, per credential and operation, in
`<home>/client-api-idempotency.jsonl` (no `POST` exists in the read slice; the frame's test proves it). The
architecture guard refuses an import of an internal route, a page or the server into `client-api/`,
and a resource declared outside `schema.ts`.

**What was decided here that §4 left open:**

- **Open enumerations are strings.** A field with a fixed set of values is `type: string` with the
  known values in `x-extensible-enum`, never `enum`: a generated decoder then keeps an unknown value
  as itself instead of failing, and the app's own `.other(raw)` takes it. The known values are still
  on the surface ratchet, so removing one is a break.
- **No nulls.** A field with no value is absent; `nextCursor` is absent on the last page.
- **Times to the second**: `2026-11-28T10:00:00Z`. The Swift generator's default decoder refuses a
  fraction (measured: `.000Z` fails `getMe` in `clients/codegen/swift`).
- **`/meta` needs no credential**: a phone reads it before it signs in (docs/110 §4). It names the
  server's version; that is the price of a client seeing what the server can do.
- **v1 takes v1 credentials only.** The page's cookie and the installation token are refused on
  `/api/v1` (`api-credential-invalid`), at every level; the page keeps its internal routes until a
  feature moves (§4).
- **A service token reads for the Admin who minted it**, while they are one: demoted or removed, it
  answers `access-removed`. Its scopes are read scopes (`agents:read`, `work:read`, `chat:read`,
  `files:read`). Its view names nothing until the Admin names it: agents (`allAgents` or
  `agentIds`), work (`allWork` or `workIds`), and `conversationText`, false by default.
- **A personal token** may be minted by any person, viewers included — the role still bounds it —
  for at most 365 days (90 unless chosen); a service token likewise.
- **Unknown query parameters are refused** (`api-param-unknown`), so a typo or a filter this server
  does not have is said, not silently ignored. A newer client reads `meta.capabilities` first.
- **Limits**: 600 requests a minute per credential, 120 per address for what needs none, answered
  with `api-rate-limited` and `Retry-After`. A token that does not work is a sign-in try (R4, door
  `client-api`), limited and recorded in `sign-ins.jsonl` like the side door's.
- **The revision rises with every addition**, and `npm run arch` holds it to that: an `api/…` item
  added without raising `API_REVISION` fails, and the revision never falls.

**Tokens.** Minted, listed and revoked through the page's internal routes
`GET /api/client-tokens`, `POST /api/client-tokens` (`kind`, `label`, `scopes`, `expiresInDays`,
and for a service token `view`), `POST /api/client-tokens/revoke` (`id`); the operator may name the
person with `principalId`. Kept in the side door's hashed store (`mcp-tokens.json`): id, kind,
scopes, expiry, last use to the minute, view; `lbxp_` and `lbxs_` prefixes. Minting and revoking —
by the holder, an Admin or a directory sync — are in `tokens.jsonl` with who. The page has no form
for them yet.

**Agents, work and the board (part 2).** `GET /agents`, `/agents/{id}` (`agents:read`); `GET /work`,
`/work/{id}`, `/work/{id}/history`, `/board` (`work:read`). What a person may read is one function
for the page and the API, `src/web/reach.ts`: an agent by its box's members, work by its agent or,
when nobody holds it, by whether they asked for it — and the box is the boundary for Admins too.
Outside it the answer is `api-not-found`, the same as for nothing at all.

- **Work's `state` is the board's own word** (`open`, `doing`, `blocked`, `review`, `done`,
  `dropped`), not a translation; the schema's description maps each to the words a client may
  show (`open` is "ready", `doing` "in progress", `review` "in review"). There is no "needs you"
  state: `waitsOnMe` (with `waitKind`) is the page's own mark — the attention it computes for the
  person (`attentionFor`) — and any live state may carry it.
- **Top-level work** is a task nothing made (no `origin.parentId`); `topLevelId` is the highest one
  the caller may read, and `?topLevelId=` lists it with what was made for it.
- **Order**: `/work` most recently changed first (a keyset cursor, exact across pages; work that
  changes moves to the front, which `/changes` reports); `/agents` by name; history oldest first.
  A cursor names its filters and is refused (`api-cursor-invalid`) under others.
- **The board** is a column per state in the page's order — what waits on the person first, then
  the board's own order (`boardOrder`) — with `total` and the first `limit` cards; the rest through
  `/work?state=`. Titles are in the request's language. A question answered in a chat is neither
  listed nor on the board, as on the page; it is still readable by id.
- **A service token's view**: agents it names (or all its Admin may reach); work under the
  top-level work it names, with what was made for it, or with `allWork` the work its agents hold.
  Without `conversationText`, no work description and no history notes; titles, states and the
  result line (`summary`) remain.
- An agent hidden from listings is not in `/agents` and still answers by id. `hasDesktop` is not
  there yet: it arrives with desktop tickets (INV-2214).

**Durable sync (part 3).** `GET /changes?since=` and `GET /events` (SSE) both read one ledger on
disk, `changes.jsonl` (docs/05 §2.4.1), not the page's 512-frame ring:

- **A change record** is `{ seq, at, type, id, op }` — `work` or `agent`, `upsert` or `delete` — and
  nothing of what the thing says; the client fetches it through the same sight as every read. A
  record is listed only when the caller may read the thing now, or, gone, could have read it by
  what the ledger kept (who asked, who held it, which box); a service token is not told of gone work
  unless its view takes all work. Each type needs its read scope: `work:read`, `agents:read`.
- **Each thing once**: a page of `/changes` (≤ 1000, 500 by default) holds the newest change of each
  thing it covers; `durableSeq` is where to go on from, `hasMore` says to ask again at once.
- **Retention and reset**: 30 days and at most 200,000 lines, the newest always. A `since` older
  than what is kept, or beyond the newest (another installation's history), answers `reset: true`
  with the current `durableSeq`: drop the cache, reload, go on from there. `/events` says the same
  with a first `reset` event.
- **`/events`**: `Last-Event-ID` is a `seq`; the stream replays from the ledger what changed since,
  once each, then sends `ready` with the newest position, then live `change` events. No
  `Last-Event-ID`: it starts now. It ends when the credential stops being valid, and when the
  server stops. The page's own `/api/events` and its ring are unchanged.
- An agent's `status` (working, idle) is not a durable change; agents are written when they come,
  go or change what a client shows of them.

**Generation.** `clients/codegen/` holds a Swift package (swift-openapi-generator) and a Kotlin
project (openapi-generator, `kotlinx.serialization`, as lumenbox-android uses) that generate from
the document and decode answers from a newer server (`clients/codegen/fixtures`: an unknown field
and an unknown value in each). CI's `client-codegen` workflow runs both when the document, the
schema or the check changes; the contract test holds the fixtures to the schema.

**Device credentials (INV-2214, part 1).** `src/web/device-credentials.ts` (the store, `devices.json`),
`src/web/device-sign-in.ts` (starts, codes and pairing codes, in memory), `client-api/auth.ts` (the
operations), `src/web/device-routes.ts` and Settings → Mine → Phones (the page's half). Operations:
`GET /auth/providers`, `POST /auth/oauth/start`, `POST /auth/oauth/exchange`, `POST /auth/pair`,
`POST /auth/refresh` (no credential; the last three take one in the body), `POST /auth/logout` (a
device credential), `GET /devices` and `DELETE /devices/{id}` (`devices:manage`). What was decided here
that §4 and docs/110 left open:

- **This server is the authorization server the app talks to.** The app sends its PKCE challenge and
  its own `redirectUri`; it opens `/auth/<door>?device=<id>` on this server — the page's own door
  (door-sign-in.ts), with the same state, browser binding and admission rule — and the vendor sends the
  person back to this server, which holds the vendor's secret. The app is then sent a code of ours:
  one use, one minute, only with the verifier and the exact `redirectUri` the sign-in started with
  (RFC 6749 §4.1.3). The vendor's own code never reaches the phone.
- **Only an app's own address is sent a code**: a `lumenbox:` address, or `http://127.0.0.1:<port>`
  / `[::1]` for a desktop client (RFC 8252). A web address would let somebody start a sign-in, send its
  link to a colleague, and collect the colleague's code — PKCE does not stop the one who made the
  challenge. A white-label app's own scheme needs a config key, which is not added here. A custom
  scheme can be claimed by another app on the same phone; docs/110 §4 asks the apps to move to
  verified https app links before general availability.
- **Not let in is an answer, not an error**: `200 { status: "asked_to_join", message }` (docs/110's
  word), with no credential; their request is with the Admins as on the page. Outside the
  organisation, not linked, or the vendor failing: the browser goes back to the app with
  `error=access_denied` and `error_description` (`not-a-member`, `not-linked`, `vendor-refused`).
- **Pairing**: Settings → Mine → Phones shows a QR code holding
  `lumenbox://pair#server=<public origin>&code=<code>` (the fragment, so nothing on the way logs it):
  two minutes, once, signing the phone in as the person who showed it. Showing one needs a recent
  sign-in (below) and the public address; it is recorded (`pairing-shown`).
- **Tokens**: an access token `lbxd_` + 64 hex, fifteen minutes; a refresh token `lbxr_` + 64 hex,
  thirty days from its issue, and never past a year from the device's sign-in. **One family per
  device sign-in**: a family revoked is the device ended. Stored as SHA-256 only (`devices.json`,
  docs/05). A device's scopes are fixed, not chosen by the app: everything but `desktop:control`
  (docs/110 §4: v1 watches, it does not drive).
- **The 30-second window** (docs/110 §4) is not a second live token: a spent refresh token presented
  within 30 seconds answers `409 refresh-superseded` and ends nothing — the device's other process
  holds the new pair — and a retry with the first request's `Idempotency-Key` within those 30 seconds
  answers the same pair. Past 30 seconds the device ends, for whoever holds its tokens, with
  `access-removed`, and `tokens.jsonl` says `refresh-reuse`.
- **An answer that holds a token** (`x-secret-answer`: exchange, pair, refresh) is sent with
  `Cache-Control: no-store`, and its `Idempotency-Key` replay lives in memory for 30 seconds, never in
  `client-api-idempotency.jsonl`: a day-long replay of a refresh would let whoever has the spent token
  and the key take the live pair without the reuse being seen.
- **A device ends** when it is deleted (`DELETE /devices/{id}`, or Phones on the page — an Admin may
  remove anyone's), signs itself out (`/auth/logout`), its refresh token is reused, its person leaves
  in a directory sync (only the devices of that sign-in when they keep another), is removed by an
  Admin, or is signed out everywhere; and a device whose sign-in an Admin took from the person is
  refused as ended. Every ended device's calls answer `401 access-removed` — not counted as a sign-in
  try — until its last token's time is over; its open `/events` streams close at once (not at the
  next ping) and open desktops are rechecked.
- **Tries count**: a code, pairing code or refresh token that does not work is a sign-in try (R4, door
  `client-api`, reasons `auth-code`, `pairing-code`, `unknown-refresh-token`); a waiting address is
  refused before its body is looked at.
- **A request body** is checked against its schema: a field it does not take is refused
  (`api-param-unknown`), `null` is the same as absent (a generated client may send it), and a known
  value of an open enumeration is not enforced on input — an older server takes a newer app's
  platform. A `DELETE` answers what it did, with no `ETag`.
- **The step-up key is registered at sign-in** (`stepUpKeyId` + `stepUpPublicKey`, a P-256
  SubjectPublicKeyInfo, both or neither), so a device enrolled now can make the proofs part 2 checks.
- A person's first sign-in on a device asks for their own computer, as the page's first visit does
  (INV-2203). `PUT`/`DELETE /devices/self/push` are INV-2215's.

**A recent sign-in to mint (INV-2318).** The session cookie now signs `identity|epoch|signedAt`.
Minting a personal, service or side-door token, showing a pairing code, making an invite (redeemed, an
invite is a fresh sign-in, so a stale session could otherwise launder itself through one — for itself or
a new Admin) and making a box's connection code need a sign-in in the last ten minutes (`src/web/recent-sign-in.ts`); otherwise `403 sign-in-again`, and the page offers to sign
in again. A cookie from before the field still reads the page and mints nothing — kept valid rather
than signing every organisation out at an upgrade, since only minting depends on the time. Not asked:
the local level, the installation's own credential (the operator), and a person a gateway vouches for
on each request. Each mint's record names the sign-in it relied on (`signedInAt`); invites and connection
codes are recorded in `tokens.jsonl` too (`kind: invite`, `connect-code`), never the code. Taking one
sign-in from a person ends the devices made from it and closes their open streams at once.

**Decisions (INV-2214, part 2).** `client-api/inbox.ts` (the operations), `client-api/step-up.ts`
(the proof); the page and the API now share one home for each: `web/decisions.ts` (what waits on a
person — the page's own `attentionFor` over approvals, Outbox drafts, questions, the board's proposals
and requests, paused chains and routines, failures handed over), `web/approval-answer.ts`,
`web/outbox-answer.ts`, `web/secret-requests.ts`, `web/person-actions.ts`. Operations: `GET /inbox`,
`POST /approvals/{id}`, `POST /inbox/{id}/answer`, `POST /work/{id}/decisions`, `GET /notifications/{seq}`,
all `work:decide`. What was decided here:

- **One item, discriminated by `kind`**, with the payload of its kind in a field of that name
  (`approval`, `draft`, `question`, `secret`, `closeProposal`) rather than `oneOf`: every generator
  decodes it, and an unknown kind is shown by `title` and `detail` and opened on the page. `actions`
  says what may be done here; a viewer's items carry none they cannot take.
- **What is answered here**: approvals (allow `once`/`session`, deny), Outbox drafts (approve, edit,
  reject), questions (the person's words, which settle the question and reach the agent as their
  message), secrets (save to the vault, dismiss; Admins), and work (done, keep open against a close
  proposal, put off, stop — stop cancels what runs, and is refused rather than dropping work that runs and
  cannot be cancelled from here). Listed and answered on
  the page: a paused chain (answered by a message, which arrives with conversations), a held routine,
  a failure handed to a person, an undelivered message, a verification, organisation knowledge.
- **The step-up rule** is the gate's own tiers (`host/side-effects.ts`): allowing an approval of
  `reach`, `spend`, `credential`, `irreversible` or `run-later` needs a proof, and so does one whose tier
  is unknown (an extension's confirmation, an approval from before the tier was kept: `policy.jsonl`'s
  `approval-requested` now carries `tier`). Approving or editing an Outbox draft always does — it goes
  outside. Denying and rejecting never do.
- **The proof**: ECDSA P-256 / SHA-256 by the key the device registered at sign-in, over
  `lumenbox-step-up/1\n<deviceId>\n<item id>\n<decision>\n<detail>` — for an approval the decision
  `allow:once` or `allow:session` and the detail `-`, the item id the approval's; for a draft `approve`
  with `-`, or `edit` with BASE64URL(SHA-256(UTF-8 words)) without padding, the item id the inbox item's —
  DER or raw `r||s`. Only a device has one: a personal
  token cannot allow an outside action. Platform attestation (App Attest, Key Attestation) is not checked
  in v1: the server proves possession of the registered key, and the apps create it to need biometrics
  for every use (docs/110 §4).
- **`always` is refused for every v1 credential**, not only devices: a standing grant is the page's.
- **Who answered**: `user:<person> device:<id>` (or `token:<id>`) in `policy.jsonl`, and the person's
  name on the draft.
- **A secret's value** goes to the vault and nowhere else: `POST /inbox/{id}/answer` is a `secret`
  operation, so its `Idempotency-Key` replay is memory-only and the replay file keeps no digest of it.
- **The inbox in the change record**: type `inbox`, routed by the item's agent or the person who asked
  (never its words); `GET /notifications/{seq}` answers the words for an `upsert` only while the item
  still waits on the caller. The push itself is INV-2215's.
- A question its person answered no longer waits, on the page or here, before the sweep settles it; it is
  settled once the answer is in the agent's queue, so an answer refused on the way leaves it waiting.
- A paused chain is shown to whoever reaches either of its agents (the page too); a secret is saved only
  for the agent the person was shown; an `Idempotency-Key` reused for another target is a conflict; a
  cursor whose item was answered meanwhile answers `api-cursor-invalid` rather than restarting the list.

Step 4 is what a company needs to show the work board to its customers. Steps 5 and 6 can follow
without changing anything a step-4 client relies on — which is the test of whether the design
above is right.
