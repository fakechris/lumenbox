/**
 * The relay outside the box.
 *
 * Accepts streams from the box's proxy and opens each one from here, so the agent's browsing
 * leaves from this machine's network rather than from wherever the box runs. That is the whole
 * feature: a datacentre address gets blocked, geofenced or served a different page, and
 * anything on the user's own network is otherwise unreachable from a box.
 *
 * It refuses to start without a token. A relay with no token is an open proxy on whatever
 * network it can reach, which is worth failing loudly over rather than defaulting to.
 *
 * Deliberately not a general proxy: it speaks one small protocol, forwards bytes, and applies
 * whatever restrictions it was given. It never parses the traffic.
 */

import { createServer, connect as netConnect, type Server } from "node:net";
import {
  EgressProtocolError,
  decodeRequest,
  encodeResponse,
  type StreamRequest,
} from "./protocol.ts";

export interface RelayOptions {
  token: string;
  port?: number;
  /** Loopback by default: a relay on a routable address is reachable by more than the box. */
  host?: string;
  /**
   * Destinations the relay will open. Empty means anywhere.
   *
   * Here because the relay's reason to exist is reaching the user's network, and "the user's
   * network" is exactly what an agent should not be able to sweep. A deployment that only
   * wants public egress sets this to what it means.
   */
  allow?: readonly string[];
  log?: (line: string) => void;
}

const DEFAULT_PORT = 8790;
/** A stream that never sends its preamble is not a stream. */
const PREAMBLE_TIMEOUT_MS = 10_000;

export class RelayError extends Error {}

export function startEgressRelay(options: RelayOptions): Server {
  if (!options.token || options.token.length < 16) {
    throw new RelayError(
      "The relay needs a token of at least 16 characters. Without one it is an open proxy " +
        "for anything that can reach it."
    );
  }
  const log = options.log ?? (() => {});
  const allow = options.allow ?? [];

  const server = createServer(box => {
    box.setNoDelay(true);
    box.setTimeout(PREAMBLE_TIMEOUT_MS, () => box.destroy());

    let head = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      let decoded: ReturnType<typeof decodeRequest>;
      try {
        decoded = decodeRequest(head);
      } catch (error) {
        // No detail back on a protocol error: whatever is talking is not the box's proxy, and
        // telling it what was wrong only helps it guess again.
        log(`relay: rejected a stream (${describe(error)})`);
        box.destroy();
        return;
      }
      if (!decoded) return;

      box.off("data", onData);
      box.setTimeout(0);
      const { request, rest } = decoded;

      if (request.token !== options.token) {
        log(`relay: wrong token for ${request.host}:${request.port}`);
        box.end(encodeResponse(false, "unauthorized"));
        return;
      }
      if (!permitted(request, allow)) {
        log(`relay: ${request.host}:${request.port} is not in the allow list`);
        box.end(encodeResponse(false, "not allowed"));
        return;
      }

      const upstream = netConnect(request.port, request.host);
      upstream.setNoDelay(true);

      upstream.on("connect", () => {
        log(`relay: ${request.host}:${request.port}`);
        box.write(encodeResponse(true));
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(box);
        box.pipe(upstream);
      });

      upstream.on("error", error => {
        // The reason goes back: "example.com refused" is the difference between a debuggable
        // failure and a page that just does not load.
        box.end(encodeResponse(false, describe(error)));
        upstream.destroy();
      });
      box.on("error", () => {
        upstream.destroy();
        box.destroy();
      });
    };

    box.on("data", onData);
    box.on("error", () => box.destroy());
  });

  const host = options.host ?? "127.0.0.1";
  server.listen(options.port ?? DEFAULT_PORT, host, () => {
    log(
      `egress relay on ${host}:${options.port ?? DEFAULT_PORT}` +
        (allow.length > 0 ? `, allowing ${allow.join(", ")}` : ", allowing anywhere")
    );
  });
  return server;
}

/**
 * Whether the relay will open this destination.
 *
 * A pattern is a host, or `*.example.com` for a suffix, optionally with `:port`. Matched
 * against the requested host rather than the resolved address: the point is to express intent
 * ("only these services"), and an address check would be a different, weaker promise.
 */
export function permitted(
  request: Pick<StreamRequest, "host" | "port">,
  allow: readonly string[]
): boolean {
  if (allow.length === 0) return true;

  return allow.some(pattern => {
    const [patternHost, patternPort] = splitPattern(pattern);
    if (patternPort !== undefined && patternPort !== request.port) return false;
    if (patternHost === "*") return true;
    if (patternHost.startsWith("*.")) {
      const suffix = patternHost.slice(1);
      return request.host === patternHost.slice(2) || request.host.endsWith(suffix);
    }
    return request.host === patternHost;
  });
}

function splitPattern(pattern: string): [string, number | undefined] {
  const at = pattern.lastIndexOf(":");
  if (at <= 0) return [pattern, undefined];
  const port = Number(pattern.slice(at + 1));
  if (!Number.isInteger(port)) return [pattern, undefined];
  return [pattern.slice(0, at), port];
}

function describe(error: unknown): string {
  if (error instanceof EgressProtocolError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
