/**
 * Host and phone connectors for `Noise_NK` QR pairing, `Noise_IK` mutual zero-knowledge sessions,
 * and direct LAN/tailnet candidate selection with relay fallback (docs/109 §3.1–3.2).
 */

import http from "node:http";
import type net from "node:net";
import { type HostMuxHandlers, RelayMux } from "./mux.ts";
import {
  LUMENBOX_RELAY_PROLOGUE,
  NoiseError,
  respondIk,
  respondNk,
  startIkInitiator,
  startNkInitiator,
  type X25519Keypair,
} from "./noise.ts";
import {
  fromBase64Url,
  type PairedDeviceRecord,
  type PairedDeviceStore,
  type PairingOfferManager,
  type ParsedPairingOffer,
  selectCandidateTransportUrl,
  toBase64Url,
} from "./pairing.ts";
import { connectWebSocket, type MinimalWebSocket, upgradeServerSocket } from "./ws-wire.ts";

export interface HostConnectorOptions {
  readonly routeId: string;
  readonly hostKeypair: X25519Keypair;
  readonly relayUrl?: string;
  readonly directListenPort?: number;
  readonly directListenHost?: string;
  readonly offerManager: PairingOfferManager;
  readonly deviceStore: PairedDeviceStore;
  readonly handlers: HostMuxHandlers;
  readonly initialWindowBytes?: number;
}

export interface RunningHostConnector {
  readonly directUrl?: string;
  broadcastHostSleeping(reason?: string): void;
  close(): Promise<void>;
}

interface HostSessionChannel {
  sendHandshakeText(jsonText: string): void;
  sendEncryptedBinary(wire: Uint8Array): void;
  rejectSession(reason: string): void;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function attachHostSessionAdmission(
  channel: HostSessionChannel,
  options: HostConnectorOptions,
  activeMuxes: Set<RelayMux>,
): {
  onHandshakeText(text: string): void;
  onBinary(wire: Uint8Array): void;
  dispose(): void;
} {
  let mux: RelayMux | null = null;
  let untrack: (() => void) | null = null;

  const dispose = () => {
    untrack?.();
    untrack = null;
    if (mux) {
      activeMuxes.delete(mux);
      mux.close();
      mux = null;
    }
  };

  return {
    onHandshakeText(text: string) {
      if (mux) {
        dispose();
        channel.rejectSession("Duplicate handshake");
        return;
      }
      const env = parseObject(text);
      if (!env) {
        channel.rejectSession("Malformed handshake JSON");
        return;
      }
      if (typeof env.message !== "string") {
        channel.rejectSession("Missing Noise message");
        return;
      }

      try {
        const msg1 = fromBase64Url(env.message);
        if (env.type === "pair_hello") {
          let registeredDevice: PairedDeviceRecord | null = null;
          const { message2, session } = respondNk({
            responderStaticKeypair: options.hostKeypair,
            message1: msg1,
            prologue: LUMENBOX_RELAY_PROLOGUE,
            responsePayload: (clientPayload) => {
              const req = parseObject(Buffer.from(clientPayload).toString("utf8"));
              if (!req || typeof req.pairSecret !== "string" || typeof req.deviceStaticPub !== "string") {
                throw new NoiseError("invalid_pair_request", "Missing pairSecret or deviceStaticPub");
              }
              if (!options.offerManager.consumeSecret(fromBase64Url(req.pairSecret))) {
                throw new NoiseError("pair_secret_rejected", "Pairing secret expired or already used");
              }
              const platform =
                req.platform === "ios" || req.platform === "android" ? req.platform : "other";
              registeredDevice = options.deviceStore.register({
                publicKey: fromBase64Url(req.deviceStaticPub),
                deviceName: typeof req.deviceName === "string" ? req.deviceName : "Phone",
                platform,
              });
              return Buffer.from(
                JSON.stringify({
                  deviceId: registeredDevice.deviceId,
                  connId: registeredDevice.connId,
                  scopes: registeredDevice.scopes,
                }),
                "utf8",
              );
            },
          });
          channel.sendHandshakeText(
            JSON.stringify({ type: "pair_ready", message: toBase64Url(message2) }),
          );
          session.destroy();
          return;
        }

        if (env.type === "ik_hello") {
          let admittedDevice: PairedDeviceRecord | undefined;
          const { message2, session } = respondIk({
            responderStaticKeypair: options.hostKeypair,
            message1: msg1,
            prologue: LUMENBOX_RELAY_PROLOGUE,
            admitInitiator: (clientStaticPub) => {
              const found = options.deviceStore.findByPublicKey(clientStaticPub);
              if (!found) {
                throw new NoiseError("device_not_authorized", "Device is unknown or revoked");
              }
              options.deviceStore.touchLastSeen(found.deviceId);
              admittedDevice = found;
              return Buffer.from(
                JSON.stringify({ deviceId: found.deviceId, scopes: found.scopes }),
                "utf8",
              );
            },
          });
          const dev = admittedDevice!;
          mux = new RelayMux({
            role: "host",
            session,
            sendWire: (wire) => channel.sendEncryptedBinary(wire),
            handlers: options.handlers,
            deviceId: dev.deviceId,
            ...(options.initialWindowBytes !== undefined
              ? { initialWindowBytes: options.initialWindowBytes }
              : {}),
            onProtocolError: () => {
              dispose();
              channel.rejectSession("Encrypted record error");
            },
          });
          activeMuxes.add(mux);
          untrack = options.deviceStore.trackLiveSession(dev.deviceId, () => {
            dispose();
            channel.rejectSession("Device revoked");
          });
          channel.sendHandshakeText(
            JSON.stringify({ type: "ik_ready", message: toBase64Url(message2) }),
          );
          return;
        }

        channel.rejectSession("Unsupported handshake type");
      } catch (err) {
        dispose();
        channel.rejectSession(err instanceof Error ? err.message : "Handshake failed");
      }
    },
    onBinary(wire: Uint8Array) {
      if (!mux) {
        channel.rejectSession("Encrypted frame before Noise_IK session");
        return;
      }
      mux.receiveWire(wire);
    },
    dispose,
  };
}

export async function startHostRelayConnector(
  options: HostConnectorOptions,
): Promise<RunningHostConnector> {
  const activeMuxes = new Set<RelayMux>();
  let relayWs: MinimalWebSocket | null = null;
  let directServer: http.Server | null = null;
  let directUrl: string | undefined;

  if (options.relayUrl) {
    const ws = await connectWebSocket(options.relayUrl);
    relayWs = ws;
    const sessions = new Map<string, ReturnType<typeof attachHostSessionAdmission>>();

    await new Promise<void>((resolve, reject) => {
      let registered = false;
      ws.onText((text) => {
        const msg = parseObject(text);
        if (!msg) return;
        if (!registered && msg.type === "host_registered") {
          registered = true;
          resolve();
          return;
        }
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : "";
        if (msg.type === "session_open" && sid) {
          const handler = attachHostSessionAdmission(
            {
              sendHandshakeText: (jsonText) =>
                ws.sendText(
                  JSON.stringify({ type: "session_text", sessionId: sid, payload: jsonText }),
                ),
              sendEncryptedBinary: (wire) => {
                const sidBytes = Buffer.from(sid, "ascii");
                const out = new Uint8Array(1 + sidBytes.byteLength + wire.byteLength);
                out[0] = sidBytes.byteLength;
                out.set(sidBytes, 1);
                out.set(wire, 1 + sidBytes.byteLength);
                ws.sendBinary(out);
              },
              rejectSession: (reason) => {
                sessions.delete(sid);
                ws.sendText(JSON.stringify({ type: "session_reject", sessionId: sid, reason }));
              },
            },
            options,
            activeMuxes,
          );
          sessions.set(sid, handler);
        } else if (msg.type === "session_text" && sid && typeof msg.payload === "string") {
          sessions.get(sid)?.onHandshakeText(msg.payload);
        } else if (msg.type === "session_close" && sid) {
          sessions.get(sid)?.dispose();
          sessions.delete(sid);
        }
      });
      ws.onBinary((bytes) => {
        if (bytes.byteLength < 2) return;
        const sidLen = bytes[0] ?? 0;
        if (bytes.byteLength < 1 + sidLen) return;
        const sid = Buffer.from(bytes.subarray(1, 1 + sidLen)).toString("ascii");
        sessions.get(sid)?.onBinary(bytes.subarray(1 + sidLen));
      });
      ws.onClose((code, reason) => {
        for (const s of sessions.values()) s.dispose();
        sessions.clear();
        if (!registered) reject(new Error(`Relay registration closed (${code}: ${reason})`));
      });
      ws.sendText(JSON.stringify({ type: "host_register", routeId: options.routeId }));
    });
  }

  if (options.directListenPort !== undefined) {
    const bindHost = options.directListenHost ?? "127.0.0.1";
    const srv = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    directServer = srv;
    srv.on("upgrade", (req, socket, head) => {
      const ws = upgradeServerSocket(req, socket, head, {
        maxFrameBytes: 2 * 1024 * 1024,
        maxOutboundQueueBytes: 8 * 1024 * 1024,
      });
      if (!ws) return;
      const admission = attachHostSessionAdmission(
        {
          sendHandshakeText: (jsonText) => ws.sendText(jsonText),
          sendEncryptedBinary: (wire) => ws.sendBinary(wire),
          rejectSession: (reason) => ws.close(4003, reason),
        },
        options,
        activeMuxes,
      );
      ws.onText((t) => admission.onHandshakeText(t));
      ws.onBinary((b) => admission.onBinary(b));
      ws.onClose(() => admission.dispose());
    });
    await new Promise<void>((resolve) => srv.listen(options.directListenPort, bindHost, resolve));
    const addr = srv.address() as net.AddressInfo;
    directUrl = `ws://${bindHost}:${addr.port}/direct`;
  }

  return {
    ...(directUrl ? { directUrl } : {}),
    broadcastHostSleeping(reason = "suspend") {
      const at = new Date().toISOString();
      for (const mux of activeMuxes) mux.notifyHostSleeping(reason, at);
    },
    async close() {
      for (const mux of [...activeMuxes]) mux.close();
      activeMuxes.clear();
      relayWs?.close(1000, "Host stopping");
      if (directServer) {
        await new Promise<void>((resolve) => directServer!.close(() => resolve()));
      }
    },
  };
}

async function openClientTransportChannel(options: {
  directUrls: readonly string[];
  relayUrl: string;
  routeId: string;
}): Promise<{ ws: MinimalWebSocket; mode: "direct" | "relay" }> {
  const chosen = await selectCandidateTransportUrl({
    directUrls: options.directUrls,
    relayUrl: options.relayUrl,
  });
  const ws = await connectWebSocket(chosen.url);
  if (chosen.mode === "direct") {
    return { ws, mode: "direct" };
  }
  await new Promise<void>((resolve, reject) => {
    let connected = false;
    ws.onText((text) => {
      if (connected) return;
      const msg = parseObject(text);
      if (!msg) return;
      if (msg.type === "client_connected") {
        connected = true;
        resolve();
      } else if (msg.type === "relay_error") {
        reject(
          new Error(`Relay rejected client: ${typeof msg.reason === "string" ? msg.reason : "unknown"}`),
        );
      }
    });
    ws.onClose((code, reason) => {
      if (!connected) reject(new Error(`Relay closed before pairing (${code}: ${reason})`));
    });
    ws.sendText(JSON.stringify({ type: "client_connect", routeId: options.routeId }));
  });
  return { ws, mode: "relay" };
}

/**
 * Pairs a phone using a parsed `#fragment` QR offer (`Noise_NK`) and registers `deviceKeypair`.
 */
export async function pairPhoneWithOffer(options: {
  offer: ParsedPairingOffer;
  deviceKeypair: X25519Keypair;
  deviceName: string;
  platform: "ios" | "android" | "other";
}): Promise<{ deviceId: string; connId: string; scopes: string[]; mode: "direct" | "relay" }> {
  const { ws, mode } = await openClientTransportChannel({
    directUrls: options.offer.directUrls,
    relayUrl: options.offer.relayUrl,
    routeId: options.offer.routeId,
  });

  try {
    const reqJson = Buffer.from(
      JSON.stringify({
        pairSecret: toBase64Url(options.offer.pairSecret),
        deviceStaticPub: toBase64Url(options.deviceKeypair.publicKey),
        deviceName: options.deviceName,
        platform: options.platform,
      }),
      "utf8",
    );
    const { message1, state } = startNkInitiator({
      responderStaticPublicKey: options.offer.hostPublicKey,
      prologue: LUMENBOX_RELAY_PROLOGUE,
      payload: reqJson,
    });

    const reply = await new Promise<{ deviceId: string; connId: string; scopes: string[] }>(
      (resolve, reject) => {
        let done = false;
        ws.onText((text) => {
          if (done) return;
          try {
            const env = parseObject(text);
            if (env?.type !== "pair_ready" || typeof env.message !== "string" || !env.message) return;
            done = true;
            const { payload, session } = state.completeMessage2(fromBase64Url(env.message));
            session.destroy();
            const replyObj = parseObject(Buffer.from(payload).toString("utf8"));
            if (!replyObj || typeof replyObj.deviceId !== "string" || typeof replyObj.connId !== "string") {
              throw new Error("Invalid pairing response payload");
            }
            resolve({
              deviceId: replyObj.deviceId,
              connId: replyObj.connId,
              scopes: Array.isArray(replyObj.scopes)
                ? replyObj.scopes.filter((s): s is string => typeof s === "string")
                : [],
            });
          } catch (err) {
            done = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        ws.onClose((code, reason) => {
          if (!done) {
            done = true;
            reject(new Error(`Pairing closed (${code}: ${reason})`));
          }
        });
        ws.sendText(JSON.stringify({ type: "pair_hello", message: toBase64Url(message1) }));
      },
    );
    return { ...reply, mode };
  } finally {
    ws.close(1000, "Pairing finished");
  }
}

export interface ConnectedPhoneSession {
  readonly mux: RelayMux;
  readonly deviceId: string;
  readonly scopes: readonly string[];
  readonly mode: "direct" | "relay";
  close(): void;
  onClose(fn: (code: number, reason: string) => void): void;
}

/**
 * Connects a previously paired phone using `Noise_IK_25519_ChaChaPoly_SHA256` (mutual zero-knowledge
 * authentication) over the best reachable candidate path (`direct` preferred, `relay` fallback).
 */
export async function connectPhoneIk(options: {
  hostPublicKey: Uint8Array;
  deviceKeypair: X25519Keypair;
  relayUrl: string;
  routeId: string;
  directUrls?: readonly string[];
  initialWindowBytes?: number;
  onHostSleeping?: (info: { at: string; reason: string }) => void;
}): Promise<ConnectedPhoneSession> {
  const { ws, mode } = await openClientTransportChannel({
    directUrls: options.directUrls ?? [],
    relayUrl: options.relayUrl,
    routeId: options.routeId,
  });

  const { message1, state } = startIkInitiator({
    initiatorStaticKeypair: options.deviceKeypair,
    responderStaticPublicKey: options.hostPublicKey,
    prologue: LUMENBOX_RELAY_PROLOGUE,
  });

  const established = await new Promise<{
    mux: RelayMux;
    deviceId: string;
    scopes: string[];
  }>((resolve, reject) => {
    let ready = false;
    ws.onText((text) => {
      if (ready) return;
      try {
        const env = parseObject(text);
        if (!env) return;
        if (env.type === "host_offline") {
          ready = true;
          reject(new Error("Host offline"));
          return;
        }
        if (env.type !== "ik_ready" || typeof env.message !== "string" || !env.message) return;
        ready = true;
        const { payload, session } = state.completeMessage2(fromBase64Url(env.message));
        const infoObj = parseObject(Buffer.from(payload).toString("utf8"));
        if (!infoObj || typeof infoObj.deviceId !== "string") {
          throw new Error("Invalid Noise_IK server admission payload");
        }
        const info = {
          deviceId: infoObj.deviceId,
          scopes: Array.isArray(infoObj.scopes)
            ? infoObj.scopes.filter((s): s is string => typeof s === "string")
            : [],
        };
        const mux = new RelayMux({
          role: "client",
          session,
          sendWire: (wire) => ws.sendBinary(wire),
          ...(options.initialWindowBytes !== undefined
            ? { initialWindowBytes: options.initialWindowBytes }
            : {}),
          ...(options.onHostSleeping ? { onHostSleeping: options.onHostSleeping } : {}),
          onProtocolError: () => ws.close(4003, "Client record decryption failed"),
        });
        ws.onBinary((b) => mux.receiveWire(b));
        ws.onClose((_c, r) => mux.close(new Error(r || "Transport closed")));
        resolve({ mux, deviceId: info.deviceId, scopes: info.scopes });
      } catch (err) {
        ready = true;
        ws.close(4003, "Handshake verification failed");
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.onClose((code, reason) => {
      if (!ready) {
        ready = true;
        reject(new Error(`Noise_IK rejected (${code}: ${reason})`));
      }
    });
    ws.sendText(JSON.stringify({ type: "ik_hello", message: toBase64Url(message1) }));
  });

  return {
    mux: established.mux,
    deviceId: established.deviceId,
    scopes: established.scopes,
    mode,
    close: () => {
      established.mux.close();
      ws.close(1000, "Client closed");
    },
    onClose: (fn) => ws.onClose(fn),
  };
}
