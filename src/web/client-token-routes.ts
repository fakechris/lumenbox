/**
 * Minting, listing and revoking the client API's tokens (docs/106 §4.3, INV-2213). Internal routes
 * of the page, like the side door's `/api/mcp/tokens`: `/api/v1` itself does not administer
 * credentials (docs/106 §4.2).
 *
 * - A **personal** token is minted by a person for themselves — any role, since a token never raises
 *   what its person may do — with the scopes they choose and a lifetime of at most a year.
 * - A **service** token is minted by an Admin for a named integration. It reads for that Admin, only
 *   what its view names, and only while they are an Admin; its scopes are read scopes.
 *
 * The secret is in the answer to the mint and nowhere else; `tokens.jsonl` records who minted and
 * revoked what (token-ledger.ts). A mint from a page session needs a recent sign-in (recent-sign-in.ts,
 * INV-2318), and its record says when that was.
 */

import { type Principals, type Role, roleAtLeast, soleAdmin } from "../host/principals.ts";
import { type ApiError, apiError } from "./api-error.ts";
import { EMPTY_VIEW, SCOPE_NAMES, SERVICE_SCOPES, type Scope, type ServiceView } from "./client-api/schema.ts";
import type { McpTokenStore } from "./mcp-tokens.ts";

const DAY_MS = 24 * 60 * 60_000;
export const CLIENT_TOKEN_MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

export interface ClientTokenDeps {
  readJson(): Promise<Record<string, unknown>>;
  /** Who is signed in; absent for the installation's own credential (the operator, at the local level). */
  userId: string | undefined;
  role: Role;
  principals: Pick<Principals, "list" | "resolve" | "isKnown" | "byId">;
  tokens: Pick<McpTokenStore, "mintClient" | "listClient" | "revokeClient">;
  /** Whether this request's sign-in is recent enough to mint (recent-sign-in.ts): its time, or the refusal. */
  freshSignIn(): { ok: true; signedInAt?: string } | { ok: false; error: ApiError };
  now?: () => Date;
}

type Answer = { status: number; body: unknown };
const refused = (why: string): Answer => ({ status: 400, body: apiError("client-token-invalid", { why }) });

const ids = (value: unknown): string[] | undefined =>
  value === undefined ? [] : Array.isArray(value) && value.length <= 100 && value.every(item => typeof item === "string" && item.length > 0 && item.length <= 200) ? [...new Set(value as string[])] : undefined;

/** A view from a request body: every field checked, nothing assumed; what is not named is not visible. */
function viewOf(value: unknown): ServiceView | string {
  if (value === undefined) return { ...EMPTY_VIEW };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "view must be an object";
  const raw = value as Record<string, unknown>;
  const agentIds = ids(raw.agentIds), workIds = ids(raw.workIds);
  if (agentIds === undefined || workIds === undefined) return "agentIds and workIds are lists of at most 100 ids";
  for (const key of ["allAgents", "allWork", "conversationText"] as const) if (raw[key] !== undefined && typeof raw[key] !== "boolean") return `${key} is true or false`;
  return { allAgents: raw.allAgents === true, agentIds, allWork: raw.allWork === true, workIds, conversationText: raw.conversationText === true };
}

/** Answers the three routes; undefined for any other. */
export async function clientTokenRoute(route: string, deps: ClientTokenDeps): Promise<Answer | undefined> {
  if (route !== "GET /api/client-tokens" && route !== "POST /api/client-tokens" && route !== "POST /api/client-tokens/revoke") return undefined;
  const isAdmin = roleAtLeast(deps.role, "admin");
  // Nobody signed in is the installation's one Admin (INV-1681), as for side-door tokens.
  const me = deps.userId === undefined ? soleAdmin(deps.principals.list()) : deps.principals.isKnown(deps.userId) ? deps.principals.resolve(deps.userId).id : undefined;

  if (route === "GET /api/client-tokens") {
    return { status: 200, body: {
      tokens: deps.tokens.listClient().filter(token => isAdmin || token.principalId === me).map(token => ({ ...token, mine: token.principalId === me })),
      scopes: SCOPE_NAMES, serviceScopes: SERVICE_SCOPES, maxDays: CLIENT_TOKEN_MAX_DAYS,
    } };
  }

  const body = await deps.readJson().catch(() => undefined);
  if (body === undefined || typeof body !== "object" || Array.isArray(body)) return { status: 400, body: apiError("body-invalid") };
  const by = deps.userId ?? "operator";

  if (route === "POST /api/client-tokens/revoke") {
    const done = deps.tokens.revokeClient(String(body.id ?? ""), token => isAdmin || token.principalId === me, by);
    return done ? { status: 200, body: { revoked: true } } : { status: 404, body: apiError("token-not-yours") };
  }

  const fresh = deps.freshSignIn();
  if (!fresh.ok) return { status: 403, body: fresh.error };
  const kind = body.kind === "service" ? "service" : body.kind === undefined || body.kind === "personal" ? "personal" : undefined;
  if (kind === undefined) return refused("kind is personal or service");
  // The operator may name the person, as for side-door tokens: an installation with several Admins has no one to assume.
  const named = deps.userId === undefined && typeof body.principalId === "string" ? deps.principals.byId(body.principalId)?.id : undefined;
  const holder = named ?? me;
  if (kind === "service" && (!isAdmin || (named !== undefined && deps.principals.byId(named)?.role !== "admin"))) return { status: 403, body: apiError("role-needed", { need: "admin", role: deps.role }) satisfies ApiError };
  if (holder === undefined) return { status: 400, body: apiError("token-needs-person", { admins: deps.principals.list().filter(person => person.role === "admin").length }) };
  const allowed: readonly Scope[] = kind === "service" ? SERVICE_SCOPES : SCOPE_NAMES;
  const scopes = body.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(scope => allowed.includes(scope as Scope))) return refused(`scopes is a list from ${allowed.join(", ")}`);
  const days = body.expiresInDays === undefined ? DEFAULT_DAYS : body.expiresInDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > CLIENT_TOKEN_MAX_DAYS) return refused(`expiresInDays is a whole number from 1 to ${CLIENT_TOKEN_MAX_DAYS}`);
  const view = kind === "service" ? viewOf(body.view) : undefined;
  if (typeof view === "string") return refused(view);
  if (kind === "personal" && body.view !== undefined) return refused("only a service token has a view");
  const now = (deps.now ?? (() => new Date()))();
  const minted = deps.tokens.mintClient({
    kind, principalId: holder, label: String(body.label ?? ""), scopes: scopes as Scope[], expiresAt: new Date(now.getTime() + days * DAY_MS), by, now,
    ...(view !== undefined ? { view } : {}), ...(fresh.signedInAt !== undefined ? { signedInAt: fresh.signedInAt } : {}),
  });
  return { status: 200, body: { token: minted.token, credential: minted.credential } };
}
