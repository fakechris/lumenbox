/**
 * The wire between the box's proxy and the relay outside it.
 *
 * Why this exists: the box's browser exits from wherever the box runs, which in a cluster is
 * a datacentre address. Real sites treat those differently — blocked, geofenced, or served a
 * different page — and anything on the user's own network is unreachable. Sending the box's
 * traffic out through a relay the user runs puts the agent on the network the user actually
 * has.
 *
 * The obvious design is a WebSocket the client opens into the box, with streams multiplexed
 * inside it. That needs a multiplexer, which is where this kind of code goes wrong. Here the
 * direction is reversed — the box dials the relay, one connection per stream — so the framing
 * is a text preamble and then raw bytes, with nothing to interleave and nothing to get out of
 * order. The cost is a TCP setup per stream, which is what a proxy
 * does anyway.
 *
 * The token is in the preamble rather than a TLS client certificate or anything cleverer
 * because the relay's whole job is to be reachable from one box. It refuses to start without
 * one: a relay with no token is an open proxy on the user's network, and that is worth
 * failing loudly over rather than defaulting to.
 */

export const PROTOCOL = "AGENTBOX-EGRESS";
export const VERSION = 1;

/** Bounded so a malformed or hostile preamble cannot be read forever. */
export const MAX_PREAMBLE_BYTES = 4096;

export interface StreamRequest {
  token: string;
  host: string;
  port: number;
}

export class EgressProtocolError extends Error {}

/** Hostnames and IPs only: this string reaches a DNS resolver and a socket. */
const HOST_PATTERN = /^[A-Za-z0-9._:\-[\]]{1,253}$/;

export function encodeRequest(request: StreamRequest): string {
  if (!HOST_PATTERN.test(request.host)) {
    throw new EgressProtocolError(`Not a host: ${JSON.stringify(request.host)}`);
  }
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    throw new EgressProtocolError(`Not a port: ${request.port}`);
  }
  // The token goes on its own line and is never logged by either side.
  return (
    `${PROTOCOL} ${VERSION}\r\n` +
    `Authorization: ${request.token}\r\n` +
    `Host: ${request.host}:${request.port}\r\n` +
    "\r\n"
  );
}

/**
 * Parses a preamble out of whatever has arrived so far.
 *
 * Returns `undefined` when it is incomplete, so a caller can keep reading rather than
 * guessing how much to wait for. Throws only when it can never become valid.
 */
export function decodeRequest(
  buffer: Buffer
): { request: StreamRequest; rest: Buffer } | undefined {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) {
    if (buffer.length > MAX_PREAMBLE_BYTES) {
      throw new EgressProtocolError("Preamble is too long to be one");
    }
    return undefined;
  }

  const lines = buffer.subarray(0, end).toString("utf8").split("\r\n");
  const [greeting = "", ...headers] = lines;
  const match = new RegExp(`^${PROTOCOL} (\\d+)$`).exec(greeting);
  if (!match) throw new EgressProtocolError("Not an egress stream");
  if (Number(match[1]) !== VERSION) {
    throw new EgressProtocolError(`Unsupported version ${match[1]}`);
  }

  let token: string | undefined;
  let target: string | undefined;
  for (const line of headers) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (name === "authorization") token = value;
    if (name === "host") target = value;
  }

  if (!token) throw new EgressProtocolError("No token");
  if (!target) throw new EgressProtocolError("No host");

  // Last colon, so an IPv6 literal in brackets survives.
  const split = target.lastIndexOf(":");
  if (split <= 0) throw new EgressProtocolError(`No port in ${JSON.stringify(target)}`);
  const host = target.slice(0, split);
  const port = Number(target.slice(split + 1));
  if (!HOST_PATTERN.test(host)) {
    throw new EgressProtocolError(`Not a host: ${JSON.stringify(host)}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EgressProtocolError(`Not a port: ${JSON.stringify(target.slice(split + 1))}`);
  }

  return { request: { token, host, port }, rest: buffer.subarray(end + 4) };
}

export function encodeResponse(ok: boolean, detail = ""): string {
  return ok
    ? `${PROTOCOL} 200 OK\r\n\r\n`
    : `${PROTOCOL} 502 ${detail.replace(/[\r\n]+/g, " ").slice(0, 200)}\r\n\r\n`;
}

export function decodeResponse(
  buffer: Buffer
): { ok: boolean; detail: string; rest: Buffer } | undefined {
  const end = buffer.indexOf("\r\n\r\n");
  if (end === -1) {
    if (buffer.length > MAX_PREAMBLE_BYTES) {
      throw new EgressProtocolError("Response preamble is too long to be one");
    }
    return undefined;
  }
  const line = buffer.subarray(0, end).toString("utf8").split("\r\n")[0] ?? "";
  const match = new RegExp(`^${PROTOCOL} (\\d+)\\s*(.*)$`).exec(line);
  if (!match) throw new EgressProtocolError(`Not an egress response: ${line.slice(0, 60)}`);
  return {
    ok: match[1] === "200",
    detail: match[2] ?? "",
    rest: buffer.subarray(end + 4),
  };
}

/**
 * The target of an HTTP proxy request line.
 *
 * CONNECT carries `host:port`. A plain HTTP request through a proxy carries an absolute URI,
 * and the origin server must not see it — most reject one — so the caller rewrites the line
 * to origin form using what this returns.
 */
export function parseProxyTarget(
  line: string
): { host: string; port: number; method: string; connect: boolean; path?: string } | undefined {
  const [method, target] = line.split(/\s+/);
  if (!method || !target) return undefined;

  if (method.toUpperCase() === "CONNECT") {
    const split = target.lastIndexOf(":");
    if (split <= 0) return undefined;
    const port = Number(target.slice(split + 1));
    if (!Number.isInteger(port)) return undefined;
    return { host: target.slice(0, split), port, method, connect: true };
  }

  if (!/^https?:\/\//i.test(target)) return undefined;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    method,
    connect: false,
    path: `${url.pathname}${url.search}` || "/",
  };
}
