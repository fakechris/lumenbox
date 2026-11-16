/**
 * Every request Poppy makes goes through here (INV-1893).
 *
 * The addresses Poppy calls are not ours: a site's poppy.json names its conversation, Browser
 * Join, task and commerce endpoints, its authorization server names its token endpoints, and an
 * operation names where its answer goes. Called with the global `fetch`, any of them could point
 * the host at 127.0.0.1 or at another service on its network, and what came back went into the
 * model's context. So:
 *
 * - The socket connects through `guardedLookup`, the lookup WebFetch uses: an inside address is
 *   refused when the name is resolved, not checked beside it, so a second DNS answer cannot differ.
 *   A literal address, which is never looked up, is refused by the same rule before connecting.
 * - https only, no user:password in the URL.
 * - Redirects are not followed, except where the protocol needs them (discovery), and then by
 *   hand, each hop back through the same checks.
 * - An endpoint a Company named must be on that Company's own site (`within`): a site cannot have
 *   the agent sign sessions, or send a token, to a third party it names.
 * - The body is capped, so a hostile endpoint cannot stream without end into memory.
 */

import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { isIP } from "node:net";
import { forbiddenAddress, guardedLookup } from "../web.ts";

export interface PoppyRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Default 15 s. A conversation stream passes its own signal instead. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** One request to a checked URL. Replaced only by tests, so no test reaches the network. */
export type PoppyTransport = (url: URL, init: PoppyRequest) => Promise<Response>;

/** Thrown for a URL Poppy will not call. The message says why, in words an agent can relay. */
export class PoppyRefused extends Error {}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

/** Whether `host` is `site` itself or a name under it. */
export function withinSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = site.toLowerCase().replace(/\.$/, "");
  return h === s || h.endsWith(`.${s}`);
}

/** The URL, if Poppy may call it: https, no credentials, and on `site` when one is named. */
export function poppyUrl(raw: string, site?: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PoppyRefused(`${raw} is not a URL`);
  }
  if (url.protocol !== "https:") throw new PoppyRefused(`${url.origin} is not https`);
  if (url.username !== "" || url.password !== "") throw new PoppyRefused(`${url.host} carries credentials in its URL`);
  if (site !== undefined && !withinSite(url.hostname, site)) throw new PoppyRefused(`${url.hostname} is not on ${site}, the site that named it`);
  // A literal address is never looked up, so the guarded lookup never sees it: judged here instead.
  const literal = url.hostname.replace(/^\[|\]$/g, "");
  const inside = isIP(literal) !== 0 ? forbiddenAddress(literal) : undefined;
  if (inside !== undefined) throw new PoppyRefused(`${literal} ${inside}`);
  return url;
}

let transport: PoppyTransport = guardedHttps;

/** For tests: answer every Poppy request with `next`; with nothing, back to the network. */
export function usePoppyTransport(next?: PoppyTransport): void {
  transport = next ?? guardedHttps;
}

/** One request; a redirect is refused, not followed. */
export async function poppyRequest(raw: string, init: PoppyRequest = {}, site?: string): Promise<Response> {
  const url = poppyUrl(raw, site);
  const response = await transport(url, init);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => undefined);
    throw new PoppyRefused(`${url.host} answered with a redirect, which Poppy does not follow here`);
  }
  return response;
}

/** A GET that follows up to `hops` redirects, each one checked as the first was. */
export async function poppyGetFollowing(raw: string, init: PoppyRequest, hops = 3): Promise<{ response: Response; url: URL }> {
  let url = poppyUrl(raw);
  for (let hop = 0; ; hop++) {
    const response = await transport(url, { ...init, method: "GET" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) return { response, url };
    await response.body?.cancel().catch(() => undefined);
    if (hop >= hops) throw new PoppyRefused(`${url.host} redirected more than ${hops} times`);
    url = poppyUrl(new URL(location, url).toString());
  }
}

function guardedHttps(url: URL, init: PoppyRequest): Promise<Response> {
  return new Promise((resolve, reject) => {
    const timeoutMs = init.signal === undefined ? (init.timeoutMs ?? DEFAULT_TIMEOUT_MS) : undefined;
    const call = httpsRequest(url, { method: init.method ?? "GET", headers: init.headers ?? {}, lookup: guardedLookup, ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}) }, incoming => {
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) incoming.destroy(new PoppyRefused(`${url.host} sent more than ${MAX_BODY_BYTES} bytes`));
      });
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 599) {
        incoming.destroy();
        reject(new PoppyRefused(`${url.host} answered with status ${status}`));
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value === undefined) continue;
        for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
      }
      const empty = status === 204 || status === 205 || status === 304;
      if (empty) incoming.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>), { status, headers }));
    });
    call.on("timeout", () => call.destroy(new PoppyRefused(`${url.host} did not answer within ${(timeoutMs ?? 0) / 1000}s`)));
    call.on("error", reject);
    init.signal?.addEventListener("abort", () => call.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    call.end(init.body);
  });
}
