/**
 * Conversations through `/api/v1` on a real server (INV-2214): what a person reads is what the page draws, never a tool's
 * input; a message reaches the agent once however often it is sent; a file goes into the conversation's inbox in the
 * agent's sandbox (a fake box daemon here) and is named to the agent; the live stream says a message was taken and ends
 * when the device does; and what changed is in `/changes` for those who may read it.
 *
 * Most tests pause the agents (work control), so a message is admitted and queued and no model is called. One runs turns for
 * real against a model on this machine's loopback that answers from a script (`model`): how many turns a repeated message makes
 * is then counted where it is made, and a card's press reaches live work.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { problemsOf } from "./routes.ts";
import { OPERATIONS, SCHEMAS, SCOPE_NAMES, type Operation, type Schema } from "./schema.ts";
import { conversationIdOf } from "./conversations.ts";
import { fakeBox, scriptedModel } from "./testing/fakes.ts";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_PUBLIC_URL", "ANTHROPIC_API_KEY", "AGENTBOX_BASE_URL", "AGENTBOX_API_KEY", "AGENTBOX_PROVIDER", "AGENTBOX_EXPOSURE", "AGENTBOX_TRUSTED_PROXIES", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN"] as const;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function server(t: TestContext, options: { model?: string } = {}) {
  const { Principals } = await import("../../host/principals.ts");
  const { AgentRegistry } = await import("../../agents/registry.ts");
  const { AttachedBoxProvisioner } = await import("../../box/provisioner.ts");
  const { startWebServer } = await import("../server.ts");
  const home = mkdtempSync(join(tmpdir(), "client-api-chat-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  // A model credential that is never used (the agents are paused): ready as far as a send is concerned. Or the scripted model.
  Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_PUBLIC_URL: "https://box.example.test", ANTHROPIC_API_KEY: "fixture-not-real" },
    options.model !== undefined ? { AGENTBOX_PROVIDER: "custom", AGENTBOX_BASE_URL: options.model, AGENTBOX_API_KEY: "fixture-not-real" } : {});
  mkdirSync(join(home, "agents"), { recursive: true });
  new Principals().save([
    { id: "dee", name: "Dee", role: "driver", identities: ["ding:dee-staff"] },
    { id: "vic", name: "Vic", role: "viewer", identities: [] },
    { id: "ann", name: "Ann", role: "admin", identities: [] },
    { id: "pat", name: "Pat", role: "driver", identities: [] },
  ]);
  const registry = new AgentRegistry(join(home, "agents"));
  registry.attachBox({ id: "pat-box", name: "Pat's sandbox", kind: "attached", members: ["pat"], displayFloor: 1, workDir: "/work", createdAt: new Date().toISOString() });
  const writer = registry.create({ name: "Writer" });
  const patBot = registry.create({ name: "PatBot", boxId: "pat-box" });
  // An agent whose model has no credential here: a message to it is refused before it is taken.
  const unset = registry.create({ name: "Unset", provider: "deepseek" });
  // What the page would draw: a person's request, a step, a card, a question, and the answer. The step's command carries a secret.
  const at = "2026-11-28T10:00:00.000Z";
  registry.appendTranscript(writer.id, { role: "user", text: "Make the cover.", fromPerson: true, at });
  registry.appendTranscript(writer.id, { role: "assistant", kind: "blocks", at, turnId: "turn-1", blocks: [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "tu-1", name: "bash", input: { command: "curl -H 'Authorization: sk-live-SECRET' https://example.test" } },
    { type: "tool_use", id: "tu-2", name: "ShowUI", input: { surface: "cover", title: "Pick a cover", components: [{ id: "root", component: "Text", text: "Red or blue?" }] } },
    { type: "tool_use", id: "tu-3", name: "AskUser", input: { question: "Which cover?", options: ["red", "blue"] } },
  ] });
  registry.appendTranscript(writer.id, { role: "user", kind: "results", at, blocks: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }, { type: "tool_result", tool_use_id: "tu-2", content: "shown" }, { type: "tool_result", tool_use_id: "tu-3", content: "asked" }] });
  registry.appendTranscript(writer.id, { role: "assistant", text: "The blue cover is ready.", at });
  // The sandbox: a box daemon that keeps what is uploaded to it.
  const { uploads, port } = await fakeBox(t);
  let base = "", stop: () => void = () => {};
  const operator = { authorization: "Bearer t0k", "content-type": "application/json" };
  t.after(async () => {
    if (base !== "") await cancelAll();
    stop();
    for (const key of KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  });
  const start = () => startWebServer({ port: 0, host: "0.0.0.0", token: "t0k", onLog: () => {}, boxProvisioner: new AttachedBoxProvisioner({ baseUrl: `http://127.0.0.1:${port}`, token: "daemon" }), onReady: url => { base = url.replace("0.0.0.0", "127.0.0.1"); } });
  stop = await start();
  const pause = async () => options.model !== undefined || assert.equal((await fetch(`${base}/api/work-control/pause-members`, { method: "POST", headers: operator, body: JSON.stringify({ agents: [writer.id, unset.id] }) })).status, 200);
  await pause();
  const mint = async (body: Record<string, unknown>) => {
    const answer = await fetch(`${base}/api/client-tokens`, { method: "POST", headers: operator, body: JSON.stringify({ expiresInDays: 30, label: "t", ...body }) });
    const json = await answer.json() as { token: string; credential: { id: string } };
    assert.equal(answer.status, 200, JSON.stringify(json));
    return json.token;
  };
  const op = (id: string) => OPERATIONS.find(operation => operation.operationId === id) as Operation;
  let from = 0;
  const call = (operationId: string, init: { token: string; id?: string; query?: string; body?: unknown; bytes?: Buffer; type?: string; headers?: Record<string, string> }) => {
    const operation = op(operationId);
    from += 1;
    return fetch(`${base}/api/v1${operation.path.replace("{id}", encodeURIComponent(init.id ?? ""))}${init.query ?? ""}`, {
      method: operation.method,
      headers: { authorization: `Bearer ${init.token}`, "x-forwarded-for": `198.51.100.${from % 250}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.type !== undefined ? { "content-type": init.type } : {}), ...init.headers },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.bytes !== undefined ? { body: new Uint8Array(init.bytes) } : {}),
    });
  };
  /** A 200 answer, checked against its documented resource. */
  const read = async <T>(operationId: string, init: Parameters<typeof call>[1]): Promise<T> => {
    const answer = await call(operationId, init);
    const body = await answer.json() as T;
    assert.equal(answer.status, 200, `${operationId}: ${JSON.stringify(body)}`);
    assert.deepEqual(problemsOf(body, SCHEMAS[op(operationId).response] as Schema), [], `${operationId} answers its documented shape`);
    return body;
  };
  const { makeSession, sessionKey, SESSION_COOKIE } = await import("../session.ts");
  /** A phone paired for Dee: its access token and id. */
  const phone = async () => {
    const shown = await fetch(`${base}/api/devices/pairing`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(makeSession("ding:dee-staff", sessionKey("t0k"), 0, Math.floor(Date.now() / 1000)))}`, "content-type": "application/json" }, body: "{}" });
    const { link } = await shown.json() as { link: string };
    const code = new URLSearchParams(new URL(link).hash.slice(1)).get("code")!;
    const paired = await fetch(`${base}/api/v1/auth/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName: "Dee's phone", platform: "ios" }) });
    const { tokens } = await paired.json() as { tokens: { accessToken: string; deviceId: string } };
    return tokens;
  };
  // What was sent waits in the paused agents' queues, and the bus waits for it to settle even after a stop: cancelled, as the
  // page's work control does, before this server stops.
  async function cancelAll() {
    const { TaskStore } = await import("../../host/tasks.ts");
    for (const task of new TaskStore(join(home, "tasks.jsonl")).list()) {
      const preview = await (await fetch(`${base}/api/work-control/preview?taskId=${task.id}`, { headers: operator })).json() as { token?: string };
      if (preview.token !== undefined) await (await fetch(`${base}/api/work-control/cancel`, { method: "POST", headers: operator, body: JSON.stringify({ taskId: task.id, token: preview.token }) })).body?.cancel();
    }
  }
  const restart = async () => { await cancelAll(); stop(); stop = await start(); await pause(); };
  return { home, base: () => base, writer, patBot, unset, mint, call, read, uploads, phone, restart, operator };
}

type Page<T> = { items: T[]; nextCursor?: string };
type Conversation = { id: string; agentId: string; kind: string; title: string; canWrite: boolean };
type Message = { id: string; kind: string; text?: string; steps?: string[]; card?: { surfaceId: string; a2ui: string }; question?: { question: string; options?: string[] } };

test("a person reads the conversations of agents they may reach, as the page draws them and never a tool's input; a viewer reads and writes nothing; a service token reads only with conversation text", async t => {
  const box = await server(t);
  const dee = await box.mint({ principalId: "dee", scopes: SCOPE_NAMES });
  const main = conversationIdOf(box.writer.id, "main");
  const listed = await box.read<Page<Conversation>>("listConversations", { token: dee });
  assert.ok(listed.items.some(row => row.id === main && row.kind === "main" && row.title === "Writer" && row.canWrite));
  assert.ok(!listed.items.some(row => row.agentId === box.patBot.id), "Pat's own sandbox's agent is not Dee's to read");
  const vic = await box.mint({ principalId: "vic", scopes: SCOPE_NAMES });
  assert.equal((await box.read<Page<Conversation>>("listConversations", { token: vic })).items.find(row => row.id === main)?.canWrite, false, "a viewer reads and cannot write");

  const messages = await box.read<Page<Message>>("listMessages", { token: dee, id: main });
  assert.deepEqual(messages.items.map(message => message.kind), ["person", "agent", "steps", "card", "question", "agent"]);
  assert.equal(messages.items[0]!.text, "Make the cover.");
  assert.deepEqual(messages.items[3]!.card?.surfaceId, "cover");
  assert.deepEqual(JSON.parse(messages.items[3]!.card!.a2ui)[0].createSurface?.surfaceId ?? "cover", "cover");
  assert.deepEqual(messages.items[4]!.question, { question: "Which cover?", options: ["red", "blue"] });
  assert.ok(!JSON.stringify(messages).includes("SECRET") && !JSON.stringify(messages).includes("curl -H"), "a step shows the program, never the command");
  // Older ones by the cursor; what came after one by `after`.
  const newest = await box.read<Page<Message>>("listMessages", { token: dee, id: main, query: "?limit=2" });
  assert.deepEqual(newest.items.map(message => message.id), messages.items.slice(-2).map(message => message.id));
  const older = await box.read<Page<Message>>("listMessages", { token: dee, id: main, query: `?limit=2&cursor=${newest.nextCursor}` });
  assert.deepEqual(older.items.map(message => message.id), messages.items.slice(2, 4).map(message => message.id));
  const later = await box.read<Page<Message>>("listMessages", { token: dee, id: main, query: `?after=${messages.items[3]!.id}` });
  assert.deepEqual(later.items.map(message => message.id), messages.items.slice(4).map(message => message.id));

  assert.equal((await box.call("listMessages", { token: dee, id: conversationIdOf(box.patBot.id, "main") })).status, 404, "out of reach is not found");
  assert.equal((await box.call("sendMessage", { token: vic, id: main, body: { clientMessageId: "vic-0001", text: "hi" } })).status, 403, "a viewer instructs nobody");

  const blind = await box.mint({ kind: "service", principalId: "ann", scopes: ["chat:read"], view: { allAgents: true } });
  assert.deepEqual((await box.read<Page<Conversation>>("listConversations", { token: blind })).items, [], "no conversation text in the view: no conversations");
  assert.equal((await box.call("listMessages", { token: blind, id: main })).status, 404);
  const reader = await box.mint({ kind: "service", principalId: "ann", scopes: ["chat:read"], view: { allAgents: true, conversationText: true } });
  assert.equal((await box.read<Page<Message>>("listMessages", { token: reader, id: main })).items.length, 6);
});

test("a message sent again — the same Idempotency-Key, the same clientMessageId with another key, after a restart — reaches the agent once, through the page's path", async t => {
  const box = await server(t);
  const dee = await box.mint({ principalId: "dee", scopes: SCOPE_NAMES });
  const main = conversationIdOf(box.writer.id, "main");
  const body = { clientMessageId: "0b6f3c1e-9d2a-4f61-8a55-2f7f4c1e9a01", text: "Make it blue, please." };
  const first = await box.read<{ messageId: string; clientMessageId: string }>("sendMessage", { token: dee, id: main, body, headers: { "idempotency-key": "send-key-0001" } });
  const again = await box.call("sendMessage", { token: dee, id: main, body, headers: { "idempotency-key": "send-key-0001" } });
  assert.equal(again.headers.get("idempotent-replayed"), "true");
  assert.deepEqual(await again.json(), first);
  assert.deepEqual(await box.read("sendMessage", { token: dee, id: main, body, headers: { "idempotency-key": "send-key-0002" } }), first, "the clientMessageId names the message");
  assert.deepEqual(await box.read("sendMessage", { token: dee, id: main, body }), first, "with no key at all");
  await box.restart();
  assert.deepEqual(await box.read("sendMessage", { token: dee, id: main, body }), first, "across a restart");
  const changed = await box.call("sendMessage", { token: dee, id: main, body: { ...body, text: "Make it red." } });
  assert.equal(changed.status, 409, "one clientMessageId, other words: a conflict, not a second message");
  // One request on the board for it, and one message in the agent's queue: one turn.
  const { TaskStore } = await import("../../host/tasks.ts");
  const tasks = new TaskStore(join(box.home, "tasks.jsonl")).list();
  assert.equal(tasks.filter(task => task.sourceMessageId === first.messageId).length, 1, JSON.stringify(tasks.map(task => [task.id, task.sourceMessageId])));
  const queued = readFileSync(join(box.home, "inbox.jsonl"), "utf8").split("\n").filter(line => line.includes(first.messageId) && line.includes("\"admit\""));
  assert.ok(queued.length <= 1, `admitted once: ${queued.length}`);
  // A model with no credential here is said, before anything is taken.
  const refused = await box.call("sendMessage", { token: dee, id: conversationIdOf(box.unset.id, "main"), body: { clientMessageId: "unset-0001", text: "hello" } });
  assert.equal((await refused.json() as { code: string }).code, "model-not-configured");
  // A card whose work is gone: the press does nothing and makes no work.
  const press = await box.call("sendCardAction", { token: dee, id: main, body: { clientMessageId: "press-0001", surfaceId: "cover", action: "pick", contextJson: "{\"color\":\"blue\"}" } });
  assert.equal((await press.json() as { code: string }).code, "surface-work-unavailable");
  const stop = await box.read<{ stopped: boolean }>("stopTurn", { token: dee, id: main });
  assert.equal(stop.stopped, false, "nothing ran in it");
});

test("a file goes into the conversation's inbox in the agent's sandbox, checked by type and size, and a message names where it is", async t => {
  const box = await server(t);
  const dee = await box.mint({ principalId: "dee", scopes: SCOPE_NAMES });
  const main = conversationIdOf(box.writer.id, "main");
  const query = (name: string) => `?conversationId=${encodeURIComponent(main)}&name=${encodeURIComponent(name)}`;
  const up = await box.read<{ id: string; name: string; kind: string; sizeBytes: number }>("uploadFile", { token: dee, query: query("cover.png"), bytes: PNG, type: "image/png" });
  assert.deepEqual([up.name, up.kind, up.sizeBytes], ["cover.png", "image", PNG.length]);
  const stored = [...box.uploads.keys()].find(path => path.endsWith("/chats/main/inbox/cover.png"));
  assert.ok(stored !== undefined && box.uploads.get(stored)!.equals(PNG), [...box.uploads.keys()].join(", "));
  const second = await box.read<{ name: string }>("uploadFile", { token: dee, query: query("cover.png"), bytes: PNG, type: "image/png" });
  assert.equal(second.name, "cover-2.png", "a second file of one name never overwrites the first");
  assert.equal((await box.call("uploadFile", { token: dee, query: query("x.png"), bytes: Buffer.from("not an image"), type: "image/png" })).status, 415, "an image is what it says");
  assert.equal((await box.call("uploadFile", { token: dee, query: query("x.svg"), bytes: Buffer.from("<svg/>"), type: "image/svg+xml" })).status, 415);
  assert.equal((await box.call("uploadFile", { token: dee, query: query("big.png"), bytes: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), type: "image/png" })).status, 413);
  const vic = await box.mint({ principalId: "vic", scopes: SCOPE_NAMES });
  assert.equal((await box.call("uploadFile", { token: vic, query: query("v.txt"), bytes: Buffer.from("hi"), type: "text/plain" })).status, 403);
  assert.equal((await box.call("uploadFile", { token: dee, query: `?conversationId=${encodeURIComponent(conversationIdOf(box.patBot.id, "main"))}&name=a.txt`, bytes: Buffer.from("hi"), type: "text/plain" })).status, 404);

  const sent = await box.read<{ messageId: string }>("sendMessage", { token: dee, id: main, body: { clientMessageId: "with-file-0001", text: "Use this one.", attachmentIds: [up.id] } });
  const board = readFileSync(join(box.home, "tasks.jsonl"), "utf8");
  assert.ok(board.includes(sent.messageId));
  const unknown = await box.call("sendMessage", { token: dee, id: main, body: { clientMessageId: "with-file-0002", text: "And this.", attachmentIds: ["up_nope"] } });
  assert.equal((await unknown.json() as { code: string }).code, "upload-unknown");
  const ann = await box.mint({ principalId: "ann", scopes: SCOPE_NAMES });
  const theirs = await box.call("sendMessage", { token: ann, id: main, body: { clientMessageId: "with-file-0003", text: "Mine now.", attachmentIds: [up.id] } });
  assert.equal((await theirs.json() as { code: string }).code, "upload-unknown", "an upload is its person's");
});

test("the live stream says a message was taken, and ends when the device does; what changed is in /changes for those who may read it", async t => {
  const box = await server(t);
  const tokens = await box.phone();
  const main = conversationIdOf(box.writer.id, "main");
  const opened = await box.call("streamConversation", { token: tokens.accessToken, id: main });
  assert.equal(opened.status, 200);
  const reader = opened.body!.getReader();
  let seen = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(seen)) {
      const { value, done } = await reader.read();
      if (done) return false;
      seen += Buffer.from(value).toString("utf8");
    }
    return true;
  };
  const sent = await box.read<{ messageId: string }>("sendMessage", { token: tokens.accessToken, id: main, body: { clientMessageId: "stream-0001", text: "Are you there?" } });
  assert.ok(await until(new RegExp(`event: sent\\ndata: \\{"kind":"sent","sent":\\{"id":"${sent.messageId}"\\}\\}`)), seen);

  const dee = await box.mint({ principalId: "dee", scopes: SCOPE_NAMES });
  const changes = await box.read<{ items: { type: string; id: string }[] }>("getChanges", { token: dee, query: "?since=0" });
  assert.ok(changes.items.some(item => item.type === "conversation" && item.id === main), JSON.stringify(changes.items));
  const narrow = await box.mint({ principalId: "dee", scopes: ["work:read"] });
  assert.ok(!(await box.read<{ items: { type: string }[] }>("getChanges", { token: narrow, query: "?since=0" })).items.some(item => item.type === "conversation"), "chat:read is needed");
  const blind = await box.mint({ kind: "service", principalId: "ann", scopes: ["chat:read"], view: { allAgents: true } });
  assert.ok(!(await box.read<{ items: { type: string }[] }>("getChanges", { token: blind, query: "?since=0" })).items.some(item => item.type === "conversation"), "nor to a view without conversation text");

  // The device is removed on the page: its stream ends at once.
  assert.equal((await fetch(`${box.base()}/api/devices/remove`, { method: "POST", headers: box.operator, body: JSON.stringify({ id: tokens.deviceId }) })).status, 200);
  assert.equal(await until(/$^/), false, "the stream ended");
});

test("with a model that answers, a repeated message makes one turn; the stream carries the turn as it happens; each new message is a change record; and a press on the agent's card reaches its live work", async t => {
  const model = await scriptedModel(t);
  const box = await server(t, { model: model.url });
  const dee = await box.mint({ principalId: "dee", scopes: SCOPE_NAMES });
  const main = conversationIdOf(box.writer.id, "main");
  const opened = await box.call("streamConversation", { token: dee, id: main });
  const reader = opened.body!.getReader();
  let seen = "";
  const until = async (pattern: RegExp) => { while (!pattern.test(seen)) { const { value, done } = await reader.read(); if (done) return false; seen += Buffer.from(value).toString("utf8"); } return true; };
  const before = (await box.read<{ durableSeq: number }>("getChanges", { token: dee, query: "?since=0" })).durableSeq;

  const body = { clientMessageId: "turn-once-0001", text: "Make it blue." };
  const sends = await Promise.all([1, 2, 3].map(n => box.read<{ messageId: string }>("sendMessage", { token: dee, id: main, body, headers: { "idempotency-key": `turn-once-key-${n}` } })));
  assert.equal(new Set(sends.map(sent => sent.messageId)).size, 1, "three sends, one message");
  assert.ok(await until(/event: turn\ndata: \{"kind":"turn","turn":\{"state":"ended"\}\}/), seen);
  assert.match(seen, /event: text\ndata: \{"kind":"text","text":\{"delta":"Done\."\}\}/, "the words as they came");
  const turns = model.requests.filter(request => request.tools > 0 && request.last.includes("Make it blue."));
  assert.equal(turns.length, 1, `one turn for the message: ${JSON.stringify(model.requests.map(request => request.last.slice(0, 60)))}`);
  // Kept: the person's words and the answer, each with a change record and a `message` event.
  assert.ok(await until(/event: message\n/), seen);
  const after = await box.read<{ items: { type: string; id: string; conversationId?: string }[] }>("getChanges", { token: dee, query: `?since=${before}` });
  const kept = after.items.filter(item => item.type === "message");
  assert.ok(kept.length >= 2 && kept.every(item => item.conversationId === main), JSON.stringify(after.items));
  const messages = await box.read<{ items: { id: string; kind: string; text?: string; sentIds?: string[] }[] }>("listMessages", { token: dee, id: main, query: `?after=${kept[0]!.id}` });
  assert.ok((await box.read<{ items: { id: string; kind: string; sentIds?: string[] }[] }>("listMessages", { token: dee, id: main })).items.some(message => message.kind === "person" && message.sentIds?.includes(sends[0]!.messageId)), "the person's message names what was sent");
  assert.ok(messages.items.some(message => message.kind === "agent" && message.text === "Done."));

  // A card drawn in a turn that is still open: its press reaches the agent as the page's does, and continues that work.
  await box.read("sendMessage", { token: dee, id: main, body: { clientMessageId: "card-turn-0001", text: "Draw a card." } });
  for (let tries = 0; tries < 100 && !model.requests.some(request => /"tu-card"/.test(request.last)); tries += 1) await new Promise(resolve => setTimeout(resolve, 50));
  const card = (await box.read<{ items: { kind: string; card?: { surfaceId: string } }[] }>("listMessages", { token: dee, id: main })).items.filter(message => message.kind === "card").at(-1);
  assert.equal(card?.card?.surfaceId, "pick");
  const press = await box.read<{ messageId: string }>("sendCardAction", { token: dee, id: main, body: { clientMessageId: "press-live-0001", surfaceId: "pick", action: "pick", contextJson: "{\"choice\":\"blue\"}" } });
  assert.match(press.messageId, /^v1-/);
  model.release();
  assert.ok(await until(/"sent":\{"id":"v1-/), seen);
  await reader.cancel();
});
