/**
 * PoppyManager — the single entry point for Poppy protocol support.
 *
 * Coordinates discovery, identity, sessions, OAuth, UCP, and header injection.
 * The host creates one instance at startup. Agents never touch it directly:
 * their requests go through fetchPage (which calls shouldInjectHeaders →
 * headersFor) and the Poppy tools.
 *
 * Keys and tokens stay in the manager, never in model context (spec 10.1).
 *
 * `who` is whom a call acts for: the agent's id. A Poppy User is the person a personal agent
 * acts for, and in LumenBox that is an agent's own standing — two agents on one installation are
 * two Users to a Company, with their own User IDs, sessions, sign-ins and tokens. Every map below
 * is keyed by it, so one agent's sign-in is never another's credential (INV-1893).
 */

import { type AgentIdentity, loadOrCreateIdentity, clientMetadataDocument, jwksDocument } from "./identity.ts";
import { type PoppyCompany, discoverCompany, hasUcpExtension } from "./discovery.ts";
import {
  DelegatedKeyManager,
  type UserIdStore,
  FileUserIdStore,
  userIdFor,
  createSession,
  type PoppySession,
} from "./session.ts";
import {
  type AuthServerMeta,
  type DeviceCodeResponse,
  discoverAuthServer,
  buildAuthorizationUrl,
  exchangeCode,
  startDeviceAuth,
  pollDeviceToken,
  refreshToken,
  revokeToken,
  OAuthError,
} from "./oauth.ts";
import { join } from "node:path";
import { type StoredToken, TokenStore } from "./token-store.ts";
import { requestBrowserJoin, type BrowserJoinResult } from "./browser-join.ts";
import { conversationEndpoint, exchange, type ConversationState, type ConversationTurn } from "./conversations.ts";
import { destinationsOf, type Destinations } from "./destinations.ts";
import { PoppyRefused, poppyRequest } from "./http.ts";
import { approvalHeader, approvalOf, OPERATIONS_EXTENSION, operationFromApi, operationFromMcp, withMcpApproval, type Declined, type Operation } from "./operations.ts";
import { fetchUcpProfile, platformProfileUrl, ucpAgentHeader, withUcpMeta, type UcpProfile } from "./ucp.ts";

/** How long a domain found without poppy.json is not asked again. */
const NEGATIVE_TTL_MS = 10 * 60_000;

export interface PoppyManagerOptions {
  /** The agentbox home directory (~/.agentbox). */
  home: string;
  /** The HTTPS origin where this host serves (e.g. https://agent.lumenbox.ai). */
  origin: string;
  /** Where User IDs are kept. Defaults to a file beside the agent key. */
  userIdStore?: UserIdStore;
}

/**
 * An operation a Company asked for, waiting on the person's answer to a consent card, with what is
 * needed to make the same request again with the approval (Operations extension §6): the request
 * itself for an API or an MCP tool call, the conversation for a conversation.
 */
export interface PendingOperation {
  who: string;
  domain: string;
  operation: Operation;
  via: { kind: "api" | "mcp"; method: string; url: string; body?: string; headers: Record<string, string> } | { kind: "conversation"; conversationId: string };
  /** Where to tell the agent what came of it. */
  agentId: string;
  conversation: string;
  /** Which sign-in it was asked under, or none: the answer goes only under the same one. */
  signIn?: string;
}

/** A signed request's answer, as the agent sees it. */
export interface PoppyResponse {
  /** How the answer was read: a JSON-RPC (MCP) answer carries an operation differently from an API's. */
  transport: "api" | "mcp";
  status: number;
  contentType: string;
  body: string;
  /** The Company asks for approval of this before it acts. */
  operation?: Operation;
  /** The Company declined an approval. */
  declined?: Declined;
}

/** Headers the agent may not set: credentials, and the ones this host signs or names itself. */
const RESERVED_HEADERS = /^(authorization|cookie|host|content-length|poppy-.*|ucp-agent)$/i;
/** How much of an answer is kept for the agent to read. */
const MAX_ANSWER_CHARS = 40_000;

/** How the manager tells an agent what came of an operation it was waiting on. */
export type TellAgent = (agentId: string, conversation: string, text: string) => void;

export class PoppyManager {
  private identity: AgentIdentity | undefined;
  private readonly userIdStore: UserIdStore;
  private readonly home: string;
  private readonly origin: string;

  /** `who|domain` → Session. */
  private readonly sessions = new Map<string, PoppySession>();
  /** `who|domain` → DelegatedKeyManager (one per User ID). */
  private readonly keyManagers = new Map<string, DelegatedKeyManager>();
  /**
   * Domains checked and found without poppy.json, and when. Forgotten after `NEGATIVE_TTL_MS`: a
   * failed lookup is often a bad minute, not a site without Poppy, and was kept for the process's life.
   */
  private readonly negative = new Map<string, number>();
  /** Pending discovery requests, so we don't fetch poppy.json twice for the same domain. */
  private readonly pending = new Map<string, Promise<PoppyCompany | null>>();

  /** Discovered auth server metadata by issuer. Rediscovered after a restart, never assumed. */
  private readonly authServers = new Map<string, AuthServerMeta>();
  /** Persistent token store. Created after init(). */
  private tokenStore: TokenStore | undefined;
  /** Refreshes in flight by token key: two requests needing one refresh share it. */
  private readonly refreshing = new Map<string, Promise<string | undefined>>();
  /** Active OAuth authorization flows waiting for callback. */
  private readonly pendingAuthFlows = new Map<string, {
    who: string;
    server: AuthServerMeta;
    company: PoppyCompany;
    verifier: string;
    redirectUri: string;
    scopes: string[];
    startedAt: number;
  }>();
  /** Active device code flows waiting for user action. */
  private readonly pendingDeviceFlows = new Map<string, {
    who: string;
    server: AuthServerMeta;
    company: PoppyCompany;
    deviceCode: string;
    expiresAt: number;
    interval: number;
  }>();
  /** Operations waiting on a consent card, by the approval's id. */
  private readonly pendingOperations = new Map<string, PendingOperation>();
  /** UCP profiles by domain, fetched with the Company's poppy.json and kept as long as it is. */
  private readonly ucpProfiles = new Map<string, { company: PoppyCompany; profile: UcpProfile | null }>();
  /** Ongoing conversations, by `who|domain|conversationId`: the cursor and the events handled. */
  private readonly conversations = new Map<string, ConversationState>();

  constructor(options: PoppyManagerOptions) {
    this.home = options.home;
    this.origin = options.origin;
    this.userIdStore = options.userIdStore ?? new FileUserIdStore(join(options.home, "poppy-user-ids.json"));
  }

  /** Initialize: load or create the agent's key pair + token store. */
  async init(): Promise<void> {
    // Once, however many callers race to it: two first calls must not each make a key.
    this.initialising ??= (async () => {
      this.identity = await loadOrCreateIdentity(this.home, this.origin);
      this.tokenStore = new TokenStore(this.home);
    })();
    return this.initialising;
  }
  private initialising?: Promise<void>;

  /** Whether init() has been called. */
  get ready(): boolean {
    return this.identity !== undefined;
  }

  /** The agent identity, after init(). */
  getIdentity(): AgentIdentity {
    if (!this.identity) throw new Error("PoppyManager not initialized — call init() first");
    return this.identity;
  }

  // ── Discovery ─────────────────────────────────────────────────

  /**
   * Discover a Company by domain. Returns null when the domain does not
   * publish poppy.json or serves a version we do not implement.
   */
  async discover(domain: string): Promise<PoppyCompany | null> {
    const key = domain.toLowerCase();
    if (this.knownWithout(key)) return null;

    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = discoverCompany(domain).then(company => {
      this.pending.delete(key);
      if (!company) {
        this.negative.set(key, Date.now());
        return null;
      }
      return company;
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** Discover the Company for a domain AND its auth server (if any). */
  async discoverWithAuth(domain: string): Promise<{
    company: PoppyCompany;
    authServer: AuthServerMeta | null;
  } | null> {
    const company = await this.discover(domain);
    if (!company) return null;
    const authServer = company.auth?.issuer && !company.auth.disabled ? await this.authServerFor(company.auth.issuer) : null;
    return { company, authServer };
  }

  private async authServerFor(issuer: string): Promise<AuthServerMeta | null> {
    const cached = this.authServers.get(issuer);
    if (cached) return cached;
    const found = await discoverAuthServer(issuer);
    if (found) this.authServers.set(issuer, found);
    return found;
  }

  private knownWithout(domain: string): boolean {
    const at = this.negative.get(domain);
    if (at === undefined) return false;
    if (Date.now() - at < NEGATIVE_TTL_MS) return true;
    this.negative.delete(domain);
    return false;
  }

  // ── Sessions ──────────────────────────────────────────────────

  /**
   * Gets or creates `who`'s Session at a domain.
   * Returns null if the domain does not support Poppy.
   */
  async sessionFor(domain: string, who: string): Promise<PoppySession | null> {
    if (!this.identity) return null;

    const key = `${who}|${domain.toLowerCase()}`;
    const company = await this.discover(domain);
    if (!company) return null;
    // Kept only while discovery still answers with the same document (it caches for minutes): a
    // Company that moved an endpoint or changed issuer is met with what it says now.
    const existing = this.sessions.get(key);
    if (existing?.company === company) return existing;

    // By domain, not by the identifier a document claims: a site naming another Company's issuer
    // must not share that Company's User ID or delegated key, or the two could be matched.
    const userId = userIdFor(key, this.userIdStore);

    let keyMgr = this.keyManagers.get(key);
    if (!keyMgr) {
      keyMgr = new DelegatedKeyManager(this.identity);
      this.keyManagers.set(key, keyMgr);
    }

    const session = createSession(this.identity, company, userId, keyMgr);
    this.sessions.set(key, session);
    return session;
  }

  // ── Signed headers ────────────────────────────────────────────

  /**
   * The Poppy headers for `who`'s request to this URL at its Company: the Session JWT for this
   * method and URL, the version, the extensions this agent speaks, and Authorization when `who`
   * holds a token there (refreshed if needed). Only over https; empty when the URL's domain is not
   * a Poppy Company. Never throws.
   */
  async headersFor(method: string, url: string, who: string, domain?: string): Promise<Record<string, string>> {
    try {
      const target = new URL(url);
      if (target.protocol !== "https:") return {};
      const session = await this.sessionFor(domain ?? target.hostname.toLowerCase(), who);
      if (!session) return {};
      const headers = await session.headers(method, url, await this.getValidToken(who, session.company));
      return { ...headers, "Poppy-Extensions": this.extensionsFor(session.company) };
    } catch {
      return {};
    }
  }

  /** The extensions this agent declares to a Company: the ones both speak (spec 3.4). */
  private extensionsFor(company: PoppyCompany): string {
    const speaks = [OPERATIONS_EXTENSION, `"ucp";v="1"`];
    return speaks.filter(entry => company.extensions?.[entry.slice(1, entry.indexOf('"', 1))] !== undefined).join(", ") || OPERATIONS_EXTENSION;
  }

  // ── OAuth: Authorization Code Flow ────────────────────────────

  /**
   * Starts an authorization code flow for `who` at a Company.
   *
   * Returns the URL the user's browser should open, and a state value
   * that identifies this flow in the callback.
   */
  async startSignIn(domain: string, who: string, scopes?: string[]): Promise<{ url: string; state: string } | null> {
    if (!this.identity) return null;

    const discovery = await this.discoverWithAuth(domain);
    if (!discovery?.authServer?.authorizationEndpoint) return null;

    const { company, authServer } = discovery;
    const requestedScopes = scopes ?? Object.keys(company.auth?.scopes ?? {});
    const redirectUri = `${this.origin}/poppy/callback`;

    const { url, state, verifier } = await buildAuthorizationUrl({
      server: authServer,
      identity: this.identity,
      redirectUri,
      scopes: requestedScopes,
    });

    // Clean up old flows (older than 15 min).
    const cutoff = Date.now() - 15 * 60_000;
    for (const [s, flow] of this.pendingAuthFlows) {
      if (flow.startedAt < cutoff) this.pendingAuthFlows.delete(s);
    }

    this.pendingAuthFlows.set(state, { who, server: authServer, company, verifier, redirectUri, scopes: requestedScopes, startedAt: Date.now() });
    return { url, state };
  }

  /**
   * Handles the OAuth callback (code + state).
   *
   * Returns the Company name and scopes on success, or throws.
   */
  async handleCallback(code: string, state: string): Promise<{ companyName: string; scopes: string }> {
    const flow = this.pendingAuthFlows.get(state);
    if (!flow) throw new Error("Unknown or expired OAuth state");
    this.pendingAuthFlows.delete(state);

    const tokens = await exchangeCode(flow.server, this.getIdentity(), code, flow.redirectUri, flow.verifier);
    this.tokenStore?.set(TokenStore.key(flow.who, flow.company.domain), flow.server.issuer, tokens);
    return { companyName: flow.company.name, scopes: tokens.scope ?? flow.scopes.join(" ") };
  }

  // ── OAuth: Device Code Flow ───────────────────────────────────

  /**
   * Starts a device authorization flow for `who` at a Company.
   *
   * Returns a user code + URL for the user to visit on another device.
   */
  async startDeviceSignIn(domain: string, who: string, scopes?: string[]): Promise<DeviceCodeResponse | null> {
    if (!this.identity) return null;

    const discovery = await this.discoverWithAuth(domain);
    if (!discovery?.authServer?.deviceAuthorizationEndpoint) return null;

    const { company, authServer } = discovery;
    const requestedScopes = scopes ?? Object.keys(company.auth?.scopes ?? {});

    const result = await startDeviceAuth(authServer, this.identity, requestedScopes);

    this.pendingDeviceFlows.set(result.deviceCode, {
      who,
      server: authServer,
      company,
      deviceCode: result.deviceCode,
      expiresAt: Date.now() + result.expiresIn * 1000,
      interval: result.interval,
    });

    return result;
  }

  /**
   * Polls for a device code flow completion.
   * Returns true when the user has authorized, false when still pending,
   * throws when the flow expired or was denied.
   */
  async pollDeviceSignIn(deviceCode: string): Promise<boolean> {
    const flow = this.pendingDeviceFlows.get(deviceCode);
    if (!flow) throw new Error("Unknown device code flow");
    if (Date.now() > flow.expiresAt) {
      this.pendingDeviceFlows.delete(deviceCode);
      throw new Error("Device code flow expired");
    }

    const tokens = await pollDeviceToken(flow.server, this.getIdentity(), deviceCode);
    if (!tokens) return false;

    this.tokenStore?.set(TokenStore.key(flow.who, flow.company.domain), flow.server.issuer, tokens);
    this.pendingDeviceFlows.delete(deviceCode);
    return true;
  }

  // ── Token Management ──────────────────────────────────────────

  /**
   * A valid access token for `who` at this Company, refreshing if needed; undefined when there is
   * none. Only a token granted at this domain by the issuer it names now is used.
   */
  private async getValidToken(who: string, company: PoppyCompany): Promise<string | undefined> {
    const issuer = company.auth?.issuer;
    if (!this.tokenStore || !this.identity || !issuer || company.auth?.disabled) return undefined;
    const key = TokenStore.key(who, company.domain);
    const stored = this.tokenStore.get(key, issuer);
    if (!stored) return undefined;
    if (!this.tokenStore.needsRefresh(stored)) return stored.accessToken;
    if (!stored.refreshToken) return this.tokenStore.hasValid(stored) ? stored.accessToken : undefined;

    // One refresh per token at a time. Two requests that both found it stale used to refresh it
    // twice, and the loser — its refresh token already rotated away — deleted the winner's token.
    const inFlight = this.refreshing.get(key);
    if (inFlight) return inFlight;
    const refreshing = this.refresh(key, issuer, stored).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, refreshing);
    return refreshing;
  }

  private async refresh(key: string, issuer: string, stored: StoredToken): Promise<string | undefined> {
    const store = this.tokenStore;
    // Judged when it is returned, not when the refresh began: it may have lapsed while we waited.
    const stillGood = () => (store?.hasValid(stored) ? stored.accessToken : undefined);
    const server = await this.authServerFor(issuer);
    if (!server || !store || !this.identity || !stored.refreshToken) return stillGood();
    // A sign-in that landed while this refresh was out is newer than anything it brings back:
    // its answer, or its "grant gone", is about a token no longer held, and is not written.
    const superseded = () => store.get(key, issuer)?.refreshToken !== stored.refreshToken;
    try {
      const fresh = await refreshToken(server, this.identity, stored.refreshToken);
      if (superseded()) return store.get(key, issuer)?.accessToken;
      store.set(key, issuer, fresh, { refreshed: true });
      return fresh.accessToken;
    } catch (error) {
      if (superseded()) return store.get(key, issuer)?.accessToken;
      // Only the server saying the grant is finished ends it. A 503 or a dropped connection is
      // this hour's problem: the token is kept, and used while it still has time on it.
      if (error instanceof OAuthError && error.grantGone) {
        store.remove(key);
        return undefined;
      }
      return stillGood();
    }
  }

  /** Whether `who` holds a token for this domain. */
  hasTokenFor(domain: string, who: string): boolean {
    const session = this.sessions.get(`${who}|${domain.toLowerCase()}`);
    const issuer = session?.company.auth?.issuer;
    return issuer !== undefined && this.tokenStore?.get(TokenStore.key(who, domain), issuer) !== undefined;
  }

  /** Revokes and removes `who`'s token at a Company. */
  async revokeTokenFor(domain: string, who: string): Promise<void> {
    if (!this.identity || !this.tokenStore) return;
    const company = await this.discover(domain);
    const issuer = company?.auth?.issuer;
    if (!company || !issuer) return;
    const key = TokenStore.key(who, company.domain);
    const stored = this.tokenStore.get(key, issuer);
    if (!stored) return;

    const server = await this.authServerFor(issuer);
    if (server) {
      if (stored.refreshToken) {
        await revokeToken(server, this.identity, stored.refreshToken, "refresh_token");
      }
      await revokeToken(server, this.identity, stored.accessToken, "access_token");
    }
    this.tokenStore.remove(key);
  }

  // ── Destinations and UCP ──────────────────────────────────────

  /** Where `who`'s signed requests may go at this Company, with its UCP profile read alongside. */
  async destinationsFor(domain: string): Promise<{ company: PoppyCompany; destinations: Destinations } | null> {
    const company = await this.discover(domain);
    if (!company) return null;
    let ucp = this.ucpProfiles.get(company.domain.toLowerCase());
    if (ucp?.company !== company) {
      // Read again whenever poppy.json is: the profile at the domain the document validated (ucp extension §3).
      ucp = { company, profile: hasUcpExtension(company) ? await fetchUcpProfile(company.domain) : null };
      this.ucpProfiles.set(company.domain.toLowerCase(), ucp);
    }
    return { company, destinations: destinationsOf(company, ucp.profile) };
  }

  /** This Company's UCP profile, if it has one, after `destinationsFor`. */
  ucpProfileOf(domain: string): UcpProfile | null {
    return this.ucpProfiles.get(domain.toLowerCase())?.profile ?? null;
  }

  /** Whether this domain is a Company already discovered here — without asking it. */
  known(domain: string): boolean {
    return this.ucpProfiles.has(domain.toLowerCase());
  }

  // ── Browser Join (spec 6) ─────────────────────────────────────

  /**
   * Joins the agent's browser to `who`'s Session at a Company already discovered. Returns the URL
   * the box browser opens, or null when the Company doesn't offer it.
   */
  async browserJoin(domain: string, who: string): Promise<BrowserJoinResult | null> {
    const session = await this.sessionFor(domain, who);
    if (!session?.company.web?.browserSessionEndpoint) return null;
    return requestBrowserJoin(session.company, session, await this.getValidToken(who, session.company));
  }

  // ── Signed requests ───────────────────────────────────────────

  /**
   * `who`'s request to one of a Company's destinations, signed. A URL that isn't a destination is
   * refused before anything is sent. A UCP service gets the platform profile in `UCP-Agent` and, for
   * an MCP `tools/call`, in `arguments.meta["ucp-agent"]`. An answer that asks for approval comes
   * back with the operation; the caller puts it to the person.
   */
  async request(who: string, input: { method: string; url: string; body?: string; headers?: Record<string, string>; domain?: string }, approval?: string): Promise<PoppyResponse> {
    const target = new URL(input.url);
    const domain = (input.domain ?? target.hostname).toLowerCase();
    const found = await this.destinationsFor(domain);
    if (!found) throw new PoppyRefused(`${domain} is not a Poppy Company (no usable poppy.json)`);
    const kind = found.destinations.kindOf(target);
    if (kind === undefined) throw new PoppyRefused(`${target.origin}${target.pathname} is not one of ${found.company.domain}'s destinations`);
    const method = input.method.toUpperCase();
    const own = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name]) => !RESERVED_HEADERS.test(name)));
    const profile = platformProfileUrl(this.origin);
    const isMcp = kind === "ucp" && input.body !== undefined;
    const body = isMcp ? withUcpMeta(input.body!, profile) : input.body;
    const headers: Record<string, string> = {
      ...own,
      ...(body !== undefined && !Object.keys(own).some(name => /^content-type$/i.test(name)) ? { "Content-Type": "application/json" } : {}),
      ...(await this.headersFor(method, input.url, who, found.company.domain)),
      ...(kind === "ucp" ? { "UCP-Agent": ucpAgentHeader(profile) } : {}),
      ...(approval !== undefined ? { "Poppy-Approval": approval } : {}),
    };
    const response = await poppyRequest(input.url, { method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: 30_000 }, found.destinations);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const transport = isMcp || (parsed as { jsonrpc?: unknown } | undefined)?.jsonrpc === "2.0" ? "mcp" : "api";
    const asks = transport === "mcp" ? operationFromMcp(parsed) : operationFromApi(response.status, parsed);
    return { transport, status: response.status, contentType: response.headers.get("content-type") ?? "", body: text.slice(0, MAX_ANSWER_CHARS), ...asks };
  }

  // ── Conversations (spec 8) ────────────────────────────────────

  /**
   * Sends `who`'s message to a Company's agent — starting a conversation, or continuing
   * `conversationId` — and reads its reply until it has finished or `deadline` passes.
   */
  async converse(who: string, domain: string, message: { text?: string; approval?: ReturnType<typeof approvalOf> }, conversationId: string | undefined, deadline: number): Promise<ConversationTurn> {
    const found = await this.destinationsFor(domain);
    if (!found) throw new PoppyRefused(`${domain} is not a Poppy Company (no usable poppy.json)`);
    const endpoint = conversationEndpoint(found.company);
    if (!endpoint) throw new PoppyRefused(`${found.company.domain} offers no Poppy conversation`);
    const key = (id: string) => `${who}|${found.company.domain.toLowerCase()}|${id}`;
    const state = conversationId === undefined ? undefined : (this.conversations.get(key(conversationId)) ?? { conversationId, seen: new Set<string>() });
    const send = async (method: string, url: string, body?: string) => {
      const headers = { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(await this.headersFor(method, url, who, found.company.domain)) };
      return poppyRequest(url, { method, headers, ...(body !== undefined ? { body } : {}), timeoutMs: 30_000 }, found.destinations);
    };
    const result = await exchange(endpoint, send, message, state, deadline);
    this.conversations.set(key(result.state.conversationId), result.state);
    return result.turn;
  }

  // ── Operations (Operations extension v3) ──────────────────────

  /** Holds an operation until the person answers the approval `approvalId`, with the sign-in it came under. */
  awaitDecision(approvalId: string, pending: PendingOperation): void {
    this.pendingOperations.set(approvalId, { ...pending, ...this.signInOf(pending.who, pending.domain) });
  }

  private signInOf(who: string, domain: string): { signIn?: string } {
    const company = this.sessions.get(`${who}|${domain.toLowerCase()}`)?.company;
    const issuer = company?.auth?.issuer;
    const at = issuer === undefined ? undefined : this.tokenStore?.get(TokenStore.key(who, company!.domain), issuer)?.signIn;
    return at === undefined ? {} : { signIn: at };
  }

  /**
   * The person answered a consent card. If it was for a Company's operation: approved, the same
   * request is made again with the approval, through the interface that returned it; declined,
   * nothing is sent (the extension has no rejection). Either way the agent is told what came of it.
   * Anything else is not ours: ignored.
   */
  async settleApproval(approvalId: string, how: "allowed" | "refused", tell: TellAgent): Promise<void> {
    const pending = this.pendingOperations.get(approvalId);
    if (!pending) return;
    this.pendingOperations.delete(approvalId);
    const { who, domain, operation, agentId, conversation, via } = pending;
    const asked = `${domain}'s operation ${operation.operation_id}`;
    if (how === "refused") {
      tell(agentId, conversation, `The person declined ${asked}. Nothing was sent to ${domain}, so the action was not performed.`);
      return;
    }
    // Signed in as someone else since it asked: the approval would go under an account that never saw the request.
    if (this.signInOf(who, domain).signIn !== pending.signIn) {
      tell(agentId, conversation, `The person approved ${asked}, but the sign-in at ${domain} changed since it was asked, so the approval was not sent. Ask again if it is still needed.`);
      return;
    }
    if (Date.parse(operation.expires_at) < Date.now()) {
      tell(agentId, conversation, `The person approved ${asked}, but its terms expired at ${operation.expires_at}, so the approval was not sent. Ask again for current terms.`);
      return;
    }
    const approval = approvalOf(operation);
    try {
      if (via.kind === "conversation") {
        const turn = await this.converse(who, domain, { text: "The user approved this.", approval }, via.conversationId, Date.now() + 60_000);
        const said = turn.messages.map(message => message.text).filter(Boolean).join("\n\n");
        const declined = turn.declined.find(entry => entry.operation_id === operation.operation_id);
        tell(agentId, conversation, declined
          ? `The person approved ${asked}, and ${domain} declined it${declined.reason ? `: ${declined.reason}` : "."} Nothing was performed; do not send the approval again.`
          : `The person approved ${asked}; the approval was sent in conversation ${via.conversationId}.${said ? ` ${domain} said:\n\n${said}` : ` ${domain} has not replied yet.`}`);
        return;
      }
      // The same request again: an MCP tool call with the approval in its _meta, an API request with it in Poppy-Approval.
      const body = via.kind === "mcp" && via.body !== undefined ? withMcpApproval(via.body, approval) : via.body;
      const answer = await this.request(who, { method: via.method, url: via.url, ...(body !== undefined ? { body } : {}), headers: via.headers, domain }, via.kind === "api" ? approvalHeader(approval) : undefined);
      tell(agentId, conversation, answer.declined
        ? `The person approved ${asked}, and ${domain} declined it${answer.declined.reason ? `: ${answer.declined.reason}` : "."} Nothing was performed; do not send the approval again.`
        : answer.operation
          ? `The person approved ${asked}, but ${domain} answered with new terms (revision ${answer.operation.revision}); they need the person's approval again. Make the request again to put them to the person.`
          : `The person approved ${asked}; the request was made again with the approval and ${domain} answered HTTP ${answer.status}:\n\n${answer.body.slice(0, 4000)}`);
    } catch (error) {
      tell(agentId, conversation, `The person approved ${asked}, but sending the approval to ${domain} failed: ${error instanceof Error ? error.message : String(error)}. Nothing confirms the action was performed.`);
    }
  }

  // ── HTTP endpoints (served by the host's web server) ──────────

  /** The client metadata document for GET /poppy/agent.json. */
  clientMetadata(): Record<string, unknown> {
    return clientMetadataDocument(this.getIdentity());
  }

  /** The JWKS document for GET /poppy/jwks.json. */
  jwks(): { keys: Array<Record<string, unknown>> } {
    return jwksDocument(this.getIdentity());
  }

  // ── Diagnostics ───────────────────────────────────────────────

  /**
   * What `who` has: its sessions and tokens (never a token itself). Which domains were found to
   * have no poppy.json is only counted: the list is every site any agent here has fetched.
   */
  status(who: string): {
    ready: boolean;
    clientId: string | undefined;
    activeSessions: string[];
    domainsWithoutPoppy: number;
    tokens: Array<{ domain: string; issuer: string; hasAccess: boolean; hasRefresh: boolean }>;
    pendingAuthFlows: number;
    pendingDeviceFlows: number;
  } {
    const mine = `${who}|`;
    return {
      ready: this.ready,
      clientId: this.identity?.clientId,
      activeSessions: [...this.sessions.keys()].filter(key => key.startsWith(mine)).map(key => key.slice(mine.length)),
      domainsWithoutPoppy: this.negative.size,
      tokens: this.tokenStore?.status(mine).map(t => ({ domain: t.key.slice(mine.length), issuer: t.issuer, hasAccess: t.hasAccess, hasRefresh: t.hasRefresh })) ?? [],
      pendingAuthFlows: [...this.pendingAuthFlows.values()].filter(flow => flow.who === who).length,
      pendingDeviceFlows: [...this.pendingDeviceFlows.values()].filter(flow => flow.who === who).length,
    };
  }
}
