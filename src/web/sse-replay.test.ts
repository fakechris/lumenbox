import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { SseReplay } from "./sse-replay.ts";

test("bounded replay covers disconnects, eviction, oversize events, restart and current authorization", () => {
  const events = new SseReplay<{ type: string; owner: string; n: number }>();
  const cursor = events.cursor;
  for (let n = 0; n < 10; n++) events.publish({ type: "step", owner: n % 2 ? "alice" : "bob", n });
  const all = events.catchUp(cursor, () => true);
  assert.equal(all.reset, false);
  assert.equal(all.frames.length, 10);
  assert.equal(new Set(all.frames.map(f => /^id: (.+)$/m.exec(f)![1])).size, 10);
  assert.equal(events.catchUp(events.cursor, () => true).frames.length, 0);
  assert.equal(events.catchUp(cursor, e => e.owner === "alice").frames.length, 5);
  assert.equal(events.catchUp(cursor, () => false).frames.length, 0, "revoked viewers cannot replay old frames");
  assert.equal(new SseReplay().catchUp(events.cursor, () => true).reset, true);
  assert.equal(events.catchUp(events.epoch + ":999", () => true).reset, true);
  assert.equal(events.catchUp("broken", () => true).reset, true);
  const small = new SseReplay({ events: 2, bytes: 512 });
  const old = small.cursor;
  for (let n = 0; n < 3; n++) small.publish({ n });
  assert.equal(small.catchUp(old, () => true).reset, true);
  const beforeLarge = small.cursor;
  small.publish({ text: "x".repeat(1024) });
  assert.equal(small.catchUp(beforeLarge, () => true).reset, true);
});

test("HTTP Last-Event-ID resumes exactly the missing authorized events and sends reset after restart", async () => {
  let events = new SseReplay<{ type: string; owner: string; n: number }>();
  let allowed = true;
  const server = createServer((req, res) => events.connect(req, res, e => allowed && e.owner === "alice"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  async function connect(cursor?: string) {
    const controller = new AbortController();
    const response = await fetch(base, { signal: controller.signal, headers: cursor ? { "Last-Event-ID": cursor } : {} });
    const reader = response.body!.getReader();
    let text = "";
    return { close: async () => { controller.abort(); await reader.cancel().catch(() => {}); },
      receive: async () => {
        while (!text.includes("event: checkpoint") && !text.includes('data: {"type":"reset"}')) {
          const chunk = await reader.read(); if (chunk.done) throw new Error("stream ended before boundary");
          text += new TextDecoder().decode(chunk.value);
        }
        return text;
      } };
  }
  try {
    const initial = await connect();
    const connected = await initial.receive();
    const cursor = /^id: (.+)$/m.exec(connected)![1]!;
    await initial.close();
    for (let n = 0; n < 10; n++) events.publish({ type: "step", owner: "alice", n });
    events.publish({ type: "step", owner: "bob", n: 99 });
    const resumed = await connect(cursor);
    const caught = await resumed.receive();
    assert.equal((caught.match(/data: \{"type":"step"/g) ?? []).length, 10);
    assert.equal(caught.includes('"owner":"bob"'), false);
    await resumed.close();
    allowed = false;
    const revoked = await connect(cursor);
    assert.equal((await revoked.receive()).includes('"type":"step"'), false);
    await revoked.close();
    events.close(); events = new SseReplay();
    const restarted = await connect(cursor);
    assert.match(await restarted.receive(), /"type":"reset"/);
    await restarted.close();
  } finally { events.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a backpressured response stops its ping immediately and handles asynchronous stream errors", async () => {
  const { PassThrough } = await import("node:stream");
  const events = new SseReplay();
  const response = new PassThrough({ highWaterMark: 1 }) as unknown as import("node:http").ServerResponse;
  response.writeHead = (() => response) as typeof response.writeHead;
  events.connect({ headers: {} } as import("node:http").IncomingMessage, response, () => true);
  assert.equal(events.size, 0);
  assert.equal(response.writableEnded, true);
  response.emit("error", new Error("socket closed while draining"));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(response.destroyed, true);
  events.close();
});
