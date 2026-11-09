/** Isolated module configuration: these deadlines apply before the turn stack loads. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { test } from "node:test";
process.env.AGENTBOX_FIRST_TOKEN_DEADLINE_MS = "2000";
process.env.AGENTBOX_STREAM_IDLE_DEADLINE_MS = "100";
const { OpenAIWireClient } = await import("./openai-wire.ts");
const { runEpisode } = await import("./scenario.ts");
const { SpendLimits } = await import("./spend-limits.ts");

for (const capped of [false, true]) test(`a real SSE stream that stops after content ${capped ? "hands back at its reserved spend line" : "recovers despite keepalives"}`, async () => {
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
    const spend = capped ? new SpendLimits({ ledger: () => [], rates: () => ({ m: { inputPerM: 5, outputPerM: 10 } }), pause: async () => {}, resume: async () => {}, isPaused: () => false, notify: () => {}, nameOf: id => id, log: () => {} }) : undefined;
    const episode = await runEpisode({
      team: [{ name: "Nova", tools: [] }], says: capped ? [] : ["Answer after checking."],
      ...(spend !== undefined ? { spendLimits: spend, drive: async ({ frontId, bus }: { frontId: string; bus: import("../agents/bus.ts").AgentBus }) => { spend.setLimits(frontId, { perWake: 0.1, perDay: 100 }); bus.sendFromUser(frontId, "Answer after checking."); await bus.wake(frontId); } } : {}),
      provider: { label: "test", model: "m", contextWindow: 200000, maxTokens: 1000, vision: false, adaptiveThinking: false, effort: false, promptCaching: false, auth: "bearer", keyEnv: "UNUSED_FIXTURE" },
      client: new OpenAIWireClient({ baseURL: `http://127.0.0.1:${port}` }) as never,
    });
    try {
      assert.equal(requests, capped ? 1 : 2, "no paid retry once the allowance reaches its line");
      const transcript = JSON.stringify(episode.registry.readTranscript(episode.registry.list()[0]!.id));
      assert.match(transcript, capped ? /reserved for unreported failed calls/ : /Recovered complete answer/);
      assert.doesNotMatch(transcript, /partial to discard/, "a failed response must not become durable conversation history");
    } finally { episode.cleanup(); }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
