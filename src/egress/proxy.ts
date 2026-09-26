/**
 * The proxy inside the box.
 *
 * An ordinary HTTP proxy on loopback, except that it never dials the destination itself: every
 * connection is handed to a relay outside the box, which opens it from wherever the relay runs.
 * That is the point — the box's browser then appears on the user's network instead of on a
 * datacentre address, and anything only reachable from there becomes reachable at all.
 *
 * Loopback only, and deliberately: a proxy listening on the container's other interfaces would
 * be an open proxy for anything that could route to it.
 */

import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { tokenFromProxyAuthorization } from "./call.ts";
import {
  decodeResponse,
  encodeRequest,
  parseProxyTarget,
  type StreamRequest,
} from "./protocol.ts";

export interface ProxyOptions {
  /** host:port of the relay outside the box. */
  relay: string;
  token: string;
  port?: number;
  /**
   * Which call a connection belongs to (INV-784, call.ts): the credential in its
   * `Proxy-Authorization` when boxd vouches for it, or the one browser action in flight
   * when it carries none. Absent means nothing is attributed, which is what the proxy
   * did before.
   */
  calls?: { resolve(credential: string | undefined): string | undefined };
  log?: (line: string) => void;
}

/** Where box-chrome expects the proxy (docker/box/box-chrome); docs/06 lists it. */
export const DEFAULT_PORT = 8791;
/** A browser opens a lot of these; a stalled relay must not hold them all open forever. */
const RELAY_TIMEOUT_MS = 20_000;
/** A request head longer than this is not one. */
const MAX_HEAD_BYTES = 16_384;

export function startEgressProxy(options: ProxyOptions): Server {
  const log = options.log ?? (() => {});
  const [relayHost, relayPort] = splitHostPort(options.relay);

  const server = createServer(client => {
    client.setNoDelay(true);
    let head = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      // The whole header block, not just the request line: the credential that says whose
      // connection this is lives in the headers, and the blank line is the only thing that
      // says they have all arrived.
      const headersEnd = head.indexOf("\r\n\r\n");
      if (headersEnd === -1) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      const lineEnd = head.indexOf("\r\n");

      const line = head.subarray(0, lineEnd).toString("utf8");
      const target = parseProxyTarget(line);
      if (!target) {
        // A relative request line means someone pointed a client at this as if it were an
        // origin server. Say so rather than hanging.
        client.end("HTTP/1.1 400 Bad Request\r\n\r\nThis is a proxy, not a server.\r\n");
        return;
      }

      client.off("data", onData);
      const { headers, proxyAuthorization } = splitHeaders(head.subarray(lineEnd + 2, headersEnd));
      const body = head.subarray(headersEnd + 4);
      const rest = target.connect
        ? // The client sends its own headers after the CONNECT line; they are the proxy's,
          // not the destination's, so everything up to the blank line is dropped.
          body
        : Buffer.concat([
            // Rewritten to origin form: an origin server must not receive an absolute URI,
            // and most reject one. The proxy's own credential is dropped with it.
            Buffer.from(`${target.method} ${target.path} ${versionOf(line)}\r\n`),
            Buffer.from(headers.map(header => `${header}\r\n`).join("")),
            Buffer.from("\r\n"),
            body,
          ]);

      const call = options.calls?.resolve(tokenFromProxyAuthorization(proxyAuthorization));
      open(
        { token: options.token, host: target.host, port: target.port, ...(call !== undefined ? { call } : {}) },
        target.connect,
        rest
      );
    };

    const open = (request: StreamRequest, isConnect: boolean, pending: Buffer) => {
      const relay = netConnect(relayPort, relayHost);
      relay.setNoDelay(true);
      relay.setTimeout(RELAY_TIMEOUT_MS, () => relay.destroy(new Error("relay timed out")));

      let response = Buffer.alloc(0);
      let established = false;

      relay.on("connect", () => relay.write(encodeRequest(request)));

      // Typed wide and narrowed here: a socket's `data` carries a Buffer unless an
      // encoding was set — it is not set — but newer @types/node describe the listener
      // as `string | Buffer`, and a build that only typechecks against the version
      // installed today is a dependency bump waiting to fail (it did: the first
      // dependabot npm PR after the release gate landed).
      relay.on("data", (chunk: string | Buffer) => {
        if (established) return;
        response = Buffer.concat([response, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        let decoded: ReturnType<typeof decodeResponse>;
        try {
          decoded = decodeResponse(response);
        } catch (error) {
          client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          relay.destroy();
          log(`egress: ${describe(error)}`);
          return;
        }
        if (!decoded) return;

        established = true;
        relay.setTimeout(0);
        if (!decoded.ok) {
          log(`egress: ${request.host}:${request.port} refused (${decoded.detail})`);
          client.end(`HTTP/1.1 502 Bad Gateway\r\n\r\n${decoded.detail}\r\n`);
          relay.destroy();
          return;
        }

        // CONNECT gets its own 200 so the client starts TLS; a plain request does not, since
        // the destination's own response is what follows.
        if (isConnect) client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (pending.length > 0) relay.write(pending);
        if (decoded.rest.length > 0) client.write(decoded.rest);

        relay.pipe(client);
        client.pipe(relay);
      });

      const drop = () => {
        relay.destroy();
        client.destroy();
      };
      relay.on("error", error => {
        if (!established) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        log(`egress: relay error for ${request.host}:${request.port}: ${describe(error)}`);
        drop();
      });
      client.on("error", drop);
    };

    client.on("data", onData);
    client.on("error", () => client.destroy());
  });

  server.listen(options.port ?? DEFAULT_PORT, "127.0.0.1", () => {
    log(`egress proxy on 127.0.0.1:${options.port ?? DEFAULT_PORT} via ${options.relay}`);
  });
  return server;
}

/** The header lines, minus the ones that belong to this hop, and the credential they carried. */
function splitHeaders(block: Buffer): { headers: string[]; proxyAuthorization: string | undefined } {
  const headers: string[] = [];
  let proxyAuthorization: string | undefined;
  for (const header of block.toString("utf8").split("\r\n")) {
    if (header === "") continue;
    const at = header.indexOf(":");
    const name = at === -1 ? "" : header.slice(0, at).trim().toLowerCase();
    if (name === "proxy-authorization") {
      proxyAuthorization = header.slice(at + 1).trim();
      continue;
    }
    headers.push(header);
  }
  return { headers, proxyAuthorization };
}

function versionOf(requestLine: string): string {
  return requestLine.split(/\s+/)[2] ?? "HTTP/1.1";
}

export function splitHostPort(value: string): [string, number] {
  const at = value.lastIndexOf(":");
  if (at <= 0) throw new Error(`Not a host:port: ${JSON.stringify(value)}`);
  const port = Number(value.slice(at + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Not a port in ${JSON.stringify(value)}`);
  }
  return [value.slice(0, at), port];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { Socket };
