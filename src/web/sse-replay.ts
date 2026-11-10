/** Bounded SSE transport; durable task/transcript readers remain the source of history. */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

interface Frame<E> { seq: number; event: E; text: string; bytes: number }
export class SseReplay<E> {
  readonly epoch = randomUUID();
  private seq = 0;
  private bytes = 0;
  private readonly frames: Frame<E>[] = [];
  private readonly clients = new Map<ServerResponse, (event: E) => boolean>();
  private readonly timers = new Map<ServerResponse, ReturnType<typeof setInterval>>();
  constructor(private readonly limits = { events: 512, bytes: 1024 * 1024 }) {}
  get size(): number { return this.clients.size; }
  get cursor(): string { return `${this.epoch}:${this.seq}`; }

  publish(event: E): void {
    const json = JSON.stringify(event);
    const text = `id: ${this.epoch}:${++this.seq}\ndata: ${json}\n\n`;
    const frame = { seq: this.seq, event: JSON.parse(json) as E, text, bytes: Buffer.byteLength(text) };
    this.frames.push(frame); this.bytes += frame.bytes;
    while (this.frames.length > this.limits.events || this.bytes > this.limits.bytes) this.bytes -= this.frames.shift()!.bytes;
    for (const [res, allowed] of this.clients) this.deliver(res, () => allowed(frame.event) ? text : "");
  }

  catchUp(cursor: string | undefined, allowed: (event: E) => boolean): { reset: boolean; frames: string[] } {
    if (cursor === undefined) return { reset: false, frames: [] };
    const match = /^(.*):(\d+)$/.exec(cursor), seq = match ? Number(match[2]) : NaN;
    const earliest = this.frames[0]?.seq ?? this.seq + 1;
    if (match?.[1] !== this.epoch || !Number.isSafeInteger(seq) || seq < earliest - 1 || seq > this.seq) return { reset: true, frames: [] };
    return { reset: false, frames: this.frames.filter(frame => frame.seq > seq && allowed(frame.event)).map(frame => frame.text) };
  }

  connect(req: IncomingMessage, res: ServerResponse, allowed: (event: E) => boolean): void {
    const header = req.headers["last-event-id"];
    const replay = this.catchUp(typeof header === "string" ? header : undefined, allowed);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    this.clients.set(res, allowed);
    const timer = setInterval(() => this.deliver(res, () => ": ping\n\n"), 20_000);
    timer.unref(); this.timers.set(res, timer);
    res.on("close", () => this.remove(res));
    res.on("error", () => { this.remove(res); res.destroy(); });
    this.deliver(res, () => ": connected\n\n" + (replay.reset
      ? `id: ${this.cursor}\ndata: {"type":"reset"}\n\n`
      : replay.frames.join("") + `id: ${this.cursor}\nevent: checkpoint\ndata: {}\n\n`));
  }

  close(): void { for (const res of this.clients.keys()) { this.remove(res); res.end(); } }
  private remove(res: ServerResponse): void { clearInterval(this.timers.get(res)); this.timers.delete(res); this.clients.delete(res); }
  private deliver(res: ServerResponse, payload: () => string): void {
    try {
      const text = payload();
      if (res.writableEnded || res.destroyed) { this.remove(res); return; }
      if (text && !res.write(text)) { this.remove(res); res.end(); }
    } catch { this.remove(res); res.destroy(); }
  }
}
