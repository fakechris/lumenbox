<!-- doc: 106-stable-surface-and-client-api
     title: What stays stable: release lines, the stable list, remote access, and the client API
     family: spec
     status: current
     domain: compatibility
     updated: 2026-11-27
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
`tokens.jsonl`, approvals answered through the API name who answered them in `policy.jsonl`, and
`audit export` carries both.

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
| 4. Client API, read slice | `/meta`, `/me`, `/agents`, `/work`, `/board`, `/events`, `/changes`; pure default-deny route table; service and personal tokens with scopes and views; OpenAPI + contract tests | Not built. Paged work list, resumable event stream and stable error codes exist internally |
| 5. Client API, the rest; remote access, public level | Auth & device credentials, polymorphic decisions, conversations & uploads, deliverables, desktop tickets; R9–R10 | Not built |
| 6. Shared storage for an organisation; mobile apps | Shared storage: a design of its own. Native iOS and Android clients, encrypted relay and wake-only push: docs/110 | Decided in docs/110; not built |

Step 4 is what a company needs to show the work board to its customers. Steps 5 and 6 can follow
without changing anything a step-4 client relies on — which is the test of whether the design
above is right.
