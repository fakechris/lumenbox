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
  log?: (line: string) => void;
}

const DEFAULT_PORT = 8791;
/** A browser opens a lot of these; a stalled relay must not hold them all open forever. */
const RELAY_TIMEOUT_MS = 20_000;

export function startEgressProxy(options: ProxyOptions): Server {
  const log = options.log ?? (() => {});
  const [relayHost, relayPort] = splitHostPort(options.relay);

  const server = createServer(client => {
    client.setNoDelay(true);
    let head = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const lineEnd = head.indexOf("\r\n");
      if (lineEnd === -1) {
        if (head.length > 8192) client.destroy();
        return;
      }

      const line = head.subarray(0, lineEnd).toString("utf8");
      const target = parseProxyTarget(line);
      if (!target) {
        // A relative request line means someone pointed a client at this as if it were an
        // origin server. Say so rather than hanging.
        client.end("HTTP/1.1 400 Bad Request\r\n\r\nThis is a proxy, not a server.\r\n");
        return;
      }

      client.off("data", onData);
      const rest = target.connect
        ? // The client sends its own headers after the CONNECT line; they are the proxy's,
          // not the destination's, so everything up to the blank line is dropped.
          dropHeaders(head.subarray(lineEnd + 2))
        : Buffer.concat([
            // Rewritten to origin form: an origin server must not receive an absolute URI,
            // and most reject one.
            Buffer.from(`${target.method} ${target.path} ${versionOf(line)}\r\n`),
            head.subarray(lineEnd + 2),
          ]);

      open({ token: options.token, host: target.host, port: target.port }, target.connect, rest);
    };

    const open = (request: StreamRequest, isConnect: boolean, pending: Buffer) => {
      const relay = netConnect(relayPort, relayHost);
      relay.setNoDelay(true);
      relay.setTimeout(RELAY_TIMEOUT_MS, () => relay.destroy(new Error("relay timed out")));

      let response = Buffer.alloc(0);
      let established = false;

      relay.on("connect", () => relay.write(encodeRequest(request)));

      relay.on("data", chunk => {
        if (established) return;
        response = Buffer.concat([response, chunk]);
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

/** Everything up to and including the blank line, which belongs to the proxy hop. */
function dropHeaders(buffer: Buffer): Buffer {
  const end = buffer.indexOf("\r\n\r\n");
  return end === -1 ? Buffer.alloc(0) : buffer.subarray(end + 4);
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
