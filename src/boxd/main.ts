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
import { createReadStream, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  BOXD_PORT,
  type ClipboardReadRequest,
  type ClipboardResult,
  type ClipboardWriteRequest,
  type ComputerRequest,
  type ComputerResult,
  type ExecRequest,
  type ExecResult,
  type DisplayInfo,
  type EnsureDisplayRequest,
  type EnsureDisplayResult,
  type HealthResult,
  type ListDirRequest,
  type ListDirResult,
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
import { RecordService, RECORDINGS_DIR } from "./record-service.ts";
import { runShell } from "./shell-service.ts";
import { listDir, readFile, writeFile } from "./fs-service.ts";

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

async function handleHealth(): Promise<HealthResult> {
  // Never block on a desktop coming up: shell and fs work without one, and the
  // container health check must not hang while Xvfb starts.
  const running = displays.list();
  const primary = running.find(entry => entry.index === defaultDisplayIndex);
  return {
    ok: true,
    version: VERSION,
    display,
    resolution: primary?.resolution,
    refresh_rate: undefined,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
    displays: running,
    desktop_health: displays.health(),
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
): { index: number; upstream: string } | undefined {
  const match = /^\/vnc\/(\d+)(\/.*)?$/.exec(path);
  if (!match) return undefined;
  const index = Number(match[1]);
  const rest = match[2] ?? "/";
  return { index, upstream: rest === "/" ? "/vnc.html" : rest };
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
  const port = DisplayManager.novncPort(parsed.index);
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

type Handler = (body: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "POST /computer": (body: ComputerRequest) => handleComputer(body),
  "POST /exec": (body: ExecRequest): Promise<ExecResult> => {
    // A shell on someone else's desktop can do everything computer-use can — start a
    // window on it, type with xdotool — so it is gated the same way.
    if (body.display !== undefined) displays.assertOwner(body.display, body.owner);
    return runShell(body);
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
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");

  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { "content-range": `bytes */${total}` });
      res.end();
      return;
    }
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

      // noVNC for a desktop, proxied so only this port has to be published.
      if (url.startsWith("/vnc/")) {
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
 * Deliberately unauthenticated, like /health: the browser cannot set headers on a
 * WebSocket, and the host proxies this from its own loopback-only server. Publishing
 * boxd to a routable address exposes these desktops — which the README says.
 */
server.on("upgrade", (req, clientSocket: Socket, head: Buffer) => {
  const parsed = parseVncPath((req.url ?? "").split("?")[0] ?? "");
  if (!parsed || !displays.has(parsed.index)) {
    clientSocket.destroy();
    return;
  }

  const query = (req.url ?? "").includes("?")
    ? (req.url ?? "").slice((req.url ?? "").indexOf("?"))
    : "";
  const port = DisplayManager.novncPort(parsed.index);

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
server.listen(BOXD_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${BOXD_PORT}, display ${display}`);
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
