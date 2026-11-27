/**
 * Who is looking at a desktop, by what right, and for how long (docs/106 §5 R6, R8; INV-2204).
 *
 * A desktop stream is a person's eyes and hands on an agent's computer, and it outlives the
 * request that opened it. Three things live here, each one thing a cookie could not say:
 *
 * **A ticket** (off local). The socket opens only with one: issued to one signed-in person for
 * one desktop in one mode, good for one use within a minute. The mode is the lower of what was
 * asked and what the person's role allows, decided when it is issued and again when it is used.
 * A ticket is a credential in an address — noVNC opens its socket from the `path=` in the page's
 * address and a browser cannot put a header on a socket — which is why it is single-use and
 * short, why it is taken out of every address this server passes on or prints, and why the store
 * is in memory: a restart forgets every ticket, and nothing is lost by that. On local the session
 * cookie suffices, as it always has, and no ticket is asked for.
 *
 * **An idle limit** (off local). A stream nothing has moved on, in either direction, for
 * `DESKTOP_IDLE_MS` is closed with a reason the page shows; opening it again takes a new ticket.
 *
 * **A record** (every level). `desktop-sessions.jsonl`: a line when a stream opens — who, whose
 * desktop, which mode — and a line when it closes — why, how long, and for a driving stream
 * whether a key or a button was ever pressed. Never what was typed, clicked or shown.
 */
import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { appendLine } from "../host/jsonl.ts";

export type DesktopMode = "view" | "control";

/** How long a ticket is good for. */
export const TICKET_TTL_MS = 60_000;

/**
 * How long a stream may sit with nothing moving on it before it is closed (off local).
 *
 * Fifteen minutes. A desktop an agent is working on repaints constantly and a person driving one
 * sends input, so neither is ever idle; what goes quiet is a tab left open on a still screen,
 * which is a view of a machine nobody is watching. Shorter would close a person reading a long
 * page on the desktop without scrolling; longer leaves a forgotten tab holding a live view for
 * most of an hour. Coming back costs one reload.
 */
export const DESKTOP_IDLE_MS = 15 * 60_000;

export const DESKTOP_SESSIONS_LEDGER = "desktop-sessions.jsonl";

/** Why a ticket was not honoured; the word is the answer's code and nothing more is said. */
export type TicketRefusal = "ticket-missing" | "ticket-unknown" | "ticket-expired" | "ticket-used" | "ticket-other-person" | "ticket-other-desktop";

interface Ticket { person: string; desktop: string; mode: DesktopMode; expiresAt: number; used: boolean }

/** The live tickets. In memory: a restart invalidates every one, which is the right answer for a credential a minute long. */
export class DesktopTickets {
  private readonly tickets = new Map<string, Ticket>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** A ticket for `person` to open `desktop` in `mode` — which the caller has already lowered to what the role allows. */
  issue(person: string, desktop: string, mode: DesktopMode): string {
    const now = this.now();
    // Kept a little past expiry so a late or repeated one is told which it was; then forgotten.
    for (const [value, ticket] of this.tickets) if (ticket.expiresAt + TICKET_TTL_MS < now) this.tickets.delete(value);
    const value = randomBytes(24).toString("base64url");
    this.tickets.set(value, { person, desktop, mode, expiresAt: now + TICKET_TTL_MS, used: false });
    return value;
  }

  private check(value: string | null | undefined, person: string, desktop: string): Ticket | TicketRefusal {
    if (value === null || value === undefined || value === "") return "ticket-missing";
    const ticket = this.tickets.get(value);
    if (ticket === undefined) return "ticket-unknown";
    if (ticket.used) return "ticket-used";
    if (ticket.expiresAt <= this.now()) return "ticket-expired";
    if (ticket.person !== person) return "ticket-other-person";
    if (ticket.desktop !== desktop) return "ticket-other-desktop";
    return ticket;
  }

  /** Whether this ticket would open that desktop for that person now, without spending it: what the page's own request asks. */
  good(value: string | null | undefined, person: string, desktop: string): boolean {
    return typeof this.check(value, person, desktop) !== "string";
  }

  /** Spends the ticket: the mode it carries, or why not. A ticket answers yes once. */
  redeem(value: string | null | undefined, person: string, desktop: string): { mode: DesktopMode } | { refused: TicketRefusal } {
    const ticket = this.check(value, person, desktop);
    if (typeof ticket === "string") return { refused: ticket };
    ticket.used = true;
    return { mode: ticket.mode };
  }
}

/** The lower of what was asked and what the role allows. */
export function grantedMode(asked: string | null | undefined, mayDrive: boolean): DesktopMode {
  return mayDrive && asked !== "view" ? "control" : "view";
}

const TICKET_IN_PATH = /([?&])ticket=[A-Za-z0-9_-]*&?/;

/** The ticket noVNC was handed: inside the page address's `path=` (the socket's own path and query), or on the socket's address itself. */
export function ticketIn(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const direct = params.get("ticket");
  if (direct !== null) return direct;
  const path = params.get("path");
  const at = path === null ? -1 : path.indexOf("?");
  return at < 0 ? undefined : (new URLSearchParams(path!.slice(at)).get("ticket") ?? undefined);
}

/** An address's query with no ticket in it — for what is passed to the box, logged or compared. */
export function withoutTicket(search: string): string {
  if (search === "") return "";
  const params = new URLSearchParams(search);
  params.delete("ticket");
  const path = params.get("path");
  if (path !== null && path.includes("?")) params.set("path", path.replace(TICKET_IN_PATH, "$1").replace(/[?&]$/, ""));
  const out = params.toString();
  return out === "" ? "" : `?${out}`;
}

/** The page's address with `ticket` put where noVNC reads the socket's path from; `prefix` is `desktop/1` or `desktop/b/<box>/1`. */
export function pageAddressWith(pathname: string, search: string, prefix: string, ticket: string): string {
  const params = new URLSearchParams(withoutTicket(search));
  const path = params.get("path") ?? `${prefix}/websockify`;
  params.set("path", `${path}${path.includes("?") ? "&" : "?"}ticket=${ticket}`);
  return `${pathname}?${params.toString()}`;
}

/** The close code an idle stream is ended with, so the page can say that and not something vaguer. */
export const IDLE_CLOSE_CODE = 4408;

/**
 * The desktop page with a way back when its stream ends (off local).
 *
 * noVNC's page is the box's, and when its socket closes it leaves the last picture on the canvas.
 * Off local the socket cannot simply be opened again — its ticket is spent — so a box restart, an
 * idle close or a withdrawn permission would leave a frozen screen that looks alive. This adds,
 * to the page as it passes through, a notice over the picture when a socket that had opened
 * closes, with one button: it reloads the page, which is given a new ticket. Not automatic: a
 * page that reopened itself would make the idle limit mean nothing.
 *
 * It watches the socket itself rather than noVNC's markup, which differs between its versions
 * (measured: the box's page keeps no state class on the document): the page's `WebSocket` is
 * wrapped before noVNC's modules run — an inline script runs first — and nothing else is touched.
 */
export function withReopenNotice(html: string, words: { closed: string; idle: string; reopen: string }): string {
  const at = html.lastIndexOf("</body>");
  if (at < 0) return html;
  const text = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c");
  const script =
    `<script>(function(){var Native=window.WebSocket,shown=false;if(!Native)return;` +
    `function show(idle){if(shown)return;shown=true;var box=document.createElement("div");box.id="lumenbox-desktop-closed";` +
    `box.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;` +
    `background:rgba(0,0,0,.82);color:#eee;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;padding:24px";` +
    `var p=document.createElement("p");p.style.cssText="max-width:34em;margin:0";p.textContent=idle?${text(words.idle)}:${text(words.closed)};` +
    `var b=document.createElement("button");b.textContent=${text(words.reopen)};b.style.cssText="font:inherit;padding:8px 18px;border-radius:8px;border:0;background:#eee;color:#111;cursor:pointer";` +
    `b.onclick=function(){location.reload();};box.appendChild(p);box.appendChild(b);document.body.appendChild(box);}` +
    `function Watched(url,protocols){var socket=protocols===undefined?new Native(url):new Native(url,protocols),opened=false;` +
    `socket.addEventListener("open",function(){opened=true;});` +
    `socket.addEventListener("close",function(event){if(opened)show(event.code===${IDLE_CLOSE_CODE});});return socket;}` +
    `Watched.prototype=Native.prototype;Watched.CONNECTING=0;Watched.OPEN=1;Watched.CLOSING=2;Watched.CLOSED=3;window.WebSocket=Watched;})();</script>`;
  return html.slice(0, at) + script + html.slice(at);
}

/** Why a stream ended. */
export type StreamEnd = "left" | "idle" | "revoked" | "box-gone";

/** One line of `desktop-sessions.jsonl`. */
export interface DesktopSessionRecord {
  at: string;
  event: "opened" | "closed";
  /** Ties a close to its open. Random; nothing else. */
  stream: string;
  /** The person's roster id, the gateway's user id, or `operator` for the installation's own credential. */
  person: string;
  /** The box the desktop is in, and which display; `agent` when one owns that display. */
  box: string;
  display: number;
  agent?: string;
  /** The stream the server gave: `control` is the driving stream, `view` the view-only one. */
  mode: DesktopMode;
  /** How it was let in: a ticket, or at local the session alone. */
  by: "ticket" | "session";
  /** On `closed`. */
  reason?: StreamEnd;
  seconds?: number;
  /** On `closed` for a driving stream: whether a key or a pointer button was pressed. `unknown` when the stream could not be read. */
  input?: boolean | "unknown";
}

export interface StreamOpen { person: string; box: string; display: number; agent?: string; mode: DesktopMode; by: "ticket" | "session" }

/** A WebSocket close frame from the server: status 4000 + `code`, and words noVNC shows. */
function closeFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, 120);
  const frame = Buffer.alloc(4 + text.length);
  frame[0] = 0x88;
  frame[1] = 2 + text.length;
  frame.writeUInt16BE(code, 2);
  text.copy(frame, 4);
  return frame;
}

/**
 * Reads the browser's half of the stream far enough to say whether a key or a button was pressed.
 *
 * WebSocket frames from a browser are masked; inside them is RFB. After the handshake (version,
 * security choice, ClientInit — noVNC to a desktop with no password) each client message starts
 * with its type and has a known length. A key event (4) or a pointer event (5) with a button
 * down is input; a pointer merely moving is not — a viewer's mouse crosses the picture too. On
 * anything it does not recognise it stops and says `unknown` rather than guess. It keeps nothing
 * it reads: one boolean comes out.
 */
export class InputWatch {
  private buffer: Buffer = Buffer.alloc(0);
  private payload: Buffer = Buffer.alloc(0);
  private handshake = 12 + 1 + 1;
  state: boolean | "unknown" = false;

  feed(chunk: Buffer): void {
    if (this.state !== false) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 1 << 20) { this.state = "unknown"; this.buffer = Buffer.alloc(0); return; }
    while (this.state === false && this.buffer.length >= 2) {
      const first = this.buffer[0]!, second = this.buffer[1]!;
      // A compressed or unmasked frame is not something this reads.
      if ((first & 0x70) !== 0 || (second & 0x80) === 0) { this.state = "unknown"; return; }
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const data = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < data.length; i += 1) data[i]! ^= mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      const opcode = first & 0x0f;
      if (opcode === 0x2 || opcode === 0x0) this.rfb(data);
    }
  }

  private rfb(data: Buffer): void {
    this.payload = this.payload.length === 0 ? data : Buffer.concat([this.payload, data]);
    if (this.handshake > 0) {
      const skip = Math.min(this.handshake, this.payload.length);
      this.handshake -= skip;
      this.payload = this.payload.subarray(skip);
    }
    while (this.state === false && this.payload.length > 0) {
      const type = this.payload[0]!;
      let length: number | undefined;
      if (type === 0) length = 20;                                                        // SetPixelFormat
      else if (type === 2) length = this.payload.length < 4 ? -1 : 4 + 4 * this.payload.readUInt16BE(2); // SetEncodings
      else if (type === 3) length = 10;                                                   // FramebufferUpdateRequest
      else if (type === 4) { this.state = true; return; }                                 // KeyEvent
      else if (type === 5) { if (this.payload.length < 2) return; if (this.payload[1] !== 0) { this.state = true; return; } length = 6; } // PointerEvent
      else if (type === 6) { this.state = true; return; }                                 // ClientCutText: a paste is input
      else if (type === 150) length = 10;                                                 // EnableContinuousUpdates
      else if (type === 248) length = this.payload.length < 9 ? -1 : 9 + this.payload[8]!; // ClientFence
      else if (type === 251) length = this.payload.length < 7 ? -1 : 8 + 16 * this.payload[6]!; // SetDesktopSize
      else if (type === 255) { if (this.payload.length < 2) return; if (this.payload[1] === 0) { this.state = true; return; } length = 12; } // QEMU: an extended key event
      if (length === undefined) { this.state = "unknown"; return; }
      if (length < 0 || this.payload.length < length) return;
      this.payload = this.payload.subarray(length);
    }
  }
}

/** A stream being held: tell it what moves, and it says when it ended. */
export interface HeldStream {
  /** Bytes from the browser (`up`) or from the box (`down`). */
  moved(direction: "up" | "down", chunk: Buffer): void;
  /** Ends it for a reason, once; the first reason given is the one recorded. */
  end(reason: StreamEnd): void;
}

export interface DesktopStreamsOptions {
  /** Appends one record; a failure to write is logged by the caller's function, never thrown into the stream. */
  record: (line: DesktopSessionRecord) => void;
  /** Off local: close a stream nothing moved on for this long. Absent, streams are never closed for being quiet. */
  idleMs?: number;
  now?: () => number;
}

/** The streams that are open: their record, and — off local — their idle limit. */
export class DesktopStreams {
  private readonly options: DesktopStreamsOptions;

  constructor(options: DesktopStreamsOptions) { this.options = options; }

  /** A stream that has just been joined to its box. `client` is the browser's socket: it is what an idle close is written to. */
  opened(open: StreamOpen, client: Socket): HeldStream {
    const now = this.options.now ?? Date.now;
    const stream = randomBytes(6).toString("hex");
    const startedAt = now();
    const watch = open.mode === "control" ? new InputWatch() : undefined;
    let last = startedAt, ended = false;
    const base = { stream, person: open.person, box: open.box, display: open.display, ...(open.agent !== undefined ? { agent: open.agent } : {}), mode: open.mode, by: open.by };
    this.options.record({ at: new Date(startedAt).toISOString(), event: "opened", ...base });
    const end = (reason: StreamEnd): void => {
      if (ended) return;
      ended = true;
      if (timer !== undefined) clearInterval(timer);
      this.options.record({
        at: new Date(now()).toISOString(), event: "closed", ...base, reason, seconds: Math.round((now() - startedAt) / 1000),
        ...(watch !== undefined ? { input: watch.state } : {}),
      });
    };
    const idleMs = this.options.idleMs;
    const timer = idleMs === undefined ? undefined : setInterval(() => {
      if (ended || now() - last < idleMs) return;
      end("idle");
      // Said in the socket's own words first, so the page shows why; then the socket goes.
      try { client.write(closeFrame(IDLE_CLOSE_CODE, "Closed after a while with nothing happening. Reload to watch again.")); } catch { /* already gone */ }
      client.destroy();
    }, Math.max(1_000, Math.min(30_000, Math.floor(idleMs / 4))));
    timer?.unref();
    return {
      moved(direction, chunk) {
        last = now();
        if (direction === "up") watch?.feed(chunk);
      },
      end,
    };
  }
}

/** Appends to `<home>/desktop-sessions.jsonl`; a failed write is said, not thrown. */
export function desktopSessionLedger(path: string, log: (line: string) => void): (record: DesktopSessionRecord) => void {
  return record => {
    try { appendLine(path, JSON.stringify(record)); } catch (error) { log(`desktop sessions: could not record a stream ${record.event}: ${error instanceof Error ? error.message : String(error)}`); }
  };
}
