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
export const API_REVISION = 0;
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
  maxLength?: number;
  pattern?: string;
  /** Known values of an open enumeration: a reader treats any other value as "other". */
  "x-extensible-enum"?: string[];
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

// --- errors -----------------------------------------------------------------------------------

/** Every code `/api/v1` answers with, and its status. The words are `err.<code>` in `src/i18n/server-errors.ts`. */
export const ERRORS = {
  "api-operation-unknown": { status: 404, meaning: "No operation has this method and path." },
  "api-method-not-allowed": { status: 405, meaning: "The path exists and does not take this method; `Allow` names those it takes." },
  "api-credential-needed": { status: 401, meaning: "The operation needs `Authorization: Bearer <token>`." },
  "api-credential-invalid": { status: 401, meaning: "The token is not one this installation issued, or it was revoked." },
  "api-credential-expired": { status: 401, meaning: "The token's lifetime is over." },
  "access-removed": { status: 401, meaning: "The person the token acts for no longer has access. A client drops what it stored for this installation." },
  "api-scope-needed": { status: 403, meaning: "The token does not carry the scope the operation needs." },
  "api-param-invalid": { status: 400, meaning: "A parameter has a value the operation does not take." },
  "api-param-unknown": { status: 400, meaning: "The operation takes no parameter of this name." },
  "api-idempotency-key-invalid": { status: 400, meaning: "`Idempotency-Key` is 8 to 128 of A–Z, a–z, 0–9, `_ . : -`." },
  "api-idempotency-conflict": { status: 409, meaning: "This `Idempotency-Key` was used within 24 hours for a different request." },
  "api-rate-limited": { status: 429, meaning: "Too many requests; wait the seconds `Retry-After` names." },
  "sign-in-limited": { status: 429, meaning: "Too many tries with tokens that did not work from this address; wait the seconds `Retry-After` names." },
  "api-internal": { status: 500, meaning: "The server failed; `requestId` names the failure in its log." },
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
} as const satisfies Record<string, Schema>;
export type SchemaName = keyof typeof SCHEMAS;

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
  /** Codes this operation answers beyond those every operation of its kind may (`commonErrors`). */
  errors?: ApiErrorCode[];
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
] as const satisfies readonly Operation[];
export type OperationId = (typeof OPERATIONS)[number]["operationId"];

/** The codes every operation may answer, by what it needs: what the frame itself refuses with. */
export function commonErrors(operation: Operation): ApiErrorCode[] {
  const codes: ApiErrorCode[] = [];
  if (operation.auth === "credential") codes.push("api-credential-needed", "api-credential-invalid", "api-credential-expired", "access-removed", "sign-in-limited");
  if (operation.scope !== undefined) codes.push("api-scope-needed");
  if ((operation.query ?? []).length > 0 || (operation.pathParams ?? []).length > 0) codes.push("api-param-invalid");
  codes.push("api-param-unknown", "api-rate-limited", "api-internal");
  if (operation.method === "POST") codes.push("api-idempotency-key-invalid", "api-idempotency-conflict");
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
  "- Every `POST` accepts `Idempotency-Key`: a repeat within 24 hours with the same body answers the first answer.",
  "- 429 carries `Retry-After` in seconds.",
  "- A deprecated operation answers with `Deprecation` and `Sunset` headers for a full release line before it goes. Operations listed in `meta.preview` may change in any release.",
  "",
  "Credentials (`Authorization: Bearer`): a personal token (`lbxp_…`) is a person's own script; a service token (`lbxs_…`) is an integration an Admin named, limited to its view.",
  "What a call may do is the person's role, intersected with the token's scopes, intersected with what that person may see; a token never raises anything.",
  "Cross-origin browser calls are not answered with CORS headers.",
].join("\n");
