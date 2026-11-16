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

/** `who|domain|sid` already joined: each agent's browser joins its own session, and joins again when that session is new. */
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
  who: string,
  targetUrl: string,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  try {
    const target = new URL(targetUrl);
    if (target.protocol !== "https:") return undefined;
    const domain = target.hostname.toLowerCase();
    const session = await manager.sessionFor(domain, who);
    if (!session) return undefined;
    const key = `${who}|${domain}|${session.sid}`;
    if (joined.has(key)) return undefined;

    const result = await manager.browserJoin(domain, who);
    if (!result) return undefined;

    joined.add(key);
    // Not the URL: it is a one-time credential for the session.
    log(`Browser Join for ${domain}`);
    return result.url;
  } catch {
    return undefined;
  }
}

/** Clears the join cache (for tests). */
export function clearJoinCache(): void {
  joined.clear();
}
