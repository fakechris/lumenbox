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

import { execFileSync } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { AgentRegistry, MAIN_CONVERSATION, conversationIdFor } from "../agents/registry.ts";
import type { BusEvent } from "../agents/bus.ts";
import { BoxManager, defaultBoxConfig } from "../box/docker.ts";
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
 * The tool list from a request body: an array of known names, `null` for "all",
 * `undefined` for "not provided", or an Error naming what was wrong.
 */
function readToolList(value: unknown): readonly string[] | null | undefined | Error {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return new Error("tools must be an array of tool names");
  }
  const unknown = (value as string[]).filter(name => !ALL_TOOLS.includes(name));
  if (unknown.length > 0) {
    return new Error(`Unknown tools: ${unknown.join(", ")}. Known: ${ALL_TOOLS.join(", ")}.`);
  }
  return value as string[];
}

/**
 * Which code is running, for reading a bug report against the right build.
 *
 * Version from package.json; commit from git, asked once at startup — a deployment
 * without a git checkout says so via AGENTBOX_BUILD or shows "unknown", which is
 * still more honest than showing nothing and guessing later.
 */
function buildInfo(): { version: string; commit: string } {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string") version = pkg.version;
  } catch {
    // The page shows 0.0.0, which reads as "could not tell" and is exactly true.
  }
  let commit = process.env.AGENTBOX_BUILD ?? "";
  if (commit === "") {
    try {
      commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      commit = "unknown";
    }
  }
  return { version, commit };
}

/**
 * The exit code that means "start me again with the new config".
 *
 * 75 is EX_TEMPFAIL — a temporary condition, try again — which is exactly what a
 * settings-driven restart is. The desktop shell relaunches on it; any other exit is a
 * stop or a crash and is treated as one.
 */
export const RESTART_EXIT_CODE = 75;

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
import { agentboxHome, loadConfig, saveConfig, type AgentboxConfig } from "../config.ts";

type AgentboxConfigHostExec = NonNullable<AgentboxConfig["hostExec"]>;
import { ChannelManager } from "../channels/manager.ts";
import { DingTalkChannel } from "../channels/dingtalk.ts";
import { FeishuChannel } from "../channels/feishu.ts";
import { TelegramChannel } from "../channels/telegram.ts";
import { HostRunner, hostRunnerConfig } from "../host/host-runner.ts";
import { ALL_TOOLS } from "../host/orchestrator.ts";
import { PRESET_MODELS, providerNames, resolveProvider, testProvider } from "../host/provider.ts";
import { Principals, roleAtLeast, type Principal, type Role } from "../host/principals.ts";
import { Vault, type Grant } from "../host/vault.ts";
import { seedStarterSkills } from "../host/starter-skills.ts";
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
  | { type: "prompt"; agentId: string; text: string; userId?: string; conversation?: string }
  | { type: "error"; message: string }
  /** One line of docker output while the box is brought up from the page. */
  | { type: "box_setup"; line: string; done?: boolean; ok?: boolean }
  /** An approval was just created; the desktop shell turns this into a notification. */
  | { type: "approval_pending"; agentId: string; agentName: string; description: string };

export async function startWebServer(options: WebOptions): Promise<() => void> {
  const log = options.onLog ?? (() => {});
  const registry = new AgentRegistry();
  /** Read once on first request; it never changes while the server is up. */
  let vendorScript: Buffer | undefined;
  /** The woff2 faces, read once each. Seven files, ~400 KB total. */
  const fontCache = new Map<string, Buffer>();
  /** Asked once: the answer cannot change while this process runs. */
  const build = buildInfo();
  /** One docker bring-up at a time; a second click joins the first via the events. */
  let boxUpInFlight = false;
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

  // The moment an agent starts waiting on a person is worth pushing, not only
  // polling: the desktop shell turns this into a system notification, which is the
  // only way to learn about it while the window is closed.
  const announceApproval = (approval: {
    agentId: string;
    agentName: string;
    description: string;
  }) => {
    broadcast({
      type: "approval_pending",
      agentId: approval.agentId,
      agentName: approval.agentName,
      description: approval.description,
    });
  };

  // The door out of the box, built from config: off unless an operator turned it on.
  // Read once at construction — a change to it takes effect at the next restart, the
  // same as the provider, because it decides what tools an agent is even offered.
  const hostRunner = new HostRunner(hostRunnerConfig(loadConfig().hostExec ?? {}));
  if (hostRunner.enabled) log("host execution is on; every host command still asks for approval");

  // The credential vault. Read fresh on each edit through the routes; the orchestrator
  // holds this one instance, so a granted secret is usable on the next host command.
  const vault = new Vault();

  const orchestrator = new Orchestrator({
    registry,
    provider: options.provider,
    useBox: options.useBox,
    boxProvisioner: provisioner,
    hostRunner,
    vault,
    onTurnEvent: broadcast,
    onBusEvent: broadcast,
  });

  // ── chat channels ────────────────────────────────────────────────────────────
  //
  // Each is enabled by its credentials being present — including via the config
  // file's env map — and every message runs an ordinary turn through the ordinary
  // gates. The allow list is read fresh per message, so adding someone needs no
  // restart.
  // The people, and the one-time migration from the old flat allow list: every
  // identity that used to be a bare channel grant becomes a driver principal, so a
  // person's existing access survives the upgrade rather than being silently revoked.
  const principals = new Principals();
  {
    const legacy = loadConfig().channelAllow ?? [];
    const unclaimed = legacy.filter(identity => !principals.isKnown(identity));
    if (unclaimed.length > 0) {
      principals.save([
        ...principals.list(),
        ...unclaimed.map(identity => ({
          id: identity,
          name: identity,
          role: "driver" as const,
          identities: [identity],
        })),
      ]);
      saveConfig({ channelAllow: null });
      log(`migrated ${unclaimed.length} channel grant(s) to driver principals`);
    }
  }

  const channels = new ChannelManager({
    mayDrive: identity => roleAtLeast(principals.roleOf(identity), "driver"),
    log: line => log(line),
    ask: async (agentName, text, identity, chatKey) => {
      const agent =
        agentName !== undefined
          ? registry.resolve(agentName)
          : (registry.list()[0] ?? orchestrator.ensureDefaultAgent());
      channels.remember(agent.id, identity.split(":")[0] ?? "", identity);
      // Each outside chat is its own conversation thread: two groups talking to the
      // same agent never read each other's context. Permission stays with the person
      // (identity); context stays with the room (chatKey); spend is billed to the
      // principal the identity resolves to, so one person's several phones are one bill.
      const conversation = conversationIdFor(chatKey);
      const principal = principals.resolve(identity).id;
      const before = registry.readTranscript(agent.id, conversation).length;
      broadcast({ type: "prompt", agentId: agent.id, text, userId: principal, conversation });
      await orchestrator.prompt(agent.id, text, { userId: principal }, { conversation });
      await orchestrator.settle();
      return orchestrator.replySince(agent.id, before, conversation);
    },
  });
  {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
    channels.register(
      new TelegramChannel(telegramToken ?? "", line => log(line)),
      telegramToken !== undefined,
      telegramToken !== undefined ? "starting" : "set TELEGRAM_BOT_TOKEN"
    );
    const feishuId = process.env.FEISHU_APP_ID;
    const feishuSecret = process.env.FEISHU_APP_SECRET;
    channels.register(
      new FeishuChannel(feishuId ?? "", feishuSecret ?? "", line => log(line)),
      feishuId !== undefined && feishuSecret !== undefined,
      feishuId !== undefined && feishuSecret !== undefined
        ? "starting"
        : "set FEISHU_APP_ID and FEISHU_APP_SECRET"
    );
    const dingId = process.env.DINGTALK_CLIENT_ID;
    const dingSecret = process.env.DINGTALK_CLIENT_SECRET;
    channels.register(
      new DingTalkChannel(dingId ?? "", dingSecret ?? "", line => log(line)),
      dingId !== undefined && dingSecret !== undefined,
      dingId !== undefined && dingSecret !== undefined
        ? "starting"
        : "set DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET"
    );
  }
  channels.start();

  orchestrator.policy.onApprovalRequested = approval => {
    announceApproval(approval);
    // Whoever asked from a phone is the person who can unblock this, and they are
    // exactly the person not looking at the page.
    channels.notifyAsker(
      approval.agentId,
      `${approval.agentName || "An agent"} needs your consent:\n${approval.description}\n` +
        `The turn is paused. Open LumenBox to allow or refuse.`
    );
  };

  // The box dying is exactly the event nobody is looking at the page for. A light
  // health probe, and only the ok→gone *transition* is announced — a box that stays
  // down does not deserve a notification a minute.
  let boxWasHealthy = false;
  const boxWatch = setInterval(() => {
    void (async () => {
      const client = orchestrator.boxClient();
      if (!client) return;
      try {
        await client.health();
        boxWasHealthy = true;
      } catch (error) {
        if (boxWasHealthy) {
          boxWasHealthy = false;
          const detail = error instanceof Error ? error.message : String(error);
          log(`box stopped answering: ${detail}`);
          broadcast({ type: "error", message: `The box stopped answering: ${detail}` });
        }
      }
    })();
  }, 30_000);
  boxWatch.unref?.();

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

  // Mutable: the UI can bring the box up after this server started without one.
  let box = await orchestrator.connectBox();
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
    const boxClient = orchestrator.boxClient();
    if (boxClient) void seedStarterSkills(boxClient, line => log(line));
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

      /**
       * Refuses a request the caller's role is too low for.
       *
       * The web token holder is the machine's operator — they run it, they are admin;
       * a gateway that asserts a userId resolves that identity through the roster. So
       * the local UI is unrestricted (as it always was) while a channel-authenticated
       * or gateway user is held to their role.
       */
      const refusedRole = (need: Role): boolean => {
        const role: Role =
          caller.userId === undefined ? "admin" : principals.roleOf(caller.userId);
        if (roleAtLeast(role, need)) return false;
        send(res, 403, {
          error: `This needs the ${need} role; you are ${role}. Ask an admin.`,
        });
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

        // The IBM Plex faces the page's @font-face rules point at, from the repo's
        // assets directory. Absent is fine — font-display: swap and the stacks fall
        // back to system fonts — so a deployment without the directory degrades
        // quietly instead of breaking the page. The name is allowlisted by shape,
        // which is what keeps this from being a file server.
        if (url.pathname.startsWith("/assets/fonts/")) {
          const name = url.pathname.slice("/assets/fonts/".length);
          if (!/^[A-Za-z0-9-]+\.woff2$/.test(name)) {
            send(res, 404, { error: "not a font" });
            return;
          }
          try {
            let font = fontCache.get(name);
            if (font === undefined) {
              const dir =
                process.env.AGENTBOX_ASSETS_DIR ??
                fileURLToPath(new URL("../../assets/fonts", import.meta.url));
              font = readFileSync(join(dir, name));
              fontCache.set(name, font);
            }
            res.writeHead(200, {
              "content-type": "font/woff2",
              "content-length": font.length,
              // Unlike the page, a font file never changes under the same name.
              "cache-control": "public, max-age=86400",
            });
            res.end(font);
          } catch {
            send(res, 404, { error: `${name} is not present on this deployment` });
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
            standing: orchestrator.policy.standingGrants(),
            stopped: orchestrator.registry
              .list()
              .filter(agent => orchestrator.policy.isStopped(agent.id))
              .map(agent => agent.id),
          });
          return;
        }

        // The credential vault: names, descriptions and grants — never values. Admin
        // only, because a secret's grants are who-may-do-what.
        if (route === "GET /api/vault") {
          if (refusedRole("admin")) return;
          send(res, 200, { secrets: vault.list() });
          return;
        }

        if (route === "POST /api/vault") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          const id = typeof body.id === "string" ? body.id.trim() : "";
          if (id === "") {
            send(res, 400, { error: "A secret needs an id (the environment variable name)." });
            return;
          }
          const grants: Grant[] = Array.isArray(body.grants)
            ? (body.grants as Record<string, unknown>[])
                .filter(g => typeof g.holder === "string" && g.holder !== "")
                .map(g => ({
                  holder: g.holder as string,
                  ...(typeof g.expiresAt === "string" && g.expiresAt !== ""
                    ? { expiresAt: g.expiresAt }
                    : {}),
                }))
            : [];
          vault.setSecret({
            id,
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(typeof body.value === "string" && body.value !== "" ? { value: body.value } : {}),
            grants,
          });
          log(`vault: saved secret ${id}`);
          send(res, 200, { secrets: vault.list() });
          return;
        }

        if (route === "POST /api/vault/remove") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          vault.removeSecret(String(body.id ?? ""));
          send(res, 200, { secrets: vault.list() });
          return;
        }

        // The chat channels: which exist, which are running, and the people who may
        // use them. The roster is the access-control list now, not a flat allow list.
        if (route === "GET /api/channels") {
          send(res, 200, {
            channels: channels.list(),
            principals: principals.list(),
          });
          return;
        }

        // Replaces the whole people roster. Only an admin edits who may do what —
        // otherwise a driver could promote themselves, which is the access-control
        // check being decorative.
        if (route === "POST /api/principals") {
          if (refusedRole("admin")) return;
          const body = await readJson(req);
          if (!Array.isArray(body.principals)) {
            send(res, 400, { error: "principals must be an array" });
            return;
          }
          const roster: Principal[] = [];
          for (const raw of body.principals as Record<string, unknown>[]) {
            const name = typeof raw.name === "string" ? raw.name.trim() : "";
            if (name === "") continue;
            const role: Role =
              raw.role === "admin" || raw.role === "driver" ? (raw.role as Role) : "viewer";
            const identities = Array.isArray(raw.identities)
              ? (raw.identities as unknown[]).filter((i): i is string => typeof i === "string")
              : [];
            roster.push({
              id: typeof raw.id === "string" && raw.id !== "" ? raw.id : (identities[0] ?? name),
              name,
              role,
              identities,
            });
          }
          principals.save(roster);
          log(`principals roster updated (${roster.length} people)`);
          send(res, 200, { principals: principals.list() });
          return;
        }

        // Ending a standing grant. The next identical action asks again.
        if (route === "POST /api/policy/revoke") {
          if (refused()) return;
          const body = await readJson(req);
          const revoked = orchestrator.policy.revokeStanding(String(body.fingerprint ?? ""));
          if (!revoked) {
            send(res, 404, { error: "No standing approval with that fingerprint." });
            return;
          }
          send(res, 200, { revoked: true });
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
          const scope =
            body.scope === "session" || body.scope === "always" ? body.scope : "once";
          const answered =
            route === "POST /api/approve"
              ? orchestrator.policy.grant(id, "user", scope)
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

        // ── settings: which provider, persisted ────────────────────────────────────
        //
        // The choice used to live only in the launch command, and a restart that forgot
        // the flag silently became a different company's model with a credential that
        // could not work. The file is the fix; this pair of routes is the interface to
        // it. A change takes effect at the next start — the orchestrator is built around
        // one provider, and swapping it under running turns would be a livelier bug than
        // a restart.
        if (route === "GET /api/config") {
          const config = loadConfig();
          send(res, 200, {
            current: describeProvider(options.provider),
            config: {
              provider: config.provider ?? null,
              model: config.model ?? null,
              baseUrl: config.baseUrl ?? null,
            },
            // The host door, and why it is or is not usable right now.
            hostExec: {
              enabled: hostRunner.enabled,
              cwd: config.hostExec?.cwd ?? null,
              // Present only after a restart with it on; the live runner is what an
              // agent would actually reach, so its reason is the honest one.
              unavailableReason: hostRunner.unavailableReason() ?? null,
            },
            // Whether a credential is present is worth showing; the credential is not.
            presets: providerNames().map(name => {
              const profile = resolveProvider(name);
              return {
                name,
                label: profile.label,
                model: profile.model,
                models: PRESET_MODELS[name] ?? [],
                keyEnv: profile.keyEnv,
                keyPresent:
                  process.env[profile.keyEnv] !== undefined ||
                  (profile.keyEnv === "ANTHROPIC_API_KEY" &&
                    process.env.ANTHROPIC_AUTH_TOKEN !== undefined),
              };
            }),
          });
          return;
        }

        if (route === "POST /api/config") {
          if (refused()) return;
          const body = await readJson(req);

          const providerValue = body.provider;
          if (
            typeof providerValue === "string" &&
            !providerNames().includes(providerValue.toLowerCase())
          ) {
            send(res, 400, {
              error: `Unknown provider "${providerValue}". Known: ${providerNames().join(", ")}.`,
            });
            return;
          }

          const field = (value: unknown): string | null | undefined =>
            value === null ? null : typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

          // The key is stored under the variable the chosen provider reads, and only
          // there: the UI cannot write arbitrary environment variables.
          const chosenName =
            (typeof providerValue === "string" ? providerValue.toLowerCase() : undefined) ??
            loadConfig().provider ??
            "anthropic";
          const key = field(body.key);
          // Host execution: a whole object or nothing. Enabling without a working
          // directory is refused here rather than saved and failed later.
          let hostExecChange: AgentboxConfigHostExec | null | undefined;
          if (body.hostExec !== undefined) {
            const incoming = (body.hostExec ?? {}) as { enabled?: unknown; cwd?: unknown };
            const enabled = incoming.enabled === true;
            const cwd = typeof incoming.cwd === "string" ? incoming.cwd.trim() : "";
            if (enabled && cwd === "") {
              send(res, 400, {
                error: "Turning host execution on needs a working directory for its commands.",
              });
              return;
            }
            hostExecChange =
              enabled || cwd !== "" ? { enabled, ...(cwd !== "" ? { cwd } : {}) } : null;
          }
          const path = saveConfig({
            provider: providerValue === null ? null : field(providerValue)?.toLowerCase(),
            model: body.model === null ? null : field(body.model),
            baseUrl: body.baseUrl === null ? null : field(body.baseUrl),
            ...(hostExecChange !== undefined ? { hostExec: hostExecChange } : {}),
            ...(key !== undefined && key !== null
              ? { env: { [resolveProvider(chosenName).keyEnv]: key } }
              : {}),
          });
          log(`config saved to ${path}`);
          send(res, 200, { saved: true, note: "Takes effect when the server restarts." });
          return;
        }

        // Brings the box up from the page — the first-run path, where telling someone
        // to go find a terminal is the product giving up. The docker output streams to
        // every connected page as events, because an image pull is minutes long and a
        // silent minutes-long button is indistinguishable from a broken one.
        if (route === "POST /api/box/up") {
          if (refused()) return;
          if (boxUpInFlight) {
            send(res, 409, { error: "The box is already being started." });
            return;
          }
          if (box.connected) {
            send(res, 200, { ok: true, detail: box.detail });
            return;
          }
          boxUpInFlight = true;
          send(res, 202, { starting: true });
          void (async () => {
            try {
              const manager = new BoxManager(defaultBoxConfig());
              await manager.up({
                onOutput: line => broadcast({ type: "box_setup", line }),
              });
              box = await orchestrator.connectBox();
              if (box.connected) {
                const desktops = await orchestrator.ensureAllDesktops();
                for (const desktop of desktops) {
                  log(`desktop for ${desktop.name}: ${desktop.index === undefined ? "failed" : `:${desktop.index}`}`);
                }
              }
              broadcast({
                type: "box_setup",
                line: box.connected ? `ready — ${box.detail}` : `failed — ${box.detail}`,
                done: true,
                ok: box.connected,
              });
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              broadcast({ type: "box_setup", line: `failed — ${detail}`, done: true, ok: false });
            } finally {
              boxUpInFlight = false;
            }
          })();
          return;
        }

        // One real round trip against the endpoint before anything is saved: "invalid
        // api key" from the vendor beats a saved config that fails at the next restart.
        if (route === "POST /api/config/test") {
          if (refused()) return;
          const body = await readJson(req);
          const name = typeof body.provider === "string" ? body.provider.toLowerCase() : "";
          if (!providerNames().includes(name)) {
            send(res, 400, { error: `Unknown provider "${name}".` });
            return;
          }
          try {
            const profile = resolveProvider(name);
            if (typeof body.model === "string" && body.model.trim() !== "") {
              profile.model = body.model.trim();
            }
            if (typeof body.baseUrl === "string" && body.baseUrl.trim() !== "") {
              profile.baseUrl = body.baseUrl.trim();
            }
            const key =
              typeof body.key === "string" && body.key.trim() !== ""
                ? body.key.trim()
                : undefined;
            const result = await testProvider(profile, key);
            send(res, 200, result);
          } catch (error) {
            send(res, 200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return;
        }

        // Exits with the code the desktop shell treats as "start me again". Under a bare
        // CLI the process simply ends, which the page says out loud before asking.
        if (route === "POST /api/restart") {
          if (refused()) return;
          log("restart requested from the UI");
          send(res, 202, { restarting: true });
          setTimeout(() => process.exit(RESTART_EXIT_CODE), 300);
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
          // Since local midnight, because "what did today cost" is the question a
          // person glancing at the top bar is asking.
          const midnight = new Date();
          midnight.setHours(0, 0, 0, 0);
          send(res, 200, {
            provider: describeProvider(options.provider),
            build,
            usageToday: orchestrator.usage.totalsSince(midnight.getTime()),
            // Broken out by person, with a readable name where the id is a principal.
            usageByPrincipal: orchestrator.usage
              .byPrincipalSince(midnight.getTime())
              .map(entry => ({
                principal: entry.principal,
                name: entry.principal === "" ? "unattributed" : principals.resolve(entry.principal).name,
                inputTokens: entry.totals.inputTokens,
                outputTokens: entry.totals.outputTokens,
              })),
            box: { ...box, ok: box.connected },
            allTools: ALL_TOOLS,
            agents: registry.list().map(record => {
              const index = registry.displayIndexFor(record.id);
              return {
                id: record.id,
                name: record.profile.name,
                title: record.profile.title ?? "",
                description: record.profile.description,
                // null means unrestricted — every tool, including ones added later.
                tools: record.profile.tools ?? null,
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
          // Which thread — the team room by default, or one outside chat.
          const conversation = url.searchParams.get("conversation") ?? MAIN_CONVERSATION;
          // Mapped for reading, not replayed raw: the stored form is written for the
          // model, and the roster is what lets a wake prompt be split back into the
          // messages that caused it.
          const roster = registry.list().map(record => ({
            id: record.id,
            name: record.profile.name,
          }));
          send(res, 200, toDisplayEntries(registry.readTranscript(id, conversation), roster));
          return;
        }

        // Every thread an agent has, so the page can offer a switcher. The team room
        // is always first; the rest are outside chats, newest activity first.
        if (route === "GET /api/conversations") {
          const id = url.searchParams.get("agent") ?? "";
          if (!registry.has(id)) {
            send(res, 404, { error: `No agent ${id}` });
            return;
          }
          const list = registry.listConversations(id).sort((a, b) => {
            if (a.id === MAIN_CONVERSATION) return -1;
            if (b.id === MAIN_CONVERSATION) return 1;
            return String(b.lastAt ?? "").localeCompare(String(a.lastAt ?? ""));
          });
          send(res, 200, { conversations: list });
          return;
        }

        if (route === "POST /api/agents") {
          if (refused()) return;
          const body = await readJson(req);
          const name = String(body.name ?? "").trim();
          if (name === "") {
            send(res, 400, { error: "The agent needs a name." });
            return;
          }
          const tools = readToolList(body.tools);
          if (tools instanceof Error) {
            send(res, 400, { error: tools.message });
            return;
          }
          const created = registry.create({
            name,
            description: String(body.description ?? ""),
            ...(typeof body.title === "string" && body.title.trim() !== ""
              ? { title: body.title.trim() }
              : {}),
            // A full set is stored as no restriction, so a later new tool reaches an
            // agent that was created with "everything" rather than being withheld.
            ...(tools !== undefined && tools !== null && tools.length < ALL_TOOLS.length
              ? { tools }
              : {}),
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

        // Deleting an agent, with the records decision made explicit: archive the
        // directory (transcript, memory, plan — readable, restorable by moving it
        // back) or delete it outright. Refused mid-turn, because tearing the state
        // out from under a running turn manufactures exactly the interrupted-turn
        // recovery case for no reason; and refused for the last agent, because an
        // empty roster is a page with nothing to click.
        if (route === "POST /api/agents/delete") {
          const body = await readJson(req);
          const agentId = String(body.id ?? "");
          if (refused(agentId)) return;
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          if (orchestrator.bus.activeAgentIds().includes(agentId)) {
            send(res, 409, {
              error: "This agent is in the middle of a turn. Stop it first, then delete.",
            });
            return;
          }
          if (registry.list().length <= 1) {
            send(res, 400, { error: "This is the last agent; create another before deleting it." });
            return;
          }
          const archive = body.records !== "delete";
          const name = registry.get(agentId).profile.name;
          const result = registry.remove(agentId, { archive });
          log(
            archive
              ? `deleted agent ${name}; records archived to ${result.archivedTo}`
              : `deleted agent ${name} and its records`
          );
          send(res, 200, { deleted: agentId, ...(result.archivedTo ? { archivedTo: result.archivedTo } : {}) });
          return;
        }

        // The human path for editing an agent: persona, role label, name, tool set.
        // Distinct from the model-facing UpdateAgent tool, which cannot touch tools —
        // an agent must not be able to widen anyone's tool set, including its own.
        if (route === "POST /api/agents/update") {
          const body = await readJson(req);
          const agentId = String(body.id ?? "");
          if (refused(agentId)) return;
          if (!registry.has(agentId)) {
            send(res, 404, { error: `No agent ${agentId}` });
            return;
          }
          const tools = readToolList(body.tools);
          if (tools instanceof Error) {
            send(res, 400, { error: tools.message });
            return;
          }
          const updated = registry.update(agentId, {
            ...(typeof body.name === "string" && body.name.trim() !== ""
              ? { name: body.name.trim() }
              : {}),
            ...(typeof body.title === "string" ? { title: body.title.trim() } : {}),
            ...(typeof body.description === "string" ? { description: body.description } : {}),
            ...(tools !== undefined
              ? { tools: tools === null || tools.length >= ALL_TOOLS.length ? null : tools }
              : {}),
          });
          log(`updated agent ${updated.profile.name} (${agentId}) from the UI`);
          send(res, 200, { id: agentId, name: updated.profile.name });
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
    clearInterval(boxWatch);
    channels.stop();
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

