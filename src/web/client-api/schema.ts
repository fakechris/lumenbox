/**
 * The client API's one schema source (docs/106 §4.1, S10): every resource, operation, scope and
 * error of `/api/v1` is declared here once. The OpenAPI document (`openapi.ts`, written to
 * `docs/api/v1.openapi.json`), the route table and request validation (`routes.ts`), the surface
 * ratchet's items (`scripts/surface-ratchet.mjs`) and the contract tests all read this file and
 * nothing else; a handler builds the resource this file names and never returns an internal object.
 *
 * Inside v1 this file changes by addition only: a new operation, a new optional field, a new known
 * value. Each addition raises `API_REVISION`, which `npm run arch` insists on. A removal or a changed
 * type fails the same check unless `src/deprecations.ts` lists it and its line has come.
 *
 * Choices that keep the generated Swift and Kotlin clients from breaking on a newer server:
 * - an enumeration is a `string` with its known values in `x-extensible-enum`, never `enum`, so a
 *   decoder that meets a value it does not know keeps it as "other" instead of failing;
 * - a field with no value is absent, never `null`, and no field ever changes type;
 * - no object says `additionalProperties: false`, so a decoder ignores the fields it does not know.
 */

import type { ErrorCode } from "../../i18n/server-errors.ts";

/** "1.<revision>": raised by every addition (docs/106 §4.1). The surface ratchet refuses an addition that leaves it. */
export const API_REVISION = 4;
export const API_VERSION = `1.${API_REVISION}`;
export const API_PREFIX = "/api/v1";

// --- the JSON Schema subset this file writes --------------------------------------------------

/** The part of JSON Schema 2020-12 (and so OpenAPI 3.1) the client API uses, and nothing more. */
export interface Schema {
  type?: "object" | "array" | "string" | "integer" | "boolean";
  $ref?: string;
  description?: string;
  format?: "date-time" | "int64";
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** Known values of an open enumeration: a reader treats any other value as "other". */
  "x-extensible-enum"?: string[];
  /** On a request body only: a field it does not declare is refused (`api-param-unknown`). Answers stay open. */
  additionalProperties?: false;
}

const text = (description: string, extra: Partial<Schema> = {}): Schema => ({ type: "string", description, ...extra });
/** A time: RFC 3339 in UTC to the second, with no fraction — what every generator's default date decoder reads. */
const time = (description: string): Schema => ({ type: "string", format: "date-time", description });
const flag = (description: string): Schema => ({ type: "boolean", description });
const known = (description: string, values: readonly string[]): Schema => ({ type: "string", description, "x-extensible-enum": [...values] });
const list = (items: Schema, description: string): Schema => ({ type: "array", items, description });
/** A resource declared in `SCHEMAS`; the OpenAPI builder refuses a name that is not there. */
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
/** An object: `fields` in order, `required` the ones always present. Every other field may be absent. */
const object = (description: string, fields: Record<string, Schema>, required: readonly string[]): Schema => ({
  type: "object", description, properties: fields, required: [...required],
});
/** A request body: an object that takes no field it does not declare. Never an answer, which stays open for new fields. */
const request = (description: string, fields: Record<string, Schema>, required: readonly string[]): Schema => ({ ...object(description, fields, required), additionalProperties: false });

// --- scopes and credentials (docs/106 §4.3) ----------------------------------------------------

/** What a credential may be used for. A token never raises anything: a call needs the person's role, the scope and the person's reach. */
export const SCOPES = {
  "agents:read": "Read the agents the person may reach.",
  "work:read": "Read work, its history and the board.",
  "work:decide": "Answer what waits on the person: count work as done, put it off, stop it, approve or deny.",
  "chat:read": "Read conversations the person may read.",
  "chat:write": "Send messages and card actions in conversations the person may drive.",
  "files:read": "Read deliverables.",
  "devices:manage": "List and remove the person's own devices.",
  "desktop:view": "Watch an agent's desktop.",
  "desktop:control": "Drive an agent's desktop.",
} as const;
export type Scope = keyof typeof SCOPES;
export const SCOPE_NAMES = Object.keys(SCOPES) as Scope[];
/** A service token reads; anything that acts is for a person's own credential. */
export const SERVICE_SCOPES: readonly Scope[] = ["agents:read", "work:read", "chat:read", "files:read"];

export const CREDENTIAL_KINDS = ["personal", "service", "device"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** The kinds a token store mints; a device credential arrives with sign-in from a phone (INV-2214). */
export type ClientTokenKind = Exclude<CredentialKind, "device">;
/** What a device credential carries: everything a person's own client does, except driving a desktop, which v1 leaves to the page (docs/110 §4). */
export const DEVICE_SCOPES: readonly Scope[] = SCOPE_NAMES.filter(scope => scope !== "desktop:control");
/** A service token's view, as `SCHEMAS.ServiceView` documents it. */
export interface ServiceView {
  allAgents: boolean;
  agentIds: string[];
  allWork: boolean;
  workIds: string[];
  conversationText: boolean;
}
/** Nothing at all: what a service token sees until its Admin names something. */
export const EMPTY_VIEW: ServiceView = { allAgents: false, agentIds: [], allWork: false, workIds: [], conversationText: false };
export const ROLES = ["viewer", "driver", "admin"] as const;
export const INSTALLATION_MODES = ["single-machine", "organisation"] as const;
/** A piece of work's state: the board's own words (`TASK_STATUSES`, src/host/tasks.ts), not a translation of them. */
export const WORK_STATES = ["open", "doing", "blocked", "review", "done", "dropped"] as const;
/** Why work waits on the person: the kinds of what the page lists under "waiting on you" for a piece of work (src/host/attention.ts). */
export const WAIT_KINDS = ["question", "review", "close-proposal", "reauthorize", "flagged", "nudged", "waiting"] as const;
export const AGENT_STATUSES = ["working", "idle"] as const;
export const ACTOR_KINDS = ["person", "agent", "system"] as const;
export const CHANGE_TYPES = ["work", "agent", "inbox"] as const;
/**
 * What waits on a person (`InboxItem.kind`): the page's own kinds (host/attention.ts), and a secret an agent asked for.
 * Open: a newer server adds kinds, and a client shows an unknown one by its words and offers the page.
 */
export const INBOX_KINDS = [
  "approval", "outbox", "question", "secret", "close-proposal", "review", "reauthorize", "flagged", "nudged",
  "paused", "routine-paused", "exception", "undeliverable", "unanswered", "verification", "org-knowledge",
] as const;
/** What a client may do about an item here; anything else is done on the page (`open-on-page`). */
export const INBOX_ACTIONS = ["allow", "deny", "approve", "edit", "reject", "answer", "save", "dismiss", "done", "keep-open", "put-off", "stop", "open-on-page"] as const;
/** What an answer did. */
export const DECISION_OUTCOMES = ["allowed", "denied", "approved", "edited", "rejected", "answered", "saved", "dismissed", "done", "kept-open", "put-off", "stopped"] as const;
/** The policy gate's classes of what an action does (host/side-effects.ts `SideEffectTier`), as v1 names them. */
export const EFFECT_TIERS = ["observe", "self", "reach", "spend", "credential", "irreversible", "run-later"] as const;
/** What an Outbox draft is (host/outbox-drafts.ts `DRAFT_KINDS`), as v1 names them. */
export const OUTBOX_DRAFT_KINDS = ["message", "publish", "submit", "email", "other"] as const;
export const CHANGE_OPS = ["upsert", "delete"] as const;
/** The organisation sign-in channels a device signs in through (docs/109): the door types with a web sign-in (src/web/sign-in.ts). */
export const PROVIDER_TYPES = ["dingtalk", "feishu"] as const;
export const SIGN_IN_STATUSES = ["authenticated", "asked_to_join"] as const;
export const DEVICE_PLATFORMS = ["ios", "android", "macos", "windows", "linux"] as const;
export const DEVICE_SIGN_IN_METHODS = ["oauth", "pairing"] as const;

// --- errors -----------------------------------------------------------------------------------

/** Every code `/api/v1` answers with, and its status. The words are `err.<code>` in `src/i18n/server-errors.ts`. */
export const ERRORS = {
  "api-operation-unknown": { status: 404, meaning: "No operation has this method and path." },
  "api-method-not-allowed": { status: 405, meaning: "The path exists and does not take this method; `Allow` names those it takes." },
  "api-credential-needed": { status: 401, meaning: "The operation needs `Authorization: Bearer <token>`." },
  "api-credential-invalid": { status: 401, meaning: "The token is not one this installation issued, or it was revoked." },
  "api-credential-expired": { status: 401, meaning: "The token's lifetime is over." },
  "access-removed": { status: 401, meaning: "The person the token acts for no longer has access, or this device was removed or signed out. A client drops what it stored for this installation." },
  "api-scope-needed": { status: 403, meaning: "The token does not carry the scope the operation needs." },
  "api-param-invalid": { status: 400, meaning: "A parameter has a value the operation does not take." },
  "api-param-unknown": { status: 400, meaning: "The operation takes no parameter of this name." },
  "api-cursor-invalid": { status: 400, meaning: "The cursor is not one this list gave, or was given for other filters. Start the list again without it." },
  "api-not-found": { status: 404, meaning: "No such resource, or none the credential may read: the two are one answer." },
  "api-idempotency-key-invalid": { status: 400, meaning: "`Idempotency-Key` is 8 to 128 of A–Z, a–z, 0–9, `_ . : -`." },
  "api-idempotency-conflict": { status: 409, meaning: "This `Idempotency-Key` was used for a different request — another body or another target — within the operation's replay window (its `Idempotency-Key` says how long)." },
  "api-rate-limited": { status: 429, meaning: "Too many requests; wait the seconds `Retry-After` names." },
  "sign-in-limited": { status: 429, meaning: "Too many tries with tokens that did not work from this address; wait the seconds `Retry-After` names." },
  "api-internal": { status: 500, meaning: "The server failed; `requestId` names the failure in its log." },
  "auth-provider-unknown": { status: 400, meaning: "No sign-in channel of this id signs a device in here; `GET /auth/providers` lists those that do." },
  "auth-redirect-invalid": { status: 400, meaning: "`redirectUri` is not an app's own address: a `lumenbox:` address, or for a desktop client `http://127.0.0.1:<port>/…`." },
  "auth-code-invalid": { status: 400, meaning: "The code is not one this server gave, was used, is over a minute old, or `codeVerifier` does not match the challenge. Start the sign-in again." },
  "pairing-code-invalid": { status: 400, meaning: "The pairing code is not one this server showed, was used, or is over two minutes old. Show a new one on the page." },
  "refresh-superseded": {
    status: 409,
    meaning: "This refresh token was used in the last 30 seconds, and nothing was ended: the device holds the new pair where it keeps them, and a retry with the first request's `Idempotency-Key` answers it again.",
  },
  "device-credential-needed": { status: 403, meaning: "Only a device credential signs itself out; a personal or service token is revoked on the page." },
  "api-role-needed": { status: 403, meaning: "The person's role does not allow this answer: answering for an agent takes a driver, saving a secret an Admin." },
  "approval-always-refused": { status: 403, meaning: "`always` is not granted through v1: a standing grant is made on the page. Answer `once` or `session`." },
  "step-up-required": { status: 403, meaning: "Allowing this needs a step-up proof (`stepUp`) from a device that registered a step-up key; a token without one cannot allow it." },
  "step-up-invalid": { status: 403, meaning: "The step-up proof is not this device's registered key's signature over this decision." },
  "inbox-answer-invalid": { status: 400, meaning: "The answer does not fit this item: `INBOX_ACTIONS` it takes are in its `actions`." },
  "decision-refused": { status: 409, meaning: "The board refused this decision for the work as it is now (for example done work cannot be put off); `error` says why." },
} as const satisfies Record<string, { status: number; meaning: string }>;
export type ApiErrorCode = keyof typeof ERRORS & ErrorCode;

// --- resources --------------------------------------------------------------------------------

export const SCHEMAS = {
  Error: object("A refusal. A program reads `code`; `error` is a sentence for a person, in the request's language (`Accept-Language`).", {
    code: known("Stable: what a program matches on. A code it does not know is handled by the HTTP status.", Object.keys(ERRORS)),
    error: text("What happened and what to do, for a person. Never matched on: the words change."),
    requestId: text("Names this request in the server's log."),
  }, ["code", "error", "requestId"]),
  Meta: object("What this server is and can do. Read before signing in, and to see what the server answers instead of guessing from a version.", {
    api: text('"1.<revision>": the revision rises with every addition to v1.'),
    server: text("The LumenBox version of the server."),
    installation: ref("Installation"),
    capabilities: list(text("An `operationId`."), "Every stable operation this server answers."),
    preview: list(text("An `operationId`."), "Operations this server answers that may change in any release (docs/106 §1)."),
  }, ["api", "server", "installation", "capabilities", "preview"]),
  Installation: object("The kind of installation.", {
    mode: known("A personal installation (one Owner, the desktop app) or an organisation's server.", INSTALLATION_MODES),
  }, ["mode"]),
  Me: object("The person the credential acts for, and the credential.", {
    id: text("The person's id."),
    name: text("The person's name as the installation shows it."),
    role: known("What the person may do: `viewer` watches, `driver` instructs agents, `admin` runs the installation.", ROLES),
    homeAgentId: text("The agent a direct message from this person reaches, when there is one the credential may read."),
    credential: ref("Credential"),
  }, ["id", "name", "role", "credential"]),
  Credential: object("The credential this request was made with. Never the token.", {
    id: text("The credential's id: what revoking it names."),
    kind: known("`personal`: a person's script. `service`: an integration an Admin named, reading through its view. `device`: a phone or desktop client.", CREDENTIAL_KINDS),
    label: text("The name it was given when it was minted."),
    scopes: list(known("A scope.", SCOPE_NAMES), "What it may be used for."),
    createdAt: time("When it was minted."),
    expiresAt: time("When it stops working."),
    lastUsedAt: time("When it was last used, to the minute; absent before its first use."),
    view: ref("ServiceView"),
  }, ["id", "kind", "label", "scopes", "createdAt", "expiresAt"]),
  ServiceView: object("What a service token may read (present on service credentials only). Nothing is visible unless named here, and a view never reaches past what its Admin may see.", {
    allAgents: flag("Every agent the Admin may reach."),
    agentIds: list(text("An agent id."), "These agents, when `allAgents` is false."),
    allWork: flag("All work the readable agents hold."),
    workIds: list(text("A work id."), "This work and the work made for it, when `allWork` is false."),
    conversationText: flag("Whether conversation text and work descriptions are included. False: titles, states and results only."),
  }, ["allAgents", "agentIds", "allWork", "workIds", "conversationText"]),
  Agent: object("An agent the caller may reach: one in a box the person is a member of (and, for a service token, one its view names).", {
    id: text("The agent's id."),
    name: text("The agent's name."),
    title: text("A short subtitle, e.g. \"release manager\"."),
    description: text("What the agent is for, as its profile says."),
    boxId: text("The box the agent works in."),
    boxName: text("That box's name."),
    teams: list(text("A team: a label on agents in one box."), "The teams the agent is on."),
    status: known("`working`: in a turn now. `idle`: not.", AGENT_STATUSES),
    isHome: flag("Whether a direct message from the person reaches this agent."),
  }, ["id", "name", "boxId", "boxName", "teams", "status", "isHome"]),
  AgentPage: object("A page of agents, by name.", {
    items: list(ref("Agent"), "The agents on this page."),
    nextCursor: text("The next page's cursor; absent on the last page."),
  }, ["items"]),
  Work: object("A piece of work, as the page's All work and board show it. Built from the task; never the task itself.", {
    id: text("The work's id."),
    title: text("What it is, in a line."),
    state: known([
      "The board's state:",
      "`open` — asked for, not started (a client's \"ready\");",
      "`doing` — being worked on (\"in progress\");",
      "`blocked` — waiting on something or somebody (\"blocked\"; when the person is that somebody, `waitsOnMe` is true);",
      "`review` — handed in, waiting for a reviewer (\"in review\");",
      "`done` — accepted;",
      "`dropped` — given up, kept for the record.",
      "There is no \"needs you\" state: whether it waits on the person is `waitsOnMe`, which any state but `done` and `dropped` may have.",
    ].join(" "), WORK_STATES),
    topLevelId: text("The top-level work this belongs to: its own id when nothing made it, else the id of the work at the top of what it was made for."),
    parentId: text("The work this was made for, when it was made for another."),
    agentId: text("The agent doing it, when one is and the caller may read that agent."),
    agentName: text("That agent's name."),
    conversationId: text("The conversation it was asked in, when there is one."),
    waitsOnMe: flag("Whether the person owes something on it now: an answer, a review, a decision. The same mark the page puts on its row."),
    waitKind: known("What the person owes, when `waitsOnMe`.", WAIT_KINDS),
    summary: text("The newest thing said about what was done (the result so far), cut to 700 characters."),
    description: text("The request in full. Absent for a service token whose view does not include conversation text."),
    deliverableIds: list(text("A deliverable id."), "What it handed over."),
    due: text("When it is due: a date (`2026-12-01`) or a time, as given."),
    createdAt: time("When it was asked for."),
    updatedAt: time("When it last changed."),
  }, ["id", "title", "state", "topLevelId", "waitsOnMe", "deliverableIds", "createdAt", "updatedAt"]),
  WorkPage: object("A page of work, most recently changed first. Work that changes while a client pages moves to the front; `/changes` says so.", {
    items: list(ref("Work"), "The work on this page."),
    nextCursor: text("The next page's cursor; absent on the last page."),
  }, ["items"]),
  WorkChange: object("One change in a piece of work's history.", {
    at: time("When."),
    byKind: known("Who: a person, an agent, or the installation itself (a reminder, a check, a restart).", ACTOR_KINDS),
    byId: text("Their id, for a person or an agent."),
    byName: text("Their name, for a person or an agent."),
    state: known("The state it moved to, when it moved.", WORK_STATES),
    agentId: text("The agent it was handed to, when this change handed it on."),
    note: text("What was said with it. Absent for a service token whose view does not include conversation text."),
  }, ["at", "byKind"]),
  WorkChangePage: object("A page of a piece of work's history, oldest first.", {
    items: list(ref("WorkChange"), "The changes on this page."),
    nextCursor: text("The next page's cursor; absent on the last page."),
  }, ["items"]),
  Board: object("The board: the work the caller may read, as columns by state, each in the order the page shows — what waits on the person first, then the most recently changed.", {
    columns: list(ref("BoardColumn"), "One per state, in board order: open, doing, blocked, review, done, dropped."),
  }, ["columns"]),
  BoardColumn: object("One column of the board.", {
    id: known("The column's state.", WORK_STATES),
    title: text("The column's name, in the request's language."),
    total: { type: "integer", description: "How much work is in the column; `cards` holds the first `limit` of it. The rest: `GET /work?state=`." },
    cards: list(ref("Work"), "The column's work, in board order."),
  }, ["id", "title", "total", "cards"]),
  ChangeRecord: object("That something a client may hold changed: never what it now says. Fetch it (`GET /work/{id}`, `GET /agents/{id}`); a 404 then means it is gone, or no longer the caller's to read, and the client drops it.", {
    seq: { type: "integer", format: "int64", description: "Rises with every change, across restarts: the position to resume from." },
    at: time("When it changed."),
    type: known("What changed: `work`, `agent`, or `inbox` (something now waits on a person, or no longer does: `GET /inbox`; `upsert` is also what a wake-only push names).", CHANGE_TYPES),
    id: text("Its id."),
    op: known("`upsert`: it is new or changed. `delete`: it is gone.", CHANGE_OPS),
  }, ["seq", "at", "type", "id", "op"]),
  Changes: object([
    "What changed since `since`, oldest first, each thing once (its newest change).",
    "When `reset` is true the gap is older than what the server keeps (30 days), or `since` is from another installation's history:",
    "drop what is cached, read it again (`/work`, `/agents`, `/board`, and `/inbox` with `work:decide`), then go on from `durableSeq`.",
  ].join(" "), {
    items: list(ref("ChangeRecord"), "The changes the caller may be told of."),
    durableSeq: { type: "integer", format: "int64", description: "Send it as `since` next time: everything up to it has been looked at." },
    hasMore: flag("Whether more changes follow `durableSeq` now: ask again at once."),
    reset: flag("Whether the client must reload instead (see above)."),
  }, ["items", "durableSeq", "hasMore", "reset"]),
  AuthProvider: object("A sign-in channel a device can sign in through: an organisation's DingTalk or Feishu, as the page's sign-in offers it.", {
    id: text("What `POST /auth/oauth/start` names as `provider`."),
    type: known("Which vendor.", PROVIDER_TYPES),
    displayName: text("Its name for a person, in the request's language."),
  }, ["id", "type", "displayName"]),
  AuthProviderList: object("The channels a device can sign in through here; empty when none is set up (no public address, or no channel's app).", {
    items: list(ref("AuthProvider"), "The channels."),
  }, ["items"]),
  OAuthStart: request("Starting a device's sign-in (OAuth 2.0 authorization code with PKCE, RFC 7636).", {
    provider: text("An `AuthProvider.id`.", { maxLength: 200 }),
    codeChallenge: text("BASE64URL(SHA-256(code verifier)), without padding: 43 characters.", { pattern: "^[A-Za-z0-9_-]{43}$" }),
    codeChallengeMethod: known("`S256`; nothing else is accepted.", ["S256"]),
    redirectUri: text("Where the browser goes back to the app: a `lumenbox:` address, or for a desktop client `http://127.0.0.1:<port>/…`. The code and `state` are added to it.", { maxLength: 512 }),
    state: text("Given back unchanged on `redirectUri`: the app checks it is its own.", { maxLength: 512 }),
  }, ["provider", "codeChallenge", "codeChallengeMethod", "redirectUri"]),
  OAuthStarted: object("Where to send the person: open `authorizationUrl` in the system's authentication browser.", {
    authorizationUrl: text("An address on this server that hands the person to the vendor's sign-in and back."),
    state: text("The `state` that was given."),
    expiresAt: time("When this sign-in can no longer be finished (ten minutes)."),
  }, ["authorizationUrl", "expiresAt"]),
  OAuthExchange: request("The code the app's `redirectUri` received, for a device credential.", {
    code: text("From `redirectUri`'s `code`.", { maxLength: 200 }),
    codeVerifier: text("The PKCE code verifier (RFC 7636 §4.1).", { pattern: "^[A-Za-z0-9._~-]{43,128}$" }),
    provider: text("When given, it must be the one the sign-in started with.", { maxLength: 200 }),
    redirectUri: text("The `redirectUri` the sign-in started with, exactly (RFC 6749 §4.1.3).", { maxLength: 512 }),
    deviceName: text("What the person calls this device, shown in their list of devices.", { maxLength: 60 }),
    platform: known("The device's system.", DEVICE_PLATFORMS),
    stepUpKeyId: text("The device's own id for its step-up signing key (docs/110 §4); with `stepUpPublicKey`.", { maxLength: 100, pattern: "^[A-Za-z0-9._:-]{1,100}$" }),
    stepUpPublicKey: text("That key's public half: a P-256 key, SubjectPublicKeyInfo DER, base64url without padding.", { maxLength: 400, pattern: "^[A-Za-z0-9_-]+$" }),
  }, ["code", "codeVerifier", "redirectUri", "deviceName", "platform"]),
  DevicePairing: request("A pairing code a signed-in page showed (its QR code), for a device credential.", {
    code: text("The code from the QR code.", { maxLength: 200 }),
    deviceName: text("What the person calls this device.", { maxLength: 60 }),
    platform: known("The device's system.", DEVICE_PLATFORMS),
    stepUpKeyId: text("As in `OAuthExchange`.", { maxLength: 100, pattern: "^[A-Za-z0-9._:-]{1,100}$" }),
    stepUpPublicKey: text("As in `OAuthExchange`.", { maxLength: 400, pattern: "^[A-Za-z0-9_-]+$" }),
  }, ["code", "deviceName", "platform"]),
  TokenRefresh: request("A device's refresh token, for a new pair.", {
    refreshToken: text("The refresh token (`lbxr_…`) the device holds now.", { maxLength: 200 }),
  }, ["refreshToken"]),
  DeviceTokens: object([
    "A device's tokens. The access token goes in `Authorization: Bearer` and is kept in memory only; the refresh token is kept in the device's",
    "hardware-held keychain and is spent by the next `POST /auth/refresh`, which answers a new pair.",
  ].join(" "), {
    deviceId: text("The device: what `DELETE /devices/{id}` names."),
    tokenType: known("`Bearer`.", ["Bearer"]),
    accessToken: text("`lbxd_…`, for fifteen minutes."),
    expiresInSeconds: { type: "integer", description: "Seconds the access token works for, counted when it was issued (a replayed answer repeats it): schedule the next refresh from `accessTokenExpiresAt`." },
    accessTokenExpiresAt: time("When the access token stops."),
    refreshToken: text("`lbxr_…`: used once."),
    refreshTokenExpiresAt: time("When the refresh token stops if it is not used: thirty days, and never past a year from the sign-in."),
    scopes: list(known("A scope.", SCOPE_NAMES), "What the credential may be used for."),
  }, ["deviceId", "tokenType", "accessToken", "expiresInSeconds", "accessTokenExpiresAt", "refreshToken", "refreshTokenExpiresAt", "scopes"]),
  DeviceSignIn: object([
    "The end of a device's sign-in. `authenticated`: `tokens` and `me` are present, and the person's own computer is on its way if they have none yet.",
    "`asked_to_join`: the person is not let in yet; their request is with the organisation's Admins, `message` says so, and no credential is issued.",
  ].join(" "), {
    status: known("`authenticated` or `asked_to_join`.", SIGN_IN_STATUSES),
    tokens: ref("DeviceTokens"),
    me: ref("Me"),
    message: text("For `asked_to_join`: what to tell the person, in the request's language."),
  }, ["status"]),
  Device: object("One of the person's signed-in devices.", {
    id: text("The device's id."),
    name: text("What it was called when it signed in."),
    platform: known("Its system.", DEVICE_PLATFORMS),
    signInMethod: known("`oauth`: signed in through a channel. `pairing`: scanned a code a signed-in page showed.", DEVICE_SIGN_IN_METHODS),
    providerId: text("The channel, for `oauth`."),
    scopes: list(known("A scope.", SCOPE_NAMES), "What its credential may be used for."),
    createdAt: time("When it signed in."),
    lastUsedAt: time("When it was last used, to the minute."),
    current: flag("Whether it is the device making this request."),
    stepUpKey: flag("Whether it registered a step-up signing key."),
  }, ["id", "name", "platform", "signInMethod", "scopes", "createdAt", "current", "stepUpKey"]),
  DevicePage: object("A page of the person's devices, newest first.", {
    items: list(ref("Device"), "The devices on this page."),
    nextCursor: text("The next page's cursor; absent on the last page."),
  }, ["items"]),
  InboxItem: object([
    "One thing waiting on the person, as the page lists it under \"waiting on you\". Discriminated by `kind`: the field named like the kind",
    "(`approval`, `draft`, `question`, `secret`, `closeProposal`) carries what that kind needs, and `actions` says what may be done here, each at its own operation:",
    "`allow`/`deny` at `POST /approvals/{approval.id}`; `answer`, `approve`, `edit`, `reject`, `save`, `dismiss` at `POST /inbox/{id}/answer`;",
    "`done`, `keep-open`, `put-off`, `stop` at `POST /work/{workId}/decisions`; `open-on-page`: nothing here.",
    "A kind a client does not know is shown by `title` and `detail`, and opened on the page.",
  ].join(" "), {
    id: text("The item: what `POST /inbox/{id}/answer` names. Opaque."),
    kind: known("What it is.", INBOX_KINDS),
    title: text("What it is about, in a line."),
    detail: text("One line a person can act on without opening anything."),
    decision: flag("Whether the person's answer changes what happens next (a decision), rather than something to know (a notice)."),
    actions: list(known("An action.", INBOX_ACTIONS), "What may be done here. Empty: open it on the page."),
    stepUpRequired: flag("Whether allowing or approving needs a step-up proof (`stepUp`): the action leaves the box or touches authority."),
    deadline: time("When the clock runs out and the default happens, when there is one."),
    agentId: text("The agent it is with, when one is and the caller may read it."),
    agentName: text("That agent's name, or the person it is with."),
    workId: text("The work it is about, when it is about work."),
    approval: ref("InboxApproval"),
    draft: ref("InboxDraft"),
    question: ref("InboxQuestion"),
    secret: ref("InboxSecret"),
    closeProposal: ref("InboxCloseProposal"),
  }, ["id", "kind", "title", "detail", "decision", "actions", "stepUpRequired"]),
  InboxApproval: object("An action waiting for consent (kind `approval`): answered at `POST /approvals/{id}`.", {
    id: text("The approval: what `POST /approvals/{id}` names."),
    description: text("The action exactly as it will run: what consent is given to."),
    action: text("What the tool does, in the host's words, when it says."),
    why: text("The agent's one-line case for it."),
    tier: known("What the action does, in the policy gate's classes: `reach`, `spend`, `credential`, `irreversible`, `run-later` leave the box or touch authority.", EFFECT_TIERS),
    scopes: list(known("A scope this item may be allowed for.", ["once", "session"]), "`once`, and `session` unless only this one call may be allowed."),
    requestedAt: time("When it was asked."),
  }, ["id", "description", "scopes", "requestedAt"]),
  InboxDraft: object("What an agent wants to send or do outside the box, held in the Outbox (kind `outbox`).", {
    kind: known("What the step is.", OUTBOX_DRAFT_KINDS),
    target: text("Who or where it is for, as the agent named it."),
    body: text("The words, or the command."),
    why: text("The agent's one-line case for sending it."),
    background: text("What the agent says led to it."),
  }, ["kind", "target", "body", "why"]),
  InboxQuestion: object("A question put to the person (kind `question`): answered with words, or one of `options`.", {
    options: list(text("A choice."), "Choices offered, when the agent offered some."),
    fallback: text("What the agent does with no answer by `deadline`."),
    conversation: text("The conversation the answer goes into."),
  }, []),
  InboxSecret: object("A secret an agent asked for (kind `secret`): the value goes straight into the vault, granted to that agent alone.", {
    name: text("The name it will be saved under."),
    description: text("What the agent says it is for."),
  }, ["name", "description"]),
  InboxCloseProposal: object("An agent proposes closing work the person asked for (kind `close-proposal`): answered at `POST /work/{id}/decisions`.", {
    by: text("Who proposes it."),
    reason: text("Why."),
    decideBy: time("Say nothing until then and it closes."),
  }, ["by", "reason"]),
  InboxPage: object("What waits on the person, most urgent first: what stops work, then questions, then the rest, each by its deadline.", {
    items: list(ref("InboxItem"), "The items on this page."),
    nextCursor: text("The next page's cursor; absent on the last page."),
  }, ["items"]),
  StepUpProof: object("A device's step-up proof (docs/110 §4): its registered key's ECDSA P-256 / SHA-256 signature over `lumenbox-step-up/1\\n<deviceId>\\n<item id>\\n<decision>\\n<detail>`.", {
    keyId: text("The `stepUpKeyId` the device registered.", { maxLength: 100 }),
    signature: text("The signature, DER or raw r||s, base64url.", { maxLength: 300, pattern: "^[A-Za-z0-9_-]+$" }),
  }, ["keyId", "signature"]),
  ApprovalDecision: request("An answer to an approval. `decision` `allow:once`/`allow:session` in the signed text; `detail` is `-`.", {
    decision: known("`allow` or `deny`.", ["allow", "deny"]),
    scope: known("For `allow`: `once` (this call) or `session` (this agent's turn). `always` is refused here.", ["once", "session"]),
    reason: text("For `deny`: what the agent is told.", { maxLength: 1000 }),
    stepUp: ref("StepUpProof"),
  }, ["decision"]),
  InboxAnswer: request([
    "An answer to a question, an Outbox draft or a secret request; nothing else is answered here. A question takes `answer` (`text`); a draft",
    "`approve`, `edit` (`body`) or `reject` (`reason`); a secret `save` (`value`) or `dismiss`. Approving signs `approve` with detail `-`; editing",
    "signs `edit` with the detail BASE64URL(SHA-256(UTF-8 `body`)), no padding.",
  ].join(" "), {
    action: known("One of the item's `actions` this operation takes: `answer`, `approve`, `edit`, `reject`, `save`, `dismiss`.", INBOX_ACTIONS),
    text: text("For `answer`: the words, or one of the question's `options`.", { maxLength: 20_000 }),
    body: text("For `edit`: the words to send instead.", { maxLength: 20_000 }),
    reason: text("For `reject`: what the agent is told.", { maxLength: 1000 }),
    value: text("For `save`: the secret. It goes to the vault and nowhere else — not a transcript, not a log, not a retry's memory.", { maxLength: 20_000 }),
    stepUp: ref("StepUpProof"),
  }, ["action"]),
  WorkDecision: request("A decision on work the person asked for.", {
    decision: known("`done`: count it as done. `keep-open`: refuse a proposal to close it. `put-off`: ask again at `until`. `stop`: stop it and drop it.", ["done", "keep-open", "put-off", "stop"]),
    until: time("For `put-off`: when to ask again."),
    note: text("What is said with it.", { maxLength: 2000 }),
  }, ["decision"]),
  DecisionAck: object("What the answer did.", {
    id: text("What was answered."),
    outcome: known("What happened.", DECISION_OUTCOMES),
    at: time("When."),
  }, ["id", "outcome", "at"]),
  Notification: object("What a wake-only push is about (docs/110 §5): the push carried only `seq`; the words come from here, to a device that may read them.", {
    seq: { type: "integer", format: "int64", description: "The position in the change record the push named." },
    itemId: text("The inbox item."),
    kind: known("Its kind.", INBOX_KINDS),
    title: text("A line for the notification's title."),
    body: text("A line for its body."),
    at: time("When it arrived."),
  }, ["seq", "itemId", "kind", "title", "body", "at"]),
  DeviceEnded: object("A device signed out: its tokens stopped working, its open streams closed. Calling with them now answers `access-removed`.", {
    id: text("The device."),
    endedAt: time("When."),
  }, ["id", "endedAt"]),
} as const satisfies Record<string, Schema>;
export type SchemaName = keyof typeof SCHEMAS;

const limit = (description: string, fallback: number): Param => ({ name: "limit", description: `${description} 1 to 100; ${fallback} when absent.`, schema: { type: "integer", minimum: 1, maximum: 100 } });
const cursor: Param = { name: "cursor", description: "`nextCursor` from the page before.", schema: { type: "string", maxLength: 512 } };
const idParam = (what: string): Param => ({ name: "id", description: `The ${what}'s id.`, schema: { type: "string", maxLength: 200 } });

// --- operations -------------------------------------------------------------------------------

export interface Param {
  name: string;
  description: string;
  schema: Schema;
  required?: boolean;
}

export interface Operation {
  operationId: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Under `API_PREFIX`; `{name}` is a path parameter. */
  path: string;
  summary: string;
  description: string;
  /** `none`: answered without a credential (only what a client needs before it signs in). */
  auth: "none" | "credential";
  /** The scope the credential must carry; absent means any credential. */
  scope?: Scope;
  /** docs/106 §1. A preview operation is named in `meta.preview` and promised nothing. */
  tier: "stable" | "preview";
  pathParams?: Param[];
  query?: Param[];
  response: SchemaName;
  /** A `POST`'s body: a resource of `SCHEMAS`, checked before the handler runs (routes.ts `readBody`). */
  requestBody?: SchemaName;
  /**
   * The answer or the request holds a secret (a token; a secret's value for the vault): it is sent with
   * `Cache-Control: no-store`, and an `Idempotency-Key` repeat is answered from memory only, for 30 seconds —
   * never from a file, which would otherwise keep a digest of the request for a day.
   */
  secret?: true;
  /** A credential is tried in the body: tries that do not work count against the sign-in limiter (docs/106 §5 R4). */
  signIn?: true;
  /** Codes this operation answers beyond those every operation of its kind may (`commonErrors`). */
  errors?: ApiErrorCode[];
  /** Server-sent events: `response` is the schema of each event's data; no `ETag`. */
  stream?: true;
}

export const OPERATIONS = [
  {
    operationId: "getMeta", method: "GET", path: "/meta", auth: "none", tier: "stable", response: "Meta",
    summary: "What this server is and can do",
    description: "Answered without a credential: a client reads it before signing in. `capabilities` lists every stable operation this server answers.",
  },
  {
    operationId: "getMe", method: "GET", path: "/me", auth: "credential", tier: "stable", response: "Me",
    summary: "Who the credential acts for",
    description: "The person the credential acts for — for a service token, the Admin who minted it — and the credential itself, never the token.",
  },
  {
    operationId: "listAgents", method: "GET", path: "/agents", auth: "credential", scope: "agents:read", tier: "stable", response: "AgentPage",
    query: [limit("How many agents.", 50), cursor], errors: ["api-cursor-invalid"],
    summary: "The agents the caller may reach",
    description: "Every agent in a box the person is a member of, by name; for a service token, those its view names. An agent hidden from listings is not listed, and still answers `GET /agents/{id}`.",
  },
  {
    operationId: "getAgent", method: "GET", path: "/agents/{id}", auth: "credential", scope: "agents:read", tier: "stable", response: "Agent",
    pathParams: [idParam("agent")], errors: ["api-not-found"],
    summary: "One agent",
    description: "An agent the caller may not reach answers 404, as one that does not exist.",
  },
  {
    operationId: "listWork", method: "GET", path: "/work", auth: "credential", scope: "work:read", tier: "stable", response: "WorkPage",
    query: [
      { name: "state", description: "Only work in this state.", schema: { type: "string", "x-extensible-enum": [...WORK_STATES] } },
      { name: "agentId", description: "Only work this agent is doing.", schema: { type: "string", maxLength: 200 } },
      { name: "topLevelId", description: "Only this top-level work and the work made for it.", schema: { type: "string", maxLength: 200 } },
      { name: "waitsOnMe", description: "`true`: only work the person owes something on; `false`: only work they do not.", schema: { type: "boolean" } },
      limit("How much work.", 50), cursor,
    ],
    errors: ["api-cursor-invalid"],
    summary: "All work the caller may read",
    description: [
      "The page's All work: every piece of work the person may read — work an agent in their boxes holds, and work they asked for that nobody holds —",
      "most recently changed first. A question answered in a chat is not listed, as on the page. For a service token, only what its view names.",
    ].join(" "),
  },
  {
    operationId: "getWork", method: "GET", path: "/work/{id}", auth: "credential", scope: "work:read", tier: "stable", response: "Work",
    pathParams: [idParam("work")], errors: ["api-not-found"],
    summary: "One piece of work",
    description: "Work the caller may not read answers 404, as work that does not exist.",
  },
  {
    operationId: "listWorkHistory", method: "GET", path: "/work/{id}/history", auth: "credential", scope: "work:read", tier: "stable", response: "WorkChangePage",
    pathParams: [idParam("work")], query: [limit("How many changes.", 50), cursor], errors: ["api-not-found", "api-cursor-invalid"],
    summary: "What happened to a piece of work",
    description: "Every change, oldest first: who moved it, to which state, to which agent, and what they said.",
  },
  {
    operationId: "getBoard", method: "GET", path: "/board", auth: "credential", scope: "work:read", tier: "stable", response: "Board",
    query: [limit("How many cards per column.", 50)],
    summary: "The board",
    description: "The same work as `GET /work`, as the page's board: a column per state, what waits on the person first, then the most recently changed.",
  },
  {
    operationId: "getChanges", method: "GET", path: "/changes", auth: "credential", tier: "stable", response: "Changes",
    query: [
      { name: "since", description: "The `durableSeq` from the last answer; 0 the first time.", schema: { type: "integer", minimum: 0, format: "int64" }, required: true },
      { name: "limit", description: "How many changes at most. 1 to 1000; 500 when absent.", schema: { type: "integer", minimum: 1, maximum: 1000 } },
    ],
    summary: "What changed since a position, durably",
    description: [
      "For a client waking from sleep, starting, or reconnecting: what changed since `since`, read from a ledger on the server's disk that survives restarts",
      "and is kept 30 days. A change is listed only when the caller may read the thing now (or, gone, could have read it); its words are fetched, not sent.",
      "Changes are of work, agents and the inbox; an agent's `status` (working or idle) is not a change. Any credential: each change is shown by the scope its type needs —",
      "`work:read` for work, `agents:read` for agents, `work:decide` for the inbox — and a credential without that scope is not told of it.",
    ].join(" "),
  },
  {
    operationId: "streamEvents", method: "GET", path: "/events", auth: "credential", tier: "stable", response: "ChangeRecord", stream: true,
    summary: "Changes as they happen (server-sent events)",
    description: [
      "`text/event-stream`, for a client in the foreground. Each `change` event's data is a `ChangeRecord` and its `id` is the record's `seq`.",
      "Reconnect with `Last-Event-ID` (what `EventSource` sends) and the stream first replays, from the same durable ledger as `/changes`, each thing changed since, once;",
      "then a `ready` event whose `id` is the newest position. When the gap is older than the ledger keeps, the first event is `reset`",
      "(data `{ \"durableSeq\": n }`): reload, then go on. With no `Last-Event-ID` the stream starts now. A `: ping` comment comes every 20 seconds.",
      "The stream ends when the credential stops being valid. What a credential may be told of is as for `/changes`.",
    ].join(" "),
  },
  {
    operationId: "listAuthProviders", method: "GET", path: "/auth/providers", auth: "none", tier: "stable", response: "AuthProviderList",
    summary: "The channels a device can sign in through",
    description: "An organisation's DingTalk or Feishu channels whose sign-in is set up, as the page's sign-in offers them. Read before signing in.",
  },
  {
    operationId: "startOAuth", method: "POST", path: "/auth/oauth/start", auth: "none", tier: "stable", response: "OAuthStarted", requestBody: "OAuthStart",
    errors: ["auth-provider-unknown", "auth-redirect-invalid"],
    summary: "Start a device's sign-in through a channel (PKCE)",
    description: [
      "OAuth 2.0 authorization code with PKCE `S256` (RFC 7636), with this server as the authorization server: open `authorizationUrl` in the system's",
      "authentication browser (`ASWebAuthenticationSession`, Custom Tabs). The person signs in at the vendor and comes back to this server, which sends",
      "the browser to `redirectUri` with `code` (one use, one minute) and `state` — or with `error=access_denied` and `error_description`",
      "(`not-a-member`, `not-linked`, `vendor-refused`) when the vendor's answer lets nobody in. Then `POST /auth/oauth/exchange`.",
    ].join(" "),
  },
  {
    operationId: "exchangeOAuthCode", method: "POST", path: "/auth/oauth/exchange", auth: "none", tier: "stable", response: "DeviceSignIn", requestBody: "OAuthExchange",
    secret: true, signIn: true, errors: ["auth-code-invalid", "access-removed", "sign-in-limited"],
    summary: "Finish a device's sign-in: the code for a device credential",
    description: [
      "The code and the PKCE verifier for a device credential. An activated person is `authenticated`: the answer has the device's tokens and `me`, and",
      "their own computer is made now if they are owed one and have none. A person the organisation has not let in yet is `asked_to_join`:",
      "their request waits for an Admin and no credential is issued. A code that does not work counts as a sign-in try.",
    ].join(" "),
  },
  {
    operationId: "pairDevice", method: "POST", path: "/auth/pair", auth: "none", tier: "stable", response: "DeviceSignIn", requestBody: "DevicePairing",
    secret: true, signIn: true, errors: ["pairing-code-invalid", "access-removed", "sign-in-limited"],
    summary: "Sign a device in with a pairing code a signed-in page shows",
    description: [
      "A signed-in page (Settings → Mine → Phones) shows a QR code: `lumenbox://pair#server=<origin>&code=<code>`. The code works once, for two minutes,",
      "and is shown only after a sign-in in the last ten minutes. It signs the device in as the person who showed it. A code that does not work counts as a sign-in try.",
    ].join(" "),
  },
  {
    operationId: "refreshDeviceToken", method: "POST", path: "/auth/refresh", auth: "none", tier: "stable", response: "DeviceTokens", requestBody: "TokenRefresh",
    secret: true, signIn: true, errors: ["api-credential-invalid", "api-credential-expired", "access-removed", "refresh-superseded", "sign-in-limited"],
    summary: "A new pair for a device's refresh token",
    description: [
      "Spends the refresh token and answers a new access token and a new refresh token. A refresh token is used once: presented again more than",
      "30 seconds after it was spent, the device is ended — for whoever holds its tokens — and the answer is `access-removed`; within those 30 seconds the",
      "answer is `refresh-superseded` and nothing ends. Send an `Idempotency-Key` kept for the attempt: a retry with it within 30 seconds answers the same pair.",
      "A device that sent no key, or retries later, and cannot find the newer pair where it keeps its tokens, signs in again.",
    ].join(" "),
  },
  {
    operationId: "signOutDevice", method: "POST", path: "/auth/logout", auth: "credential", tier: "stable", response: "DeviceEnded",
    errors: ["device-credential-needed"],
    summary: "Sign this device out",
    description: [
      "Ends the calling device: its access and refresh tokens stop at once and its open streams close. A device credential only.",
      "A retry after a lost answer cannot be replayed — the token it would carry is ended — and answers `access-removed`: that is the confirmation.",
    ].join(" "),
  },
  {
    operationId: "listDevices", method: "GET", path: "/devices", auth: "credential", scope: "devices:manage", tier: "stable", response: "DevicePage",
    query: [limit("How many devices.", 50), cursor], errors: ["api-cursor-invalid"],
    summary: "The person's signed-in devices",
    description: "Every device signed in as the person, newest first; `current` marks the one asking.",
  },
  {
    operationId: "deleteDevice", method: "DELETE", path: "/devices/{id}", auth: "credential", scope: "devices:manage", tier: "stable", response: "DeviceEnded",
    pathParams: [idParam("device")], errors: ["api-not-found"],
    summary: "Sign one of the person's devices out",
    description: "Ends the device: its tokens stop at once, its open streams and desktops close, and it is told `access-removed`. Another person's device answers 404.",
  },
  {
    operationId: "listInbox", method: "GET", path: "/inbox", auth: "credential", scope: "work:decide", tier: "stable", response: "InboxPage",
    query: [limit("How many items.", 50), cursor], errors: ["api-cursor-invalid"],
    summary: "What waits on the person",
    description: [
      "Every decision and notice waiting on the person — approvals, Outbox drafts, questions, secrets agents asked for, close proposals, reviews,",
      "paused chains and routines, failures handed to them — as the page lists them, only from agents and work the person may reach.",
      "Changes to it arrive in `/changes` and `/events` as type `inbox`.",
    ].join(" "),
  },
  {
    operationId: "decideApproval", method: "POST", path: "/approvals/{id}", auth: "credential", scope: "work:decide", tier: "stable", response: "DecisionAck", requestBody: "ApprovalDecision",
    pathParams: [idParam("approval")], errors: ["api-not-found", "api-role-needed", "approval-always-refused", "step-up-required", "step-up-invalid", "inbox-answer-invalid"],
    summary: "Allow or deny an action waiting for consent",
    description: [
      "Allowing an item with `stepUpRequired` needs `stepUp`, signed over `allow:once` or `allow:session` as the decision; denying never does.",
      "`always` is refused. Who answered is recorded as `user:<person> device:<id>` for a device. An approval answered already, or out of reach, is 404.",
    ].join(" "),
  },
  {
    operationId: "answerInboxItem", method: "POST", path: "/inbox/{id}/answer", auth: "credential", scope: "work:decide", tier: "stable", response: "DecisionAck", requestBody: "InboxAnswer", secret: true,
    pathParams: [idParam("inbox item")], errors: ["api-not-found", "api-role-needed", "step-up-required", "step-up-invalid", "inbox-answer-invalid"],
    summary: "Answer a question, a draft or a secret request",
    description: [
      "A question's answer goes to the agent as the person's message. Approving or editing a draft needs `stepUp` (decision `approve`, or `edit` with",
      "the SHA-256 of `body`, base64url, as the detail). A secret is saved to the vault, granted to the agent that asked, and never written anywhere",
      "else; saving or dismissing one takes an Admin.",
    ].join(" "),
  },
  {
    operationId: "decideWork", method: "POST", path: "/work/{id}/decisions", auth: "credential", scope: "work:decide", tier: "stable", response: "DecisionAck", requestBody: "WorkDecision",
    pathParams: [idParam("work")], errors: ["api-not-found", "api-role-needed", "decision-refused", "inbox-answer-invalid"],
    summary: "Count work as done, keep it open, put it off, or stop it",
    description: [
      "On work the person may read. `stop` cancels what runs for it and drops it; when something runs for it that cannot be cancelled from here",
      "(no trusted record of what runs), it is refused with `decision-refused` and nothing is dropped: stop it on the page.",
    ].join(" "),
  },
  {
    operationId: "getNotification", method: "GET", path: "/notifications/{seq}", auth: "credential", scope: "work:decide", tier: "stable", response: "Notification",
    pathParams: [{ name: "seq", description: "The `seq` the push carried.", schema: { type: "integer", minimum: 1, format: "int64" } }], errors: ["api-not-found"],
    summary: "The words for a wake-only push",
    description: "For a phone's notification handler: the item the change at `seq` is about, if it still waits on the person. Gone, or not theirs: 404, and the generic banner stays.",
  },
] as const satisfies readonly Operation[];
export type OperationId = (typeof OPERATIONS)[number]["operationId"];

/** The codes every operation may answer, by what it needs: what the frame itself refuses with. */
export function commonErrors(operation: Operation): ApiErrorCode[] {
  const codes: ApiErrorCode[] = [];
  if (operation.auth === "credential") codes.push("api-credential-needed", "api-credential-invalid", "api-credential-expired", "access-removed", "sign-in-limited");
  if (operation.scope !== undefined) codes.push("api-scope-needed");
  // Every POST reads a body, and a body that is not a JSON object (or not JSON) is refused with this code.
  if ((operation.query ?? []).length > 0 || (operation.pathParams ?? []).length > 0 || operation.method === "POST") codes.push("api-param-invalid");
  codes.push("api-param-unknown", "api-rate-limited", "api-internal");
  // A conflict is the same key on another body: an operation that takes no body cannot have one.
  if (operation.method === "POST") codes.push("api-idempotency-key-invalid", ...(operation.requestBody !== undefined ? ["api-idempotency-conflict" as const] : []));
  return [...codes, ...(operation.errors ?? [])];
}

/** The conventions every client relies on (docs/106 §4.1), as the OpenAPI document states them. */
export const CONVENTIONS = [
  "LumenBox client API, v1 (docs/106 §4). Additions only inside v1: a new operation, a new optional field, a new known value — each raises the revision `GET /api/v1/meta` reports.",
  "",
  "Conventions, the same for every operation:",
  "- JSON, camelCase. Ids are opaque strings: compare them, never parse them. Times are RFC 3339 in UTC, to the second (`2026-11-28T10:00:00Z`).",
  "- A field with no value is absent, never null.",
  "- A client ignores fields it does not know.",
  "- A string listed with `x-extensible-enum` is an open enumeration: a client treats a value it does not know as \"other\", shows the item's plain words, and offers to open it on the page or the desktop app when it cannot act on it.",
  "- Lists take `?limit=` (1–100) and `?cursor=` and answer `{ items, nextCursor }`; `nextCursor` is absent on the last page.",
  "- Errors are `{ code, error, requestId }`: `code` is stable and is what a program reads; `error` is a sentence in the request's language (`Accept-Language`). Every answer carries `X-Request-Id`.",
  "- An unknown path answers 404 `api-operation-unknown`; a known path with a method it does not take, 405 `api-method-not-allowed`. A resource the caller may not see answers 404 exactly as one that does not exist.",
  "- Reads carry `ETag`; a request with a matching `If-None-Match` answers 304 with no body.",
  "- Every `POST` accepts `Idempotency-Key`: a repeat within 24 hours with the same body answers the first answer —",
  "  within 30 seconds, from memory only, for an operation whose answer or request holds a secret (`x-secret-answer`: a token, or a secret for the vault).",
  "- 429 carries `Retry-After` in seconds.",
  "- A deprecated operation answers with `Deprecation` and `Sunset` headers for a full release line before it goes. Operations listed in `meta.preview` may change in any release.",
  "",
  "Credentials (`Authorization: Bearer`): a personal token (`lbxp_…`) is a person's own script; a service token (`lbxs_…`) is an integration an Admin named, limited to its view;",
  "a device credential (`lbxd_…`, fifteen minutes, renewed with its refresh token `lbxr_…` at `POST /auth/refresh`) is a person's phone or desktop client.",
  "A request body is JSON: a field the operation does not take is refused (`api-param-unknown`), and `null` is the same as absent.",
  "What a call may do is the person's role, intersected with the token's scopes, intersected with what that person may see; a token never raises anything.",
  "Cross-origin browser calls are not answered with CORS headers.",
].join("\n");
