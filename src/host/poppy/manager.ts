/**
 * PoppyManager — the single entry point for Poppy protocol support.
 *
 * Coordinates discovery, identity, sessions and header injection. The host
 * creates one instance at startup. Agents never touch it directly: their
 * requests go through fetchPage (which calls shouldInjectHeaders → getHeaders)
 * and MCP client calls (same path).
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

  constructor(options: PoppyManagerOptions) {
    this.home = options.home;
    this.origin = options.origin;
    this.userIdStore = options.userIdStore ?? new MemoryUserIdStore();
    this.autoDiscover = options.autoDiscover ?? true;
  }

  /** Initialize: load or create the agent's key pair. Call once at startup. */
  async init(): Promise<void> {
    this.identity = await loadOrCreateIdentity(this.home, this.origin);
  }

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

    // One DelegatedKeyManager per User ID per Company (spec 5.2, 10.7).
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
   *
   * Called by fetchPage and MCP clients before making a request.
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
   * does not support Poppy. Never throws.
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
      return session.headers(method, url, accessToken);
    } catch {
      return {};
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

  /** Summary for logging / debugging. */
  status(): {
    ready: boolean;
    clientId: string | undefined;
    activeSessions: string[];
    negativeCache: string[];
  } {
    return {
      ready: this.ready,
      clientId: this.identity?.clientId,
      activeSessions: [...this.sessions.keys()],
      negativeCache: [...this.negative],
    };
  }
}
