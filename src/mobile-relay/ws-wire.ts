/**
 * Minimal RFC 6455 WebSocket upgrade and frame codec over Node's `net`/`http` (zero dependencies).
 */

import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface MinimalWebSocket {
  readonly isOpen: boolean;
  readonly queuedBytes: number;
  sendText(text: string): boolean;
  sendBinary(bytes: Uint8Array): boolean;
  close(code?: number, reason?: string): void;
  onText(fn: (text: string) => void): void;
  onBinary(fn: (bytes: Uint8Array) => void): void;
  onClose(fn: (code: number, reason: string) => void): void;
  onError(fn: (err: Error) => void): void;
}

function encodeWsFrame(opcode: number, payload: Uint8Array, mask: boolean): Buffer {
  const len = payload.byteLength;
  const headerLen = 2 + (len < 126 ? 0 : len <= 0xffff ? 2 : 8) + (mask ? 4 : 0);
  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  let pos = 2;
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) {
    frame[1] = maskBit | len;
  } else if (len <= 0xffff) {
    frame[1] = maskBit | 126;
    frame.writeUInt16BE(len, 2);
    pos = 4;
  } else {
    frame[1] = maskBit | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    pos = 10;
  }
  if (mask) {
    const maskKey = randomBytes(4);
    maskKey.copy(frame, pos);
    pos += 4;
    for (let i = 0; i < len; i++) {
      frame[pos + i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
    }
  } else {
    frame.set(payload, pos);
  }
  return frame;
}

export function attachWebSocket(
  socket: Duplex,
  options: {
    isClient: boolean;
    maxFrameBytes: number;
    maxOutboundQueueBytes: number;
    initialBuffer?: Buffer;
  },
): MinimalWebSocket {
  let open = true;
  let rxBuf: Buffer = options.initialBuffer ? Buffer.from(options.initialBuffer) : Buffer.alloc(0);
  const textListeners: Array<(t: string) => void> = [];
  const binListeners: Array<(b: Uint8Array) => void> = [];
  const closeListeners: Array<(code: number, reason: string) => void> = [];
  const errListeners: Array<(err: Error) => void> = [];

  const emitClose = (code: number, reason: string) => {
    if (!open) return;
    open = false;
    socket.destroy();
    for (const fn of closeListeners) fn(code, reason);
  };

  const writeRaw = (frame: Buffer): boolean => {
    if (!open) return false;
    const netSock = socket as net.Socket;
    const buffered = typeof netSock.writableLength === "number" ? netSock.writableLength : 0;
    if (buffered + frame.byteLength > options.maxOutboundQueueBytes) {
      emitClose(1009, "Outbound queue ceiling exceeded");
      return false;
    }
    socket.write(frame);
    return true;
  };

  const parseFrames = () => {
    while (open && rxBuf.byteLength >= 2) {
      const b0 = rxBuf[0] ?? 0;
      const b1 = rxBuf[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let headerLen = 2;

      if (!fin) {
        emitClose(1002, "Fragmented WebSocket frames are not supported");
        return;
      }
      if (!options.isClient && !masked) {
        emitClose(1002, "Client frames must be masked");
        return;
      }

      if (payloadLen === 126) {
        if (rxBuf.byteLength < 4) return;
        payloadLen = rxBuf.readUInt16BE(2);
        headerLen = 4;
      } else if (payloadLen === 127) {
        if (rxBuf.byteLength < 10) return;
        const big = rxBuf.readBigUInt64BE(2);
        if (big > BigInt(options.maxFrameBytes)) {
          emitClose(1009, "Frame exceeds maximum size");
          return;
        }
        payloadLen = Number(big);
        headerLen = 10;
      }

      if (payloadLen > options.maxFrameBytes) {
        emitClose(1009, "Frame exceeds maximum size");
        return;
      }

      const maskLen = masked ? 4 : 0;
      const totalFrameLen = headerLen + maskLen + payloadLen;
      if (rxBuf.byteLength < totalFrameLen) return;

      const payload = Buffer.from(rxBuf.subarray(headerLen + maskLen, totalFrameLen));
      if (masked) {
        const maskKey = rxBuf.subarray(headerLen, headerLen + 4);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = (payload[i] ?? 0) ^ (maskKey[i & 3] ?? 0);
        }
      }
      rxBuf = rxBuf.subarray(totalFrameLen);

      if (opcode === 0x01) {
        const text = payload.toString("utf8");
        for (const fn of textListeners) fn(text);
      } else if (opcode === 0x02) {
        const copy = new Uint8Array(payload);
        for (const fn of binListeners) fn(copy);
      } else if (opcode === 0x08) {
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : 1000;
        const reason = payload.byteLength > 2 ? payload.subarray(2).toString("utf8") : "";
        if (open) {
          const reply = Buffer.allocUnsafe(2);
          reply.writeUInt16BE(code, 0);
          socket.write(encodeWsFrame(0x08, reply, options.isClient));
        }
        emitClose(code, reason);
        return;
      } else if (opcode === 0x09) {
        writeRaw(encodeWsFrame(0x0a, payload, options.isClient));
      } else if (opcode !== 0x0a) {
        emitClose(1002, "Unsupported opcode");
        return;
      }
    }
  };

  socket.on("data", (chunk: Buffer) => {
    if (!open) return;
    if (rxBuf.byteLength + chunk.byteLength > options.maxFrameBytes + 64) {
      emitClose(1009, "Receive buffer exceeded");
      return;
    }
    rxBuf = rxBuf.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([rxBuf, chunk]);
    parseFrames();
  });
  socket.on("close", () => emitClose(1006, "Socket closed"));
  socket.on("end", () => emitClose(1000, "Socket ended"));
  socket.on("error", (err: Error) => {
    for (const fn of errListeners) fn(err);
    emitClose(1006, err.message);
  });

  if (rxBuf.byteLength > 0) queueMicrotask(parseFrames);

  return {
    get isOpen() {
      return open;
    },
    get queuedBytes() {
      const netSock = socket as net.Socket;
      return typeof netSock.writableLength === "number" ? netSock.writableLength : 0;
    },
    sendText(text: string) {
      return writeRaw(encodeWsFrame(0x01, Buffer.from(text, "utf8"), options.isClient));
    },
    sendBinary(bytes: Uint8Array) {
      return writeRaw(encodeWsFrame(0x02, bytes, options.isClient));
    },
    close(code = 1000, reason = "") {
      if (!open) return;
      const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 120);
      const body = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
      body.writeUInt16BE(code, 0);
      reasonBytes.copy(body, 2);
      try {
        socket.write(encodeWsFrame(0x08, body, options.isClient));
      } catch {}
      emitClose(code, reason);
    },
    onText: (fn) => textListeners.push(fn),
    onBinary: (fn) => binListeners.push(fn),
    onClose: (fn) => closeListeners.push(fn),
    onError: (fn) => errListeners.push(fn),
  };
}

export async function connectWebSocket(
  wsUrl: string,
  options?: {
    headers?: Record<string, string>;
    maxFrameBytes?: number;
    maxOutboundQueueBytes?: number;
    timeoutMs?: number;
  },
): Promise<MinimalWebSocket> {
  const url = new URL(wsUrl);
  if (url.protocol !== "ws:") {
    throw new Error(`connectWebSocket supports ws:// in local runtime; got ${url.protocol}`);
  }
  const port = url.port ? Number(url.port) : 80;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + WS_GUID).digest("base64");

  return new Promise<MinimalWebSocket>((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let settled = false;
    let buf = Buffer.alloc(0);

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err);
    };

    sock.setTimeout(options?.timeoutMs ?? 5_000, () => fail(new Error("WebSocket connect timeout")));
    sock.once("error", fail);
    sock.once("connect", () => {
      sock.setTimeout(0);
      const pathAndQuery = `${url.pathname || "/"}${url.search}`;
      const extraHeaders = Object.entries(options?.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("");
      const req =
        `GET ${pathAndQuery} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${key}\r\n` +
        "Sec-WebSocket-Version: 13\r\n" +
        `${extraHeaders}\r\n`;
      sock.write(req);
    });

    const onHandshakeData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (buf.byteLength > 16 * 1024) fail(new Error("Oversized HTTP upgrade response"));
        return;
      }
      sock.removeListener("data", onHandshakeData);
      sock.removeListener("error", fail);
      const head = buf.subarray(0, headerEnd).toString("latin1");
      const leftover = buf.subarray(headerEnd + 4);
      const statusLine = head.split("\r\n")[0] ?? "";
      if (!statusLine.startsWith("HTTP/1.1 101 ")) {
        fail(new Error(`WebSocket upgrade rejected: ${statusLine}`));
        return;
      }
      const acceptMatch = /^sec-websocket-accept:\s*(.+)$/im.exec(head);
      if (!acceptMatch || acceptMatch[1]?.trim() !== expectedAccept) {
        fail(new Error("Invalid Sec-WebSocket-Accept header"));
        return;
      }
      settled = true;
      resolve(
        attachWebSocket(sock, {
          isClient: true,
          maxFrameBytes: options?.maxFrameBytes ?? 2 * 1024 * 1024,
          maxOutboundQueueBytes: options?.maxOutboundQueueBytes ?? 8 * 1024 * 1024,
          initialBuffer: leftover,
        }),
      );
    };
    sock.on("data", onHandshakeData);
  });
}

export function upgradeServerSocket(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { maxFrameBytes: number; maxOutboundQueueBytes: number },
): MinimalWebSocket | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || key.length === 0) {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key.trim() + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return attachWebSocket(socket, {
    isClient: false,
    maxFrameBytes: options.maxFrameBytes,
    maxOutboundQueueBytes: options.maxOutboundQueueBytes,
    initialBuffer: head,
  });
}
