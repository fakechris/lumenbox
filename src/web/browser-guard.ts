/**
 * What a browser is held to (docs/106 §5 R5, INV-2204), at every exposure level.
 *
 * A browser sends this installation's cookies with any request to it, whoever wrote the page that
 * made the request. So a request that changes something, and a socket upgrade, has to come from
 * this installation's own page: its `Origin` — or, without one, its `Referer` — is ours, or the
 * request is refused. Nothing answers with `Access-Control-Allow-Origin`, so no other page can read
 * a reply either; that is the cross-origin default and there is no list to add to.
 *
 * **Ours** is the declared public address off local (`AGENTBOX_PUBLIC_URL`), the one people open.
 * Where none is declared — local, where the app loads `http://127.0.0.1:<port>/` and a browser
 * opens the same or `localhost` — it is whatever address the request itself was sent to: the
 * `Origin`'s host is the `Host` header's. A page on another site can make neither true.
 *
 * **Not asked** (each because the request is not a browser spending a cookie):
 * - `GET`, `HEAD`, `OPTIONS`: they change nothing, and a link from anywhere must still open the page.
 * - A request with an `Authorization` header: a bearer credential is put there by a program — the
 *   CLI, the app's shell, the control plane's gateway, a side-door or MCP-face client, a box
 *   registering. A page on another site cannot add that header without a preflight nobody answers.
 * - A request with neither `Origin` nor `Referer`: not a browser. Every browser names the origin
 *   of a cross-site `POST` and of every socket upgrade.
 * - `/hooks/<id>`: a webhook is called from anywhere by design and carries its own secret.
 * The OAuth callbacks are `GET`s; what protects them is the state, and the cookie that binds it
 * to the browser that started (door-sign-in.ts).
 *
 * The page's headers are here too, so the two servers a person reaches send the same ones.
 */
import type { IncomingMessage } from "node:http";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin of an address a person opens (`https://box.example.com`), or undefined when it is not one. */
export function originOf(address: string | undefined): string | undefined {
  try {
    const url = new URL((address ?? "").trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : undefined;
  } catch { return undefined; }
}

const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);

/**
 * Why a request is refused for where it came from, or undefined. `upgrade` is a socket upgrade,
 * which is a `GET` that is not safe: the socket carries the screen and the keyboard.
 */
export function originRefusal(req: Pick<IncomingMessage, "method" | "headers" | "url">, publicOrigin: string | undefined, upgrade = false): string | undefined {
  if (!upgrade && SAFE.has((req.method ?? "GET").toUpperCase())) return undefined;
  if (req.headers.authorization !== undefined) return undefined;
  if (/^\/hooks\/[^/]+\/?(?:\?|$)/.test(req.url ?? "")) return undefined;
  const origin = first(req.headers.origin);
  const claimed = origin !== undefined ? origin : originOf(first(req.headers.referer));
  if (origin === undefined && first(req.headers.referer) === undefined) return undefined;
  if (claimed === undefined || claimed === "null") return "cross-origin";
  if (publicOrigin !== undefined) return claimed.toLowerCase() === publicOrigin.toLowerCase() ? undefined : "cross-origin";
  const host = (first(req.headers.host) ?? "").toLowerCase();
  return host !== "" && originOf(claimed)?.replace(/^https?:\/\//, "").toLowerCase() === withoutDefaultPort(host, claimed) ? undefined : "cross-origin";
}

/** `Host` as an origin would write it: without the port a scheme implies. */
function withoutDefaultPort(host: string, origin: string): string {
  return origin.startsWith("https://") ? host.replace(/:443$/, "") : host.replace(/:80$/, "");
}

/**
 * The headers every response carries.
 *
 * The policy is what can be enforced without rewriting the page. It keeps the page from being
 * framed by another site, from posting a form elsewhere, from loading a plugin or a `<base>`, and
 * from fetching, connecting or framing anywhere but here. **`script-src` and `style-src` are not
 * strict**: the single-page app, the sign-in pages and noVNC's page are written with inline
 * scripts, inline event handlers and inline styles, so both need `'unsafe-inline'` — which means
 * the policy does not stop a script injected into the page from running. Making them strict is a
 * rewrite of how the page is assembled (nonces or external files), and is its own piece of work.
 * Images may come from any `https:` address, because a rendered message may show one.
 */
export function securityHeaders(req: Pick<IncomingMessage, "headers">, publicOrigin: string | undefined): Record<string, string> {
  // The socket's address, said outright: older WebKit does not take 'self' to cover ws: and wss:.
  const host = publicOrigin !== undefined ? publicOrigin.replace(/^https?:\/\//, "") : (first(req.headers.host) ?? "");
  const sockets = /^[a-z0-9.\-:[\]]+$/i.test(host) ? ` ws://${host} wss://${host}` : "";
  return {
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: data:",
      "font-src 'self' data:",
      `connect-src 'self'${sockets}`,
      "frame-src 'self'",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
}
