/**
 * The ACP session protocol between host and boxd (INV-1234, docs/81), split out of index.ts
 * when the architecture ratchet (INV-1225) asked that file to stop growing. Everything here is
 * re-exported from index.ts; import from either.
 */
/**
 * ACP sessions (INV-1234, docs/81): a delegated engine kept alive and spoken to over its stdio
 * JSON-RPC, through boxd. Requests from the host are answered as `response` events; requests
 * from the engine (a permission question) arrive as `request` events and are answered with
 * `/acp/reply`. Polled by sequence number, like `/xwatchdog/events`.
 */
export interface AcpOpenRequest {
  /** Minted by the host like a job id; the engine's own session id is a separate thing. */
  session_id: string;
  /** The command that ends up running the engine's ACP surface, as `bash -lc` runs it. */
  command: string;
  cwd: string;
  env?: Record<string, string>;
  display?: number;
  /** Name the engine's session to `session/load` it instead of `session/new`. */
  engine_session_id?: string;
  call?: string;
}

export interface AcpOpenResult {
  session_id: string;
  engine_session_id: string;
  loaded: boolean;
  pid: number;
  log_path: string;
}

export interface AcpSessionStatus {
  session_id: string;
  engine_session_id?: string;
  cwd: string;
  command: string;
  running: boolean;
  /** A record from before a boxd restart: no process, loadable by opening the same id again. */
  detached?: boolean;
  pid: number;
  started_at: string;
  ended_at?: string;
  exit_code?: number;
  log_path: string;
}

export interface AcpEvent {
  seq: number;
  at: string;
  kind: "update" | "request" | "response" | "exit" | "stderr" | "stdout";
  /** The JSON-RPC message, for update / request / response. */
  message?: Record<string, unknown>;
  /** A line that was not a message, or the exit note. */
  line?: string;
  exit_code?: number;
}

export interface AcpSendRequest {
  session_id: string;
  method: string;
  params?: unknown;
  /** A notification: no id, no response event. */
  notify?: boolean;
}

export interface AcpSendResult {
  /** The id the response event will carry; absent for a notification. */
  rpc_id?: number;
}

export interface AcpReplyRequest {
  session_id: string;
  /** The engine's own request id. */
  rpc_id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface AcpEventsRequest {
  session_id: string;
  /** Events after this sequence number; 0 for all kept. */
  since?: number;
  /** How long to wait for a first new event before answering empty. */
  timeout_ms?: number;
}

export interface AcpEventsResult {
  events: AcpEvent[];
  running: boolean;
  last_seq: number;
  engine_session_id?: string;
  exit_code?: number;
}

export interface AcpCloseRequest {
  session_id: string;
}
