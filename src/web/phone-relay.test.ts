/**
 * A personal installation's phones through the relay (INV-2327), on the real server with a local relay
 * process: the page shows the relay's QR code, a phone pairs over `Noise_NK` and reconnects over
 * `Noise_IK`, and every `/api/v1` request it sends through the channel is answered by the client API's
 * frame — the same credential and scope checks as over HTTP. Removing one phone closes its session and
 * refuses its key; the other phone goes on. The Mac's sleep notice reaches the phones.
 */

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ConnectedPhoneSession, connectPhoneIk, generateX25519Keypair, pairPhoneWithOffer, parsePairingOfferUri, startRelayServer } from "../mobile-relay/index.ts";
import { pairingRelay, relayAddressOf } from "./phone-relay.ts";

const KEYS = ["AGENTBOX_HOME", "AGENTBOX_UI_TOKEN", "AGENTBOX_NO_TOKEN", "AGENTBOX_PUBLIC_URL", "AGENTBOX_EXPOSURE", "AGENTBOX_MOBILE_RELAY"] as const;

async function installation(t: TestContext) {
  const relay = await startRelayServer(0, "127.0.0.1");
  const home = mkdtempSync(join(tmpdir(), "phone-relay-"));
  const previous = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, { AGENTBOX_HOME: home, AGENTBOX_MOBILE_RELAY: relay.url });
  // A personal installation: the Owner alone, on this Mac.
  writeFileSync(join(home, "principals.json"), JSON.stringify({ principals: [{ id: "local:owner", name: "Owner", role: "admin", identities: [] }], installation: { mode: "single-machine", ownerId: "local:owner" } }));
  const { startWebServer } = await import("./server.ts");
  let base = "";
  const logs: string[] = [];
  const stop = await startWebServer({ port: 0, host: "127.0.0.1", token: "t0k", useBox: false, onLog: line => logs.push(line), onReady: url => { base = url; } });
  t.after(async () => {
    stop();
    await relay.close();
    for (const key of KEYS) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    rmSync(home, { recursive: true, force: true });
  });
  const operator = { authorization: "Bearer t0k", "content-type": "application/json" };
  const page = async (path: string, body?: unknown) => {
    const answer = await fetch(`${base.replace(/\/$/, "")}${path}`, body === undefined ? { headers: operator } : { method: "POST", headers: operator, body: JSON.stringify(body) });
    return { status: answer.status, data: await answer.json() as Record<string, unknown> };
  };
  // The server connects out to the relay as it starts: until it has, the page says so rather than show a code that cannot work.
  let shown = await page("/api/devices/pairing", {});
  for (let tries = 0; shown.status !== 200 && tries < 100; tries += 1) {
    assert.equal(shown.data.code, "phone-relay-offline", JSON.stringify(shown.data));
    await new Promise(resolve => setTimeout(resolve, 50));
    shown = await page("/api/devices/pairing", {});
  }
  assert.equal(shown.status, 200, JSON.stringify(shown.data));
  return { relay, base: base.replace(/\/$/, ""), page, logs, shown: shown.data as { link: string; expiresAt: string; qrSvg: string } };
}

/** A phone paired with a fresh code from the page: its key, its device id and its first access token. */
async function pairPhone(page: Awaited<ReturnType<typeof installation>>["page"], name: string, link?: string) {
  const offer = parsePairingOfferUri(link ?? ((await page("/api/devices/pairing", {})).data as { link: string }).link);
  const keypair = generateX25519Keypair();
  const paired = await pairPhoneWithOffer({ offer, deviceKeypair: keypair, deviceName: name, platform: "ios" });
  const tokens = paired.reply.tokens as { accessToken: string; refreshToken: string; deviceId: string };
  assert.equal(tokens.deviceId, paired.deviceId, "the pairing signs the phone in as a device of the client API's store");
  return { offer, keypair, deviceId: paired.deviceId, access: tokens.accessToken, refresh: tokens.refreshToken };
}

const json = (body: Uint8Array) => JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;

test("a phone pairs through the relay and every /api/v1 request it sends there is answered by the frame, as over HTTP; a removed phone is refused and closed, the other goes on", async t => {
  const { relay, base, page, shown } = await installation(t);
  assert.match(shown.link, /^lumenbox:\/\/pair#hostPub=[\w-]+&relay=[^&]+&route=host_[\w-]+&pairSecret=[\w-]+$/, "the secret is in the fragment");
  assert.ok(shown.qrSvg.startsWith("<svg"));
  const a = await pairPhone(page, "Chris iPhone", shown.link);
  // The code works once.
  await assert.rejects(pairPhoneWithOffer({ offer: a.offer, deviceKeypair: generateX25519Keypair(), deviceName: "again", platform: "ios" }));
  const b = await pairPhone(page, "Chris iPad");
  const connect = (phone: { keypair: ReturnType<typeof generateX25519Keypair> }, onHostSleeping?: (info: { at: string; reason: string }) => void) =>
    connectPhoneIk({ hostPublicKey: a.offer.hostPublicKey, deviceKeypair: phone.keypair, relayUrl: relay.url, routeId: a.offer.routeId, ...(onHostSleeping ? { onHostSleeping } : {}) });
  const sleeps: string[] = [];
  const sessionA: ConnectedPhoneSession = await connect(a);
  const sessionB = await connect(b, info => sleeps.push(info.reason));
  const get = (session: ConnectedPhoneSession, path: string, token?: string) => session.mux.request({ method: "GET", path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

  // Who the phone is, and what changed: the frame's own answers, with its request id and validator.
  const me = await get(sessionA, "/api/v1/me", a.access);
  assert.equal(me.status, 200, Buffer.from(me.body).toString());
  assert.equal(json(me.body).id, "local:owner");
  assert.deepEqual(json(me.body).credential, { ...(json(me.body).credential as object), kind: "device", id: a.deviceId });
  assert.ok(me.headers["x-request-id"] && me.headers.etag);
  const changes = await get(sessionA, "/api/v1/changes?since=0", a.access);
  assert.equal(changes.status, 200, Buffer.from(changes.body).toString());
  assert.equal(typeof json(changes.body).durableSeq, "number");

  // The same checks as over HTTP: no credential, and a credential without the scope, are refused alike, word for word.
  const minted = await page("/api/client-tokens", { kind: "personal", label: "work only", scopes: ["work:read"], expiresInDays: 1 });
  assert.equal(minted.status, 200, JSON.stringify(minted.data));
  const narrow = minted.data.token as string;
  for (const [path, token] of [["/api/v1/agents", narrow], ["/api/v1/me", undefined]] as const) {
    const viaRelay = await get(sessionA, path, token);
    const viaHttp = await fetch(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
    const httpBody = await viaHttp.json() as Record<string, unknown>;
    assert.equal(viaRelay.status, viaHttp.status, path);
    assert.equal(json(viaRelay.body).code, httpBody.code, path);
    assert.equal(json(viaRelay.body).error, httpBody.error, path);
  }
  assert.equal(json((await get(sessionA, "/api/v1/agents", narrow)).body).code, "api-scope-needed");
  // Only /api/v1 is carried: the page's own routes are not reachable through the relay, with the installation's token or any other.
  assert.equal((await get(sessionA, "/api/state", "t0k")).status, 404);
  // The refresh token rotates through the relay as through HTTP.
  const refreshed = await sessionA.mux.request({ method: "POST", path: "/api/v1/auth/refresh", headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ refreshToken: a.refresh })) });
  assert.equal(refreshed.status, 200, Buffer.from(refreshed.body).toString());
  a.access = json(refreshed.body).accessToken as string;

  // The change stream is the frame's too: an HTTP answer on the stream, ended when the device is.
  const events = await sessionB.mux.openStream({ target: "events", path: "/api/v1/events", headers: { authorization: `Bearer ${b.access}` } });
  const eventBytes: Buffer[] = [];
  events.onData(chunk => eventBytes.push(Buffer.from(chunk)));
  const eventsEnded = new Promise<void>(resolve => events.onClose(() => resolve()));
  for (let tries = 0; !Buffer.concat(eventBytes).includes("\r\n\r\n") && tries < 100; tries += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(Buffer.concat(eventBytes).toString(), /^HTTP\/1\.1 200 [^\r]*\r\n[\s\S]*content-type: text\/event-stream/i);
  // A desktop over the relay goes to the server's own desktop gate, read-only: a phone holds no page sign-in, so it is refused there.
  const desktop = await sessionB.mux.openStream({ target: "vnc-ro", path: "/vnc-ro/1/websockify", headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } });
  const desktopBytes: Buffer[] = [];
  desktop.onData(chunk => desktopBytes.push(Buffer.from(chunk)));
  await new Promise<void>(resolve => desktop.onClose(() => resolve()));
  assert.match(Buffer.concat(desktopBytes).toString(), /^HTTP\/1\.1 40[13] /);
  const driving = await sessionB.mux.openStream({ target: "vnc-ro", path: "/vnc/1/websockify" });
  assert.equal(await new Promise(resolve => driving.onClose(resolve)), "stream_path_refused", "never the desktop that drives");

  // Both phones are on the person's one list of devices, the page's and the API's.
  const listed = (await page("/api/devices")).data.devices as { id: string; name: string }[];
  assert.deepEqual(listed.map(device => device.name).sort(), ["Chris iPad", "Chris iPhone"]);
  assert.equal((json((await get(sessionB, "/api/v1/devices", b.access)).body).items as unknown[]).length, 2);

  // The Mac going to sleep, as the desktop app says it: every connected phone is told.
  assert.deepEqual((await page("/api/mobile-relay/sleeping", { reason: "suspend" })).data, { told: true });
  for (let tries = 0; sleeps.length === 0 && tries < 50; tries += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sleeps, ["suspend"]);

  // Removing phone A on the page: its session closes now, its key is refused, its token is access-removed — phone B goes on.
  const closedA = new Promise<void>(resolve => sessionA.onClose(() => resolve()));
  assert.equal((await page("/api/devices/remove", { id: a.deviceId })).status, 200);
  await closedA;
  await assert.rejects(connect(a), /rejected|closed/i);
  assert.equal(json((await get(sessionB, "/api/v1/me", a.access)).body).code, "access-removed");
  const stillB = await get(sessionB, "/api/v1/me", b.access);
  assert.equal(stillB.status, 200);
  // And B's own stream is untouched by A's removal.
  assert.equal(await Promise.race([eventsEnded.then(() => "ended"), new Promise(resolve => setTimeout(() => resolve("open"), 100))]), "open");

  // Removing B ends its stream too.
  assert.equal((await page("/api/devices/remove", { id: b.deviceId })).status, 200);
  await eventsEnded;
  sessionB.close();
});

test("phone access needs a relay a phone may be sent to; an organisation pairs through its public address", () => {
  assert.equal(relayAddressOf("wss://relay.example.com/"), "wss://relay.example.com");
  assert.equal(relayAddressOf("ws://127.0.0.1:4000"), "ws://127.0.0.1:4000");
  assert.equal(relayAddressOf("ws://relay.example.com"), undefined, "unencrypted to another machine");
  assert.equal(relayAddressOf("https://relay.example.com"), undefined);
  assert.equal(relayAddressOf("not an address"), undefined);
  assert.equal(pairingRelay(undefined, "organisation"), undefined);
  assert.deepEqual(pairingRelay(undefined, "single-machine"), { on: false });
});
