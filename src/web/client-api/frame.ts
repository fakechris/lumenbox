/**
 * Every `/api/v1` request, in one order (docs/106 §4): the route table, then the credential, then
 * the limits, then the scope, then the parameters, then the handler; and every answer in one shape —
 * a documented resource with `ETag`, or `{ code, error, requestId }`. A handler returns a resource
 * built from internal objects (docs/106 §4.1) or throws `refuse(code)`; it never writes a response.
 *
 * The credential is the client API's own (personal and service tokens, `McpTokenStore`; a device's
 * access token, `DeviceStore`): the page's cookie and the installation token are not accepted here. Mounted before the page's gate, like the
 * side door; the Origin check exempts a request with a bearer credential (browser-guard.ts, R5).
 */

import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Role } from "../../host/principals.ts";
import type { Task } from "../../host/tasks.ts";
import type { Locale } from "../../i18n/locale.ts";
import type { BoardItem } from "../board-order.ts";
import { requestLocaleOf } from "../page-locale.ts";
import type { Reach } from "../reach.ts";
import type { ChangeLedger } from "./change-ledger.ts";
import { apiError, localizedBody } from "../api-error.ts";
import { type IdempotencyStore, KEY_PATTERN } from "../idempotency.ts";
import type { ClientCredential, McpTokenStore } from "../mcp-tokens.ts";
import type { DeviceAuth } from "./auth.ts";
import type { ChatAccess } from "./conversations.ts";
import type { DecisionAccess } from "./inbox.ts";
import { matchRoute, readBody, readParams, type ParamValue } from "./routes.ts";
import { HANDLERS } from "./handlers.ts";
import { API_PREFIX, ERRORS, OPERATIONS, UPLOAD_MAX_BYTES, type ApiErrorCode, type Operation, type OperationId } from "./schema.ts";

/** The person a credential acts for, as the roster has them now. */
export interface ClientPerson {
  id: string;
  name: string;
  role: Role;
}

export interface Caller {
  credential: ClientCredential;
  person: ClientPerson;
}

/** An agent as the registry and the bus know it now: what `Agent` is built from. */
export interface AgentFact {
  id: string;
  name: string;
  title?: string;
  description: string;
  boxId: string;
  boxName: string;
  teams: readonly string[];
  /** Kept out of listings by its profile. */
  hidden: boolean;
  /** In a turn now. */
  working: boolean;
}

/** What the read operations read, as the server has it at the moment of the call (mount.ts wires it). */
export interface ClientWorld {
  /** What this person may read: the page's own answer (reach.ts). */
  reachOf(person: ClientPerson): Reach;
  agents(): readonly AgentFact[];
  tasks(): readonly Task[];
  /** What the person owes and what others wait on, among these tasks, as the page's attention lists it (attention.ts). */
  attention(person: ClientPerson, tasks: readonly Task[]): { mine: readonly BoardItem[]; theirs: readonly BoardItem[] };
  /** Who an id in a task's history is: a person or an agent; undefined for the installation's own bookkeepers. */
  actor(id: string): { kind: "person" | "agent"; name: string } | undefined;
  /** The durable change ledger (change-ledger.ts). */
  changes: Pick<ChangeLedger, "latest" | "after" | "onAppend" | "onClose">;
  /** Writes what changed in the agents since the ledger last said; called before a read of the ledger. */
  noteAgents(): void;
}

export interface ClientApiDeps {
  world: ClientWorld;
  /** Every credential `/api/v1` takes: personal and service tokens, and devices' access tokens (`removed`: a device that was ended). */
  tokens: {
    clientFor(presented: string | undefined, now: Date): ReturnType<McpTokenStore["clientFor"]> | { refused: "removed" };
    touch(id: string, now: Date): string;
  };
  /** Device sign-in, refresh and the person's devices (auth.ts, devices.ts). */
  devices: DeviceAuth;
  /** What waits on a person, and their answers (inbox.ts). */
  decisions: DecisionAccess;
  /** Conversations: what was said, sending, stopping, files, the live stream (conversations.ts). */
  chat: ChatAccess;
  /** The roster person with this id, now; undefined once they are gone. */
  person(id: string): ClientPerson | undefined;
  installationMode(): "single-machine" | "organisation";
  /** The server's version, as `meta.server`. */
  version: string;
  /** The agent a direct message from this person reaches, if any. */
  homeAgentOf(personId: string): string | undefined;
  /** The sign-in limiter (R4): how long this address must wait, and a try that did not get in. */
  signIns: { blocked(req: IncomingMessage): number | undefined; failed(req: IncomingMessage, reason: string): void; succeeded(req: IncomingMessage, account: string): void };
  /** The address a request came from, as the sign-in limiter reads it. */
  address(req: IncomingMessage): string;
  idempotency: IdempotencyStore;
  /** For answers that hold a token: memory only, 30 seconds (schema.ts `secret`). */
  secretIdempotency: IdempotencyStore;
  log(line: string): void;
  now?: () => Date;
  /** Requests a credential, or an address with none, may make per window. */
  limits?: { credential: number; address: number; windowMs: number };
}

export interface Call {
  operation: Operation;
  params: Record<string, ParamValue>;
  /** A `POST`'s body, checked against the operation's `requestBody`; empty for any other. */
  body: Record<string, unknown>;
  /** An `upload` operation's body: the bytes and the `Content-Type` they came with. */
  upload?: { bytes: Buffer; type: string };
  /** Absent only for an operation answered without a credential. */
  caller?: Caller;
  deps: ClientApiDeps;
  requestId: string;
  /** The request's language, for the few words a resource carries for a person (a board column's title). */
  locale: Locale;
  /** Whether the credential still works and its person still has access: what a long-lived stream asks before each event. */
  stillValid(): boolean;
  /** A stream says how it ends; `recheckStreams` ends it the moment its credential stops being valid. Returns the undo, for when it ends on its own. */
  track(end: () => void): () => void;
  /** A credential tried in the body did not work (`signIn` operations): a sign-in try, limited and on the record (R4). */
  signInFailed(reason: string): void;
  /** One that worked, for `account` (a person's id): on the record, and that account's count cleared. */
  signInSucceeded(account: string): void;
}

/** What a stream operation's handler answers: it writes the response itself, after the frame has said yes. */
export interface Stream {
  open(req: IncomingMessage, res: ServerResponse, requestId: string): void;
}
const STREAM = Symbol("stream");
export const stream = (open: Stream["open"]): Stream & { [STREAM]: true } => ({ open, [STREAM]: true });
const isStream = (value: unknown): value is Stream => typeof value === "object" && value !== null && STREAM in value;

export type Handler = (call: Call) => unknown;
export type Handlers = { readonly [K in OperationId]: Handler };

/** What a handler throws to refuse: a code from `schema.ts`, and the blanks of its words. */
export class Refused extends Error {
  constructor(readonly code: ApiErrorCode, readonly vars: Record<string, string | number> = {}, readonly headers: Record<string, string> = {}) {
    super(code);
  }
}
export const refuse = (code: ApiErrorCode, vars: Record<string, string | number> = {}): never => { throw new Refused(code, vars); };

/**
 * Counts requests per key in fixed windows: enough to answer 429 before a loop takes the server down.
 * At most `keys` windows are kept; past that the least recently used go first, so many addresses
 * arriving at once cannot reset the count of one that is still calling.
 */
export class Window {
  private readonly counts = new Map<string, { start: number; count: number }>();
  constructor(private readonly windowMs: number, private readonly keys = 10_000) {}
  /** Seconds to wait, or undefined when this request fits. */
  take(key: string, limit: number, now: number): number | undefined {
    const current = this.counts.get(key);
    if (current === undefined || now - current.start >= this.windowMs) {
      // The map's order is the order of last use: a new window goes to the back, as does each use below.
      this.counts.delete(key);
      this.counts.set(key, { start: now, count: 1 });
      for (const oldest of this.counts.keys()) {
        if (this.counts.size <= this.keys) break;
        this.counts.delete(oldest);
      }
      return undefined;
    }
    current.count += 1;
    this.counts.delete(key);
    this.counts.set(key, current);
    return current.count > limit ? Math.max(1, Math.ceil((current.start + this.windowMs - now) / 1000)) : undefined;
  }
}

const DEFAULT_LIMITS = { credential: 600, address: 120, windowMs: 60_000 };

/** A strong validator for a body: the same bytes, the same tag. */
const etagOf = (payload: string): string => `"${createHash("sha256").update(payload).digest("base64url").slice(0, 32)}"`;
const matches = (header: string | undefined, etag: string): boolean =>
  header?.split(",").map(part => part.trim().replace(/^W\//, "")).some(part => part === etag || part === "*") === true;

export function clientApi(deps: ClientApiDeps, table: { operations: readonly Operation[]; handlers: Partial<Record<string, Handler>> } = { operations: OPERATIONS, handlers: HANDLERS }) {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const window = new Window(limits.windowMs);
  const now = () => (deps.now ?? (() => new Date()))();
  /** Streams open now, each with how to tell whether it may go on and how to end it. */
  const streams = new Set<{ stillValid(): boolean; end(): void }>();

  function write(res: ServerResponse, status: number, requestId: string, payload: string | undefined, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      ...(payload !== undefined ? { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(payload)) } : {}),
      "x-request-id": requestId, "cache-control": "private, no-cache", vary: "Authorization, Accept-Language", ...headers,
    });
    res.end(payload);
  }

  const errorBody = (req: IncomingMessage, requestId: string, refusal: Refused) => ({ ...(localizedBody(apiError(refusal.code, refusal.vars), req) as object), requestId });

  /** Who is calling, or the refusal. Counts a token that did not work as a try (R4), as the side door does. */
  function authenticate(req: IncomingMessage): Caller {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
    if (bearer === undefined) throw new Refused("api-credential-needed");
    const wait = deps.signIns.blocked(req);
    if (wait !== undefined) throw new Refused("sign-in-limited", { seconds: wait }, { "retry-after": String(wait) });
    const found = deps.tokens.clientFor(bearer, now());
    if ("refused" in found) {
      if (found.refused === "invalid") { deps.signIns.failed(req, "unknown-token"); throw new Refused("api-credential-invalid"); }
      // A device that was ended: told so, never counted as a guess — it is the device's own token.
      if (found.refused === "removed") throw new Refused("access-removed");
      throw new Refused("api-credential-expired");
    }
    const person = deps.person(found.credential.principalId);
    // A service token reads for its Admin while they are one; a personal token for its person while they are on the roster.
    if (person === undefined || (found.credential.kind === "service" && person.role !== "admin")) throw new Refused("access-removed");
    return { credential: found.credential, person };
  }

  /** The same credential, judged again without counting a try: still issued, still in time, its person still there. */
  function recheck(req: IncomingMessage, caller: Caller): boolean {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
    const found = deps.tokens.clientFor(bearer, now());
    if ("refused" in found || found.credential.id !== caller.credential.id) return false;
    const person = deps.person(found.credential.principalId);
    return person !== undefined && !(found.credential.kind === "service" && person.role !== "admin");
  }

  function limited(key: string, limit: number): void {
    const wait = window.take(key, limit, now().getTime());
    if (wait !== undefined) throw new Refused("api-rate-limited", { seconds: wait }, { "retry-after": String(wait) });
  }

  /** A file's bytes, at most `UPLOAD_MAX_BYTES`: refused before reading when the declared length is over, and when the bytes go over. */
  async function readRawBody(req: IncomingMessage): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > UPLOAD_MAX_BYTES) throw new Refused("upload-too-large");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > UPLOAD_MAX_BYTES) throw new Refused("upload-too-large");
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > 1_000_000) throw new Refused("api-param-invalid", { name: "body", why: "at most 1 MB" });
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Refused("api-param-invalid", { name: "body", why: "JSON" }); }
  }

  /** Answers a `/api/v1` request; false for any other path, which the caller handles. */
  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;
    const requestId = randomUUID();
    let idempotencyKey: string | undefined, settleIn: IdempotencyStore = deps.idempotency;
    try {
      const match = matchRoute(req.method ?? "GET", url.pathname, table.operations);
      if (match.kind === "unknown") throw new Refused("api-operation-unknown", { route: `${req.method ?? ""} ${url.pathname}` });
      if (match.kind === "method") throw new Refused("api-method-not-allowed", { method: req.method ?? "", allowed: match.allowed.join(", ") }, { allow: match.allowed.join(", ") });
      if (match.kind === "malformed") throw new Refused("api-param-invalid", { name: match.name, why: "percent-encoded UTF-8" });
      const operation = match.operation;
      let caller = operation.auth === "credential" ? authenticate(req) : undefined;
      limited(caller === undefined ? `address:${deps.address(req)}` : `credential:${caller.credential.id}`, caller === undefined ? limits.address : limits.credential);
      if (caller !== undefined && operation.scope !== undefined && !caller.credential.scopes.includes(operation.scope)) throw new Refused("api-scope-needed", { scope: operation.scope });
      const read = readParams(operation, match.pathParams, url.searchParams);
      if ("code" in read) throw new Refused(read.code, { name: read.vars.name, why: read.vars.why ?? "" });
      // A credential in the body is a sign-in try: an address that is waiting is refused before it is looked at (R4).
      if (operation.signIn === true) { const wait = deps.signIns.blocked(req); if (wait !== undefined) throw new Refused("sign-in-limited", { seconds: wait }, { "retry-after": String(wait) }); }
      const bytes = operation.upload === true ? await readRawBody(req) : undefined;
      const upload = bytes === undefined ? undefined : { bytes, type: String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() };
      // An upload's request, for a repeat: what it is for and a digest of its bytes.
      const raw = upload !== undefined ? { query: read.values, type: upload.type, sha256: createHash("sha256").update(upload.bytes).digest("hex") } : operation.method === "POST" ? await readJsonBody(req) : {};
      const body = upload !== undefined ? { values: {} } : readBody(operation, raw);
      if ("code" in body) throw new Refused(body.code, { name: body.vars.name, why: body.vars.why ?? "" });
      // This request is a use: what it answers already says so.
      if (caller !== undefined) caller = { ...caller, credential: { ...caller.credential, lastUsedAt: deps.tokens.touch(caller.credential.id, now()) } };
      const handler = table.handlers[operation.operationId];
      if (handler === undefined) throw new Error(`no handler for ${operation.operationId}`);
      const stillValid = (): boolean => { try { return caller === undefined || recheck(req, caller); } catch { return false; } };
      const track = (end: () => void) => { const entry = { stillValid, end }; streams.add(entry); return () => { streams.delete(entry); }; };
      const call: Call = {
        operation, params: read.values, body: body.values, ...(upload !== undefined ? { upload } : {}), ...(caller !== undefined ? { caller } : {}), deps, requestId, locale: requestLocaleOf(req), stillValid, track,
        signInFailed: reason => deps.signIns.failed(req, reason), signInSucceeded: account => deps.signIns.succeeded(req, account),
      };
      if (operation.stream === true) {
        const opened = await handler(call);
        if (!isStream(opened)) throw new Error(`${operation.operationId} is a stream and answered something else`);
        opened.open(req, res, requestId);
        return true;
      }

      if (operation.method === "POST") {
        // A repeat of a POST within 24 hours answers the first answer; the key is the credential's own.
        // An answer that holds a token is kept in memory for 30 seconds, never in the file (schema.ts `secret`).
        const store = operation.secret === true ? deps.secretIdempotency : deps.idempotency;
        const noStore: Record<string, string> = operation.secret === true ? { "cache-control": "no-store" } : {};
        const header = req.headers["idempotency-key"];
        const key = typeof header === "string" ? header : undefined;
        if (key !== undefined && !KEY_PATTERN.test(key)) throw new Refused("api-idempotency-key-invalid");
        // One credential's key is not another's: the stored key is the key with whose and which operation, hashed to a fixed length.
        const scoped = key === undefined ? undefined : createHash("sha256").update(`${caller?.credential.id ?? "anyone"}\n${operation.operationId}\n${key}`).digest("hex");
        // The target is part of the request: one key and one body sent to two approvals is two requests (a conflict), not a replay.
        const claim = store.claim(scoped, Object.keys(match.pathParams).length > 0 ? { path: match.pathParams, body: raw } : raw);
        if (claim.kind === "invalid") throw new Refused("api-idempotency-key-invalid");
        if (claim.kind === "conflict") throw new Refused("api-idempotency-conflict");
        if (claim.kind === "replay") { const reply = await claim.reply; write(res, reply.status, requestId, JSON.stringify(reply.body), { "idempotent-replayed": "true", ...noStore }); return true; }
        if (claim.kind === "fresh") { idempotencyKey = scoped; settleIn = store; }
        const answer = await handler(call);
        store.settle(idempotencyKey, { status: 200, body: answer });
        idempotencyKey = undefined;
        write(res, 200, requestId, JSON.stringify(answer), noStore);
        return true;
      }

      // Only a read has a validator: a DELETE answers what it did, once.
      if (operation.method !== "GET") { write(res, 200, requestId, JSON.stringify(await handler(call))); return true; }
      const payload = JSON.stringify(await handler(call));
      const etag = etagOf(payload);
      if (matches(req.headers["if-none-match"], etag)) { write(res, 304, requestId, undefined, { etag }); return true; }
      write(res, 200, requestId, payload, { etag });
    } catch (error) {
      const refusal = error instanceof Refused ? error : new Refused("api-internal", { requestId });
      if (!(error instanceof Refused)) deps.log(`client api ${requestId}: ${req.method} ${url.pathname}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      const status = ERRORS[refusal.code].status, body = errorBody(req, requestId, refusal);
      // A refused POST is refused again on a repeat, with the same words: the first answer is the answer.
      if (idempotencyKey !== undefined) settleIn.settle(idempotencyKey, { status, body });
      if (!res.headersSent) write(res, status, requestId, JSON.stringify(body), refusal.headers);
    }
    return true;
  }

  /** Ends every open stream whose credential no longer works: called the moment a device or a person's access ends. */
  function recheckStreams(): void {
    for (const entry of [...streams]) if (!entry.stillValid()) { streams.delete(entry); entry.end(); }
  }

  return { handle, recheckStreams };
}
