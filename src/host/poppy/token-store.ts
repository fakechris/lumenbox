/**
 * Persistent token storage for Poppy OAuth (spec 10.1).
 *
 * Tokens are kept on the host and never enter model context — the manager reads them here and
 * puts them on outbound requests itself. The file is written mode 0o600, like the agent key.
 *
 * Keyed by who signed in, at which domain (`TokenStore.key`), with the issuer that granted the
 * token beside it. Not by issuer alone: an issuer is whatever a site's poppy.json says, and a
 * site claiming another Company's issuer would otherwise be handed that Company's token. A token
 * is used only at the domain it was granted for, and only while that domain still names the
 * issuer that granted it.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TokenSet } from "./oauth.ts";

const TOKEN_FILENAME = "poppy-tokens.json";
const REFRESH_AHEAD_MS = 60_000;

export interface StoredToken {
  /** `who|domain` — see `TokenStore.key`. */
  key: string;
  issuer: string;
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  refreshToken?: string;
  scope?: string;
  updatedAt: number;
}

export class TokenStore {
  private tokens: Map<string, StoredToken>;
  private readonly path: string;

  /** The key for a token: whom the agent signed in as, at which domain. */
  static key(who: string, domain: string): string {
    return `${who}|${domain.toLowerCase()}`;
  }

  constructor(home: string) {
    this.path = join(home, TOKEN_FILENAME);
    this.tokens = new Map();
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken[];
      // An entry from before the key existed was keyed by issuer alone; it is not used.
      this.tokens = new Map(data.filter(t => typeof t.key === "string").map(t => [t.key, t]));
    } catch {
      // File doesn't exist or is corrupt; start fresh.
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.tokens.values()], null, 2), { mode: 0o600 });
  }

  /**
   * Stores a token set. A refresh that answers without a new refresh token keeps the old one
   * (RFC 6749 §6: the server may leave it unchanged), rather than losing the way to refresh again.
   */
  set(key: string, issuer: string, tokenSet: TokenSet): void {
    const before = this.tokens.get(key);
    const refreshToken = tokenSet.refreshToken ?? (before?.issuer === issuer ? before.refreshToken : undefined);
    this.tokens.set(key, {
      key,
      issuer,
      accessToken: tokenSet.accessToken,
      tokenType: tokenSet.tokenType,
      expiresAt: tokenSet.expiresAt,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenSet.scope !== undefined ? { scope: tokenSet.scope } : {}),
      updatedAt: Date.now(),
    });
    this.save();
  }

  /** The stored token under this key, only if it was granted by `issuer`. */
  get(key: string, issuer: string): StoredToken | undefined {
    const token = this.tokens.get(key);
    return token?.issuer === issuer ? token : undefined;
  }

  /** Whether the token needs refreshing (expired or about to). */
  needsRefresh(token: StoredToken): boolean {
    return Date.now() > token.expiresAt - REFRESH_AHEAD_MS;
  }

  /** Whether the access token has not expired. */
  hasValid(token: StoredToken): boolean {
    return Date.now() < token.expiresAt;
  }

  /** Removes a token (on revocation or a refused grant). */
  remove(key: string): void {
    if (this.tokens.delete(key)) this.save();
  }

  /** Summary for diagnostics, for keys starting with `prefix` (one person's). Never the tokens. */
  status(prefix = ""): Array<{ key: string; issuer: string; hasAccess: boolean; hasRefresh: boolean; expiresAt: number }> {
    return [...this.tokens.values()].filter(t => t.key.startsWith(prefix)).map(t => ({
      key: t.key,
      issuer: t.issuer,
      hasAccess: Date.now() < t.expiresAt,
      hasRefresh: t.refreshToken !== undefined,
      expiresAt: t.expiresAt,
    }));
  }
}
