/**
 * boxd — the in-box daemon.
 *
 * Runs inside the container as the unprivileged `box` user and exposes computer-use,
 * shell, and filesystem operations over HTTP on BOXD_PORT. This is the only thing
 * the host talks to; the host never runs xdotool or ffmpeg itself.
 *
 * Auth is a bearer token from BOXD_TOKEN. The port is published to the Docker host,
 * so on a remote engine it is reachable by anything that can route to that host —
 * the token is the only thing standing between the network and a shell in the box.
 */

import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRange } from "./range.ts";
import { timingSafeEqual } from "node:crypto";
import {
  BOXD_PORT,
  BOXD_PROTOCOL,
  type ClipboardReadRequest,
  type ClipboardResult,
  type ClipboardWriteRequest,
  type BrowserRequest,
  type BrowserResponse,
  type ComputerRequest,
  type ComputerResult,
  type ExecRequest,
  type ExecResult,
  type JobStartedResult,
  type JobStatus,
  type JobWaitRequest,
  type JobWaitResult,
  type DisplayInfo,
  type EnsureDisplayRequest,
  type EnsureDisplayResult,
  type HealthResult,
  type ListDirRequest,
  type ListDirResult,
  type DownloadFileRequest,
  type DownloadFileResult,
  type UploadFileRequest,
  type UploadFileResult,
  type ReadFileRequest,
  type ReadFileResult,
  type RecordListResult,
  type RecordStartRequest,
  type RecordStopRequest,
  type RecordingInfo,
  type WriteFileRequest,
  type WriteFileResult,
} from "../protocol/index.ts";
import { DisplayManager, DisplayOwnershipError } from "./displays.ts";
import { getDisplay, parseDisplayNum } from "../cua/display.ts";
import { readClipboard, writeClipboard } from "./clipboard-service.ts";
import { startEgressProxy } from "../egress/proxy.ts";
import { RecordService, RECORDINGS_DIR } from "./record-service.ts";
import { AGENT_NICE, reapSpool, runShell, withoutBoxToken } from "./shell-service.ts";
import { JobService } from "./job-service.ts";
import { BrowserService } from "./browser-service.ts";
import { downloadFile, listDir, readFile, uploadFile, writeFile } from "./fs-service.ts";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const startedAt = Date.now();

const display = getDisplay();
const token = process.env.BOXD_TOKEN ?? "";

const displays = new DisplayManager(line => log(line));
const recorder = new RecordService(line => log(line));

/** The desktop `box shot` and the smoke test look at when none is named. */
const defaultDisplayIndex = (() => {
  try {
    return parseDisplayNum(display);
  } catch {
    return 1;
  }
})();

function log(message: string): void {
  process.stdout.write(`[boxd] ${message}\n`);
}

function authorized(req: IncomingMessage): boolean {
  // An empty configured token means auth is disabled; refuse to run that way
  // rather than silently serving a shell to the network (checked at startup).
  const header = req.headers.authorization ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expected = Buffer.from(token);
  const actual = Buffer.from(presented);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(400, `Malformed JSON body: ${describe(error)}`);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** The crash log PID 1 keeps, newest last and bounded. */
const CRASH_LOG = process.env.BOX_CRASH_LOG ?? "/tmp/agentbox-crashes.jsonl";
const CRASH_LIMIT = 20;

function recentCrashes(): HealthResult["crashes"] {
  try {
    return readFileSync(CRASH_LOG, "utf8")
      .split("\n")
      .filter(line => line.trim() !== "")
      .slice(-CRASH_LIMIT)
      .flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          // A line written while the file was being appended to. One record is not worth
          // failing a health check over.
          return [];
        }
      });
  } catch {
    // No crashes recorded, or no log yet.
    return [];
  }
}

async function handleHealth(): Promise<HealthResult> {
  // Never block on a desktop coming up: shell and fs work without one, and the
  // container health check must not hang while Xvfb starts.
  const running = displays.list();
  const primary = running.find(entry => entry.index === defaultDisplayIndex);
  return {
    ok: true,
    version: VERSION,
    protocol: BOXD_PROTOCOL,
    display,
    resolution: primary?.resolution,
    refresh_rate: undefined,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    displays: running,
    desktop_health: displays.health(),
    crashes: recentCrashes(),
  };
}

async function handleComputer(body: ComputerRequest): Promise<ComputerResult> {
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    throw new HttpError(400, "actions must be a non-empty array");
  }
  const index = body.display ?? defaultDisplayIndex;
  displays.assertOwner(index, body.owner);
  const desktop = await displays.ensure(index, body.owner);
  const x11 = desktop.executor;
  const started = Date.now();

  try {
    const result = await x11.execute(body.actions, {
      bindUnmappedCharacters: body.bind_unmapped_characters ?? true,
    });
    return {
      success: result.success,
      screenshot: result.screenshot,
      windows: result.windows,
      cursor_position: result.cursorPosition,
      action_count: result.actionCount,
      duration_ms: result.durationMs,
      error: result.error,
    };
  } catch (error) {
    // A failed action is exactly when the model most needs to see the screen:
    // it has to work out what state the desktop is actually in before retrying.
    // Returning only an error string leaves it guessing, so settle and capture
    // before reporting. A capture that also fails must not mask the real error.
    let screenshot = "";
    try {
      const recovery = await x11.execute([
        { action: "wait", duration_ms: 400 },
        { action: "screenshot" },
      ]);
      screenshot = recovery.screenshot;
    } catch (captureError) {
      log(`could not capture an error screenshot: ${describe(captureError)}`);
    }

    return {
      success: false,
      screenshot,
      action_count: body.actions.length,
      duration_ms: Date.now() - started,
      error: describe(error),
    };
  }
}

/**
 * Parses "/vnc/<index>/<rest>" into the desktop and the upstream path.
 *
 * Each desktop's noVNC listens on its own in-container port and none of them are
 * published. Proxying here means one published port serves any number of desktops,
 * where fixed port mappings would cap the count at container-create time.
 */
function parseVncPath(
  path: string
): { index: number; upstream: string; viewOnly: boolean } | undefined {
  // Two prefixes for the same desktop. `/vnc-ro/` reaches the view-only x11vnc, and which one a
  // person gets is decided upstream by their role — boxd does not authenticate this path at all, so
  // it must not be the thing making that decision.
  const match = /^\/(vnc|vnc-ro)\/(\d+)(\/.*)?$/.exec(path);
  if (!match) return undefined;
  const index = Number(match[2]);
  const rest = match[3] ?? "/";
  return {
    index,
    upstream: rest === "/" ? "/vnc.html" : rest,
    viewOnly: match[1] === "vnc-ro",
  };
}

/** Which of a desktop's two noVNC stacks a parsed path names. */
function vncPortOf(parsed: { index: number; viewOnly: boolean }): number {
  return parsed.viewOnly
    ? DisplayManager.novncViewOnlyPort(parsed.index)
    : DisplayManager.novncPort(parsed.index);
}

function proxyVnc(req: IncomingMessage, res: ServerResponse, path: string): void {
  const parsed = parseVncPath(path.split("?")[0] ?? path);
  if (!parsed) {
    send(res, 404, { error: `Not a desktop path: ${path}` });
    return;
  }
  if (!displays.has(parsed.index)) {
    send(res, 404, {
      error: `Desktop ${parsed.index} is not running. Ensure it first.`,
    });
    return;
  }

  const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const port = vncPortOf(parsed);
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: `${parsed.upstream}${query}`,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    response => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    }
  );

  upstream.on("error", error => {
    if (!res.headersSent) send(res, 502, { error: `Desktop unreachable: ${error.message}` });
    else res.end();
  });
  req.pipe(upstream);
}

/**
 * A route handler, which declares its own request type.
 *
 * `any` is deliberate and the alternative is worse: with `unknown` every handler below would need a
 * cast at its own boundary, moving one honest `any` into a dozen dishonest ones. The type each
 * handler declares is the checked contract; this signature only has to let them differ.
 */
// biome-ignore lint/suspicious/noExplicitAny: see above — the handlers' own parameter types are the contract
type Handler = (body: any) => Promise<unknown>;

/** Background jobs live for the life of the daemon, like the shell sessions do. */
const jobs = new JobService();

// Yesterday's spilled output is dead weight; today's is evidence.
//
// On a timer as well as at startup. It used to run once, here, which made "a 24-hour
// buffer" untrue of any daemon that stays up: a box running for a week held week-old
// output, and the adversarial review of docs/15 said so. Hourly is far more often than
// needed to keep a 24-hour promise, and costs one directory listing.
{
  const reap = (): void => {
    const removed = reapSpool();
    if (removed > 0) log(`reaped ${removed} stale spool file(s)`);
  };
  reap();
  // Unref'd: a sweep of temporary files is not a reason for the process to stay alive.
  setInterval(reap, 3_600_000).unref();
}

/**
 * The semantic browser, per desktop. Connections are held open between calls, so this
 * outlives any one request — see browser-service.ts for why that is load-bearing.
 */
const browser = new BrowserService();

const routes: Record<string, Handler> = {
  "POST /computer": (body: ComputerRequest) => handleComputer(body),
  "POST /exec": async (body: ExecRequest): Promise<ExecResult | JobStartedResult> => {
    // A shell on someone else's desktop can do everything computer-use can — start a
    // window on it, type with xdotool — so it is gated the same way.
    if (body.display !== undefined) displays.assertOwner(body.display, body.owner);
    // Every shell command, with who asked for it. Nothing recorded this before, so the
    // box could not answer "who ran that" for the one endpoint where the answer matters
    // most. Truncated because a log is not a transcript; the spool files hold output.
    log(
      `exec [${body.actor ?? "unlabelled"}]${body.background === true ? " (background)" : ""}: ` +
        `${body.command.replace(/\s+/g, " ").slice(0, 200)}`
    );
    if (body.background === true) {
      return jobs.start({
        command: body.command,
        ...(body.cwd !== undefined ? { cwd: body.cwd } : {}),
        ...(body.env !== undefined ? { env: body.env } : {}),
        ...(body.display !== undefined ? { display: body.display } : {}),
        nice: AGENT_NICE,
        scrubbedEnv: withoutBoxToken(process.env),
      });
    }
    return runShell(body);
  },
  // Background work, once started, is asked about rather than waited on.
  "POST /jobs": async (): Promise<{ jobs: JobStatus[] }> => ({ jobs: jobs.list() }),
  "POST /jobs/wait": async (body: JobWaitRequest): Promise<JobWaitResult> => {
    const result = await jobs.wait(body);
    if (result === undefined) throw new Error(`No job ${body.job_id}`);
    return result;
  },
  "POST /jobs/kill": async (body: { job_id: string }): Promise<JobStatus> => {
    const result = jobs.kill(body.job_id);
    if (result === undefined) throw new Error(`No job ${body.job_id}`);
    return result;
  },
  // Gated on desktop ownership exactly as /exec and /computer are: driving the browser on
  // someone else's desktop is driving their screen, whichever protocol it goes over.
  "POST /browser": async (body: BrowserRequest): Promise<BrowserResponse> => {
    const display = body.display ?? defaultDisplayIndex;
    displays.assertOwner(display, body.owner);
    await displays.ensure(display);
    switch (body.op) {
      case "open":
        return browser.open(display, String(body.url ?? "about:blank"));
      case "snapshot":
        return browser.snapshot(display);
      case "read": {
        const result = await browser.read(display);
        return { url: result.url, title: "", snapshot: "", text: result.text };
      }
      case "act":
        return browser.act(display, String(body.action ?? ""), {
          ...(body.ref !== undefined ? { ref: body.ref } : {}),
          ...(body.text !== undefined ? { text: body.text } : {}),
          ...(body.key !== undefined ? { key: body.key } : {}),
          ...(body.replace !== undefined ? { replace: body.replace } : {}),
        });
      case "scroll":
        return browser.scroll(display, String(body.direction ?? "down"), Number(body.amount ?? 3));
      case "upload":
        return browser.upload(display, String(body.ref ?? ""), body.files ?? []);
      case "check": {
        const checked = await browser.check(display, String(body.url ?? "about:blank"));
        return { url: String(body.url ?? ""), title: checked.title, snapshot: checked.snapshot };
      }
      case "wait":
        return browser.waitFor(
          display,
          String(body.waitFor ?? "text"),
          String(body.value ?? ""),
          body.seconds
        );
      default:
        throw new Error(`Unknown browser op ${body.op}`);
    }
  },
  "GET /displays": async (): Promise<DisplayInfo[]> => displays.list(),
  // Per desktop, like everything else: each agent has its own, so "the clipboard" is
  // whichever screen the caller means.
  "POST /clipboard/read": async (body: ClipboardReadRequest): Promise<ClipboardResult> => ({
    text: await readClipboard(body.display ?? defaultDisplayIndex),
  }),
  "POST /clipboard/write": async (body: ClipboardWriteRequest): Promise<ClipboardResult> => {
    const text = typeof body.text === "string" ? body.text : "";
    await writeClipboard(body.display ?? defaultDisplayIndex, text);
    return { text };
  },
  // Recording needs the desktop's real resolution, so it goes through ensure() rather
  // than trusting the request: a recording of a display that is not up is an empty file.
  "POST /record/start": async (body: RecordStartRequest): Promise<RecordingInfo> => {
    const desktop = await displays.ensure(body.display ?? defaultDisplayIndex);
    return recorder.start({
      display: desktop.index,
      resolution: desktop.detection.resolution.display,
      name: body.name,
      framerate: body.framerate,
      crf: body.crf,
      drawMouse: body.draw_mouse,
    });
  },
  "POST /record/stop": (body: RecordStopRequest): Promise<RecordingInfo> =>
    recorder.stop(body.display ?? defaultDisplayIndex),
  // Both methods: curl reaches for GET on a listing, the host client posts everything.
  "GET /recordings": async (): Promise<RecordListResult> => ({
    recordings: recorder.list(),
  }),
  "POST /recordings": async (): Promise<RecordListResult> => ({
    recordings: recorder.list(),
  }),
  "POST /displays/ensure": async (
    body: EnsureDisplayRequest
  ): Promise<EnsureDisplayResult> => {
    const desktop = await displays.ensure(body.index, body.owner);
    return {
      index: desktop.index,
      display: desktop.display,
      resolution: desktop.detection.resolution,
      vnc_path: DisplayManager.vncPath(desktop.index),
    };
  },
  "POST /fs/download": (body: DownloadFileRequest): Promise<DownloadFileResult> =>
    downloadFile(body),

  "POST /fs/upload": (body: UploadFileRequest): Promise<UploadFileResult> => uploadFile(body),

  "POST /fs/read": (body: ReadFileRequest): Promise<ReadFileResult> =>
    readFile(body),
  "POST /fs/write": (body: WriteFileRequest): Promise<WriteFileResult> =>
    writeFile(body),
  "POST /fs/list": (body: ListDirRequest): Promise<ListDirResult> =>
    listDir(body),
};

/**
 * Streams one recording out of the recordings directory.
 *
 * The name is matched against the directory listing rather than joined onto a path:
 * this parameter arrives over HTTP, and a join is how "../../etc/passwd" becomes a
 * file read. Nothing outside that directory can be named, whatever the caller sends.
 */
function serveRecording(req: IncomingMessage, res: ServerResponse): void {
  const requested = new URL(req.url ?? "", "http://box").searchParams.get("name") ?? "";
  let entries: string[] = [];
  try {
    entries = readdirSync(RECORDINGS_DIR);
  } catch {
    entries = [];
  }
  if (!entries.includes(requested)) {
    send(res, 404, { error: `No recording named ${requested}` });
    return;
  }

  const path = join(RECORDINGS_DIR, requested);
  const total = statSync(path).size;
  const range = resolveRange(req.headers.range, total);

  if (range !== undefined) {
    if (range === "unsatisfiable") {
      res.writeHead(416, { "content-range": `bytes */${total}` });
      res.end();
      return;
    }
    const { start, end } = range;
    res.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${total}`,
      "accept-ranges": "bytes",
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "content-type": "video/mp4",
    "content-length": total,
    "accept-ranges": "bytes",
  });
  createReadStream(path).pipe(res);
}

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const route = `${req.method ?? "GET"} ${url}`;

    try {
      if (route === "GET /health") {
        // Unauthenticated so container health checks work without the token.
        send(res, 200, await handleHealth());
        return;
      }

      if (!authorized(req)) {
        send(res, 401, { error: "Unauthorized" });
        return;
      }

      // noVNC for a desktop, proxied so only this port has to be published. Both prefixes: the
      // driving stack at /vnc/ and the view-only stack at /vnc-ro/, which a viewer's page is served
      // from. Routing only /vnc/ meant a viewer's noVNC HTML request fell through to a 404, so the
      // correctly-view-only WebSocket was never opened and the whole feature was dead at the HTTP
      // layer — the injection-refusal was verified against the raw port and this path was not.
      if (url.startsWith("/vnc/") || url.startsWith("/vnc-ro/")) {
        proxyVnc(req, res, url);
        return;
      }

      // A recording, streamed. Range requests are honoured because that is how a
      // browser seeks in a video; without it the player can only play from the start.
      if (route === "GET /recordings/file") {
        serveRecording(req, res);
        return;
      }

      const handler = routes[route];
      if (!handler) {
        send(res, 404, { error: `No route for ${route}` });
        return;
      }

      const body = req.method === "GET" ? {} : await readBody(req);
      send(res, 200, await handler(body));
    } catch (error) {
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof DisplayOwnershipError
            ? 403
            : 500;
      if (status >= 500) log(`error on ${route}: ${describe(error)}`);
      send(res, status, { error: describe(error) });
    }
  })();
});

if (token.length < 16) {
  process.stderr.write(
    "[boxd] refusing to start: BOXD_TOKEN must be set to at least 16 characters.\n" +
      "The daemon exposes shell access; an unauthenticated port is not survivable.\n"
  );
  process.exit(1);
}

/**
 * The WebSocket upgrade carrying a desktop's pixels.
 *
 * Replayed to the upstream verbatim and then joined byte-for-byte, because
 * everything after the handshake is framed RFB rather than HTTP.
 *
 * **Authenticated, because the reason it was not no longer holds.** It used to be open
 * like /health, on the reasoning that a browser cannot set headers on a WebSocket and
 * that only the host's proxy could reach this port. The second half was measured false
 * twice on 2026-08-28: the daemon was published on every interface, so the whole LAN
 * could open a desktop; and after that was fixed, a container on Docker's default bridge
 * still reached this port at the box's private-network address, because Docker 29's
 * DOCKER-FORWARD chain accepts forwarding out of every bridge — user-defined networks
 * are not isolated from each other on that engine, however widely that is believed.
 *
 * The browser still cannot set the header, and does not have to: it connects to the
 * host, which checks the person, and the host puts this token on the hop it makes
 * itself. What is being authenticated here is the hop, not the human.
 */
server.on("upgrade", (req, clientSocket: Socket, head: Buffer) => {
  if (!authorized(req)) {
    clientSocket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    return;
  }
  const parsed = parseVncPath((req.url ?? "").split("?")[0] ?? "");
  if (!parsed || !displays.has(parsed.index)) {
    clientSocket.destroy();
    return;
  }

  const query = (req.url ?? "").includes("?")
    ? (req.url ?? "").slice((req.url ?? "").indexOf("?"))
    : "";
  const port = vncPortOf(parsed);

  const upstream = netConnect(port, "127.0.0.1", () => {
    const headers = Object.entries(req.headers)
      .map(([key, value]) =>
        `${key}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`
      )
      .join("");
    upstream.write(`GET ${parsed.upstream}${query} HTTP/1.1\r\n${headers}\r\n`);
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

// Bind on all interfaces: Docker's port publishing reaches the container through
// its bridge address, not loopback. The bearer token is the access control.
// Egress, when a relay was named. The browser's traffic then leaves from wherever the relay
// runs — the user's own network — instead of from wherever this box runs. Off unless
// configured: without a relay there is nothing to send traffic to.
const egressRelay = process.env.AGENTBOX_EGRESS_RELAY;
if (egressRelay) {
  try {
    startEgressProxy({
      relay: egressRelay,
      token: process.env.AGENTBOX_EGRESS_TOKEN ?? token,
      log: line => log(line),
    });
  } catch (error) {
    // Not fatal: a box with no egress proxy is a box that browses from its own address, which
    // is what it did before this existed.
    log(`egress proxy not started: ${describe(error)}`);
  }
}

const listenPort = process.env.BOXD_PORT ? parseInt(process.env.BOXD_PORT, 10) : BOXD_PORT;
// 0.0.0.0 in a container, where Docker is the only way in. As a drop-in on somebody else's
// machine — Grok Bot's VM, reached over an SSH tunnel — loopback, so the daemon is not one
// token away from that machine's network.
const listenHost = process.env.BOXD_BIND ?? "0.0.0.0";

server.listen(listenPort, listenHost, () => {
  log(`listening on ${listenHost}:${listenPort}, display ${display}`);
  // Encoders left running by a previous daemon. They are adopted by PID 1 when boxd dies and keep
  // writing, and this process's map is empty — so without this, starting a recording gives you two
  // ffmpegs on one screen and a file nobody will ever stop.
  const reclaimed = recorder.reclaimOrphans();
  if (reclaimed > 0) log(`stopped ${reclaimed} recording(s) left by a previous daemon`);
  // Warm the display so the first computer call is not paying detection latency.
  displays.ensure(defaultDisplayIndex).catch(error => {
    log(`default desktop not ready yet: ${describe(error)}`);
  });
  // A component that dies takes the user's view of the box with it, silently: the
  // agent keeps working against X while the screen stays dead. Repair is on a timer.
  displays.startSupervisor();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
