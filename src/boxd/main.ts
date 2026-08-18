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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  BOXD_PORT,
  type ComputerRequest,
  type ComputerResult,
  type ExecRequest,
  type ExecResult,
  type HealthResult,
  type ListDirRequest,
  type ListDirResult,
  type ReadFileRequest,
  type ReadFileResult,
  type WriteFileRequest,
  type WriteFileResult,
} from "../protocol/index.ts";
import { X11Executor } from "../cua/x11-executor.ts";
import {
  detectDisplay,
  getDisplay,
  waitForDisplay,
  type DisplayDetectionResult,
} from "../cua/display.ts";
import { runShell } from "./shell-service.ts";
import { listDir, readFile, writeFile } from "./fs-service.ts";

const VERSION = "0.1.0";
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const startedAt = Date.now();

const display = getDisplay();
const token = process.env.BOXD_TOKEN ?? "";

/**
 * Display state is resolved lazily and cached: the daemon must come up even when
 * X is still starting (or absent entirely), because shell and filesystem calls
 * do not need a display.
 */
let displayState: DisplayDetectionResult | undefined;
let executor: X11Executor | undefined;

async function ensureExecutor(): Promise<X11Executor> {
  if (executor && displayState) return executor;
  await waitForDisplay(display, 30_000);
  displayState = await detectDisplay(display);
  executor = new X11Executor({
    display,
    resolution: displayState.resolution,
  });
  log(
    `display ${display} detected at ${displayState.resolutionString} ` +
      `(api ${displayState.resolution.api.width}x${displayState.resolution.api.height}, ` +
      `${displayState.display.refreshRate}Hz)`
  );
  return executor;
}

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
  // Report whatever display state we already have without blocking on X coming up.
  let resolution = displayState?.resolution;
  let refreshRate = displayState?.display.refreshRate;
  if (!resolution) {
    try {
      const detected = await detectDisplay(display);
      displayState = detected;
      resolution = detected.resolution;
      refreshRate = detected.display.refreshRate;
    } catch {
      // No display yet. Shell and fs endpoints still work.
    }
  }
  return {
    ok: true,
    version: VERSION,
    display,
    resolution,
    refresh_rate: refreshRate,
    uptime_seconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

async function handleComputer(body: ComputerRequest): Promise<ComputerResult> {
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    throw new HttpError(400, "actions must be a non-empty array");
  }
  const x11 = await ensureExecutor();
  const started = Date.now();

  try {
    const result = await x11.execute(body.actions, {
      bindUnmappedCharacters: body.bind_unmapped_characters ?? true,
    });
    return {
      success: result.success,
      screenshot: result.screenshot,
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

type Handler = (body: any) => Promise<unknown>;

const routes: Record<string, Handler> = {
  "POST /computer": (body: ComputerRequest) => handleComputer(body),
  "POST /exec": (body: ExecRequest): Promise<ExecResult> => runShell(body),
  "POST /fs/read": (body: ReadFileRequest): Promise<ReadFileResult> =>
    readFile(body),
  "POST /fs/write": (body: WriteFileRequest): Promise<WriteFileResult> =>
    writeFile(body),
  "POST /fs/list": (body: ListDirRequest): Promise<ListDirResult> =>
    listDir(body),
};

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

      const handler = routes[route];
      if (!handler) {
        send(res, 404, { error: `No route for ${route}` });
        return;
      }

      send(res, 200, await handler(await readBody(req)));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
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

// Bind on all interfaces: Docker's port publishing reaches the container through
// its bridge address, not loopback. The bearer token is the access control.
server.listen(BOXD_PORT, "0.0.0.0", () => {
  log(`listening on 0.0.0.0:${BOXD_PORT}, display ${display}`);
  // Warm the display so the first computer call is not paying detection latency.
  ensureExecutor().catch(error => {
    log(`display not ready yet: ${describe(error)}`);
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
  });
}
