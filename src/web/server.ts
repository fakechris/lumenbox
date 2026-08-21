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
import { join, posix } from "node:path";
import { AgentRegistry } from "../agents/registry.ts";
import type { BusEvent } from "../agents/bus.ts";
import { resolveBoxProvisioner, type BoxProvisioner } from "../box/provisioner.ts";
import { envNumber } from "../config.ts";
import { BackupSchedule, backupRoot } from "../host/backup.ts";
import { Orchestrator } from "../host/orchestrator.ts";
import { describeProvider, type ProviderProfile } from "../host/provider.ts";
import type { TurnEvent } from "../host/turn.ts";
import { APP_HTML } from "./app-html.ts";
import { authorize, callerOf, isLoopback, mayDrive, refusalToDrive } from "./auth.ts";

/**
 * The one directory a person may browse, and the one that survives a rebuild.
 *
 * Those being the same set is deliberate: "you can download it" and "it will still be here
 * tomorrow" are then one rule rather than two.
 */
const WORK_DIR = process.env.AGENTBOX_WORK_DIR ?? "/home/box/work";

/**
 * Whether a path is inside the work directory, textually.
 *
 * A prefix check on a normalised path, which stops `..` and a bare `/etc/passwd`. It does *not* stop
 * a symlink pointing out of the tree — that is checked in the daemon with `realpath`, where the
 * filesystem actually is. Both, because this one is reachable by anyone with a UI token.
 */
function withinWork(path: string): boolean {
  if (path.includes("\0")) return false;
  const normalised = posix.normalize(path);
  return normalised === WORK_DIR || normalised.startsWith(`${WORK_DIR}/`);
}
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

  // Backups on a timer, off unless asked for. The state this protects is the only part of the
  // system that cannot be rebuilt, and the previous instruction — stop the box, then `cp -a` —
  // required both stopping and remembering, so it did not happen.
  const backupHours = envNumber("AGENTBOX_BACKUP_HOURS", 0);
  const backups =
    backupHours > 0
      ? new BackupSchedule({ intervalMs: backupHours * 3_600_000, log: line => log(line) })
      : undefined;
  if (backups !== undefined) {
    // One at startup, so a fresh deployment has a copy before it has run anything, rather than
    // after the first interval it may not survive.
    backups.once();
    backups.start();
    log(`backing up every ${backupHours}h to ${backupRoot()}`);
  }

  const box = await orchestrator.connectBox();
  log(box.connected ? `box: ${box.detail}` : `box: unavailable — ${box.detail}`);

  // Recovery happens only now, after the box is connected — a recovered turn captures whatever box
  // the orchestrator holds when it is built, and a turn that started before the box was up would run
  // without shell, files, or a desktop and could finish or fail before the box ever arrived. The
  // inbox first, then interrupted turns: a turn already running is further along than a message only
  // accepted, and they run in the order queued.
  const restored = orchestrator.bus.recover();
  if (restored > 0) {
    log(
      `resumed ${restored} message${restored === 1 ? "" : "s"} accepted before the last restart ` +
        `and never started`
    );
  }
  const picked = orchestrator.resumeInterrupted();
  if (picked.resumed > 0) {
    log(`picking up ${picked.resumed} turn${picked.resumed === 1 ? "" : "s"} interrupted by a restart`);
  }
  if (picked.abandoned > 0) {
    log(
      `${picked.abandoned} interrupted turn${picked.abandoned === 1 ? "" : "s"} not picked up again ` +
        `after repeated failures; said so in the transcript`
    );
  }

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

      // Who this is, read once and in one place. `decision.allow` is passed rather than re-derived,
      // so identity cannot be trusted on a request that authentication did not accept.
      const caller = callerOf(req.headers, decision.allow);

      /**
       * Refuses a mutating request the caller may not make, and says which role would allow it.
       *
       * Returns true when it has already answered, so a handler reads as one line rather than an
       * `if` nest. Every route that changes something calls this — a check per handler is how one
       * handler ends up missing it.
       */
      const refused = (agentId?: string): boolean => {
        const agent = agentId === undefined ? undefined : registry.tryGet(agentId);
        const reason = refusalToDrive(caller, agent?.profile);
        if (reason === undefined) return false;
        send(res, 403, { error: reason });
        return true;
      };

      try {
        if (route === "GET /") {
          send(res, 200, APP_HTML, "text/html");
          return;
        }

        // noVNC and its assets. `path` tells noVNC to open its socket under the
        // same prefix, so the whole desktop lives on this origin.
        if (url.pathname.startsWith("/desktop/")) {
          // Same choice as the upgrade: the page and the socket it opens must come from the same
          // stack, or a viewer would be served a page pointing at a stream they are refused.
          const upstream = desktopUpstreamPath(
            url.pathname,
            url.search,
            mayDrive(caller)
          );
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
          if (refused()) return;
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

        // ── policy: stopping a turn, and answering an approval ─────────────────────
        //
        // These are the only two things in this API a person does *to* a running agent rather than
        // with it, which is why they are POSTs with no body beyond an id: there is nothing to get
        // wrong, and nothing that reads as a normal instruction.
        if (route === "GET /api/policy") {
          send(res, 200, {
            pending: orchestrator.policy.pending(),
            stopped: orchestrator.registry
              .list()
              .filter(agent => orchestrator.policy.isStopped(agent.id))
              .map(agent => agent.id),
          });
          return;
        }

        // What a long task's progress actually looks like: the plan and the list, which survive
        // summarisation and so are the only state that is still true after an hour.
        // ── handing work over ──────────────────────────────────────────────────────
        //
        // The gap this closes: an agent would write a report to /home/box/work and say so, and that
        // was the end of it. A person had to open the VNC desktop, find a file manager, and read it
        // there — with no way to get it onto their own machine. The reference product solves this two
        // ways: pushing the file onto the user's actual disk through an agent running on their
        // machine, or attaching it to the message. We have no agent on their machine, so the browser
        // is the delivery mechanism, and these two routes are it.
        if (route === "GET /api/files") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const dir = url.searchParams.get("dir") ?? WORK_DIR;
          // Confined here as well as in the daemon. Two checks rather than one because this is the
          // one reachable by anyone holding a UI token, including a viewer.
          if (!withinWork(dir)) {
            send(res, 403, { error: `Only ${WORK_DIR} and below can be browsed.` });
            return;
          }
          try {
            const listing = await client.listDir(dir);
            send(res, 200, listing);
          } catch (error) {
            send(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        if (route === "GET /api/file") {
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const path = url.searchParams.get("path") ?? "";
          if (!withinWork(path)) {
            send(res, 403, { error: `Only files under ${WORK_DIR} can be handed over.` });
            return;
          }
          try {
            const file = await client.downloadFile(path);
            const bytes = Buffer.from(file.base64, "base64");
            // `inline` so a browser shows what it can and downloads what it cannot; the filename is
            // still given, so "save as" produces the right name either way.
            const name = file.path.split("/").pop() ?? "file";
            res.writeHead(200, {
              "content-type": file.media_type,
              "content-length": bytes.length,
              "content-disposition": `${
                url.searchParams.get("download") === "1" ? "attachment" : "inline"
              }; filename="${name.replace(/["\\]/g, "")}"`,
              // Never cached: an agent rewrites its own output, and a stale copy would be read as
              // the current one.
              "cache-control": "no-store",
            });
            res.end(bytes);
          } catch (error) {
            send(res, 404, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        if (route === "POST /api/file") {
          // The other direction: a person hands the agent a document. Driving is required — a viewer
          // may read what the agents made and may not add to it.
          if (refused()) return;
          const client = orchestrator.boxClient();
          if (!client) {
            send(res, 503, { error: "The box is not running." });
            return;
          }
          const body = await readJson(req);
          const path = String(body.path ?? "");
          if (!withinWork(path)) {
            send(res, 403, { error: `Uploads only land under ${WORK_DIR}.` });
            return;
          }
          try {
            send(res, 200, await client.uploadFile(path, String(body.base64 ?? "")));
          } catch (error) {
            send(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        // For the composer's "/" menu. Names and descriptions only — the same index the agent gets,
        // for the same reason.
        if (route === "GET /api/skills") {
          const loaded = await orchestrator.skills.refresh();
          send(res, 200, {
            skills: loaded.skills.map(skill => ({
              slug: skill.slug,
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              path: skill.path,
            })),
            // Surfaced rather than swallowed: a skill with no description is invisible to the agent
            // while appearing to exist, and the person who wrote it is the only one who can fix it.
            problems: loaded.problems,
          });
          return;
        }

        if (route === "GET /api/progress") {
          const agentId = url.searchParams.get("agent") ?? "";
          if (!orchestrator.registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          send(res, 200, orchestrator.registry.readDurableState(agentId));
          return;
        }

        if (route === "POST /api/stop") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          if (refused(agentId)) return;
          if (!orchestrator.registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          // Recorded and effective immediately; the turn notices at its next round boundary. Not an
          // abort: cutting a request in flight would leave a tool call with no result, which the
          // next turn cannot replay.
          orchestrator.policy.stop(agentId);
          send(res, 202, { stopped: agentId });
          return;
        }

        if (route === "POST /api/approve" || route === "POST /api/deny") {
          // Answering an approval is driving: it is the moment a person authorises an action.
          if (refused()) return;
          const body = await readJson(req);
          const id = String(body.id ?? "");
          const answered =
            route === "POST /api/approve"
              ? orchestrator.policy.grant(id)
              : orchestrator.policy.deny(id, "user", String(body.reason ?? "") || undefined);
          // 404 rather than an error for an unknown id: the usual cause is a second click or a page
          // left open, and neither deserves a failure.
          if (!answered) {
            send(res, 404, { error: "That approval is not waiting for an answer." });
            return;
          }
          send(res, 200, { id });
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
          if (refused()) return;
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
          if (refused()) return;
          const body = await readJson(req);
          const created = registry.create({
            name: String(body.name ?? ""),
            description: String(body.description ?? ""),
            // Recorded so "whose agent is this" has an answer. Undefined on a box with no gateway in
            // front, which is the single-user case and stays as it was.
            ...(caller.userId !== undefined ? { ownerUserId: caller.userId } : {}),
            visibility: body.visibility === "private" ? "private" : "shared",
          });
          log(
            `created agent ${created.profile.name} (${created.id})` +
              (caller.userId === undefined ? "" : ` for ${caller.userId}`)
          );
          send(res, 200, { id: created.id, name: created.profile.name });
          return;
        }

        if (route === "POST /api/prompt") {
          const body = await readJson(req);
          const agentId = String(body.agent ?? "");
          if (refused(agentId)) return;
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
          // Attributed, so a transcript stops saying "the user" once there is more than one person
          // in a tenant. Carried on the event too, since that is what the feed renders.
          broadcast({
            type: "prompt",
            agentId,
            text,
            ...(caller.userId !== undefined ? { userId: caller.userId } : {}),
          });
          send(res, 202, { accepted: true });

          void orchestrator
            .prompt(agentId, text, caller)
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

    // And the role, not only the token: this socket is bidirectional, so authorising it as though
    // it only carried pixels is what let someone who may only watch drive the desktop instead.
    const upstreamPath = desktopUpstreamPath(
      pathname ?? "",
      query ? `?${query}` : "",
      mayDrive(callerOf(req.headers, upgradeDecision.allow))
    );

    if (!upstreamPath) {
      clientSocket.destroy();
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
  // Scheduled skills start firing only once something is serving. A CLI invocation that asks one
  // question should not begin running someone's automations as a side effect, so this lives here
  // rather than in the orchestrator's constructor.
  if (process.env.AGENTBOX_SCHEDULER !== "0") {
    orchestrator.scheduler.start();
    log("scheduled skills are armed; set AGENTBOX_SCHEDULER=0 to leave them idle");
  }

  options.onReady?.(`http://${host}:${port}`);

  return () => {
    for (const client of clients) client.end();
    // The backup timer, or an embedding that restarts the server in one process leaves the old one
    // firing alongside the new — two backups a tick, sharing a timestamp and a partial directory.
    backups?.stop();
    orchestrator.scheduler.stop();
    server.close();
  };
}

/**
 * Where in the box a desktop request goes — and, for someone who may only watch, the view-only
 * copy of the same desktop.
 *
 * The browser's URL is identical either way, so nothing about the page depends on the role and a
 * viewer cannot reach the driving stream by editing an address: the choice is made here, from the
 * identity the gateway asserted, and boxd itself does not authenticate this path.
 *
 * Read-only used to mean only that the HTTP routes refused to mutate. The screen was proxied to
 * anyone with a session, and x11vnc was not started view-only, so a viewer could type into the
 * desktop over RFB — every mutation check passed while the person did whatever they liked.
 */
export function desktopUpstreamPath(
  pathname: string,
  search: string,
  canDrive: boolean
): string | undefined {
  const match = /^\/desktop\/(\d+)(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const rest = match[2] ?? "/";
  return `/${canDrive ? "vnc" : "vnc-ro"}/${match[1]}${rest}${search}`;
}

