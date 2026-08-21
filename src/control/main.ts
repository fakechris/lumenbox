/**
 * Running the control plane.
 *
 * One process holding the four things that exist so far — store, allocator, gateway, collector — with
 * every seam still substitutable from the command line. There is deliberately no daemon, no service
 * file and no supervisor here: this is the same shape as the box's own web server, and the deployment
 * question is answered in [../docs/06-deployment.md](../docs/06-deployment.md) rather than by another
 * process manager written in TypeScript.
 *
 * What it prints on startup is chosen to answer the questions someone asks when it does not work: how
 * people are authenticated, which allocator is in use, where the database is, and what the collector
 * is doing. A control plane whose configuration is invisible is one where the first incident starts
 * with reading source.
 */

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { agentboxHome } from "../config.ts";
import { defaultBoxConfig, readBoxToken } from "../box/docker.ts";
import { StaticAllocator, type BoxAllocator } from "./allocator.ts";
import { ComposeAllocator } from "./compose.ts";
import { Collector, meterTenants } from "./collector.ts";
import { HealthNotifier, webhookDelivery } from "./notify.ts";
import { startRelay } from "../relay/server.ts";
import { availableUpstreams } from "../relay/upstreams.ts";
import { Gateway, PasswordListIdentity, type IdentityProvider } from "./gateway.ts";
import { SqliteControlStore, type ControlStore } from "./store.ts";

export interface ControlPlaneOptions {
  /** Where the gateway listens. */
  port: number;
  host: string;
  /** `compose` for real multi-tenancy, `static` for one already-running box. */
  allocator: "compose" | "static";
  image: string;
  /** `user:password:tenant,...`. Absent means one is generated and printed. */
  users?: string;
  statePath?: string;
  /** Seconds between collector sweeps. 0 disables it. */
  sweepSeconds?: number;
  /**
   * Run a model relay, so no provider key enters a box.
   *
   * Off by default: turning it on changes where credentials live, and a flag that quietly moved them
   * would be the wrong kind of surprise. On, boxes are created pointing at it.
   */
  relay?: boolean;
  relayPort?: number;
  /** Which provider's capabilities relayed boxes assume. The relay decides where traffic goes. */
  relayProvider?: string;
  secureCookies?: boolean;
  out?: (line: string) => void;
}

/**
 * The session secret, minted once and kept.
 *
 * Persisted for the same reason the box's UI token is: a restart that logs everyone out is a restart
 * that looks like a bug. `AGENTBOX_SESSION_SECRET` overrides it, which is how two gateways behind a
 * load balancer share sessions.
 */
export function loadSessionSecret(path: string): Buffer {
  const fromEnv = process.env.AGENTBOX_SESSION_SECRET;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return Buffer.from(fromEnv.trim(), "utf8");
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8").trim();
    if (existing !== "") return Buffer.from(existing, "hex");
  }
  const secret = randomBytes(32);
  writeFileSync(path, secret.toString("hex"), { encoding: "utf8", mode: 0o600 });
  return secret;
}

export interface RunningControlPlane {
  url: string;
  store: ControlStore;
  allocator: BoxAllocator;
  collector: Collector | undefined;
  close(): Promise<void>;
}

export async function startControlPlane(
  options: ControlPlaneOptions
): Promise<RunningControlPlane> {
  const out = options.out ?? (() => {});
  const home = options.statePath ?? join(agentboxHome(), "control");
  mkdirSync(home, { recursive: true });

  const store = new SqliteControlStore({ path: join(home, "control.db") });

  let allocator: BoxAllocator;
  if (options.allocator === "static") {
    // One already-running box, shared by whoever signs in. For development only, and it refuses a
    // second tenant rather than quietly handing over the first one's desktop.
    const token = readBoxToken();
    if (token === undefined) {
      throw new Error(
        "The static allocator needs an existing box: run `agentbox box up --with-host` first, " +
          "or use --allocator compose."
      );
    }
    const config = defaultBoxConfig();
    allocator = new StaticAllocator(store, {
      boxdUrl: `http://${config.host}:${config.boxdPort || 1337}`,
      uiUrl: process.env.AGENTBOX_UI_URL ?? "http://127.0.0.1:7777",
      tokens: { box: token, ui: process.env.AGENTBOX_UI_TOKEN ?? "" },
    });
  } else {
    allocator = new ComposeAllocator(store, {
      image: options.image,
      onOutput: line => out(`  ${line}`),
      ...(options.relay === true
        ? {
            // As the *container* reaches it, not as this process does. The two differ, and using
            // this process's own address is the mistake that produces a box which cannot call a
            // model at all.
            relayUrl: `http://host.docker.internal:${options.relayPort ?? 8788}`,
            relayProvider: options.relayProvider ?? process.env.AGENTBOX_PROVIDER ?? "anthropic",
          }
        : {}),
    });
  }

  let relay: Server | undefined;
  if (options.relay === true) {
    const upstreams = availableUpstreams(line => out(`  relay: ${line}`));
    if (upstreams.size === 0) {
      throw new Error(
        "The relay has no upstream: it needs a provider credential in its own environment " +
          "(ANTHROPIC_API_KEY, MINIMAX_CODE_CN_API_KEY, …). Without one it could authenticate boxes " +
          "and then have nothing to forward to."
      );
    }
    const wanted = (options.relayProvider ?? process.env.AGENTBOX_PROVIDER ?? "anthropic").toLowerCase();
    const upstream = upstreams.get(wanted);
    if (upstream === undefined) {
      throw new Error(
        `The relay has no credential for ${wanted}. It can serve: ${[...upstreams.keys()].join(", ")}.`
      );
    }
    relay = startRelay({
      port: options.relayPort ?? 8788,
      // Bound to every interface, because the traffic comes from inside a container and loopback on
      // this host is not reachable from there. That is why the token check fails closed.
      host: "0.0.0.0",
      resolve: token => {
        // Looked up per request rather than cached, so revoking a token stops it without a restart.
        for (const row of store.listBoxes(["starting", "ready", "unreachable"])) {
          if (store.readToken(row.id, "relay") === token) {
            return { token, tenantId: row.tenantId, boxId: row.id, upstream };
          }
        }
        return undefined;
      },
      onUsage: usage => {
        // Measured where the request passed, which is the point: this number cannot be understated
        // by the thing being billed. Its own table, because the box's report and the relay's
        // observation are two measurements and a total that summed both would double-count.
        store.appendRelayUsage(usage);
      },
      log: line => out(`  relay: ${line}`),
    });
  }

  let identity: IdentityProvider;
  if (options.users !== undefined && options.users.trim() !== "") {
    identity = PasswordListIdentity.parse(options.users);
  } else {
    // Generated rather than defaulted to something blank or guessable, and printed once. The
    // alternative — a control plane that starts with no credential — is how a demo becomes an
    // incident.
    const password = randomBytes(12).toString("base64url");
    identity = PasswordListIdentity.parse(`admin:${password}:default`);
    out("");
    out("  No users configured, so one was generated for this run:");
    out(`    user     admin`);
    out(`    password ${password}`);
    out(`    tenant   default`);
    out("  Set AGENTBOX_CONTROL_USERS=user:password:tenant,... to keep them across restarts.");
    out("");
  }

  const gateway = new Gateway({
    store,
    allocator,
    identity,
    sessionSecret: loadSessionSecret(join(home, "session-secret")),
    image: options.image,
    // Whatever this process was told about a provider is what a box is told. When the relay exists
    // this becomes a relay address and a per-box token instead of a key.
    boxEnv: process.env.AGENTBOX_PROVIDER
      ? { AGENTBOX_PROVIDER: process.env.AGENTBOX_PROVIDER }
      : undefined,
    secureCookies: options.secureCookies,
    log: line => out(`  ${line}`),
  });

  const server = createServer((req, res) => {
    void gateway.handle(req, res).catch(error => {
      out(`  request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error.\n");
    });
  });
  server.on("upgrade", (req, socket, head) => {
    void gateway.handleUpgrade(req, socket as Socket, head).catch(() => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const sweepSeconds = options.sweepSeconds ?? 15;
  // Where a state change is sent, if anywhere. Without it everything is still recorded and still
  // queryable — which was the whole problem: it was reported only to whoever asked, and nobody asks
  // at three in the morning.
  const webhook = process.env.AGENTBOX_HEALTH_WEBHOOK;
  const notifier = new HealthNotifier(notice => {
    // Always to the log, whether or not a webhook is configured: an operator watching the console
    // should not have to set up a webhook to see that a box just died.
    out(`  health: ${notice.text}`);
    if (webhook !== undefined && webhook.trim() !== "") {
      webhookDelivery(webhook, line => out(`  health: ${line}`))(notice);
    }
  });

  let collector: Collector | undefined;
  if (sweepSeconds > 0) {
    collector = new Collector({
      store,
      // So a restarted box is relocated rather than written off; see Collector's `allocator` note.
      allocator,
      intervalMs: sweepSeconds * 1000,
      notifier,
      log: line => out(`  collector: ${line}`),
    });
    collector.start();
  }

  const address = server.address() as { port: number };
  const url = `http://${options.host}:${address.port}`;

  out(`control plane on ${url}`);
  out(`  allocator  ${allocator.kind}${options.allocator === "compose" ? ` (${options.image})` : ""}`);
  out(`  store      ${join(home, "control.db")}`);
  out(
    `  health     ${webhook === undefined || webhook.trim() === "" ? "console only (set AGENTBOX_HEALTH_WEBHOOK to send changes somewhere)" : `console and ${webhook}`}`
  );
  out(
    `  collector  ${collector === undefined ? "disabled" : `every ${sweepSeconds}s`}` +
      `  ·  tenants ${store.listTenants().length}, boxes ${store.listBoxes(["starting", "ready", "unreachable"]).length}`
  );
  out(
    `  relay      ${
      relay === undefined
        ? "off — boxes carry a provider key, which an agent with a shell can read"
        : `on :${options.relayPort ?? 8788} (${options.relayProvider ?? process.env.AGENTBOX_PROVIDER ?? "anthropic"}); no provider key enters a box`
    }`
  );
  if (options.secureCookies !== true) {
    // Said plainly, because the cookie is the whole session and this is the one thing about this
    // deployment that is not safe to leave as it is.
    out("  no TLS: sessions travel in the clear. Put a TLS terminator in front before real use.");
  }

  return {
    url,
    store,
    allocator,
    collector,
    async close() {
      collector?.stop();
      relay?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      store.close();
    },
  };
}

/** `agentbox control status` — what the control plane knows, without starting one. */
export function describeControlPlane(statePath?: string): string[] {
  const home = statePath ?? join(agentboxHome(), "control");
  const path = join(home, "control.db");
  if (!existsSync(path)) {
    return [`No control plane state at ${path}. Nothing has run yet.`];
  }
  const store = new SqliteControlStore({ path });
  try {
    const lines: string[] = [`store ${path}`];
    for (const tenant of store.listTenants()) {
      const box = store.boxForTenant(tenant.id);
      const health = box === undefined ? undefined : store.latestHealth(box.id);
      const meter = meterTenants(store).find(entry => entry.tenantId === tenant.id);
      lines.push(
        `${tenant.name}  ${tenant.state}  ` +
          (box === undefined
            ? "no box"
            : `${box.externalId} ${box.state}` +
              (health?.degraded === true ? " (degraded)" : "") +
              `  last seen ${box.lastSeenAt ?? "never"}`)
      );
      if (meter !== undefined && meter.records > 0) {
        lines.push(
          `    ${meter.records} rounds, ${meter.inputTokens} in, ${meter.outputTokens} out` +
            (meter.limitTokens === undefined
              ? ""
              : `, limit ${meter.limitTokens}${meter.overBudget ? " — OVER" : ""}`)
        );
      }
    }
    const audit = store.recentAudit(5);
    if (audit.length > 0) {
      lines.push("recent:");
      for (const row of audit) lines.push(`    ${row.at}  ${row.actor}  ${row.action}  ${row.target}`);
    }
    return lines;
  } finally {
    store.close();
  }
}
