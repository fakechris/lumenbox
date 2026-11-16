/**
 * PoppyManager — the single entry point for Poppy protocol support.
 *
 * Coordinates discovery, identity, sessions, OAuth, UCP, and header injection.
 * The host creates one instance at startup. Agents never touch it directly:
 * their requests go through fetchPage (which calls shouldInjectHeaders →
 * headersFor) and MCP client calls (same path).
 *
 * Keys and tokens stay in the manager, never in model context (spec 10.1).
 */

import { type AgentIdentity, loadOrCreateIdentity, clientMetadataDocument, jwksDocument } from "./identity.ts";
import { type PoppyCompany, discoverCompany, hasUcpExtension, ucpEndpoint } from "./discovery.ts";
import {
  DelegatedKeyManager,
  type UserIdStore,
  MemoryUserIdStore,
  userIdFor,
  createSession,
  type PoppySession,
} from "./session.ts";
import {
  type AuthServerMeta,
  type TokenSet,
  type DeviceCodeResponse,
  discoverAuthServer,
  buildAuthorizationUrl,
  exchangeCode,
  startDeviceAuth,
  pollDeviceToken,
  refreshToken,
  revokeToken,
} from "./oauth.ts";
import { TokenStore } from "./token-store.ts";
import { UcpClient, type UcpProfile, type UcpCapabilities } from "./ucp.ts";
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

export interface PoppyManagerOptions {
  /** The agentbox home directory (~/.agentbox). */
  home: string;
  /** The HTTPS origin where this host serves (e.g. https://agent.lumenbox.ai). */
  origin: string;
  /** Persistent User ID store. Defaults to in-memory. */
  userIdStore?: UserIdStore;
  /** Whether to auto-discover poppy.json on every fetchPage domain. Defaults to true. */
  autoDiscover?: boolean;
}

export class PoppyManager {
  private identity: AgentIdentity | undefined;
  private readonly userIdStore: UserIdStore;
  private readonly home: string;
  private readonly origin: string;
  private readonly autoDiscover: boolean;

  /** Domain → Session (one Session per Company for now; the spec allows multiple). */
  private readonly sessions = new Map<string, PoppySession>();
  /** Domain → DelegatedKeyManager (one per User ID, which is one per Company). */
  private readonly keyManagers = new Map<string, DelegatedKeyManager>();
  /** Domains we already checked and found no poppy.json at. */
  private readonly negative = new Set<string>();
  /** Pending discovery requests, so we don't fetch poppy.json twice for the same domain. */
  private readonly pending = new Map<string, Promise<PoppyCompany | null>>();

  /** Discovered auth server metadata by issuer. */
  private readonly authServers = new Map<string, AuthServerMeta>();
  /** Persistent token store. Created after init(). */
  private tokenStore: TokenStore | undefined;
  /** Active OAuth authorization flows waiting for callback. */
  private readonly pendingAuthFlows = new Map<string, {
    server: AuthServerMeta;
    company: PoppyCompany;
    verifier: string;
    redirectUri: string;
    scopes: string[];
    startedAt: number;
  }>();
  /** Active device code flows waiting for user action. */
  private readonly pendingDeviceFlows = new Map<string, {
    server: AuthServerMeta;
    company: PoppyCompany;
    deviceCode: string;
    expiresAt: number;
    interval: number;
  }>();

  constructor(options: PoppyManagerOptions) {
    this.home = options.home;
    this.origin = options.origin;
    this.userIdStore = options.userIdStore ?? new MemoryUserIdStore();
    this.autoDiscover = options.autoDiscover ?? true;
  }

  /** Initialize: load or create the agent's key pair + token store. Call once at startup. */
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
    if (this.negative.has(key)) return null;

    const existing = this.pending.get(key);
    if (existing) return existing;

    const promise = discoverCompany(domain).then(company => {
      this.pending.delete(key);
      if (!company) {
        this.negative.add(key);
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

    let authServer: AuthServerMeta | null = null;
    if (company.auth?.issuer && !company.auth.disabled) {
      const cached = this.authServers.get(company.auth.issuer);
      if (cached) {
        authServer = cached;
      } else {
        authServer = await discoverAuthServer(company.auth.issuer);
        if (authServer) this.authServers.set(company.auth.issuer, authServer);
      }
    }

    return { company, authServer };
  }

  // ── Sessions ──────────────────────────────────────────────────

  /**
   * Gets or creates a Session for a domain.
   * Returns null if the domain does not support Poppy.
   */
  async sessionFor(domain: string): Promise<PoppySession | null> {
    if (!this.identity) return null;

    const key = domain.toLowerCase();
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const company = await this.discover(domain);
    if (!company) return null;

    const userId = userIdFor(company, this.userIdStore);

    let keyMgr = this.keyManagers.get(company.identifier);
    if (!keyMgr) {
      keyMgr = new DelegatedKeyManager(this.identity);
      this.keyManagers.set(company.identifier, keyMgr);
    }

    const session = createSession(this.identity, company, userId, keyMgr);
    this.sessions.set(key, session);
    return session;
  }

  // ── Header injection ──────────────────────────────────────────

  /**
   * Whether a request to this URL should carry Poppy headers.
   * Discovery (poppy.json itself) and OAuth endpoints do not carry the header.
   */
  shouldInjectHeaders(url: string): boolean {
    if (!this.autoDiscover || !this.identity) return false;
    try {
      const parsed = new URL(url);
      if (parsed.pathname === "/.well-known/poppy.json") return false;
      if (parsed.pathname.startsWith("/.well-known/oauth")) return false;
      const domain = parsed.hostname.toLowerCase();
      return !this.negative.has(domain);
    } catch {
      return false;
    }
  }

  /**
   * Returns Poppy headers for a request, or an empty object when the domain
   * does not support Poppy. Automatically includes Authorization when a stored
   * token exists (and refreshes it if needed). Never throws.
   */
  async headersFor(
    method: string,
    url: string,
    accessToken?: string
  ): Promise<Record<string, string>> {
    try {
      const domain = new URL(url).hostname.toLowerCase();
      const session = await this.sessionFor(domain);
      if (!session) return {};

      // Auto-inject stored token when none was explicitly provided.
      let token = accessToken;
      if (!token && this.tokenStore) {
        const company = await this.discover(domain);
        if (company?.auth?.issuer) {
          token = await this.getValidToken(company.auth.issuer);
        }
      }

      return session.headers(method, url, token);
    } catch {
      return {};
    }
  }

  // ── OAuth: Authorization Code Flow ────────────────────────────

  /**
   * Starts an authorization code flow for a Company.
   *
   * Returns the URL the user's browser should open, and a state value
   * that identifies this flow in the callback.
   */
  async startSignIn(
    domain: string,
    scopes?: string[],
  ): Promise<{ url: string; state: string } | null> {
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

    this.pendingAuthFlows.set(state, {
      server: authServer,
      company,
      verifier,
      redirectUri,
      scopes: requestedScopes,
      startedAt: Date.now(),
    });

    // Clean up old flows (older than 15 min).
    const cutoff = Date.now() - 15 * 60_000;
    for (const [s, flow] of this.pendingAuthFlows) {
      if (flow.startedAt < cutoff) this.pendingAuthFlows.delete(s);
    }

    return { url, state };
  }

  /**
   * Handles the OAuth callback (code + state).
   *
   * Returns the Company name and scopes on success, or throws.
   */
  async handleCallback(
    code: string,
    state: string,
  ): Promise<{ companyName: string; scopes: string }> {
    const flow = this.pendingAuthFlows.get(state);
    if (!flow) throw new Error("Unknown or expired OAuth state");
    this.pendingAuthFlows.delete(state);

    const tokens = await exchangeCode(
      flow.server,
      this.getIdentity(),
      code,
      flow.redirectUri,
      flow.verifier,
    );

    this.tokenStore?.set(flow.company.identifier, tokens);
    return {
      companyName: flow.company.name,
      scopes: tokens.scope ?? flow.scopes.join(" "),
    };
  }

  // ── OAuth: Device Code Flow ───────────────────────────────────

  /**
   * Starts a device authorization flow for a Company.
   *
   * Returns a user code + URL for the user to visit on another device.
   */
  async startDeviceSignIn(
    domain: string,
    scopes?: string[],
  ): Promise<DeviceCodeResponse | null> {
    if (!this.identity) return null;

    const discovery = await this.discoverWithAuth(domain);
    if (!discovery?.authServer?.deviceAuthorizationEndpoint) return null;

    const { company, authServer } = discovery;
    const requestedScopes = scopes ?? Object.keys(company.auth?.scopes ?? {});

    const result = await startDeviceAuth(authServer, this.identity, requestedScopes);

    this.pendingDeviceFlows.set(result.deviceCode, {
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

    this.tokenStore?.set(flow.company.identifier, tokens);
    this.pendingDeviceFlows.delete(deviceCode);
    return true;
  }

  // ── Token Management ──────────────────────────────────────────

  /**
   * Gets a valid access token for a Company (by issuer), refreshing if needed.
   * Returns undefined if no token is stored or refresh fails.
   */
  private async getValidToken(issuer: string): Promise<string | undefined> {
    if (!this.tokenStore || !this.identity) return undefined;

    const stored = this.tokenStore.get(issuer);
    if (!stored) return undefined;

    // Still valid and not about to expire.
    if (this.tokenStore.hasValid(issuer) && !this.tokenStore.needsRefresh(issuer)) {
      return stored.accessToken;
    }

    // Needs refresh.
    if (stored.refreshToken) {
      const server = this.authServers.get(issuer);
      if (server) {
        try {
          const newTokens = await refreshToken(server, this.identity, stored.refreshToken);
          this.tokenStore.set(issuer, newTokens);
          return newTokens.accessToken;
        } catch {
          // Refresh failed; remove the stored token.
          this.tokenStore.remove(issuer);
          return undefined;
        }
      }
    }

    // Token expired with no way to refresh.
    if (!this.tokenStore.hasValid(issuer)) {
      this.tokenStore.remove(issuer);
      return undefined;
    }

    return stored.accessToken;
  }

  /** Whether a Company has a stored (possibly refreshable) token. */
  hasTokenFor(domain: string): boolean {
    // Look up issuer from a cached session's company.
    for (const [d, session] of this.sessions) {
      if (d === domain.toLowerCase()) {
        return this.tokenStore?.get(session.company.identifier) !== undefined;
      }
    }
    return false;
  }

  /** Revokes and removes a stored token for a Company. */
  async revokeTokenFor(domain: string): Promise<void> {
    if (!this.identity || !this.tokenStore) return;
    const session = this.sessions.get(domain.toLowerCase());
    if (!session) return;

    const issuer = session.company.identifier;
    const stored = this.tokenStore.get(issuer);
    if (!stored) return;

    const server = this.authServers.get(issuer);
    if (server) {
      if (stored.refreshToken) {
        await revokeToken(server, this.identity, stored.refreshToken, "refresh_token");
      }
      await revokeToken(server, this.identity, stored.accessToken, "access_token");
    }
    this.tokenStore.remove(issuer);
  }

  // ── UCP ───────────────────────────────────────────────────────

  /**
   * Creates a UCP client for a Poppy-enabled Company with UCP support.
   * Returns null if the Company doesn't support UCP.
   */
  async ucpClientFor(domain: string): Promise<UcpClient | null> {
    const session = await this.sessionFor(domain);
    if (!session) return null;

    const company = await this.discover(domain);
    if (!company || !hasUcpExtension(company)) return null;

    const token = company.auth?.issuer
      ? await this.getValidToken(company.auth.issuer)
      : undefined;

    return new UcpClient(company, session, token);
  }

  // ── Browser Join (spec 8.3) ────────────────────────────────────

  /**
   * Joins the agent's browser session to the Poppy Session.
   *
   * Returns a URL the box browser should navigate to, which associates it
   * with the Poppy Session. Returns null if the Company doesn't support it.
   */
  async browserJoin(domain: string): Promise<BrowserJoinResult | null> {
    const session = await this.sessionFor(domain);
    if (!session) return null;

    const company = await this.discover(domain);
    if (!company?.web?.browserSessionEndpoint) return null;

    const token = company.auth?.issuer
      ? await this.getValidToken(company.auth.issuer)
      : undefined;

    return requestBrowserJoin(company, session, token);
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
   * Sends a message to a Company's agent and streams the response.
   *
   * Returns an AbortController to cancel the stream.
   */
  async converse(
    domain: string,
    message: string,
    onEvent: ConversationEventHandler,
    options?: { conversationId?: string },
  ): Promise<AbortController | null> {
    const session = await this.sessionFor(domain);
    if (!session) return null;

    const company = await this.discover(domain);
    if (!company) return null;

    const ep = conversationEndpoint(company);
    if (!ep) return null;

    const token = company.auth?.issuer
      ? await this.getValidToken(company.auth.issuer)
      : undefined;

    return sendMessage(ep, session, message, onEvent, {
      accessToken: token,
      conversationId: options?.conversationId,
    });
  }

  // ── Operations (spec 8.4) ─────────────────────────────────────

  /**
   * Responds to a Company's operation request (approve/reject).
   *
   * This is typically called after the user has reviewed a consent card
   * generated from the operation.
   */
  async respondToOperation(
    domain: string,
    operation: Operation,
    decision: OperationDecision,
  ): Promise<OperationResult> {
    const session = await this.sessionFor(domain);
    if (!session) return { success: false, message: "No session for domain" };

    const company = await this.discover(domain);
    const token = company?.auth?.issuer
      ? await this.getValidToken(company.auth.issuer)
      : undefined;

    return respondToOperation(operation, decision, session, token);
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

  /** Summary for logging / debugging. */
  status(): {
    ready: boolean;
    clientId: string | undefined;
    activeSessions: string[];
    negativeCache: string[];
    tokens: Array<{ issuer: string; hasAccess: boolean; hasRefresh: boolean }>;
    pendingAuthFlows: number;
    pendingDeviceFlows: number;
  } {
    return {
      ready: this.ready,
      clientId: this.identity?.clientId,
      activeSessions: [...this.sessions.keys()],
      negativeCache: [...this.negative],
      tokens: this.tokenStore?.status().map(t => ({
        issuer: t.issuer,
        hasAccess: t.hasAccess,
        hasRefresh: t.hasRefresh,
      })) ?? [],
      pendingAuthFlows: this.pendingAuthFlows.size,
      pendingDeviceFlows: this.pendingDeviceFlows.size,
    };
  }
}
