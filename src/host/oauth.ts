/**
 * The OAuth gate (INV-422): how a connector gets a token without the token ever
 * reaching a model, a box, a transcript or a log.
 *
 * Two dances, both finished by the host on the operator's machine:
 *
 * - **authorization code** — an admin starts it from Settings, the provider sends the
 *   browser back to `/oauth/callback`, the host exchanges the code for tokens and lands
 *   them in the vault as the secret `oauth:<provider>`. GitHub is the first door.
 * - **client credentials** — an app id and secret mint a tenant token directly; the
 *   host re-mints when it lapses. Feishu's tenant_access_token is the first door.
 *
 * The agent side is one tool, `connector_request`: it names the connector and the call,
 * the host attaches the bearer, and the reply comes back with the token scrubbed even
 * from an echoing endpoint. A token whose `expiresAt` has passed is refreshed before
 * it is handed to a request; the model never learns a token was ever stale.
 *
 * The gate keeps the values in the vault (docs/37 §4), so grants, audit and the
 * bundle rule (a box's bundles grant a secret, INV-420) apply to a token exactly as to
 * a pasted key. What the gate adds is the minting and the re-minting.
 */

import { randomBytes } from "node:crypto";
import type { Grant, OAuthMeta, Vault } from "./vault.ts";

export interface OAuthProvider {
  id: string;
  title: string;
  kind: OAuthMeta["kind"];
  /** Where the person is sent to say yes (authorization code only). */
  authorizeUrl?: string;
  tokenUrl: string;
  /** The API the connector tool calls, with `path` appended. */
  apiBase: string;
  /** Headers every request to the API carries beside the bearer. */
  apiHeaders?: Record<string, string>;
  defaultScopes: string[];
  /** One line for the settings surface: where the client id and secret come from. */
  setup: string;
}

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [
  {
    id: "github",
    title: "GitHub",
    kind: "authorization_code",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    apiBase: "https://api.github.com",
    apiHeaders: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    defaultScopes: ["repo", "read:org"],
    setup: "github.com/settings/developers → OAuth Apps → New → callback URL is this app's /oauth/callback. Enable expiring user tokens to get refresh tokens.",
  },
  {
    id: "feishu",
    title: "Feishu (Lark)",
    kind: "client_credentials",
    tokenUrl: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    apiBase: "https://open.feishu.cn/open-apis",
    defaultScopes: [],
    setup: "open.feishu.cn → your app → Credentials: App ID and App Secret. The tenant token is minted here and re-minted when it lapses.",
  },
];

export function oauthProvider(id: string): OAuthProvider | undefined {
  return OAUTH_PROVIDERS.find(provider => provider.id === id);
}

/** The vault secret an OAuth connection lives under. */
export function connectionSecretId(provider: string): string {
  return `oauth:${provider}`;
}

/** Fetch as the gate needs it: a function, so tests can be the provider. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

interface Pending {
  provider: OAuthProvider;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
  grants: Grant[];
  at: number;
}

/** How long a started authorization waits for the callback before it is forgotten. */
const PENDING_TTL_MS = 15 * 60_000;

/** Refresh this far ahead of the expiry, so a request never races the clock. */
const REFRESH_AHEAD_MS = 60_000;

function parseTokenReply(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // GitHub answers form-encoded unless asked for JSON; read that shape too.
    return Object.fromEntries([...new URLSearchParams(text).entries()]);
  }
}

export class OAuthGate {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly vault: Vault,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
    private readonly now: () => number = () => Date.now()
  ) {}

  providers(): OAuthProvider[] {
    return OAUTH_PROVIDERS.map(provider => ({ ...provider, defaultScopes: [...provider.defaultScopes] }));
  }

  /** The connections that exist, as the vault shows them: never a value. */
  connected(): { id: string; provider: string; kind: OAuthMeta["kind"]; expiresAt?: string; grants: Grant[] }[] {
    return this.vault
      .list()
      .filter(secret => secret.oauth !== undefined)
      .map(secret => ({
        id: secret.id,
        provider: secret.oauth!.provider,
        kind: secret.oauth!.kind,
        ...(secret.oauth!.expiresAt !== undefined ? { expiresAt: secret.oauth!.expiresAt } : {}),
        grants: secret.grants,
      }));
  }

  /**
   * Starts an authorization-code dance: the URL to send the admin's browser to. The
   * client secret waits here, keyed by an unguessable state, until the callback.
   */
  begin(input: { provider: string; clientId: string; clientSecret: string; redirectUri: string; scopes?: string[]; grants?: Grant[] }): { url: string; state: string } {
    const provider = oauthProvider(input.provider);
    if (provider === undefined) throw new Error(`unknown OAuth provider ${input.provider}`);
    if (provider.kind !== "authorization_code" || provider.authorizeUrl === undefined) {
      throw new Error(`${provider.title} uses client credentials; call connect instead`);
    }
    if (input.clientId.trim() === "" || input.clientSecret === "") throw new Error("a client id and a client secret are both required");
    this.forgetStale();
    const state = randomBytes(18).toString("base64url");
    const scopes = input.scopes !== undefined && input.scopes.length > 0 ? input.scopes : provider.defaultScopes;
    this.pending.set(state, {
      provider,
      clientId: input.clientId.trim(),
      clientSecret: input.clientSecret,
      redirectUri: input.redirectUri,
      scopes,
      grants: input.grants ?? [],
      at: this.now(),
    });
    const url = new URL(provider.authorizeUrl);
    url.searchParams.set("client_id", input.clientId.trim());
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    return { url: url.toString(), state };
  }

  /** Finishes the dance: the code becomes tokens, the tokens become the vault secret. */
  async complete(state: string, code: string): Promise<{ id: string; provider: string }> {
    this.forgetStale();
    const pending = this.pending.get(state);
    if (pending === undefined) throw new Error("this authorization is unknown or has lapsed; start it again from Settings");
    this.pending.delete(state);
    if (code.trim() === "") throw new Error("the provider sent no code");
    const reply = await this.tokenRequest(pending.provider, {
      grant_type: "authorization_code",
      code,
      client_id: pending.clientId,
      client_secret: pending.clientSecret,
      redirect_uri: pending.redirectUri,
    });
    const id = connectionSecretId(pending.provider.id);
    this.vault.setSecret({
      id,
      description: `${pending.provider.title} OAuth token`,
      value: reply.accessToken,
      grants: pending.grants,
      oauth: {
        provider: pending.provider.id,
        kind: "authorization_code",
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        scopes: pending.scopes,
        ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}),
        ...(reply.refreshToken !== undefined ? { refreshToken: reply.refreshToken } : {}),
      },
    });
    return { id, provider: pending.provider.id };
  }

  /** Client credentials: mints the tenant token now and keeps what re-mints it. */
  async connect(input: { provider: string; clientId: string; clientSecret: string; grants?: Grant[] }): Promise<{ id: string; provider: string; expiresAt?: string }> {
    const provider = oauthProvider(input.provider);
    if (provider === undefined) throw new Error(`unknown OAuth provider ${input.provider}`);
    if (provider.kind !== "client_credentials") throw new Error(`${provider.title} needs an authorization; call begin instead`);
    if (input.clientId.trim() === "" || input.clientSecret === "") throw new Error("an app id and an app secret are both required");
    const reply = await this.clientCredentials(provider, input.clientId.trim(), input.clientSecret);
    const id = connectionSecretId(provider.id);
    this.vault.setSecret({
      id,
      description: `${provider.title} tenant token`,
      value: reply.accessToken,
      grants: input.grants ?? [],
      oauth: {
        provider: provider.id,
        kind: "client_credentials",
        clientId: input.clientId.trim(),
        clientSecret: input.clientSecret,
        ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}),
      },
    });
    return { id, provider: provider.id, ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}) };
  }

  /**
   * The bearer for a connection, for a caller the vault covers: refreshed first when it
   * is about to lapse, audited by the vault as any resolution is. Undefined means not
   * granted, not connected, or not refreshable any more — said the same way.
   */
  async bearerFor(id: string, caller: Parameters<Vault["resolve"]>[1]): Promise<string | undefined> {
    const meta = this.vault.oauthOf(id);
    if (meta === undefined) return undefined;
    if (!this.vault.covers(id, caller)) {
      // Resolve anyway so the refusal is on the audit trail, then say no.
      this.vault.resolve(id, caller);
      return undefined;
    }
    if (meta.expiresAt !== undefined && Date.parse(meta.expiresAt) - REFRESH_AHEAD_MS <= this.now()) {
      const refreshed = await this.refresh(id, meta);
      if (!refreshed) return undefined;
    }
    return this.vault.resolve(id, caller);
  }

  /** Mints a new access token from what the vault kept; false when nothing can. */
  private async refresh(id: string, meta: OAuthMeta): Promise<boolean> {
    const provider = oauthProvider(meta.provider);
    if (provider === undefined || meta.clientId === undefined || meta.clientSecret === undefined) return false;
    try {
      if (meta.kind === "client_credentials") {
        const reply = await this.clientCredentials(provider, meta.clientId, meta.clientSecret);
        const { expiresAt: _old, ...rest } = meta;
        this.vault.setSecret({ id, value: reply.accessToken, oauth: { ...rest, ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}) } });
        return true;
      }
      if (meta.refreshToken === undefined) return false;
      const reply = await this.tokenRequest(provider, {
        grant_type: "refresh_token",
        refresh_token: meta.refreshToken,
        client_id: meta.clientId,
        client_secret: meta.clientSecret,
      });
      this.vault.setSecret({
        id,
        value: reply.accessToken,
        oauth: {
          ...meta,
          ...(reply.expiresAt !== undefined ? { expiresAt: reply.expiresAt } : {}),
          // A provider that rotates refresh tokens sends a new one; one that does not, none.
          refreshToken: reply.refreshToken ?? meta.refreshToken,
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private async clientCredentials(provider: OAuthProvider, clientId: string, clientSecret: string): Promise<{ accessToken: string; expiresAt?: string }> {
    if (provider.id === "feishu") {
      const response = await this.fetchFn(provider.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: clientId, app_secret: clientSecret }),
      });
      const reply = parseTokenReply(await response.text());
      if (response.status !== 200 || reply.code !== 0 || typeof reply.tenant_access_token !== "string") {
        throw new Error(`${provider.title} refused the app credentials (code ${String(reply.code ?? response.status)})`);
      }
      return { accessToken: reply.tenant_access_token, ...this.expiry(reply.expire) };
    }
    return this.tokenRequest(provider, { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret });
  }

  private async tokenRequest(provider: OAuthProvider, form: Record<string, string>): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
    const response = await this.fetchFn(provider.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    const reply = parseTokenReply(await response.text());
    if (response.status !== 200 || typeof reply.access_token !== "string" || reply.access_token === "") {
      const why = typeof reply.error_description === "string" ? reply.error_description : typeof reply.error === "string" ? reply.error : `HTTP ${response.status}`;
      throw new Error(`${provider.title} did not issue a token: ${why}`);
    }
    return {
      accessToken: reply.access_token,
      ...(typeof reply.refresh_token === "string" && reply.refresh_token !== "" ? { refreshToken: reply.refresh_token } : {}),
      ...this.expiry(reply.expires_in),
    };
  }

  private expiry(seconds: unknown): { expiresAt?: string } {
    const n = typeof seconds === "number" ? seconds : typeof seconds === "string" ? Number(seconds) : NaN;
    return Number.isFinite(n) && n > 0 ? { expiresAt: new Date(this.now() + n * 1000).toISOString() } : {};
  }

  private forgetStale(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [state, pending] of this.pending) if (pending.at < cutoff) this.pending.delete(state);
  }
}

/** Every occurrence of a token in text becomes a marker; nothing else changes. */
export function scrubToken(text: string, token: string): string {
  return token === "" ? text : text.split(token).join("<redacted>");
}
