/**
 * Talking to the box's own Chromium over the DevTools protocol.
 *
 * This runs inside the box, which is the whole point: the debugging port stays on the
 * box's loopback and is never mapped out. Everything else the agent does reaches the box
 * through boxd's HTTP surface, and the browser is no different — a port exposed to the
 * host would be a second, unauthenticated way in that answers to nobody.
 *
 * Hand-rolled rather than Playwright. Node 22 has WebSocket, the protocol is JSON in and
 * JSON out, and the parts we need are small; the alternative is ~400MB of browser
 * download machinery in the image to drive a browser that is already installed. The same
 * reasoning produced the hand-rolled MCP client and server.
 *
 * One connection per page target, held open across calls. Reconnecting per action was
 * the obvious simpler design and is wrong: `Page.enable` and the in-page ref map both
 * live for as long as the connection does, so a fresh socket per action would mean
 * re-arming the dialog handler every time and losing every ref between them.
 */

/** How long a single CDP command may take before the caller is told it did not answer. */
const COMMAND_TIMEOUT_MS = 30_000;

export class CdpError extends Error {}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** Asks the browser what pages it has open. */
export async function listTargets(port: number): Promise<CdpTarget[]> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    throw new CdpError(
      `No browser is listening on port ${port}. Start one with box-chrome on this ` +
        `desktop first. (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (!response.ok) throw new CdpError(`Browser returned HTTP ${response.status} listing targets.`);
  return (await response.json()) as CdpTarget[];
}

/** Opens a new tab and returns it, so a fresh task does not disturb what is already open. */
export async function openTarget(port: number, url: string): Promise<CdpTarget> {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT", signal: AbortSignal.timeout(10_000) }
  );
  if (!response.ok) throw new CdpError(`Could not open a tab: HTTP ${response.status}.`);
  return (await response.json()) as CdpTarget;
}


/**
 * A live connection to one page.
 *
 * Events are delivered to whoever registered for them by name. Only a handful matter —
 * dialogs opening, frames navigating, execution contexts appearing — and each is
 * something the service has to react to rather than something a caller polls for.
 */
export class CdpSession {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  private closed = false;

  private constructor(readonly targetId: string) {}

  static async open(target: CdpTarget): Promise<CdpSession> {
    if (target.webSocketDebuggerUrl === undefined) {
      throw new CdpError(`Target ${target.id} has no debugger endpoint; it cannot be driven.`);
    }
    const session = new CdpSession(target.id);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    session.socket = socket;

    socket.onmessage = event => session.receive(String(event.data));
    socket.onclose = () => session.failAll(new CdpError("The browser connection closed."));
    // Without this an error surfaces as an unhandled rejection and takes the daemon with
    // it, which is a very loud way to report that a tab went away.
    socket.onerror = () => {};

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CdpError("The browser did not accept a debugger connection in 10s.")),
        10_000
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new CdpError("The browser refused the debugger connection."));
      });
    });
    return session;
  }

  private receive(raw: string): void {
    let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (waiting === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error !== undefined) {
        waiting.reject(new CdpError(message.error.message ?? "the browser refused the command"));
      } else {
        waiting.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method !== undefined) {
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): void {
    const existing = this.listeners.get(method) ?? [];
    existing.push(listener);
    this.listeners.set(method, existing);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.closed || this.socket === undefined || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpError("The browser connection is not open."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Deliberately not retried anywhere above: a command that timed out may well
        // have run. Clicking "Place order" twice is worse than reporting uncertainty.
        reject(new CdpError(`${method} did not answer within ${timeoutMs}ms; it may still have run.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.closed = true;
    this.failAll(new CdpError("The browser connection was closed."));
    try {
      this.socket?.close();
    } catch {
      // Already gone; nothing to do.
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.socket?.readyState === WebSocket.OPEN;
  }
}
