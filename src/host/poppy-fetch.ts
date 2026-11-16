/**
 * Bridges PoppyManager with fetchPage.
 *
 * The `webFetch` seam on ToolContext is `(url: string) => Promise<FetchedPage>`, the
 * simplest surface an agent turn can call. This module creates one that:
 *
 *   1. Discovers poppy.json automatically for each domain (first request triggers it).
 *   2. Attaches a fresh Poppy-Session JWT and Poppy-Version header to every request —
 *      including each redirect hop, because the JWT binds the URL (`htu`) and method
 *      (`htm`) of the request it accompanies.
 *   3. Falls back to a plain fetch when the domain has no poppy.json.
 *
 * Keys and tokens never leave this module — they are on the host side of the wall,
 * invisible to model context (spec 10.1).
 */

import { PoppyManager, type PoppyManagerOptions } from "./poppy/manager.ts";
import { fetchPage, withRequestHeaders, type FetchedPage } from "./web.ts";

/**
 * Returns a `webFetch` function that injects Poppy protocol headers, plus
 * the underlying manager for serving the agent's metadata endpoints.
 *
 * The manager initialises lazily on the first fetch that might need headers,
 * so construction is synchronous and never blocks the server startup path.
 */
export function createPoppyFetch(
  options: PoppyManagerOptions,
  log: (line: string) => void = () => {},
): { fetch: (url: string) => Promise<FetchedPage>; manager: PoppyManager } {
  const manager = new PoppyManager(options);
  let initPromise: Promise<void> | undefined;

  async function ensureReady(): Promise<void> {
    if (manager.ready) return;
    if (initPromise === undefined) {
      initPromise = manager.init().then(
        () => log(`poppy: agent identity ready (${manager.getIdentity().clientId})`),
        (error: unknown) => log(`poppy: identity init failed — ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    await initPromise;
  }

  const fetch = async (url: string): Promise<FetchedPage> => {
    await ensureReady();

    if (!manager.ready || !manager.shouldInjectHeaders(url)) {
      return fetchPage(url);
    }

    const transport = withRequestHeaders(async (target: URL) => {
      if (!manager.shouldInjectHeaders(target.toString())) return {};
      return manager.headersFor("GET", target.toString());
    });

    return fetchPage(url, transport);
  };

  return { fetch, manager };
}
