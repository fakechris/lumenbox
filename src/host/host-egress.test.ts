/** The host egress proxy (INV-1344): listens on loopback, speaks to the relay, carries the call token. */

import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { decodeRequest, encodeResponse } from "../egress/protocol.ts";
import { callEnvironment } from "../egress/call.ts";
import { startHostEgress } from "./host-egress.ts";

test("a host command's HTTP proxy request reaches the relay as a stream carrying its call token", async () => {
  const seen: { host: string; port: number; call?: string }[] = [];
  const relay = createServer(socket => {
    let head = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const decoded = decodeRequest(head);
      if (!decoded) return;
      seen.push({ host: decoded.request.host, port: decoded.request.port, ...(decoded.request.call !== undefined ? { call: decoded.request.call } : {}) });
      socket.end(encodeResponse(false, "not allowed"));
    });
  });
  await new Promise<void>(resolve => relay.listen(0, "127.0.0.1", resolve));
  const relayPort = (relay.address() as { port: number }).port;
  const egress = await startHostEgress({ relay: `127.0.0.1:${relayPort}`, token: "relay-token-1234567890", mirror: false });
  try {
    assert.ok(egress.port > 0);
    const token = "dGVzdC1jYWxs";
    const release = egress.calls.begin(token);
    const env = callEnvironment(token, egress.port);
    const auth = Buffer.from(`call:${token}`).toString("base64");
    const answer = await new Promise<string>(resolve => {
      let text = "";
      const socket = connect(egress.port, "127.0.0.1", () => socket.write(`CONNECT vendor.test:443 HTTP/1.1\r\nHost: vendor.test:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`));
      socket.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    release();
    assert.match(env.HTTPS_PROXY!, new RegExp(`127\\.0\\.0\\.1:${egress.port}`));
    assert.deepEqual(seen, [{ host: "vendor.test", port: 443, call: token }], "the relay saw the host and the call");
    assert.match(answer, /502|403|not allowed/i, "the relay's refusal comes back to the client");
  } finally {
    egress.close();
    relay.close();
  }
});
