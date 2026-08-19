/**
 * A local web UI for driving and watching the agents.
 *
 * Exists for acceptance testing: the CLI can show one agent's turn, but the thing
 * worth checking by hand is the part a transcript cannot convey — several agents
 * working at once, one handing work to another, and the desktop changing under
 * them. Three panes, one event stream.
 *
 * Binds to loopback only. There is no authentication, because anything that can
 * reach this port can already drive the agents; keeping it off the network is the
 * control.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import type { BusEvent } from "../agents/bus.ts";
import { BoxManager, defaultBoxConfig, loadBoxToken } from "../box/docker.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { describeProvider, type ProviderProfile } from "../host/provider.ts";
import type { TurnEvent } from "../host/turn.ts";
import { APP_HTML } from "./app-html.ts";
import { agentboxHome, loadConfig } from "../config.ts";
import { ActivityLog } from "./activity.ts";
import { vendorPath } from "./markdown.ts";
import { toDisplayEntries } from "./transcript.ts";

export interface WebOptions {
  port: number;
  host?: string;
  provider: ProviderProfile;
  useBox?: boolean;
  onReady?: (url: string) => void;
  onLog?: (line: string) => void;
}

/** Anything pushed to the browser. Turn and bus events plus a few of our own. */
type OutboundEvent =
  | TurnEvent
  | BusEvent
  | { type: "prompt"; agentId: string; text: string }
  | { type: "error"; message: string };

export async function startWebServer(options: WebOptions): Promise<() => void> {
  const log = options.onLog ?? (() => {});
  const registry = new AgentRegistry();
  /** Read once on first request; it never changes while the server is up. */
  let vendorScript: Buffer | undefined;
  const clients = new Set<ServerResponse>();

  /**
   * Recent activity, so the feed is not blank on arrival.
   *
   * The feed used to exist only in the page: it showed what happened since the tab
   * loaded and lost all of it on reload, which is exactly when someone comes back to
   * see what the agents did. Kept bounded and in memory — this is a view of a run, not
   * a record of it; the transcripts on disk are the record.
   *
   * Text deltas are left out (there are thousands, and the transcript has them) and so
   * are screenshots, which would make this hold megabytes of base64. Events that draw
   * no line are skipped: this exists to fill the feed, not to mirror the stream.
   *
   * On disk, because in one process's memory it survived a browser reload but not a
   * restart — see src/web/activity.ts. How much to keep is a preference someone sets
   * once, so it lives in the config file rather than in an environment variable.
   */
  const activityLimit = loadConfig(line => log(line)).activityLimit;
  const activity = new ActivityLog({
    path: join(agentboxHome(), "activity.jsonl"),
    limit: activityLimit,
    onWarn: line => log(line),
  });

  const FEED_EVENTS = new Set([
    "prompt",
    "turn_started",
    "turn_failed",
    "turn_interrupted",
    "tool_start",
    "message_sent",
    "error",
  ]);

  const remember = (event: OutboundEvent) => {
    if (!FEED_EVENTS.has(event.type)) return;
    activity.add(event as unknown as Record<string, unknown> & { type: string });
  };

  const broadcast = (event: OutboundEvent) => {
    remember(event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // A slow or dead client must not take the server down with it.
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  };

  const orchestrator = new Orchestrator({
    registry,
    provider: options.provider,
    useBox: options.useBox,
    onTurnEvent: broadcast,
    onBusEvent: broadcast,
  });

  const box = await orchestrator.connectBox();
  log(box.connected ? `box: ${box.detail}` : `box: unavailable — ${box.detail}`);

  // Every agent's desktop, up front: the point of this UI is that a person can
  // take over any of them at any moment, which cannot wait on that agent's first
  // turn. Costs a few seconds at startup and nothing after.
  if (box.connected) {
    const desktops = await orchestrator.ensureAllDesktops();
    for (const desktop of desktops) {
      log(
        desktop.index === undefined
          ? `desktop for ${desktop.name}: failed to start`
          : `desktop for ${desktop.name}: :${desktop.index}`
      );
    }
  }

  const boxToken = loadBoxToken();
  let boxdUrl: string | undefined;
  try {
    boxdUrl = (await new BoxManager(defaultBoxConfig()).status()).boxdUrl;
  } catch {
    boxdUrl = undefined;
  }

  /**
   * Each agent's desktop is proxied under this server's own origin.
   *
   * Two reasons it goes through here rather than being linked directly. The
   * desktops live on in-container ports that are never published — boxd proxies
   * them — so this is the only route to them. And a published port would be
   * ephemeral, changing on every recreate and silently blanking any open tab.
   *
   * /desktop/<index>/... is the stable path; the browser only ever sees indices.
   */
  const boxdOrigin = (() => {
    if (!box.connected) return undefined;
    try {
      const url = new URL(boxdUrl!);
      return { host: url.hostname, port: Number(url.port) };
    } catch {
      return undefined;
    }
  })();

  /** Rewrites /desktop/<index>/<rest> to boxd's /vnc/<index>/<rest>. */
  function desktopUpstreamPath(pathname: string, search: string): string | undefined {
    const match = /^\/desktop\/(\d+)(\/.*)?$/.exec(pathname);
    if (!match) return undefined;
    const rest = match[2] ?? "/";
    return `/vnc/${match[1]}${rest}${search}`;
  }

  function proxyDesktop(req: IncomingMessage, res: ServerResponse, path: string) {
    if (!boxdOrigin) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("The box is not available. Start it with `agentbox box up`.");
      return;
    }

    const upstream = httpRequest(
      {
        host: boxdOrigin.host,
        port: boxdOrigin.port,
        method: req.method,
        path,
        headers: {
          ...req.headers,
          host: `${boxdOrigin.host}:${boxdOrigin.port}`,
          // boxd requires the token on everything but /health and the VNC stream.
          authorization: `Bearer ${boxToken}`,
        },
      },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      }
    );

    upstream.on("error", error => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`Cannot reach the box desktop: ${error.message}`);
      } else {
        res.end();
      }
    });

    req.pipe(upstream);
  }

  function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
    const payload = type === "application/json" ? JSON.stringify(body) : String(body);
    res.writeHead(status, {
      "content-type": type === "application/json" ? type : `${type}; charset=utf-8`,
      "content-length": Buffer.byteLength(payload),
      // The page is regenerated on every start; a cached copy would hide changes.
      "cache-control": "no-store",
    });
    res.end(payload);
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > 1_000_000) throw new Error("request body too large");
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;

      try {
        if (route === "GET /") {
          send(res, 200, APP_HTML, "text/html");
          return;
        }

        // noVNC and its assets. `path` tells noVNC to open its socket under the
        // same prefix, so the whole desktop lives on this origin.
        if (url.pathname.startsWith("/desktop/")) {
          const upstream = desktopUpstreamPath(url.pathname, url.search);
          if (!upstream) {
            send(res, 404, { error: `Not a desktop path: ${url.pathname}` });
            return;
          }
          proxyDesktop(req, res, upstream);
          return;
        }

        // The Markdown renderer, read from node_modules. Served from here rather than
        // a CDN so the UI works with no network and stays on the locked version.
        if (route === "GET /vendor/markdown-it.js") {
          try {
            vendorScript ??= readFileSync(vendorPath());
            res.writeHead(200, {
              "content-type": "application/javascript; charset=utf-8",
              "content-length": vendorScript.length,
              "cache-control": "no-store",
            });
            res.end(vendorScript);
          } catch (error) {
            // The page falls back to plain text, so say what is missing and carry on.
            const detail = error instanceof Error ? error.message : String(error);
            log(`markdown-it is unavailable: ${detail}`);
            send(res, 404, { error: detail });
          }
          return;
        }

        if (route === "GET /api/state") {
          send(res, 200, {
            provider: describeProvider(options.provider),
            box: { ...box, ok: box.connected },
            agents: registry.list().map(record => {
              const index = registry.displayIndexFor(record.id);
              return {
                id: record.id,
                name: record.profile.name,
                title: record.profile.title ?? "",
                description: record.profile.description,
                // Every agent has its own desktop, so the UI shows whichever one
                // belongs to the agent you are looking at.
                displayIndex: index,
                desktopUrl:
                  `/desktop/${index}/vnc.html?autoconnect=1&resize=scale` +
                  `&path=desktop/${index}/websockify`,
              };
            }),
          });
          return;
        }

        if (route === "GET /api/activity") {
          send(res, 200, activity.list());
          return;
        }

        if (route === "GET /api/transcript") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          // Mapped for reading, not replayed raw: the stored form is written for the
          // model, and the roster is what lets a wake prompt be split back into the
          // messages that caused it.
          const roster = registry.list().map(record => ({
            id: record.id,
            name: record.profile.name,
          }));
          send(res, 200, toDisplayEntries(registry.readTranscript(id), roster));
          return;
        }

        if (route === "POST /api/agents") {
          const body = await readJson(req);
          const created = registry.create({
            name: String(body.name ?? ""),
            description: String(body.description ?? ""),
          });
          log(`created agent ${created.profile.name} (${created.id})`);
          send(res, 200, { id: created.id, name: created.profile.name });
          return;
        }

        if (route === "POST /api/prompt") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const text = String(body.text ?? "").trim();

          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          if (!text) {
            send(res, 400, { error: "text is required" });
            return;
          }

          // Echo the prompt so every connected page shows it, then answer
          // immediately: the turn's output arrives over the event stream, and a
          // long turn must not hold the HTTP request open.
          broadcast({ type: "prompt", agentId, text });
          send(res, 202, { accepted: true });

          void orchestrator
            .prompt(agentId, text)
            // Teammates woken by this turn are still working; let them finish so
            // their messages and turns show up before the page looks idle.
            .then(() => orchestrator.settle())
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              log(`turn failed: ${message}`);
              broadcast({ type: "error", message });
            });
          return;
        }

        if (route === "GET /api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          clients.add(res);

          // Proxies and idle timeouts kill a silent stream; a comment keeps it open
          // without the client having to interpret anything.
          const keepAlive = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {
              clearInterval(keepAlive);
              clients.delete(res);
            }
          }, 20_000);

          req.on("close", () => {
            clearInterval(keepAlive);
            clients.delete(res);
          });
          return;
        }

        send(res, 404, { error: `No route for ${route}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`error on ${route}: ${message}`);
        if (!res.headersSent) send(res, 500, { error: message });
      }
    })();
  });

  /**
   * The WebSocket upgrade that actually carries the screen.
   *
   * Node does not proxy an upgrade for us: the handshake has to be replayed to the
   * upstream verbatim and then the two sockets joined byte-for-byte, because
   * everything after it is framed RFB rather than HTTP.
   */
  server.on("upgrade", (req, clientSocket: Socket, head: Buffer) => {
    const raw = req.url ?? "";
    const [pathname, query] = raw.split("?");
    const upstreamPath = desktopUpstreamPath(pathname ?? "", query ? `?${query}` : "");

    if (!boxdOrigin || !upstreamPath) {
      clientSocket.destroy();
      return;
    }

    const upstream = netConnect(boxdOrigin.port, boxdOrigin.host, () => {
      const headers = Object.entries(req.headers)
        .map(([key, value]) =>
          `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`
        )
        .join("");
      upstream.write(`GET ${upstreamPath} HTTP/1.1\r\n${headers}\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });

    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  });

  const host = options.host ?? "127.0.0.1";
  await new Promise<void>(resolve => server.listen(options.port, host, resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.onReady?.(`http://${host}:${port}`);

  return () => {
    for (const client of clients) client.end();
    server.close();
  };
}
