/**
 * The tailmsg door end to end on loopback (INV-1288): what it answers, whom it refuses,
 * what reaches the agent and how, and how a reply goes back. whois and the source check
 * are injected; the peer is a small local server that records what it is sent.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InboundMessage } from "./manager.ts";
import { type Peer, parseTailmsgRecordConfig, TailmsgDoor, tailmsgIdentity } from "./tailmsg.ts";

const SELF = "dev-server.example.ts.net";
const PEER = "bot-box.example.ts.net";

async function post(port: number, body: unknown, contentType = "application/json"): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/msg", method: "POST", headers: { "content-type": contentType, "content-length": Buffer.byteLength(text) } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    });
    req.on("error", reject);
    req.end(text);
  });
}

async function get(port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, path, method: "GET" }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> }));
    })
      .on("error", reject)
      .end();
  });
}

const letter = (over: Record<string, unknown> = {}) => ({ v: 1, id: `id-${Math.random().toString(36).slice(2, 12)}`, from: PEER, to: SELF, ts: "2026-10-08T14:00:00Z", text: "hello", ...over });

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

test("the door: health, refusals in order, admission, dedupe, wake, the agent's view, files, the reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tailmsg-door-"));
  const logs: string[] = [];
  const delivered: InboundMessage[] = [];
  const sent: { host: string; port: number; body: Record<string, unknown>; connectTo: string | undefined }[] = [];
  // The peer's file server: /f/good holds a file whose hash the letter will carry.
  const good = Buffer.from("the report, in full");
  const peerFiles = createServer((req, res) => {
    if (req.url === "/f/good") res.end(good);
    else if (req.url === "/f/other") res.end("something else");
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  const peerPort = await listen(peerFiles);
  let whoisAnswer: Peer | undefined = { name: PEER, user: "chris@example.com" };
  let hour = 14;
  const door = new TailmsgDoor(
    "tailmsg",
    { port: 0, allow: ["bot-box"], deny: ["tag:untrusted"], wake: { senderMax: [{ sender: "bot-box", max: "now" }], quietHours: { start: 23, end: 7 }, ratePerHour: 2 } },
    {
      self: async () => ({ name: SELF, address: "127.0.0.1" }),
      whois: async () => whoisAnswer,
      agentKnown: name => name === "codex",
      dir,
      log: line => logs.push(line),
      hour: () => hour,
      tailnetAddress: () => true,
      post: async (host, port, body, connectTo) => {
        sent.push({ host, port, body: JSON.parse(body) as Record<string, unknown>, connectTo });
        return { status: 202, body: "{}" };
      },
    }
  );
  try {
    await door.start(async message => {
      delivered.push(message);
      return message.text.includes("answer me") ? "here is the answer" : undefined;
    });
    // port 0 asked the OS; read what it gave.
    const port = ((door as unknown as { server: Server }).server.address() as { port: number }).port;

    assert.deepEqual((await get(port, "/health")).body, { ok: true, v: 1, node: SELF });
    assert.equal((await get(port, "/nope")).status, 404);
    assert.equal((await post(port, "{}", "text/plain")).status, 415);
    assert.equal((await post(port, "not json")).status, 400);
    assert.match(String((await post(port, letter({ extra: 1 }))).body.error), /unknown field/);
    assert.match(String((await post(port, letter({ to: "elsewhere" }))).body.error), /to is not this host/);

    // Whom it refuses: unknown to tailscale, denied, not allowed, lying about from.
    whoisAnswer = undefined;
    assert.equal((await post(port, letter())).status, 403);
    whoisAnswer = { name: PEER, tags: ["tag:untrusted"] };
    assert.match(String((await post(port, letter())).body.error), /denied/);
    whoisAnswer = { name: "stranger.example.ts.net" };
    assert.match(String((await post(port, letter({ from: "stranger.example.ts.net" }))).body.error), /not in the allow list/);
    whoisAnswer = { name: PEER };
    assert.match(String((await post(port, letter({ from: "dev-server.example.ts.net" }))).body.error), /from does not match/);
    assert.equal(delivered.length, 0, "nothing refused reaches the agent");

    // Admitted, wake now: delivered at once, as a letter and not an approval, unsteerable, admitted by the door.
    const first = letter({ wake: "now", agent: "codex", from_agent: "grok", text: "please answer me" });
    const accepted = await post(port, first);
    assert.equal(accepted.status, 202);
    assert.equal(accepted.body.wake, "now");
    assert.equal(delivered.length, 1);
    const seen = delivered[0]!;
    assert.equal(seen.identity, tailmsgIdentity("tailmsg", PEER));
    assert.equal(seen.identity, `tailmsg:${PEER}`, "the identity is the machine whois verified, not the agent name the peer claimed");
    assert.equal(seen.senderLabel, "grok@bot-box");
    assert.equal(seen.chatKey, `tailmsg:${PEER}`);
    assert.equal(seen.admittedByDoor, true);
    assert.equal(seen.messageId, first.id);
    assert.match(seen.text, /^@codex \[tailmsg letter from bot-box\.example\.ts\.net \(its agent grok\), kind text, wake now\]\nplease answer me/);
    assert.match(seen.text, /never an approval/);
    // The agent answered: a reply went to the peer's /msg, addressed to the agent that wrote, threaded.
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.host, PEER);
    assert.equal(sent[0]!.connectTo, "127.0.0.1", "the reply connects to the address whois verified, not to a name");
    assert.equal(sent[0]!.body.reply_to, first.id);
    assert.equal(sent[0]!.body.agent, "grok");
    assert.equal(sent[0]!.body.from, SELF);
    assert.equal(sent[0]!.body.text, "here is the answer");
    assert.equal(sent[0]!.body.to, PEER);
    // The same id again is a duplicate: 200, not delivered twice.
    const again = await post(port, first);
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(delivered.length, 1);
    assert.ok(existsSync(join(dir, "inbox", `${first.id}.json`)));
    const record = JSON.parse(readFileSync(join(dir, "inbox", `${first.id}.json`), "utf8")) as { received: { peer: Peer; agent_status: string }; delivered?: string };
    assert.equal(record.received.peer.name, PEER, "the record carries whois, not the envelope");
    assert.equal(record.received.agent_status, "known");
    assert.ok(record.delivered);

    // Batch wish: in the inbox, not delivered; a later `now` for the same agent carries it first.
    const batched = letter({ wake: "batch", agent: "codex", text: "later is fine" });
    assert.equal((await post(port, batched)).body.wake, "batch");
    assert.equal(delivered.length, 1);
    await post(port, letter({ wake: "now", agent: "codex", text: "now please" }));
    assert.equal(delivered.length, 3);
    assert.match(delivered[1]!.text, /later is fine/);
    assert.match(delivered[2]!.text, /now please/);
    // Quiet hours lower now to batch; the response says so.
    hour = 2;
    const quiet = await post(port, letter({ wake: "now", agent: "codex", text: "night" }));
    assert.equal(quiet.body.wake, "batch");
    assert.equal(delivered.length, 3);
    hour = 14;
    await door.flushBatch();
    assert.equal(delivered.length, 4);
    assert.match(delivered[3]!.text, /wake batch \(quiet hours\)\]\nnight/);

    // An agent nobody has: archived, nobody woken, even on flush.
    const nobody = await post(port, letter({ wake: "now", agent: "ghost", text: "boo" }));
    assert.equal(nobody.status, 202);
    assert.equal(nobody.body.wake, "batch");
    await door.flushBatch();
    assert.equal(delivered.length, 4);
    assert.ok(logs.some(line => line.includes("to ghost [unknown]")));

    // A wish of none is archived only.
    await post(port, letter({ wake: "none", agent: "codex", text: "fyi" }));
    await door.flushBatch();
    assert.equal(delivered.length, 4);

    // Files: fetched from the sender to .part, kept only when size and sha256 match.
    const sha = createHash("sha256").update(good).digest("hex");
    const withFiles = letter({
      wake: "now",
      agent: "codex",
      text: "see the files",
      fetch: [
        { name: "../report.txt", url: `http://bot-box:${peerPort}/f/good`, sha256: sha, size: good.length },
        { name: "wrong.txt", url: `http://bot-box:${peerPort}/f/other`, sha256: sha, size: good.length },
        { name: "missing.txt", url: `http://bot-box:${peerPort}/f/none`, sha256: sha, size: good.length },
      ],
    });
    door["deps"].download = (url, to, max, connectTo) => {
      assert.equal(connectTo, "127.0.0.1", "the fetch connects to the address whois verified");
      return downloadFrom(url, to, max, peerPort);
    };
    // The third `now` this hour for (bot-box, codex) is over the rate of 2: batch.
    const rated = await post(port, withFiles);
    assert.equal(rated.status, 202);
    assert.equal(rated.body.wake, "batch");
    // 202 is "in the inbox"; the fetch follows the answer, and the flush hands it on.
    // The record gains `files` only once every fetch has settled, matched or dropped.
    const fetched = () => { try { return (JSON.parse(readFileSync(join(dir, "inbox", `${withFiles.id}.json`), "utf8")) as { received: { files?: string[] } }).received.files !== undefined; } catch { return false; } };
    for (let i = 0; i < 250 && !fetched(); i++) await new Promise(resolve => setTimeout(resolve, 20));
    await door.flushBatch();
    assert.equal(delivered.length, 5, logs.join("\n"));
    assert.match(delivered[4]!.text, /wake batch \(rate: 2 now-wakes per hour/);
    const files = readdirSync(join(dir, "inbox", withFiles.id, "files"));
    assert.deepEqual(files, ["report.txt"], "only the matching file is kept, under a safe name");
    assert.match(delivered[4]!.text, /files fetched from the sender and checked: .*report\.txt/);
    assert.ok(logs.some(line => /wrong\.txt .* did not match/.test(line)));
    assert.ok(logs.some(line => /missing\.txt .* could not be fetched/.test(line)));
  } finally {
    door.stop();
    peerFiles.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function downloadFrom(url: string, to: string, max: number, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    httpRequest({ host: "127.0.0.1", port, path: target.pathname }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(String(res.statusCode)));
        return;
      }
      const out = createWriteStream(to);
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > max) reject(new Error("too big"));
        out.write(chunk);
      });
      res.on("end", () => out.end(() => resolve(size)));
    })
      .on("error", reject)
      .end();
  });
}

test("tailscale is down: the door logs it, stays closed, and probe says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tailmsg-down-"));
  const logs: string[] = [];
  const door = new TailmsgDoor("tailmsg", { allow: [] }, { self: async () => undefined, whois: async () => undefined, agentKnown: () => false, dir, log: line => logs.push(line) });
  try {
    await door.start(async () => undefined);
    assert.equal(await door.probe(), "tailscale is not up");
    assert.ok(logs.some(line => line.includes("tailscale is not up")));
  } finally {
    door.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the record's tailmsg field is read strictly", () => {
  assert.deepEqual(parseTailmsgRecordConfig(undefined), { allow: [] });
  assert.deepEqual(parseTailmsgRecordConfig({ allow: [" bot-box "], deny: [], port: 7766, wake: { defaultMax: "now", quietHours: { start: 23, end: 7 }, ratePerHour: 3, senderMax: [{ sender: "x", max: "none" }] } }), {
    allow: ["bot-box"],
    port: 7766,
    wake: { defaultMax: "now", senderMax: [{ sender: "x", max: "none" }], quietHours: { start: 23, end: 7 }, ratePerHour: 3 },
  });
  assert.match(String(parseTailmsgRecordConfig({ allow: "bot-box" })), /allow must be a list/);
  assert.match(String(parseTailmsgRecordConfig({ port: 70000 })), /port/);
  assert.match(String(parseTailmsgRecordConfig({ wake: { defaultMax: "loud" } })), /defaultMax/);
  assert.match(String(parseTailmsgRecordConfig({ wake: { quietHours: { start: 25, end: 1 } } })), /quietHours/);
  assert.match(String(parseTailmsgRecordConfig({ wake: { senderMax: [{ sender: 1 }] } })), /senderMax/);
});
