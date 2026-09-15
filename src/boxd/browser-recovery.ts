/**
 * Retry and degrade for the desktop browser (INV-146): the failures a real box shows
 * — a debugger socket that dropped, a page that was mid-navigation when asked, a
 * Chrome that is not running — handled once, here, by one rule each, instead of by
 * the model burning turns on "try again".
 *
 * Three rules:
 *
 * 1. **A dropped connection is retried once, for reads only.** Snapshot, read, wait,
 *    pages, check, open: the page is forgotten, the browser is re-attached (relaunched
 *    if gone), and the op runs again. A write — act, upload, fill_secret — is *not*
 *    repeated: the click may have landed before the socket died, and repeating a write
 *    nobody can see is how a form gets submitted twice. It comes back `unknown` with
 *    the reason, and the model looks before it acts again.
 * 2. **A page caught mid-navigation is retried once after a short wait.** "Execution
 *    context was destroyed", "cannot find context": the page is loading and will be
 *    there in a moment. Same read-only rule.
 * 3. **A browser that will not come back is degraded, not fatal.** For `open` and
 *    `read` with a URL, the page is fetched without a browser: no login state, no
 *    scripts, just the document's text — and the result says so, so the model knows
 *    what it is reading and what it cannot do from there.
 */

export type BrowserFailure = "connection" | "transient";

/** The ops that may be repeated without changing anything on the page. */
const READ_ONLY_OPS = new Set(["open", "snapshot", "read", "wait", "pages", "check", "switch", "scroll"]);

const CONNECTION = /connection (closed|was closed|is not open)|did not answer within|refused the debugger connection|HTTP \d+ listing targets|did not start on desktop|ECONNREFUSED|socket hang up/i;
const TRANSIENT = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|target closed|Session with given id not found/i;

export function classifyFailure(message: string): BrowserFailure | undefined {
  if (CONNECTION.test(message)) return "connection";
  if (TRANSIENT.test(message)) return "transient";
  return undefined;
}

export function isReadOnlyOp(op: string): boolean {
  return READ_ONLY_OPS.has(op);
}

export interface RecoveryDeps {
  /** Drops the cached page so the next attempt re-attaches (and relaunches if the browser is gone). */
  forget: () => void;
  /** Waits before a transient retry. */
  delay?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type Recovered<T> =
  | { kind: "ok"; result: T; recovered?: BrowserFailure }
  | { kind: "unknown"; error: Error; failure: BrowserFailure }
  | { kind: "unavailable"; error: Error };

/**
 * Runs a browser op under the three rules. `ok` may carry `recovered`, so the reply can
 * say the browser was re-attached; `unknown` is a write the box cannot vouch for;
 * `unavailable` is a browser that failed twice on the connection and needs degrading.
 * Anything not a known failure shape is thrown as it was: a stale ref, a covered
 * click and the rest are the browser's own answers and must reach the host unchanged.
 */
export async function withRecovery<T>(op: string, run: () => Promise<T>, deps: RecoveryDeps): Promise<Recovered<T>> {
  const delay = deps.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});
  let first: Error;
  try {
    return { kind: "ok", result: await run() };
  } catch (error) {
    first = error instanceof Error ? error : new Error(String(error));
  }
  const failure = classifyFailure(first.message);
  if (failure === undefined) throw first;
  if (!isReadOnlyOp(op)) {
    log(`browser ${op}: ${failure} failure mid-write, not repeated: ${first.message}`);
    return { kind: "unknown", error: first, failure };
  }
  log(`browser ${op}: ${failure} failure, retrying once: ${first.message}`);
  if (failure === "connection") deps.forget();
  else await delay(600);
  try {
    return { kind: "ok", result: await run(), recovered: failure };
  } catch (error) {
    const second = error instanceof Error ? error : new Error(String(error));
    if (classifyFailure(second.message) === "connection") return { kind: "unavailable", error: second };
    throw second;
  }
}

/** The document's prose without a browser: tags stripped, scripts and styles dropped, whitespace folded. */
const decodeEntities = (text: string): string =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export function textOfHtml(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
  const body = html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<title[\s\S]*?<\/title>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|br|section|article|header|footer|td|th)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = decodeEntities(body)
    .split("\n")
    .map(line => line.replace(/[ \t\r]+/g, " ").trim())
    .filter(line => line !== "")
    .join("\n");
  return { title, text };
}

export const HEADLESS_NOTE =
  "The desktop browser is unavailable, so this page was fetched without it: no login state, no scripts ran, " +
  "and nothing on it can be clicked. Read what is here; for anything that needs the real browser, tell the person the browser on this box is down.";

/**
 * Fetches a page with no browser at all. Only for the degrade path: it has no cookies,
 * no scripts, and it is the honest floor, not a substitute.
 */
export async function headlessFetch(
  url: string,
  fetchFn: (url: string, init: { redirect: "follow"; signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; url: string; text(): Promise<string> }> = (u, init) => fetch(u, init)
): Promise<{ url: string; title: string; text: string }> {
  const response = await fetchFn(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "user-agent": "agentbox-headless/1" },
  });
  const html = await response.text();
  if (!response.ok) throw new Error(`fetching ${url} without a browser returned HTTP ${response.status}`);
  const { title, text } = textOfHtml(html);
  return { url: response.url || url, title, text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (${text.length - 60_000} more characters)` : text };
}
