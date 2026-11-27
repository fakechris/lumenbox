/**
 * Credit-based stream multiplexer over an authenticated Noise session (docs/109 §3.2).
 *
 * Carries three kinds of traffic over one encrypted socket without exposing local ports:
 * 1. Virtual `/api/v1/*` HTTP request/response calls (including request/response bodies);
 * 2. Server-pushed event streams (`/api/v1/events`, `/api/v1/conversations/{id}/stream`);
 * 3. Read-only desktop binary streams (`/vnc-ro/`).
 *
 * Each data stream starts with a bounded receive window (`initialWindowBytes`, default 256 KiB).
 * A sender pauses only the stream whose credit hits zero until the peer consumes bytes and returns
 * a `window_update` control frame, so a multi-megabyte deliverable download or desktop stream never
 * blocks concurrent `POST /stop` or approval requests on other streams.
 */

import type { NoiseSession } from "./noise.ts";
import {
  DEFAULT_MAX_RECORD_BYTES,
  type DecodedRecord,
  RECORD_KIND_BINARY,
  RECORD_KIND_CONTROL,
  RECORD_KIND_TEXT,
  type RecordKind,
  openRecord,
  sealRecord,
} from "./records.ts";

export const DEFAULT_INITIAL_WINDOW_BYTES = 256 * 1024;
const CONTROL_STREAM_ID = 0;

export interface VirtualHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
}

export interface VirtualHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array | AsyncIterable<Uint8Array>;
}

export type StreamTarget = "events" | "conversation-stream" | "vnc-ro";

export interface VirtualStreamRequest {
  readonly target: StreamTarget;
  readonly path: string;
  readonly headers?: Record<string, string>;
}

export interface DuplexRelayStream {
  readonly streamId: number;
  send(chunk: Uint8Array, binary?: boolean): Promise<void>;
  close(): void;
  onData(listener: (chunk: Uint8Array, binary: boolean) => void): void;
  onClose(listener: (reason?: string) => void): void;
}

export interface HostMuxHandlers {
  onHttpRequest?(req: VirtualHttpRequest, meta: { deviceId?: string }): Promise<VirtualHttpResponse>;
  onOpenStream?(
    req: VirtualStreamRequest,
    stream: DuplexRelayStream,
    meta: { deviceId?: string },
  ): Promise<void> | void;
}

type ControlFrame =
  | {
      type: "http_request";
      streamId: number;
      method: string;
      path: string;
      headers: Record<string, string>;
      hasBody: boolean;
    }
  | {
      type: "http_response";
      streamId: number;
      status: number;
      headers: Record<string, string>;
      hasBody: boolean;
    }
  | { type: "stream_end"; streamId: number }
  | { type: "stream_reset"; streamId: number; error: string }
  | {
      type: "stream_open";
      streamId: number;
      target: StreamTarget;
      path: string;
      headers?: Record<string, string>;
    }
  | { type: "stream_opened"; streamId: number }
  | { type: "window_update"; streamId: number; deltaBytes: number }
  | { type: "host_sleeping"; at: string; reason: string };

interface OutboundCredit {
  available: number;
  waiters: Array<() => void>;
  closed: boolean;
}

interface PendingHttpCall {
  status?: number;
  headers?: Record<string, string>;
  chunks: Uint8Array[];
  resolve: (res: { status: number; headers: Record<string, string>; body: Uint8Array }) => void;
  reject: (err: Error) => void;
}

interface ActiveStreamState {
  dataListeners: Array<(chunk: Uint8Array, binary: boolean) => void>;
  closeListeners: Array<(reason?: string) => void>;
  earlyChunks: Array<{ chunk: Uint8Array; binary: boolean }>;
  closed: boolean;
  closedReason?: string;
  openedResolve?: () => void;
  openedReject?: (err: Error) => void;
}

export interface RelayMuxOptions {
  readonly role: "client" | "host";
  readonly session: NoiseSession;
  readonly sendWire: (wire: Uint8Array) => void;
  readonly handlers?: HostMuxHandlers;
  readonly deviceId?: string;
  readonly initialWindowBytes?: number;
  readonly maxRecordBytes?: number;
  readonly onHostSleeping?: (info: { at: string; reason: string }) => void;
  readonly onProtocolError?: (err: Error) => void;
}

export class RelayMux {
  private readonly role: "client" | "host";
  private readonly session: NoiseSession;
  private readonly sendWire: (wire: Uint8Array) => void;
  private readonly handlers: HostMuxHandlers | undefined;
  private readonly deviceId: string | undefined;
  private readonly initialWindowBytes: number;
  private readonly maxRecordBytes: number;
  private readonly onHostSleeping: ((info: { at: string; reason: string }) => void) | undefined;
  private readonly onProtocolError: ((err: Error) => void) | undefined;

  private nextStreamId: number;
  private closed = false;
  private readonly credits = new Map<number, OutboundCredit>();
  private readonly pendingHttp = new Map<number, PendingHttpCall>();
  private readonly inboundHttpReq = new Map<
    number,
    { method: string; path: string; headers: Record<string, string>; chunks: Uint8Array[] }
  >();
  private readonly streams = new Map<number, ActiveStreamState>();

  constructor(options: RelayMuxOptions) {
    this.role = options.role;
    this.session = options.session;
    this.sendWire = options.sendWire;
    this.handlers = options.handlers;
    this.deviceId = options.deviceId;
    this.initialWindowBytes = options.initialWindowBytes ?? DEFAULT_INITIAL_WINDOW_BYTES;
    this.maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.onHostSleeping = options.onHostSleeping;
    this.onProtocolError = options.onProtocolError;
    this.nextStreamId = options.role === "client" ? 1 : 2;
  }

  private allocateStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 2;
    return id;
  }

  private creditFor(streamId: number): OutboundCredit {
    let entry = this.credits.get(streamId);
    if (!entry) {
      entry = { available: this.initialWindowBytes, waiters: [], closed: false };
      this.credits.set(streamId, entry);
    }
    return entry;
  }

  private sendControl(frame: ControlFrame): void {
    if (this.closed) return;
    const payload = Buffer.from(JSON.stringify(frame), "utf8");
    const wire = sealRecord(
      this.session.send,
      { kind: RECORD_KIND_CONTROL, streamId: CONTROL_STREAM_ID, payload },
      this.maxRecordBytes,
    );
    this.sendWire(wire);
  }

  /** Sends data on `streamId`, slicing to respect per-stream credit so other streams never stall. */
  private async sendFlowControlled(streamId: number, data: Uint8Array, kind: RecordKind): Promise<void> {
    const credit = this.creditFor(streamId);
    let offset = 0;
    if (data.byteLength === 0) return;

    while (offset < data.byteLength) {
      if (this.closed || credit.closed) {
        throw new Error(`Stream ${streamId} closed while sending`);
      }
      if (credit.available <= 0) {
        await new Promise<void>((resolve) => credit.waiters.push(resolve));
        continue;
      }
      const step = Math.min(credit.available, data.byteLength - offset, 32 * 1024);
      credit.available -= step;
      const chunk = data.subarray(offset, offset + step);
      offset += step;
      const wire = sealRecord(this.session.send, { kind, streamId, payload: chunk }, this.maxRecordBytes);
      this.sendWire(wire);
    }
  }

  /** Emits an immediate `host_sleeping` control notice before macOS suspends sockets (docs/109 §3.3). */
  notifyHostSleeping(reason = "suspend", at = new Date().toISOString()): void {
    this.sendControl({ type: "host_sleeping", at, reason });
  }

  /** Executes a virtual `/api/v1/*` HTTP request over the encrypted multiplex channel. */
  async request(req: VirtualHttpRequest): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
  }> {
    if (this.closed) throw new Error("Multiplexer is closed");
    const streamId = this.allocateStreamId();
    this.creditFor(streamId);
    const hasBody = Boolean(req.body && req.body.byteLength > 0);

    const responsePromise = new Promise<{
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    }>((resolve, reject) => {
      this.pendingHttp.set(streamId, { chunks: [], resolve, reject });
    });

    this.sendControl({
      type: "http_request",
      streamId,
      method: req.method,
      path: req.path,
      headers: req.headers,
      hasBody,
    });

    if (hasBody && req.body) {
      await this.sendFlowControlled(streamId, req.body, RECORD_KIND_BINARY);
      this.sendControl({ type: "stream_end", streamId });
    }

    return responsePromise;
  }

  /** Opens a duplex stream (`events`, `conversation-stream`, or `vnc-ro` read-only desktop stream). */
  async openStream(req: VirtualStreamRequest): Promise<DuplexRelayStream> {
    if (this.closed) throw new Error("Multiplexer is closed");
    const streamId = this.allocateStreamId();
    this.creditFor(streamId);

    const state: ActiveStreamState = {
      dataListeners: [],
      closeListeners: [],
      earlyChunks: [],
      closed: false,
    };
    const opened = new Promise<void>((resolve, reject) => {
      state.openedResolve = resolve;
      state.openedReject = reject;
    });
    this.streams.set(streamId, state);
    this.sendControl({
      type: "stream_open",
      streamId,
      target: req.target,
      path: req.path,
      ...(req.headers ? { headers: req.headers } : {}),
    });
    await opened;
    return this.buildStreamHandle(streamId, state);
  }

  private buildStreamHandle(streamId: number, state: ActiveStreamState): DuplexRelayStream {
    return {
      streamId,
      send: async (chunk: Uint8Array, binary = true) => {
        await this.sendFlowControlled(
          streamId,
          chunk,
          binary ? RECORD_KIND_BINARY : RECORD_KIND_TEXT,
        );
      },
      close: () => {
        if (state.closed) return;
        state.closed = true;
        state.closedReason = "local_close";
        this.releaseStream(streamId);
        this.sendControl({ type: "stream_end", streamId });
        for (const fn of state.closeListeners) fn("local_close");
      },
      onData: (listener) => {
        state.dataListeners.push(listener);
        if (state.earlyChunks.length > 0) {
          const buffered = state.earlyChunks.splice(0, state.earlyChunks.length);
          for (const item of buffered) listener(item.chunk, item.binary);
        }
      },
      onClose: (listener) => {
        if (state.closed) {
          queueMicrotask(() => listener(state.closedReason));
          return;
        }
        state.closeListeners.push(listener);
      },
    };
  }

  /** Feeds one inbound encrypted wire record from the transport socket. */
  receiveWire(wire: Uint8Array): void {
    if (this.closed) return;
    let record: DecodedRecord;
    try {
      record = openRecord(this.session.receive, wire, this.maxRecordBytes);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.close(error);
      this.onProtocolError?.(error);
      return;
    }

    if (record.kind === RECORD_KIND_CONTROL) {
      this.handleControlPayload(record.payload);
      return;
    }

    const len = record.payload.byteLength;
    if (len > 0) {
      this.sendControl({ type: "window_update", streamId: record.streamId, deltaBytes: len });
    }

    const inReq = this.inboundHttpReq.get(record.streamId);
    if (inReq) {
      inReq.chunks.push(record.payload);
      return;
    }

    const pending = this.pendingHttp.get(record.streamId);
    if (pending) {
      pending.chunks.push(record.payload);
      return;
    }

    const stream = this.streams.get(record.streamId);
    if (stream && !stream.closed) {
      const isBinary = record.kind === RECORD_KIND_BINARY;
      if (stream.dataListeners.length === 0) {
        stream.earlyChunks.push({ chunk: record.payload, binary: isBinary });
      } else {
        for (const fn of stream.dataListeners) fn(record.payload, isBinary);
      }
    }
  }

  private handleControlPayload(payload: Uint8Array): void {
    let frame: ControlFrame;
    try {
      frame = JSON.parse(Buffer.from(payload).toString("utf8")) as ControlFrame;
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Invalid control JSON");
      this.close(error);
      this.onProtocolError?.(error);
      return;
    }

    switch (frame.type) {
      case "window_update": {
        if (!Number.isInteger(frame.deltaBytes) || frame.deltaBytes <= 0) return;
        const credit = this.creditFor(frame.streamId);
        credit.available += frame.deltaBytes;
        const waiters = credit.waiters.splice(0, credit.waiters.length);
        for (const wake of waiters) wake();
        break;
      }
      case "host_sleeping": {
        this.onHostSleeping?.({ at: frame.at, reason: frame.reason });
        break;
      }
      case "http_request": {
        if (this.role !== "host") return;
        this.creditFor(frame.streamId);
        if (!frame.hasBody) {
          void this.dispatchHttpRequest(frame.streamId, {
            method: frame.method,
            path: frame.path,
            headers: frame.headers,
          });
        } else {
          this.inboundHttpReq.set(frame.streamId, {
            method: frame.method,
            path: frame.path,
            headers: frame.headers,
            chunks: [],
          });
        }
        break;
      }
      case "http_response": {
        const pending = this.pendingHttp.get(frame.streamId);
        if (!pending) return;
        pending.status = frame.status;
        pending.headers = frame.headers;
        if (!frame.hasBody) {
          this.pendingHttp.delete(frame.streamId);
          this.releaseStream(frame.streamId);
          pending.resolve({ status: frame.status, headers: frame.headers, body: new Uint8Array(0) });
        }
        break;
      }
      case "stream_open": {
        if (this.role !== "host") return;
        this.creditFor(frame.streamId);
        const state: ActiveStreamState = {
      dataListeners: [],
      closeListeners: [],
      earlyChunks: [],
      closed: false,
    };
        this.streams.set(frame.streamId, state);
        const handle = this.buildStreamHandle(frame.streamId, state);
        if (!this.handlers?.onOpenStream) {
          this.releaseStream(frame.streamId);
          this.sendControl({ type: "stream_reset", streamId: frame.streamId, error: "streams_unsupported" });
          return;
        }
        this.sendControl({ type: "stream_opened", streamId: frame.streamId });
        Promise.resolve(
          this.handlers.onOpenStream(
            {
              target: frame.target,
              path: frame.path,
              ...(frame.headers ? { headers: frame.headers } : {}),
            },
            handle,
            { ...(this.deviceId ? { deviceId: this.deviceId } : {}) },
          ),
        ).catch((err) => {
          this.sendControl({
            type: "stream_reset",
            streamId: frame.streamId,
            error: err instanceof Error ? err.message : "stream_error",
          });
        });
        break;
      }
      case "stream_opened": {
        const stream = this.streams.get(frame.streamId);
        stream?.openedResolve?.();
        break;
      }
      case "stream_end": {
        const inReq = this.inboundHttpReq.get(frame.streamId);
        if (inReq) {
          this.inboundHttpReq.delete(frame.streamId);
          const body = new Uint8Array(Buffer.concat(inReq.chunks.map((c) => Buffer.from(c))));
          void this.dispatchHttpRequest(frame.streamId, {
            method: inReq.method,
            path: inReq.path,
            headers: inReq.headers,
            body,
          });
          return;
        }
        const pending = this.pendingHttp.get(frame.streamId);
        if (pending) {
          this.pendingHttp.delete(frame.streamId);
          this.releaseStream(frame.streamId);
          const body = new Uint8Array(Buffer.concat(pending.chunks.map((c) => Buffer.from(c))));
          pending.resolve({
            status: pending.status ?? 200,
            headers: pending.headers ?? {},
            body,
          });
          return;
        }
        const stream = this.streams.get(frame.streamId);
        if (stream && !stream.closed) {
          stream.closed = true;
          stream.closedReason = "peer_end";
          // Keep entry in `this.streams` only if earlyChunks remain unread so `onData`/`onClose` still drain cleanly
          if (stream.earlyChunks.length === 0) {
            this.releaseStream(frame.streamId);
          }
          for (const fn of stream.closeListeners) fn("peer_end");
        }
        break;
      }
      case "stream_reset": {
        const pending = this.pendingHttp.get(frame.streamId);
        if (pending) {
          this.pendingHttp.delete(frame.streamId);
          this.releaseStream(frame.streamId);
          pending.reject(new Error(frame.error));
        }
        const stream = this.streams.get(frame.streamId);
        if (stream) {
          stream.closed = true;
          stream.closedReason = frame.error;
          stream.openedReject?.(new Error(frame.error));
          this.releaseStream(frame.streamId);
          for (const fn of stream.closeListeners) fn(frame.error);
        }
        break;
      }
    }
  }

  private async dispatchHttpRequest(streamId: number, req: VirtualHttpRequest): Promise<void> {
    if (!this.handlers?.onHttpRequest) {
      this.sendControl({
        type: "http_response",
        streamId,
        status: 404,
        headers: { "content-type": "application/json" },
        hasBody: false,
      });
      this.releaseStream(streamId);
      return;
    }
    try {
      const res = await this.handlers.onHttpRequest(req, {
        ...(this.deviceId ? { deviceId: this.deviceId } : {}),
      });
      if (!res.body) {
        this.sendControl({
          type: "http_response",
          streamId,
          status: res.status,
          headers: res.headers,
          hasBody: false,
        });
        this.releaseStream(streamId);
        return;
      }
      if (res.body instanceof Uint8Array) {
        const hasBody = res.body.byteLength > 0;
        this.sendControl({
          type: "http_response",
          streamId,
          status: res.status,
          headers: res.headers,
          hasBody,
        });
        if (hasBody) {
          await this.sendFlowControlled(streamId, res.body, RECORD_KIND_BINARY);
          this.sendControl({ type: "stream_end", streamId });
        }
        this.releaseStream(streamId);
        return;
      }
      this.sendControl({
        type: "http_response",
        streamId,
        status: res.status,
        headers: res.headers,
        hasBody: true,
      });
      for await (const chunk of res.body) {
        if (chunk.byteLength > 0) {
          await this.sendFlowControlled(streamId, chunk, RECORD_KIND_BINARY);
        }
      }
      this.sendControl({ type: "stream_end", streamId });
      this.releaseStream(streamId);
    } catch (err) {
      this.sendControl({
        type: "stream_reset",
        streamId,
        error: err instanceof Error ? err.message : "handler_error",
      });
      this.releaseStream(streamId);
    }
  }

  private releaseStream(streamId: number): void {
    const credit = this.credits.get(streamId);
    if (credit) {
      credit.closed = true;
      const waiters = credit.waiters.splice(0, credit.waiters.length);
      for (const wake of waiters) wake();
      this.credits.delete(streamId);
    }
    this.streams.delete(streamId);
    this.inboundHttpReq.delete(streamId);
  }

  close(reason?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const err = reason ?? new Error("RelayMux closed");
    for (const [id, pending] of this.pendingHttp) {
      pending.reject(err);
      this.pendingHttp.delete(id);
    }
    for (const [id, stream] of this.streams) {
      stream.closed = true;
      stream.openedReject?.(err);
      for (const fn of stream.closeListeners) fn(err.message);
      this.streams.delete(id);
    }
    for (const [id, credit] of this.credits) {
      credit.closed = true;
      for (const wake of credit.waiters.splice(0)) wake();
      this.credits.delete(id);
    }
    this.session.destroy();
  }
}
