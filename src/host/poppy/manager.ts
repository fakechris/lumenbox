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
import { UcpClient } from "./ucp.ts";
import { requestBrowserJoin, type BrowserJoinResult } from "./browser-join.ts";
import {
  conversationEndpoint,
  sendMessage,
  type ConversationEndpoint,
  type ConversationEventHandler,
} from "./conversations.ts";
import {
  type Operation,
  type OperationDecision,
  type OperationResult,
  respondToOperation,
  policyLevel,
  consentDescription,
} from "./operations.ts";

/** How long a domain found without poppy.json is not asked again. */
const NEGATIVE_TTL_MS = 10 * 60_000;

export interface PoppyManagerOptions {
  /** The agentbox home directory (~/.agentbox). */
  home: string;
  /** The HTTPS origin where this host serves (e.g. https://agent.lumenbox.ai). */
  origin: string;
  /** Where User IDs are kept. Defaults to a file beside the agent key. */
  userIdStore?: UserIdStore;
  /** Whether to auto-discover poppy.json on every fetchPage domain. Defaults to true. */
  autoDiscover?: boolean;
}

/** An operation a Company asked for, waiting on a person's answer to a consent card. */
export interface PendingOperation {
  who: string;
  domain: string;
  operation: Operation;
  /** Where to tell the agent what came of it. */
  agentId: string;
  conversation: string;
  /** Which sign-in it was asked under, or none: the answer goes only under the same one. */
  signIn?: string;
}

/** How the manager tells an agent what came of an operation it was waiting on. */
export type TellAgent = (agentId: string, conversation: string, text: string) => void;

export class PoppyManager {
  private identity: AgentIdentity | undefined;
  private readonly userIdStore: UserIdStore;
  private readonly home: string;
  private readonly origin: string;
  private readonly autoDiscover: boolean;

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

  constructor(options: PoppyManagerOptions) {
    this.home = options.home;
    this.origin = options.origin;
    this.userIdStore = options.userIdStore ?? new FileUserIdStore(join(options.home, "poppy-user-ids.json"));
    this.autoDiscover = options.autoDiscover ?? true;
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

  // ── Header injection ──────────────────────────────────────────

  /**
   * Whether a request to this URL should carry Poppy headers. Only over https: a signed session
   * and a bearer token are not sent where anyone on the path can read them. Discovery (poppy.json
   * itself) and OAuth endpoints do not carry the header.
   */
  shouldInjectHeaders(url: string): boolean {
    if (!this.autoDiscover || !this.identity) return false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      if (parsed.pathname === "/.well-known/poppy.json") return false;
      if (parsed.pathname.startsWith("/.well-known/oauth")) return false;
      return !this.knownWithout(parsed.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Returns Poppy headers for `who`'s request, or an empty object when the domain does not
   * support Poppy. Includes Authorization when `who` has a token for this domain (refreshing it
   * if needed). Never throws.
   */
  async headersFor(method: string, url: string, who: string, accessToken?: string): Promise<Record<string, string>> {
    try {
      if (!this.shouldInjectHeaders(url)) return {};
      const domain = new URL(url).hostname.toLowerCase();
      const session = await this.sessionFor(domain, who);
      if (!session) return {};
      const token = accessToken ?? (await this.getValidToken(who, session.company));
      return session.headers(method, url, token);
    } catch {
      return {};
    }
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

  // ── UCP ───────────────────────────────────────────────────────

  /**
   * Creates a UCP client for `who` at a Poppy-enabled Company with UCP support.
   * Returns null if the Company doesn't support UCP.
   */
  async ucpClientFor(domain: string, who: string): Promise<UcpClient | null> {
    const session = await this.sessionFor(domain, who);
    if (!session || !hasUcpExtension(session.company)) return null;
    return new UcpClient(session.company, session, await this.getValidToken(who, session.company));
  }

  // ── Browser Join (spec 8.3) ────────────────────────────────────

  /**
   * Joins the agent's browser session to `who`'s Poppy Session.
   *
   * Returns a URL the box browser should navigate to, which associates it
   * with the Poppy Session. Returns null if the Company doesn't support it.
   */
  async browserJoin(domain: string, who: string): Promise<BrowserJoinResult | null> {
    const session = await this.sessionFor(domain, who);
    if (!session?.company.web?.browserSessionEndpoint) return null;
    return requestBrowserJoin(session.company, session, await this.getValidToken(who, session.company));
  }

  // ── Conversations (spec 8.2) ──────────────────────────────────

  /**
   * Finds the conversation endpoint for a Company.
   */
  async conversationEndpointFor(domain: string): Promise<ConversationEndpoint | null> {
    const company = await this.discover(domain);
    if (!company) return null;
    return conversationEndpoint(company);
  }

  /**
   * Sends `who`'s message to a Company's agent and streams the response.
   *
   * Returns an AbortController to cancel the stream.
   */
  async converse(
    domain: string,
    who: string,
    message: string,
    onEvent: ConversationEventHandler,
    options?: { conversationId?: string },
  ): Promise<AbortController | null> {
    const session = await this.sessionFor(domain, who);
    if (!session) return null;
    const ep = conversationEndpoint(session.company);
    if (!ep) return null;
    return sendMessage(ep, session, message, onEvent, {
      accessToken: await this.getValidToken(who, session.company),
      conversationId: options?.conversationId,
    });
  }

  // ── Operations (spec 8.4) ─────────────────────────────────────

  /**
   * Responds to a Company's operation request (approve/reject) as `who`.
   *
   * Called when the person has answered the consent card made from the operation.
   */
  async respondToOperation(domain: string, who: string, operation: Operation, decision: OperationDecision): Promise<OperationResult> {
    const session = await this.sessionFor(domain, who);
    if (!session) return { success: false, message: "No session for domain" };
    return respondToOperation(operation, decision, session, await this.getValidToken(who, session.company));
  }

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
   * The person answered a consent card. If it was for a Company's operation, the Company is told
   * the answer, and the agent is told what the Company said. Anything else is not ours: ignored.
   */
  async settleApproval(approvalId: string, how: "allowed" | "refused", tell: TellAgent): Promise<void> {
    const pending = this.pendingOperations.get(approvalId);
    if (!pending) return;
    this.pendingOperations.delete(approvalId);
    const { who, domain, operation, agentId, conversation } = pending;
    const approved = how === "allowed";
    const asked = `${operation.type} (${operation.id}) at ${domain}`;
    // Signed in as someone else since it asked: the answer would go under an account that never saw the request.
    if (this.signInOf(who, domain).signIn !== pending.signIn) {
      const said = approved ? "approved" : "declined";
      tell(agentId, conversation, `The person ${said} the Poppy operation ${asked}, but the sign-in at ${domain} changed since it was asked, so the answer was not sent. Ask ${domain} again if it is still needed.`);
      return;
    }
    let result: OperationResult;
    try {
      result = await this.respondToOperation(domain, who, operation, { approved, ...(approved ? {} : { reason: "declined by the person" }) });
    } catch (error) {
      result = { success: false, message: error instanceof Error ? error.message : String(error) };
    }
    const outcome = result.success
      ? `${domain} was told, and accepted the answer${result.message ? `: ${result.message}` : "."}`
      : `but telling ${domain} failed: ${result.message ?? "no reason given"}. Nothing confirms the Company acted on it.`;
    tell(agentId, conversation, `The person ${approved ? "approved" : "declined"} the Poppy operation ${asked}; ${outcome}`);
  }

  /**
   * Maps an operation to a policy gate level (2/3/4).
   */
  operationPolicyLevel(operation: Operation): 2 | 3 | 4 {
    return policyLevel(operation);
  }

  /**
   * Builds a consent card description from an operation.
   */
  operationConsentDescription(operation: Operation): string {
    return consentDescription(operation);
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
