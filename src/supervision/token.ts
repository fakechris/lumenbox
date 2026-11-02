/**
 * The supervision process's own side-door token (INV-1527): issued on first start through the
 * web's token endpoint with the app's UI token, for the installation's admin, kept in a 0600 file
 * and reused — tokens outlive restarts since INV-1520. Refused once, it is issued again once.
 * The secret is never logged or returned to anything but the door client.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { principalFor } from "../watchdog/install.ts";

export const SUPERVISION_TOKEN_LABEL = "LumenBox supervision";

export interface TokenDeps {
  home: string;
  url: string;
  uiToken: () => string;
  fetch: typeof fetch;
}

export const tokenFile = (home: string) => join(home, "supervision", "token");

export async function ensureToken(deps: TokenDeps, options: { renew?: boolean } = {}): Promise<string> {
  const file = tokenFile(deps.home);
  if (!options.renew && existsSync(file)) {
    const held = readFileSync(file, "utf8").trim();
    if (held !== "") return held;
  }
  if (options.renew) rmSync(file, { force: true });
  const principalId = principalFor({ home: deps.home });
  const response = await deps.fetch(`${deps.url.replace(/\/+$/, "")}/api/mcp/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${deps.uiToken()}` },
    body: JSON.stringify({ principalId, label: SUPERVISION_TOKEN_LABEL }),
  });
  if (!response.ok) throw new Error(`the web refused to issue the supervision token (HTTP ${response.status})`);
  const minted = (await response.json()) as { token: string };
  mkdirSync(join(deps.home, "supervision"), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${minted.token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return minted.token;
}
