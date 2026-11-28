/**
 * Two things outside the server that the client API's tests stand in for on loopback: an agent's sandbox (a box daemon that
 * keeps what is uploaded to it) and a model that answers from a script. Test-only (`testing/` is not production code).
 */

import type { TestContext } from "node:test";
import { createServer } from "node:http";
import { BOXD_PROTOCOL } from "../../../protocol/index.ts";

/** A box daemon: health, uploads kept by path, listings of what was uploaded, and an empty answer for anything else. */
export async function fakeBox(t: TestContext) {
  const uploads = new Map<string, Buffer>();
  const daemon = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) as Record<string, string> : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") { res.end(JSON.stringify({ ok: true, protocol: BOXD_PROTOCOL })); return; }
    if (req.url === "/fs/upload") { uploads.set(body.path!, Buffer.from(body.base64!, "base64")); res.end(JSON.stringify({ path: body.path, bytes: uploads.get(body.path!)!.length })); return; }
    if (req.url === "/fs/list") {
      const prefix = `${body.path}/`;
      res.end(JSON.stringify({ entries: [...uploads.keys()].filter(path => path.startsWith(prefix)).map(path => ({ name: path.slice(prefix.length), type: "file", size: 1 })) }));
      return;
    }
    res.end(JSON.stringify({ entries: [], skills: [], recordings: [], sessions: [], stdout: "", stderr: "", exit_code: 0 }));
  });
  await new Promise<void>(resolve => daemon.listen(0, "127.0.0.1", resolve));
  t.after(() => { daemon.closeAllConnections(); daemon.close(); });
  return { uploads, port: (daemon.address() as { port: number }).port };
}

/** The card the scripted model draws, and its one action. */
export const CARD = [
  { id: "root", component: "Column", children: ["title", "pick"] },
  { id: "title", component: "Text", text: "Which cover?", variant: "h3" },
  { id: "pick", component: "Button", child: "pick-label", action: { event: { name: "pick", context: { choice: "blue" } } } },
  { id: "pick-label", component: "Text", text: "Blue" },
];

/**
 * An Anthropic-compatible model on loopback, answering from a script: "Draw a card" is answered with a ShowUI call, whose
 * result is answered once `release` is called (the turn stays open meanwhile, so the card's work is live); anything else
 * with "Done.". Every request is kept, to count the turns a message made.
 */
export async function scriptedModel(t: TestContext) {
  const requests: { tools: number; last: string }[] = [];
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const model = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}") as { stream?: boolean; tools?: unknown[]; messages?: { role: string; content: unknown }[] };
    const lastMessage = body.messages?.at(-1);
    const last = typeof lastMessage?.content === "string" ? lastMessage.content : JSON.stringify(lastMessage?.content ?? "");
    requests.push({ tools: body.tools?.length ?? 0, last });
    const drawn = /tool_result/.test(last) && /"tu-card"/.test(last);
    if (drawn) await held;
    const content = /Draw a card/.test(last) && !drawn
      ? [{ type: "tool_use", id: "tu-card", name: "ShowUI", input: { surface: "pick", title: "Pick a cover", components: CARD } }]
      : [{ type: "text", text: "Done." }];
    const stop = content[0]!.type === "tool_use" ? "tool_use" : "end_turn";
    const message = { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "scripted", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (body.stream !== true) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
      if (block.type === "text") {
        send("content_block_start", { index, content_block: { type: "text", text: "" } });
        send("content_block_delta", { index, delta: { type: "text_delta", text: (block as { text: string }).text } });
      } else {
        send("content_block_start", { index, content_block: { ...block, input: {} } });
        send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify((block as { input: unknown }).input) } });
      }
      send("content_block_stop", { index });
    });
    send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", {});
    res.end();
  });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  t.after(() => { release(); model.closeAllConnections(); model.close(); });
  return { url: `http://127.0.0.1:${(model.address() as { port: number }).port}`, requests, release: () => release() };
}

