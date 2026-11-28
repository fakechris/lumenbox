import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  connectPhoneIk,
  connectWebSocket,
  extractClientIp,
  generateX25519Keypair,
  loadOrCreateHostIdentity,
  type PairedDeviceRecord,
  type PairedDeviceStore,
  PairingError,
  PairingOfferManager,
  pairPhoneWithOffer,
  parsePairingOfferUri,
  startHostRelayConnector,
  startRelayServer,
  toBase64Url,
} from "./index.ts";

/** Paired phones in memory: what the connector needs of a store. The installation's is the client API's device store (src/web/phone-relay.ts). */
function memoryStore(): PairedDeviceStore & { list(): PairedDeviceRecord[]; revoke(deviceId: string): boolean } {
  const devices = new Map<string, PairedDeviceRecord>();
  const live = new Map<string, Set<() => void>>();
  return {
    list: () => [...devices.values()],
    findByPublicKey: (publicKey) => [...devices.values()].find((d) => d.publicKey === toBase64Url(publicKey)),
    touchLastSeen: () => {},
    register(input) {
      const at = new Date().toISOString();
      const record: PairedDeviceRecord = {
        deviceId: `dev_${randomBytes(9).toString("base64url")}`, connId: `conn_${randomBytes(9).toString("base64url")}`, publicKey: toBase64Url(input.publicKey),
        deviceName: input.deviceName, platform: input.platform, scopes: ["agents:read"], pairedAt: at, lastSeenAt: at,
      };
      devices.set(record.deviceId, record);
      return record;
    },
    trackLiveSession(deviceId, close) {
      const set = live.get(deviceId) ?? new Set<() => void>();
      live.set(deviceId, set);
      set.add(close);
      return () => set.delete(close);
    },
    revoke(deviceId) {
      const had = devices.delete(deviceId);
      for (const close of [...(live.get(deviceId) ?? [])]) close();
      live.delete(deviceId);
      return had;
    },
  };
}

test("End-to-end: #fragment QR pairing, Noise_IK reconnect, concurrent /api/v1 + flow-controlled download without blocking POST /stop, VNC-ro stream, and single-device revocation", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lumenbox-relay-e2e-"));
  const relay = await startRelayServer(0, "127.0.0.1");

  try {
    const hostIdentity = loadOrCreateHostIdentity(tmpHome);
    // Reloading persists the exact same routeId and static public key
    const reloaded = loadOrCreateHostIdentity(tmpHome);
    assert.equal(reloaded.routeId, hostIdentity.routeId);
    assert.deepEqual(reloaded.keypair.publicKey, hostIdentity.keypair.publicKey);
    assert.equal(fs.statSync(path.join(tmpHome, "relay-host-key.json")).mode & 0o777, 0o600);

    const deviceStore = memoryStore();
    const offerManager = new PairingOfferManager();

    let stopCalledWhileStreaming = false;
    let releaseSlowChunks!: () => void;
    const slowGate = new Promise<void>((r) => {
      releaseSlowChunks = r;
    });

    const hostConnector = await startHostRelayConnector({
      routeId: hostIdentity.routeId,
      hostKeypair: hostIdentity.keypair,
      relayUrl: relay.url,
      offerManager,
      deviceStore,
      initialWindowBytes: 16 * 1024, // Tight 16 KiB window to exercise per-stream backpressure
      handlers: {
        async onHttpRequest(req, meta) {
          if (req.method === "POST" && req.path === "/api/v1/conversations/c1/stop") {
            stopCalledWhileStreaming = true;
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({ stopped: true, by: meta.deviceId }), "utf8"),
            };
          }
          if (req.method === "GET" && req.path === "/api/v1/deliverables/big") {
            async function* generateChunks() {
              yield new Uint8Array(24 * 1024).fill(0xaa);
              await slowGate;
              yield new Uint8Array(24 * 1024).fill(0xbb);
            }
            return {
              status: 200,
              headers: { "content-type": "application/octet-stream" },
              body: generateChunks(),
            };
          }
          if (req.method === "GET" && req.path === "/api/v1/meta") {
            return {
              status: 200,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({ api: "1.0", deviceId: meta.deviceId }), "utf8"),
            };
          }
          return { status: 404, headers: {} as Record<string, string> };
        },
        async onOpenStream(req, stream) {
          if (req.target === "vnc-ro") {
            await stream.send(Buffer.from("RFB 003.008\n", "ascii"), true);
            stream.close();
          }
        },
      },
    });

    try {
      // 1. Refuse query-string secrets in pairing URIs
      assert.throws(
        () => parsePairingOfferUri("lumenbox://pair?pairSecret=abc&hostPub=def"),
        (err: unknown) => err instanceof PairingError && err.code === "secret_in_query_refused",
      );

      // 2. Pair Phone A and Phone B via one-time #fragment QR offers
      const offerA = offerManager.mintOffer({
        hostPublicKey: hostIdentity.keypair.publicKey,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
      });
      const parsedOfferA = parsePairingOfferUri(offerA.uri);
      const phoneAKp = generateX25519Keypair();
      const pairedA = await pairPhoneWithOffer({
        offer: parsedOfferA,
        deviceKeypair: phoneAKp,
        deviceName: "Chris iPhone",
        platform: "ios",
      });
      assert.equal(pairedA.mode, "relay");
      assert.ok(pairedA.deviceId.startsWith("dev_"));

      // Replaying the consumed QR offer must fail!
      await assert.rejects(() =>
        pairPhoneWithOffer({
          offer: parsedOfferA,
          deviceKeypair: generateX25519Keypair(),
          deviceName: "Attacker",
          platform: "other",
        }),
      );

      const offerB = offerManager.mintOffer({
        hostPublicKey: hostIdentity.keypair.publicKey,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
      });
      const phoneBKp = generateX25519Keypair();
      const pairedB = await pairPhoneWithOffer({
        offer: parsePairingOfferUri(offerB.uri),
        deviceKeypair: phoneBKp,
        deviceName: "Chris Android",
        platform: "android",
      });
      assert.equal(deviceStore.list().length, 2);

      // 3. Reconnect both phones via Noise_IK
      const sleepingNotices: Array<{ at: string; reason: string }> = [];
      const sessionA = await connectPhoneIk({
        hostPublicKey: hostIdentity.keypair.publicKey,
        deviceKeypair: phoneAKp,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
        initialWindowBytes: 16 * 1024,
        onHostSleeping: (info) => sleepingNotices.push(info),
      });
      const sessionB = await connectPhoneIk({
        hostPublicKey: hostIdentity.keypair.publicKey,
        deviceKeypair: phoneBKp,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
      });

      // 4. Start a multi-chunk download on Phone A AND concurrently issue POST /stop:
      //    POST /stop must finish immediately without head-of-line blocking!
      const downloadPromise = sessionA.mux.request({
        method: "GET",
        path: "/api/v1/deliverables/big",
        headers: {},
      });
      const stopRes = await sessionA.mux.request({
        method: "POST",
        path: "/api/v1/conversations/c1/stop",
        headers: { "idempotency-key": "idem-1" },
        body: Buffer.from("{}", "utf8"),
      });
      assert.equal(stopRes.status, 200);
      assert.equal(stopCalledWhileStreaming, true);
      releaseSlowChunks();
      const dlRes = await downloadPromise;
      assert.equal(dlRes.status, 200);
      assert.equal(dlRes.body.byteLength, 48 * 1024);

      // 5. Read-only VNC stream works over the same Noise_IK multiplexer
      const vncChunks: Uint8Array[] = [];
      const vncStream = await sessionA.mux.openStream({
        target: "vnc-ro",
        path: "/desktop/0/websockify",
      });
      const vncDone = new Promise<void>((r) => vncStream.onClose(() => r()));
      vncStream.onData((chunk) => vncChunks.push(chunk));
      await vncDone;
      assert.equal(Buffer.concat(vncChunks.map((c) => Buffer.from(c))).toString("ascii"), "RFB 003.008\n");

      // 6. Broadcast host_sleeping notice reaches connected clients immediately
      hostConnector.broadcastHostSleeping("suspend");
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(sleepingNotices.length, 1);
      assert.equal(sleepingNotices[0]?.reason, "suspend");

      // 7. Single-device revocation: revoking Phone A kills Phone A immediately and blocks its
      //    Noise_IK reconnect, while Phone B continues serving /api/v1 requests uninterrupted!
      let phoneAClosed = false;
      sessionA.onClose(() => {
        phoneAClosed = true;
      });
      assert.equal(deviceStore.revoke(pairedA.deviceId), true);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(phoneAClosed, true);

      await assert.rejects(() =>
        connectPhoneIk({
          hostPublicKey: hostIdentity.keypair.publicKey,
          deviceKeypair: phoneAKp,
          relayUrl: relay.url,
          routeId: hostIdentity.routeId,
        }),
      );

      const metaB = await sessionB.mux.request({
        method: "GET",
        path: "/api/v1/meta",
        headers: {},
      });
      assert.equal(metaB.status, 200);
      assert.equal(
        (JSON.parse(Buffer.from(metaB.body).toString("utf8")) as { deviceId: string }).deviceId,
        pairedB.deviceId,
      );

      sessionB.close();
    } finally {
      await hostConnector.close();
    }
  } finally {
    await relay.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("Direct LAN/tailnet candidate is preferred when reachable and falls back to relay when unreachable; relay defends XFF and low-order keys", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "lumenbox-direct-e2e-"));
  const relay = await startRelayServer(0, "127.0.0.1");

  try {
    const hostIdentity = loadOrCreateHostIdentity(tmpHome);
    const deviceStore = memoryStore();
    const offerManager = new PairingOfferManager();

    const hostConnector = await startHostRelayConnector({
      routeId: hostIdentity.routeId,
      hostKeypair: hostIdentity.keypair,
      relayUrl: relay.url,
      directListenPort: 0,
      directListenHost: "127.0.0.1",
      offerManager,
      deviceStore,
      handlers: {
        async onHttpRequest() {
          return { status: 200, headers: {}, body: Buffer.from("ok") };
        },
      },
    });

    try {
      assert.ok(hostConnector.directUrl);
      const phoneKp = generateX25519Keypair();
      const offer = offerManager.mintOffer({
        hostPublicKey: hostIdentity.keypair.publicKey,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
        directUrls: [hostConnector.directUrl],
      });
      const paired = await pairPhoneWithOffer({
        offer: parsePairingOfferUri(offer.uri),
        deviceKeypair: phoneKp,
        deviceName: "LAN iPhone",
        platform: "ios",
      });
      // Reachable direct endpoint is preferred over relay!
      assert.equal(paired.mode, "direct");

      // Unreachable direct port seamlessly falls back to relay!
      const fallbackSession = await connectPhoneIk({
        hostPublicKey: hostIdentity.keypair.publicKey,
        deviceKeypair: phoneKp,
        relayUrl: relay.url,
        routeId: hostIdentity.routeId,
        directUrls: ["ws://127.0.0.1:1/unreachable"],
      });
      assert.equal(fallbackSession.mode, "relay");
      const res = await fallbackSession.mux.request({ method: "GET", path: "/api/v1/ping", headers: {} });
      assert.equal(res.status, 200);
      fallbackSession.close();

      // Relay ingress rejects non-object JSON frames ("null", primitives) without crashing!
      for (const nonObjectJson of ["null", "123", '"hello"', "[]"]) {
        const badWs = await connectWebSocket(relay.url);
        const badCode = await new Promise<number>((resolve) => {
          badWs.onClose((code) => resolve(code));
          badWs.sendText(nonObjectJson);
        });
        assert.equal(badCode, 4001);
      }

      // Relay ingress rejects handshake frames carrying an all-zero (low-order) ephemeral key!
      const rawWs = await connectWebSocket(relay.url);
      const closedCode = await new Promise<number>((resolve) => {
        rawWs.onText((t) => {
          const msg = JSON.parse(t) as { type?: string };
          if (msg.type === "client_connected") {
            const forgedLowOrderMsg = new Uint8Array(64); // first 32 bytes = all zeros (low-order!)
            rawWs.sendText(
              JSON.stringify({ type: "ik_hello", message: toBase64Url(forgedLowOrderMsg) }),
            );
          }
        });
        rawWs.onClose((code) => resolve(code));
        rawWs.sendText(JSON.stringify({ type: "client_connect", routeId: hostIdentity.routeId }));
      });
      assert.equal(closedCode, 4003);
    } finally {
      await hostConnector.close();
    }

    // Trusted proxy X-Forwarded-For extraction ignores spoofed XFF when direct peer is untrusted
    const fakeReqUntrusted = {
      socket: { remoteAddress: "203.0.113.9" },
      headers: { "x-forwarded-for": "198.51.100.1" },
    } as unknown as http.IncomingMessage;
    assert.equal(extractClientIp(fakeReqUntrusted, new Set(["127.0.0.1"])), "203.0.113.9");

    const fakeReqTrusted = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { "x-forwarded-for": "198.51.100.42, 127.0.0.1" },
    } as unknown as http.IncomingMessage;
    assert.equal(extractClientIp(fakeReqTrusted, new Set(["127.0.0.1"])), "198.51.100.42");
  } finally {
    await relay.close();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
