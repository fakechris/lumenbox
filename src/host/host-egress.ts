/**
 * The egress proxy for processes on the host (INV-1344): the same HTTP proxy boxd runs for the
 * box (egress/proxy.ts), on this machine's loopback, speaking to the same relay.
 *
 * A sandboxed host command may reach one loopback port and nothing else; this is that port.
 * Its connections carry the per-call token (INV-784) in the proxy credential, so the relay's
 * record and the `<egress_denied>` block (INV-1345) name the tool call that asked. On Linux the
 * command runs in a network namespace whose loopback is not ours, so the proxy also listens on a
 * Unix socket that socat bridges inside (host-sandbox.ts); on macOS the port is reached directly.
 */

import { createServer, connect, type Server } from "node:net";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { CallRegistry } from "../egress/call.ts";
import { startEgressProxy } from "../egress/proxy.ts";
import { unixSocketFor } from "./host-sandbox.ts";

export interface HostEgress {
  /** The loopback port host processes are allowed to reach. */
  port: number;
  /** Vouches for the call tokens whose commands are running. */
  calls: CallRegistry;
  close(): void;
}

export interface HostEgressOptions {
  /** host:port of the egress relay. */
  relay: string;
  token: string;
  /** Where the Unix-socket mirror lives; the sandbox's temp directory. */
  tmp?: string;
  /** Mirror the port on a Unix socket for Linux namespaces. Default: on Linux only. */
  mirror?: boolean;
  log?: (line: string) => void;
}

export function startHostEgress(options: HostEgressOptions): Promise<HostEgress> {
  const calls = new CallRegistry();
  const log = options.log ?? (() => {});
  return new Promise((resolve, reject) => {
    const proxy = startEgressProxy({ relay: options.relay, token: options.token, port: 0, calls, log: line => log(`host egress: ${line}`) });
    proxy.once("error", reject);
    proxy.once("listening", () => {
      const port = (proxy.address() as { port: number }).port;
      const mirror = (options.mirror ?? process.platform === "linux") ? mirrorOnUnixSocket(port, options.tmp ?? tmpdir()) : undefined;
      resolve({
        port,
        calls,
        close: () => {
          proxy.close();
          mirror?.close();
        },
      });
    });
  });
}

/** A Unix socket whose every connection is piped to the loopback port: the far end of socat's bridge. */
function mirrorOnUnixSocket(port: number, tmp: string): Server {
  const path = unixSocketFor(tmp, port);
  try {
    unlinkSync(path);
  } catch {
    // Nothing stale to remove.
  }
  const server = createServer(client => {
    const upstream = connect(port, "127.0.0.1");
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop);
    upstream.on("error", drop);
  });
  server.listen(path);
  return server;
}
