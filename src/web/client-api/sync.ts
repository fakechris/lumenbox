/**
 * `GET /changes` and `GET /events` (docs/106 §4.2, docs/110 §2): both read the durable change ledger
 * (change-ledger.ts), so a phone that slept, a server that restarted, and a stream that dropped all
 * catch up the same way. A change is shown only when the caller's sight allows it (visibility.ts),
 * and a thing changed many times since is shown once, at its newest change: the client fetches it.
 * A stream ends when its credential stops working: at the next event or ping, and at once when a device
 * or a person's access is ended (frame.ts `recheckStreams`).
 */

import type { ServerResponse } from "node:http";
import type { ChangeLine } from "./change-ledger.ts";
import { type Call, stream } from "./frame.ts";
import { apiTime } from "./times.ts";
import { sightOf } from "./visibility.ts";

const recordOf = (line: ChangeLine) => ({
  seq: line.seq, at: apiTime(line.at), type: line.type, id: line.id, op: line.op, ...(line.type === "message" && line.conversationId !== undefined ? { conversationId: line.conversationId } : {}),
});

/** The newest change of each thing among these lines that the caller may be told of, in order of that newest change, at most `limit`. */
function newest(call: Call, lines: readonly ChangeLine[], limit: number): { records: ChangeLine[]; scanned: number } {
  const sight = sightOf(call);
  const shown = new Map<string, ChangeLine>();
  let scanned = 0;
  for (const line of lines) {
    const key = `${line.type}:${line.id}`;
    if (shown.size >= limit && !shown.has(key)) break;
    scanned += 1;
    if (!sight.change(line)) continue;
    shown.delete(key);
    shown.set(key, line);
  }
  return { records: [...shown.values()], scanned };
}

export async function getChanges(call: Call) {
  const { changes } = call.deps.world;
  call.deps.world.noteAgents();
  call.deps.chat.note();
  await call.deps.decisions.noteInbox();
  const since = Number(call.params.since);
  const found = changes.after(since);
  if (found.reset) return { items: [], durableSeq: changes.latest, hasMore: false, reset: true };
  const { records, scanned } = newest(call, found.lines, typeof call.params.limit === "number" ? call.params.limit : 500);
  const durableSeq = scanned === 0 ? since : found.lines[scanned - 1]!.seq;
  return { items: records.map(recordOf), durableSeq, hasMore: scanned < found.lines.length, reset: false };
}

const PING_MS = 20_000;

export function streamEvents(call: Call) {
  return stream((req, res, requestId) => {
    const { changes } = call.deps.world;
    call.deps.world.noteAgents();
    call.deps.chat.note();
    void call.deps.decisions.noteInbox();
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-request-id": requestId, "x-accel-buffering": "no" });
    // False only once the response is gone: a full buffer is not an end, it drains on its own.
    const write = (text: string): boolean => { if (res.writableEnded || res.destroyed) return false; res.write(text); return true; };
    const event = (line: ChangeLine) => `id: ${line.seq}\nevent: change\ndata: ${JSON.stringify(recordOf(line))}\n\n`;
    const header = req.headers["last-event-id"];
    const last = typeof header === "string" && /^\d{1,16}$/.test(header.trim()) ? Number(header.trim()) : undefined;
    let opening = ": connected\n\n";
    if (last !== undefined) {
      const found = changes.after(last);
      opening += found.reset
        ? `event: reset\ndata: ${JSON.stringify({ durableSeq: changes.latest })}\n\n`
        : newest(call, found.lines, Number.MAX_SAFE_INTEGER).records.map(event).join("");
    }
    write(`${opening}id: ${changes.latest}\nevent: ready\ndata: {}\n\n`);

    const end = (target: ServerResponse) => { stop(); closed(); untrack(); clearInterval(ping); if (!target.writableEnded) target.end(); };
    const stop = changes.onAppend(line => {
      if (!call.stillValid()) { end(res); return; }
      if (sightOf(call).change(line) && !write(event(line))) end(res);
    });
    const closed = changes.onClose(() => end(res));
    // A device ended or a person's access gone ends the stream at once, not at the next event or ping.
    const untrack = call.track(() => end(res));
    const ping = setInterval(() => { if (!call.stillValid() || !write(": ping\n\n")) end(res); }, PING_MS);
    ping.unref();
    res.on("close", () => end(res));
    res.on("error", () => end(res));
  });
}
