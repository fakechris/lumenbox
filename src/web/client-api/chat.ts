/**
 * Writing in a conversation, its files and its live stream (docs/106 §4.2, docs/110 §2, INV-2214).
 *
 * A message is the page's (send-message.ts): the same checks, the same turn, the same echo into an outside chat. A card press
 * is the page's press line (show-ui-catalog.ts `actionText`) on the same path, so it continues the work its card was drawn for
 * or is refused. A message is not stepped up: it is words to the agent, and what the agent then does outside its box is asked
 * for on its own (`/inbox`, docs/106 §8.1).
 *
 * Retries: a message reaches the agent once for one `clientMessageId` within 24 hours, with or without `Idempotency-Key` — the
 * person, the conversation and that id name it, and the id the record gives it is made from them, so even past a day the
 * board's admission sees the same message twice and keeps one.
 *
 * Files go where a chat's files go: the conversation's `inbox` in the agent's sandbox (chat-files.ts), never into a box the
 * person may not enter. An upload is named by an id for 24 hours, in memory; a message names it and the agent is told where
 * it is, in the words a chat's files are named in (drop-files.ts).
 */

import { createHash, randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { handedFilesNote } from "../../channels/drop-files.ts";
import { activityPhrases } from "../../host/activity-phrase.ts";
import { actionText } from "../../host/show-ui-catalog.ts";
import { type Call, Refused, refuse, stream } from "./frame.ts";
import { type LiveEvent, type UploadRecord, conversationFor } from "./conversations.ts";
import type { ApiErrorCode } from "./schema.ts";
import { apiTime } from "./times.ts";
import { sightOf } from "./visibility.ts";

const UPLOAD_TTL_MS = 24 * 60 * 60_000;
const IMAGE_MAX = 10 * 1024 * 1024;
/** The images taken, and the bytes each begins with: an image is what it says it is, or it is refused. */
const IMAGES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/gif": bytes => bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a",
  "image/webp": bytes => bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP",
  "image/heic": bytes => bytes.subarray(4, 8).toString("latin1") === "ftyp",
  "image/heif": bytes => bytes.subarray(4, 8).toString("latin1") === "ftyp",
};

/** Who did it, as the gate records it (inbox.ts): the person, and the device or token. */
const deciderOf = (call: Call): string => `user:${call.caller!.person.id} ${call.caller!.credential.kind === "device" ? "device" : "token"}:${call.caller!.credential.id}`;

/** A conversation the caller may write in: a driver's. (A fork's is never a v1 conversation: the page shows it under its parent.) */
function writable(call: Call, id: string) {
  const found = conversationFor(call, id);
  if (call.caller!.person.role === "viewer") return refuse("api-role-needed");
  return found;
}

/**
 * One message, once: the first answer for this person, conversation and `clientMessageId` is the answer for 24 hours, kept
 * where `Idempotency-Key` answers are kept (a refusal too, so a repeat is refused with the same words).
 */
async function once(call: Call, conversationId: string, what: string, request: unknown, send: (messageId: string) => Promise<unknown>): Promise<unknown> {
  const clientMessageId = String(call.body.clientMessageId);
  const key = createHash("sha256").update(`${what}\n${call.caller!.person.id}\n${conversationId}\n${clientMessageId}`).digest("hex");
  const store = call.deps.idempotency, claim = store.claim(key, request);
  if (claim.kind === "conflict") return refuse("api-idempotency-conflict");
  if (claim.kind === "replay") {
    const { body } = await claim.reply;
    const refused = body as { refused?: ApiErrorCode; vars?: Record<string, string> };
    if (refused.refused !== undefined) throw new Refused(refused.refused, refused.vars ?? {});
    return body;
  }
  // The record's id for it, from what names it: the same message has the same id, whatever reaches the server twice.
  const messageId = `v1-${key.slice(0, 40)}`;
  try {
    const answer = await send(messageId);
    store.settle(key, { status: 200, body: answer });
    return answer;
  } catch (error) {
    store.settle(key, { status: error instanceof Refused ? 400 : 500, body: error instanceof Refused ? { refused: error.code, vars: error.vars } : { refused: "api-internal", vars: { requestId: call.requestId } } });
    throw error;
  }
}

/** The page's send path, its refusals in v1's words. */
async function sendThrough(call: Call, found: { id: string; agent: { id: string }; conversation: string }, text: string, messageId: string, surfaceAction?: unknown) {
  const sent = await call.deps.chat.send({ agentId: found.agent.id, text, conversation: found.conversation, userId: call.caller!.person.id, messageId, ...(surfaceAction !== undefined ? { surfaceAction } : {}) });
  if ("failed" in sent) throw new Error(`a message was not admitted: ${sent.failed}`);
  if ("refused" in sent) {
    if (sent.refused === "agent-unknown" || sent.refused === "fork-read-only") return refuse("api-not-found");
    if (sent.refused === "text-required") return refuse("api-param-invalid", { name: "text", why: "words" });
    return refuse(sent.refused as ApiErrorCode, sent.vars ?? {});
  }
  return { messageId, clientMessageId: String(call.body.clientMessageId), conversationId: found.id, acceptedAt: apiTime(new Date().toISOString()) };
}

export async function sendMessage(call: Call) {
  const found = writable(call, String(call.params.id));
  const ids = call.body.attachmentIds === undefined ? [] : call.body.attachmentIds as unknown[];
  if (ids.length > 10 || ids.some(id => typeof id !== "string")) return refuse("api-param-invalid", { name: "attachmentIds", why: "at most 10 upload ids" });
  const now = Date.now(), person = call.caller!.person.id;
  const files = (ids as string[]).map(id => call.deps.chat.uploads.get(id));
  if (files.some(file => file === undefined || file.personId !== person || file.conversationId !== found.id || file.expiresAt < now)) return refuse("upload-unknown");
  const text = handedFilesNote(String(call.body.text), files.map(file => file!.path));
  return once(call, found.id, "message", { text: call.body.text, attachmentIds: ids }, messageId => sendThrough(call, found, text, messageId));
}

export async function sendCardAction(call: Call) {
  const found = writable(call, String(call.params.id));
  const { surfaceId, action, contextJson } = call.body as { surfaceId: string; action: string; contextJson?: string };
  let context: Record<string, unknown> | undefined;
  if (contextJson !== undefined) {
    try { context = JSON.parse(contextJson) as Record<string, unknown>; } catch { context = undefined; }
    if (context === undefined || context === null || typeof context !== "object" || Array.isArray(context)) return refuse("api-param-invalid", { name: "contextJson", why: "a JSON object" });
  }
  const text = actionText({ name: action, surfaceId, ...(context !== undefined ? { context } : {}) });
  return once(call, found.id, "card", { surfaceId, action, contextJson }, messageId => sendThrough(call, found, text, messageId, { surface: surfaceId, name: action }));
}

export function stopTurn(call: Call) {
  const found = writable(call, String(call.params.id));
  const running = call.deps.chat.running(found.agent.id, found.conversation);
  if (running) call.deps.chat.stop(found.agent.id, deciderOf(call));
  return { conversationId: found.id, stopped: running, at: apiTime(new Date().toISOString()) };
}

/** What an upload is, by its `Content-Type`; undefined for what is not taken. */
function kindOf(type: string): UploadRecord["kind"] | undefined {
  if (type.startsWith("image/")) return IMAGES[type] !== undefined ? "image" : undefined;
  if (type.startsWith("audio/")) return "voice";
  return type.startsWith("application/") || type.startsWith("text/") ? "file" : undefined;
}

export async function uploadFile(call: Call) {
  const found = writable(call, String(call.params.conversationId));
  const { bytes, type } = call.upload!;
  const kind = kindOf(type);
  if (kind === undefined || (kind === "image" && !IMAGES[type]!(bytes))) return refuse("upload-type-refused");
  if (kind === "image" && bytes.length > IMAGE_MAX) return refuse("upload-too-large");
  const stored = await call.deps.chat.store(found.agent.id, found.conversation, { name: String(call.params.name), base64: bytes.toString("base64") }, call.caller!.person.id);
  if (stored === "no-box") return refuse("box-not-running");
  if (stored === "refused") return refuse("api-not-found");
  const record: UploadRecord = {
    id: `up_${randomBytes(16).toString("hex")}`, personId: call.caller!.person.id, conversationId: found.id, name: stored.name, path: stored.path,
    mimeType: type, kind, sizeBytes: bytes.length, expiresAt: Date.now() + UPLOAD_TTL_MS,
  };
  call.deps.chat.uploads.put(record);
  return { id: record.id, conversationId: found.id, name: record.name, mimeType: type, kind, sizeBytes: record.sizeBytes, expiresAt: apiTime(new Date(record.expiresAt).toISOString()) };
}

const PING_MS = 20_000;

/** A live event as the stream sends it: `kind`, and its payload in the field of that name. */
function frameOf(call: Call, event: LiveEvent, phrases: Map<string, string>): Record<string, unknown> {
  if (event.kind === "text") return { kind: "text", text: { delta: event.delta } };
  if (event.kind === "turn") return { kind: "turn", turn: { state: event.state } };
  if (event.kind === "sent") return { kind: "sent", sent: { id: event.id } };
  // What a step is, in words that show the program and never the command; its end says the same words its start did.
  const phrase = (event.id !== undefined ? phrases.get(event.id) : undefined) ?? activityPhrases(event.tool, event.input)[call.locale];
  if (event.id !== undefined) { if (event.state === "started") phrases.set(event.id, phrase); else phrases.delete(event.id); }
  return { kind: "step", step: { phrase, state: event.state, ...(event.state === "ended" ? { ok: event.ok !== false } : {}) } };
}

export function streamConversation(call: Call) {
  const found = conversationFor(call, String(call.params.id));
  return stream((_req, res, requestId) => {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-request-id": requestId, "x-accel-buffering": "no" });
    const write = (text: string): boolean => { if (res.writableEnded || res.destroyed) return false; res.write(text); return true; };
    const send = (event: Record<string, unknown>) => { if (!write(`event: ${String(event.kind)}\ndata: ${JSON.stringify(event)}\n\n`)) end(res); };
    // The person may still reach the agent: asked when the stream opens a turn and at each ping, not on every word.
    const mayRead = (): boolean => call.stillValid() && sightOf(call).agent(found.agent.id);
    const phrases = new Map<string, string>();
    write(": connected\n\n");
    const unwatch = call.deps.chat.watch(found.agent.id, found.conversation, event => {
      if (event.kind === "turn" && event.state === "started" && !mayRead()) { end(res); return; }
      send(frameOf(call, event, phrases));
    });
    // A message kept: what `/messages?after=` then reads.
    const unlisten = call.deps.world.changes.onAppend(line => {
      if (line.type === "message" && line.conversationId === found.id) send({ kind: "message", message: { id: line.id } });
    });
    const closed = call.deps.world.changes.onClose(() => end(res));
    const untrack = call.track(() => end(res));
    const ping = setInterval(() => { if (!mayRead() || !write(": ping\n\n")) end(res); }, PING_MS);
    ping.unref();
    let ended = false;
    function end(target: ServerResponse) {
      if (ended) return;
      ended = true;
      unwatch(); unlisten(); closed(); untrack(); clearInterval(ping);
      if (!target.writableEnded) target.end();
    }
    res.on("close", () => end(res));
    res.on("error", () => end(res));
  });
}
