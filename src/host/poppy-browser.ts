/**
 * Browser Join integration for the Poppy protocol.
 *
 * When an agent opens a page in its browser, and the target domain supports
 * Poppy Browser Join (spec 8.3), this hook navigates the browser to the
 * join URL first. The Company's server sets cookies or other credentials
 * that associate the browser with the Poppy Session, so subsequent page
 * loads in the browser are authenticated.
 *
 * Called from browser_open in tools.ts, before the actual navigation.
 */

import type { PoppyManager } from "./poppy/manager.ts";

/** Domains that have already been joined in this process. */
const joined = new Set<string>();

/**
 * If the domain supports Browser Join and hasn't been joined yet,
 * requests a join URL from the Company. The caller should navigate to
 * this URL before the intended page.
 *
 * Returns the join URL, or undefined when no join is needed.
 */
export async function poppyBrowserJoinUrl(
  manager: PoppyManager,
  targetUrl: string,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  try {
    const domain = new URL(targetUrl).hostname.toLowerCase();
    if (joined.has(domain)) return undefined;

    const result = await manager.browserJoin(domain);
    if (!result) return undefined;

    joined.add(domain);
    log(`Browser Join for ${domain}: navigating to ${result.url}`);
    return result.url;
  } catch {
    return undefined;
  }
}

/** Clears the join cache (for tests). */
export function clearJoinCache(): void {
  joined.clear();
}
