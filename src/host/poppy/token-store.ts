/**
 * Persistent token storage for Poppy OAuth (spec 10.1).
 *
 * Stores access and refresh tokens per Company (by issuer) on the host's
 * filesystem. Tokens never enter model context — the manager reads them
 * here and injects them as Authorization headers on outbound requests.
 *
 * The file is written mode 0o600 (owner-only), same as the agent key.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TokenSet } from "./oauth.ts";

const TOKEN_FILENAME = "poppy-tokens.json";
const REFRESH_AHEAD_MS = 60_000;

export interface StoredToken {
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

  constructor(home: string) {
    this.path = join(home, TOKEN_FILENAME);
    this.tokens = new Map();
    this.load();
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as StoredToken[];
      this.tokens = new Map(data.map(t => [t.issuer, t]));
    } catch {
      // File doesn't exist or is corrupt; start fresh.
    }
  }

  private save(): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.tokens.values()], null, 2), { mode: 0o600 });
  }

  /** Stores a token set for a Company. */
  set(issuer: string, tokenSet: TokenSet): void {
    this.tokens.set(issuer, {
      issuer,
      accessToken: tokenSet.accessToken,
      tokenType: tokenSet.tokenType,
      expiresAt: tokenSet.expiresAt,
      refreshToken: tokenSet.refreshToken,
      scope: tokenSet.scope,
      updatedAt: Date.now(),
    });
    this.save();
  }

  /** Returns the stored token for a Company, or undefined if none or expired without refresh. */
  get(issuer: string): StoredToken | undefined {
    return this.tokens.get(issuer);
  }

  /** Whether the token needs refreshing (expired or about to). */
  needsRefresh(issuer: string): boolean {
    const t = this.tokens.get(issuer);
    if (!t) return false;
    return Date.now() > t.expiresAt - REFRESH_AHEAD_MS;
  }

  /** Whether there's a valid (non-expired) access token for a Company. */
  hasValid(issuer: string): boolean {
    const t = this.tokens.get(issuer);
    if (!t) return false;
    return Date.now() < t.expiresAt;
  }

  /** Whether there's a refresh token available for a Company. */
  hasRefreshToken(issuer: string): boolean {
    return this.tokens.get(issuer)?.refreshToken !== undefined;
  }

  /** Removes a Company's tokens (on revocation or error). */
  remove(issuer: string): void {
    if (this.tokens.delete(issuer)) this.save();
  }

  /** All issuers we hold tokens for. */
  issuers(): string[] {
    return [...this.tokens.keys()];
  }

  /** Summary for diagnostics. */
  status(): Array<{ issuer: string; hasAccess: boolean; hasRefresh: boolean; expiresAt: number }> {
    return [...this.tokens.values()].map(t => ({
      issuer: t.issuer,
      hasAccess: Date.now() < t.expiresAt,
      hasRefresh: t.refreshToken !== undefined,
      expiresAt: t.expiresAt,
    }));
  }
}
