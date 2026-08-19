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

import { randomBytes } from "node:crypto";
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
import { resolveBoxProvisioner, type BoxProvisioner } from "../box/provisioner.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { describeProvider, type ProviderProfile } from "../host/provider.ts";
import type { TurnEvent } from "../host/turn.ts";
import { APP_HTML } from "./app-html.ts";
import { COOKIE_NAME, authorize, isLoopback } from "./auth.ts";
import { agentboxHome, loadConfig } from "../config.ts";
import { ActivityLog } from "./activity.ts";
import { vendorPath } from "./markdown.ts";
import { toDisplayEntries } from "./transcript.ts";

export interface WebOptions {
  port: number;
  /**
   * Shared secret for the UI. Anyone holding it can drive the agents, which is the whole
   * access model: there are no users, only whoever has the token.
   */
  token?: string;
  /** Where the box comes from. Defaults to the environment's choice. */
  boxProvisioner?: BoxProvisioner;
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

  const provisioner = options.boxProvisioner ?? resolveBoxProvisioner();

  const orchestrator = new Orchestrator({
    registry,
    provider: options.provider,
    useBox: options.useBox,
    boxProvisioner: provisioner,
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


  /**
   * Each agent's desktop is proxied under this server's own origin.
   *
   * Two reasons it goes through here rather than being linked directly. The
   * desktops live on in-container ports that are never published — boxd proxies
   * them — so this is the only route to them. And a published port would be
   * ephemeral, changing on every recreate and silently blanking any open tab.
   *
   * /desktop/<index>/... is the stable path; the browser only ever sees indices.
   *
   * Resolved per request rather than once at startup, and re-resolved when a proxy
   * attempt fails. Docker assigns boxd a fresh host port on every `box up --recreate`,
   * so a cached one turns every desktop into a 502 for the rest of the process's life —
   * which is what happened three times while building this: the box was rebuilt, the UI
   * kept pointing at a dead port, and the only fix anyone knew was restarting the UI.
   * The lookup is a `docker port` call, cached for a few seconds so a page load's worth
   * of asset requests does not shell out for each one.
   */
  interface Origin {
    host: string;
    port: number;
    token: string;
  }
  let cachedOrigin: { value: Origin | undefined; at: number } | undefined;
  const ORIGIN_TTL_MS = 5000;

  async function resolveBoxdOrigin(force = false): Promise<Origin | undefined> {
    if (!force && cachedOrigin && Date.now() - cachedOrigin.at < ORIGIN_TTL_MS) {
      return cachedOrigin.value;
    }
    let value: Origin | undefined;
    try {
      const endpoint = await provisioner.endpoint();
      if (endpoint) {
        const url = new URL(endpoint.baseUrl);
        value = {
          host: url.hostname,
          port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
          token: endpoint.token,
        };
      }
    } catch {
      value = undefined;
    }
    cachedOrigin = { value, at: Date.now() };
    return value;
  }

  /** Rewrites /desktop/<index>/<rest> to boxd's /vnc/<index>/<rest>. */
  function desktopUpstreamPath(pathname: string, search: string): string | undefined {
    const match = /^\/desktop\/(\d+)(\/.*)?$/.exec(pathname);
    if (!match) return undefined;
    const rest = match[2] ?? "/";
    return `/vnc/${match[1]}${rest}${search}`;
  }

  async function proxyDesktop(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    retried = false
  ): Promise<void> {
    const origin = await resolveBoxdOrigin(retried);
    if (!origin) {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("The box is not available. Start it with `agentbox box up`.");
      return;
    }

    const upstream = httpRequest(
      {
        host: origin.host,
        port: origin.port,
        method: req.method,
        path,
        headers: {
          ...req.headers,
          host: `${origin.host}:${origin.port}`,
          // boxd requires the token on everything but /health and the VNC stream.
          authorization: `Bearer ${origin.token}`,
        },
      },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      }
    );

    upstream.on("error", error => {
      // A recreated box means a new host port. One retry with a forced lookup turns
      // that from a permanent 502 into a hiccup.
      if (!retried && !res.headersSent) {
        void proxyDesktop(req, res, path, true);
        return;
      }
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

      const decision = authorize(
        { token, host },
        {
          authorization: req.headers.authorization,
          cookie: req.headers.cookie,
          query: url.searchParams.get("token"),
        }
      );
      if (!decision.allow) {
        // No WWW-Authenticate: a browser prompt would be the wrong shape for this, and the
        // token belongs in the URL once rather than typed into a dialog.
        send(res, 401, {
          error:
            "This UI needs a token. Open it with ?token=… or send an Authorization: Bearer header.",
        });
        return;
      }
      if ("setCookie" in decision && decision.setCookie) {
        // Set before anything else writes headers, so the iframe and video requests that
        // follow this page load are already authenticated.
        res.setHeader("set-cookie", decision.setCookie);
      }

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
          await proxyDesktop(req, res, upstream);
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

        // Recording. The video streams through this server for the same reason the
        // desktop does: boxd's port is not something the browser should know about.
        if (route === "GET /recording") {
          const name = url.searchParams.get("name") ?? "";
          await proxyDesktop(
            req,
            res,
            `/recordings/file?name=${encodeURIComponent(name)}`
          );
          return;
        }

        // The clipboard, both directions. A VNC canvas is not a text field: without
        // this, anything the user wants in the box has to be retyped by hand, and
        // anything an agent leaves on the clipboard is stuck there.
        if (route === "POST /api/clipboard") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const client = orchestrator.boxClient();

          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }

          const index = registry.displayIndexFor(agentId);
          try {
            // Text present means write, absent means read: one route, because the two
            // are the same operation from the page's point of view.
            const result =
              typeof body.text === "string"
                ? await client.writeClipboard(body.text, index)
                : await client.readClipboard(index);
            send(res, 200, result);
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        // What has been spent. Shaped for a collector that remembers an offset — ?since=<seq> —
        // which is also what the UI uses to show a running total without re-reading everything.
        if (route === "GET /api/usage") {
          const since = Number(url.searchParams.get("since") ?? 0);
          const afterSeq = Number.isFinite(since) && since > 0 ? since : 0;
          send(res, 200, {
            records: orchestrator.usage.since(afterSeq, 500),
            totals: orchestrator.usage.totals(afterSeq),
          });
          return;
        }

        if (route === "GET /api/recordings") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 200, { recordings: [] });
            return;
          }
          send(res, 200, await client.listRecordings());
          return;
        }

        if (route === "POST /api/record") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          const action = String(body.action ?? "");
          const client = orchestrator.boxClient();

          if (!client) {
            send(res, 503, { error: "The box is not available." });
            return;
          }
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }

          // Recorded per desktop, and every agent has its own, so this records exactly
          // the screen the person is looking at.
          const index = registry.displayIndexFor(agentId);
          const name = registry.get(agentId).profile.name;
          try {
            const result =
              action === "start"
                ? await client.startRecording({ display: index, name })
                : await client.stopRecording(index);
            log(
              action === "start"
                ? `recording ${name}'s desktop to ${result.file}`
                : `recording saved: ${result.file} (${result.size_bytes ?? 0} bytes)`
            );
            send(res, 200, result);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            send(res, 400, { error: message });
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

    if (!upstreamPath) {
      clientSocket.destroy();
      return;
    }

    // The RFB socket carries the screen, so it needs the same check. A browser sends the
    // cookie on an upgrade but cannot set a header, which is why the cookie exists.
    const upgradeDecision = authorize(
      { token, host },
      { authorization: req.headers.authorization, cookie: req.headers.cookie }
    );
    if (!upgradeDecision.allow) {
      clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }

    void openUpgrade(req, clientSocket, head, upstreamPath);
  });

  /** The RFB socket, joined to whichever host port boxd is published on right now. */
  async function openUpgrade(
    req: IncomingMessage,
    clientSocket: Socket,
    head: Buffer,
    upstreamPath: string
  ): Promise<void> {
    const origin = await resolveBoxdOrigin();
    if (!origin) {
      clientSocket.destroy();
      return;
    }

    const upstream = netConnect(origin.port, origin.host, () => {
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
  }

  const host = options.host ?? "127.0.0.1";

  // The old justification for having no authentication was that this binds loopback:
  // anything able to reach it can already drive the agents. That stopped being true when
  // the orchestrator moved into the box, where it binds 0.0.0.0 and only Docker's publish
  // address keeps it local. So a non-loopback bind without a configured token gets one
  // generated and announced, rather than being served openly.
  const configured = options.token ?? process.env.AGENTBOX_UI_TOKEN;
  let token = configured;
  if (!token && !isLoopback(host)) {
    token = randomBytes(16).toString("hex");
    log(`bound to ${host} with no token configured; generated one`);
    log(`open: http://${host}:${options.port}/?token=${token}`);
  }
  if (!token) {
    log("no UI token: anything that can reach this port can drive the agents");
  }
  await new Promise<void>(resolve => server.listen(options.port, host, resolve));

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  options.onReady?.(`http://${host}:${port}`);

  return () => {
    for (const client of clients) client.end();
    server.close();
  };
}
