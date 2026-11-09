/** Isolated module configuration: these deadlines apply before the turn stack loads. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
process.env.AGENTBOX_FIRST_TOKEN_DEADLINE_MS = "2000";
process.env.AGENTBOX_STREAM_IDLE_DEADLINE_MS = "100";
const { OpenAIWireClient } = await import("./openai-wire.ts");
const { runEpisode } = await import("./scenario.ts");

test("a real SSE stream that stops after content is aborted and recovered, despite keepalives", async () => {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (content: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
      if (requests === 1) {
        send("partial to discard");
        const heartbeat = setInterval(() => res.write('data: {"choices":[]}\n\n'), 20);
        res.on("close", () => clearInterval(heartbeat));
      } else {
        send("Recovered complete answer.");
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        res.end();
      }
    });
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const episode = await runEpisode({
      team: [{ name: "Nova", tools: [] }], says: ["Answer after checking."],
      client: new OpenAIWireClient({ baseURL: `http://127.0.0.1:${port}` }) as never,
    });
    try {
      assert.equal(requests, 2);
      const transcript = JSON.stringify(episode.registry.readTranscript(episode.registry.list()[0]!.id));
      assert.match(transcript, /Recovered complete answer/);
      assert.doesNotMatch(transcript, /partial to discard/, "a failed response must not become durable conversation history");
    } finally { episode.cleanup(); }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
