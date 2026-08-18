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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentRegistry } from "../agents/registry.ts";
import type { BusEvent } from "../agents/bus.ts";
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { describeProvider, type ProviderProfile } from "../host/provider.ts";
import type { TurnEvent } from "../host/turn.ts";
import { APP_HTML } from "./app-html.ts";

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
  const clients = new Set<ServerResponse>();

  const broadcast = (event: OutboundEvent) => {
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

  // The noVNC URL is a property of the container, so ask Docker rather than
  // guessing a port.
  let novncUrl: string | undefined;
  try {
    novncUrl = (await new BoxManager(defaultBoxConfig()).status()).novncUrl;
  } catch {
    novncUrl = undefined;
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

        if (route === "GET /api/state") {
          send(res, 200, {
            provider: describeProvider(options.provider),
            box: { ...box, ok: box.connected, novncUrl },
            agents: registry.list().map(record => ({
              id: record.id,
              name: record.profile.name,
              title: record.profile.title ?? "",
              description: record.profile.description,
            })),
          });
          return;
        }

        if (route === "GET /api/transcript") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          send(res, 200, registry.readTranscript(id));
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
