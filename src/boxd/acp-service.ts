/**
 * ACP sessions: a delegated engine kept alive, spoken to, and asked about (INV-1234, docs/81).
 *
 * A job (job-service.ts) is a command with its stdin closed: started, then asked about. An
 * engine that speaks the Agent Client Protocol is the other shape — a child that stays up
 * between prompts and talks newline-delimited JSON-RPC 2.0 on its stdio, in both directions:
 * the host sends prompts, steers and cancels; the engine streams updates and sends requests
 * of its own, a permission question above all. So this is a second service rather than a
 * flag on the first: the process is held, the pipe is read, and everything that crossed it
 * is an event with a sequence number the host polls for (the same cursor shape as
 * `/xwatchdog/events`), because an HTTP request cannot hold a model turn open.
 *
 * What is kept on disk, beside the job logs: the raw lines both ways in `<id>.log`, and a
 * small record `<id>.acp.json` naming the engine's own session id and the working directory —
 * the two things `session/load` needs after a restart. Never the environment: the relay
 * credential arrives per open and is not written anywhere by this file.
 */
import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, type WriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type {
  AcpCloseRequest,
  AcpEvent,
  AcpEventsRequest,
  AcpEventsResult,
  AcpOpenRequest,
  AcpOpenResult,
  AcpReplyRequest,
  AcpSendRequest,
  AcpSendResult,
  AcpSessionStatus,
} from "../protocol/index.ts";
import { JOB_ID, JOBS_DIR } from "./job-service.ts";

/** How long the engine gets to answer `initialize` and `session/new` / `session/load`. */
const OPEN_TIMEOUT_MS = 60_000;
/** Events kept in memory per session; the log on disk has all of them. */
const EVENTS_KEPT = 5_000;
/** The longest a poll waits for a new event before answering empty. */
const POLL_CAP_MS = 120_000;
/** After a close, how long the engine gets to exit on SIGTERM before SIGKILL. */
const CLOSE_GRACE_MS = 3_000;

/** The capabilities the host declares: text only, no file or terminal delegation, mcode's extension notifications on. */
const CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  _meta: { "minimax-code/extensions": true },
};

export class AcpOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcpOpenError";
  }
}

interface Session {
  status: AcpSessionStatus;
  child: ChildProcessByStdio<Writable, Readable, Readable> | undefined;
  log: WriteStream | undefined;
  buffer: string;
  nextId: number;
  events: AcpEvent[];
  seq: number;
  /** Resolvers of polls waiting for the next event. */
  waiters: (() => void)[];
  /** Our own requests still unanswered: resolved by the matching response event. */
  pending: Map<number, { resolve: (message: Record<string, unknown>) => void; timer: NodeJS.Timeout }>;
}

interface RecordOnDisk {
  session_id: string;
  engine_session_id?: string;
  cwd: string;
  command: string;
  started_at: string;
}

export class AcpService {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly dir: string = JOBS_DIR) {
    this.recover();
  }

  /**
   * Records left by a boxd that stopped while sessions were open. The processes are gone (or
   * orphaned beyond reach); what survives is the engine's session id and its cwd, which is
   * exactly what the host needs to decide whether to `session/load` — so they are listed as
   * not running, with the record kept until the host opens the same id again or closes it.
   */
  private recover(): void {
    if (!existsSync(this.dir)) return;
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith(".acp.json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as RecordOnDisk;
        this.sessions.set(record.session_id, {
          status: {
            session_id: record.session_id,
            ...(record.engine_session_id !== undefined ? { engine_session_id: record.engine_session_id } : {}),
            cwd: record.cwd,
            command: record.command,
            running: false,
            detached: true,
            pid: -1,
            started_at: record.started_at,
            log_path: join(this.dir, `${record.session_id}.log`),
          },
          child: undefined,
          log: undefined,
          buffer: "",
          nextId: 1,
          events: [],
          seq: 0,
          waiters: [],
          pending: new Map(),
        });
      } catch {
        // An unreadable record is a session nobody can load; it is not worth failing startup over.
      }
    }
  }

  list(): AcpSessionStatus[] {
    return [...this.sessions.values()].map(session => ({ ...session.status }));
  }

  get(id: string): AcpSessionStatus | undefined {
    const session = this.sessions.get(id);
    return session === undefined ? undefined : { ...session.status };
  }

  /**
   * Spawns the engine, performs `initialize`, then `session/new` — or `session/load` when the
   * caller names the engine session it wants back. Returns only once the engine has answered
   * both; an engine that refuses (no credential, a cwd that does not match the persisted
   * session, an unknown id) fails the open definitely, with its own words.
   */
  async open(input: AcpOpenRequest & { nice: number; scrubbedEnv: NodeJS.ProcessEnv }): Promise<AcpOpenResult> {
    mkdirSync(this.dir, { recursive: true });
    if (!JOB_ID.test(input.session_id)) throw new AcpOpenError(`session_id must match ${JOB_ID}`);
    const existing = this.sessions.get(input.session_id);
    if (existing?.child !== undefined) {
      throw new AcpOpenError(`session ${input.session_id} is already open`);
    }
    const logPath = join(this.dir, `${input.session_id}.log`);
    const log = createWriteStream(logPath, { flags: "a" });
    const child = spawn(
      "nice",
      ["-n", String(input.nice), "/bin/bash", "-lc", input.command],
      {
        cwd: input.cwd,
        env: { ...input.scrubbedEnv, ...(input.display !== undefined ? { DISPLAY: `:${input.display}` } : {}), ...input.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      }
    );
    const session: Session = {
      status: {
        session_id: input.session_id,
        cwd: input.cwd,
        command: input.command,
        running: true,
        pid: child.pid ?? -1,
        started_at: new Date().toISOString(),
        log_path: logPath,
      },
      child,
      log,
      buffer: "",
      nextId: 1,
      events: [],
      seq: 0,
      waiters: [],
      pending: new Map(),
    };
    this.sessions.set(input.session_id, session);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => this.onData(session, String(chunk)));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        log.write(`stderr: ${line}\n`);
        this.push(session, { kind: "stderr", line: line.slice(0, 500) });
      }
    });
    child.on("error", error => this.ended(session, 127, `failed to start: ${error.message}`));
    child.on("close", code => this.ended(session, code ?? 1));

    try {
      await this.request(session, "initialize", { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES }, OPEN_TIMEOUT_MS);
      const loaded = input.engine_session_id !== undefined;
      const opened = loaded
        ? await this.request(session, "session/load", { sessionId: input.engine_session_id, cwd: input.cwd, mcpServers: [] }, OPEN_TIMEOUT_MS)
        : await this.request(session, "session/new", { cwd: input.cwd, mcpServers: [] }, OPEN_TIMEOUT_MS);
      const engineSessionId = loaded
        ? input.engine_session_id!
        : String((opened.result as { sessionId?: unknown } | undefined)?.sessionId ?? "");
      if (engineSessionId === "") throw new AcpOpenError("the engine answered session/new without a sessionId");
      session.status.engine_session_id = engineSessionId;
      this.writeRecord(session);
      return {
        session_id: input.session_id,
        engine_session_id: engineSessionId,
        loaded,
        pid: session.status.pid,
        log_path: logPath,
      };
    } catch (error) {
      // A failed open leaves nothing behind: no process, no record to load later.
      this.kill(session);
      this.sessions.delete(input.session_id);
      this.removeRecord(input.session_id);
      throw error instanceof AcpOpenError ? error : new AcpOpenError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Sends a request (answered later as a `response` event) or a notification (answered by nothing). */
  send(input: AcpSendRequest): AcpSendResult {
    const session = this.live(input.session_id);
    if (input.notify === true) {
      this.write(session, { jsonrpc: "2.0", method: input.method, ...(input.params !== undefined ? { params: input.params } : {}) });
      return {};
    }
    const id = session.nextId++;
    this.write(session, { jsonrpc: "2.0", id, method: input.method, ...(input.params !== undefined ? { params: input.params } : {}) });
    return { rpc_id: id };
  }

  /** Answers a request the engine sent (a permission question): the id is the engine's. */
  reply(input: AcpReplyRequest): void {
    const session = this.live(input.session_id);
    this.write(session, {
      jsonrpc: "2.0",
      id: input.rpc_id,
      ...(input.error !== undefined ? { error: input.error } : { result: input.result ?? {} }),
    });
  }

  /** Everything after `since`, waiting up to `timeout_ms` for the first new event. */
  async events(input: AcpEventsRequest): Promise<AcpEventsResult> {
    const session = this.sessions.get(input.session_id);
    if (session === undefined) return undefined as never;
    const since = input.since ?? 0;
    const fresh = () => session.events.filter(event => event.seq > since);
    let events = fresh();
    if (events.length === 0 && session.child !== undefined) {
      const wait = Math.min(Math.max(0, input.timeout_ms ?? 30_000), POLL_CAP_MS);
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => done(), wait);
        timer.unref?.();
        const done = () => {
          clearTimeout(timer);
          session.waiters = session.waiters.filter(waiter => waiter !== done);
          resolve();
        };
        session.waiters.push(done);
      });
      events = fresh();
    }
    return {
      events,
      running: session.child !== undefined,
      last_seq: session.seq,
      ...(session.status.engine_session_id !== undefined ? { engine_session_id: session.status.engine_session_id } : {}),
      ...(session.status.exit_code !== undefined ? { exit_code: session.status.exit_code } : {}),
    };
  }

  /** Ends the engine and forgets the session: nothing left to load. */
  async close(input: AcpCloseRequest): Promise<AcpSessionStatus | undefined> {
    const session = this.sessions.get(input.session_id);
    if (session === undefined) return undefined;
    if (session.child !== undefined) {
      const child = session.child;
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
      this.signal(child, "SIGTERM");
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          this.signal(child, "SIGKILL");
          resolve();
        }, CLOSE_GRACE_MS);
        timer.unref?.();
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.sessions.delete(input.session_id);
    this.removeRecord(input.session_id);
    return { ...session.status, running: false };
  }

  /** Every live engine told to stop; what boxd does on its own way out. */
  shutdown(): void {
    for (const session of this.sessions.values()) {
      if (session.child !== undefined) this.signal(session.child, "SIGTERM");
    }
  }

  private live(id: string): Session {
    const session = this.sessions.get(id);
    if (session === undefined) throw new AcpOpenError(`No ACP session ${id}`);
    if (session.child === undefined) throw new AcpOpenError(`ACP session ${id} is not running (open it again with its engine session to load it)`);
    return session;
  }

  private request(session: Session, method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new AcpOpenError(`${method} was not answered within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      session.pending.set(id, {
        resolve: message => {
          clearTimeout(timer);
          if (message.error !== undefined) {
            const error = message.error as { message?: unknown };
            reject(new AcpOpenError(`${method}: ${typeof error.message === "string" ? error.message : JSON.stringify(message.error)}`));
          } else resolve(message);
        },
        timer,
      });
      try {
        this.write(session, { jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(error);
      }
    });
  }

  private write(session: Session, message: Record<string, unknown>): void {
    if (session.child === undefined) throw new AcpOpenError(`ACP session ${session.status.session_id} is not running`);
    const line = JSON.stringify(message);
    session.log?.write(`>> ${line}\n`);
    session.child.stdin.write(`${line}\n`);
  }

  private onData(session: Session, chunk: string): void {
    session.buffer += chunk;
    let at = session.buffer.indexOf("\n");
    while (at >= 0) {
      const line = session.buffer.slice(0, at).trim();
      session.buffer = session.buffer.slice(at + 1);
      if (line !== "") this.onLine(session, line);
      at = session.buffer.indexOf("\n");
    }
  }

  private onLine(session: Session, line: string): void {
    session.log?.write(`${line}\n`);
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.push(session, { kind: "stdout", line: line.slice(0, 500) });
      return;
    }
    if (typeof message.method === "string") {
      // With an id it is the engine asking us something; without one, telling us something.
      this.push(session, message.id !== undefined ? { kind: "request", message } : { kind: "update", message });
      return;
    }
    if (typeof message.id === "number") {
      const waiting = session.pending.get(message.id);
      if (waiting !== undefined) {
        session.pending.delete(message.id);
        waiting.resolve(message);
        return;
      }
      this.push(session, { kind: "response", message });
      return;
    }
    this.push(session, { kind: "stdout", line: line.slice(0, 500) });
  }

  private push(session: Session, event: Omit<AcpEvent, "seq" | "at">): void {
    session.seq += 1;
    session.events.push({ seq: session.seq, at: new Date().toISOString(), ...event });
    if (session.events.length > EVENTS_KEPT) session.events.splice(0, session.events.length - EVENTS_KEPT);
    const waiters = session.waiters;
    session.waiters = [];
    for (const waiter of waiters) waiter();
  }

  private ended(session: Session, code: number, note?: string): void {
    if (session.child === undefined) return;
    session.child = undefined;
    session.status.running = false;
    session.status.exit_code = code;
    session.status.ended_at = new Date().toISOString();
    if (note !== undefined) session.log?.write(`${note}\n`);
    for (const [id, waiting] of session.pending) {
      session.pending.delete(id);
      waiting.resolve({ jsonrpc: "2.0", id, error: { code: -32000, message: note ?? `the engine exited (${code})` } });
    }
    this.push(session, { kind: "exit", exit_code: code, ...(note !== undefined ? { line: note } : {}) });
    session.log?.end();
    session.log = undefined;
    // A session already closed (its record removed, perhaps its directory gone) gets no new
    // record from its process's last breath; a record that cannot be written is logged, not thrown,
    // because this runs from the child's close event where nothing can catch it.
    if (!this.sessions.has(session.status.session_id)) return;
    try {
      this.writeRecord(session);
    } catch (error) {
      console.error(`[acp] ${session.status.session_id}: could not record the exit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private kill(session: Session): void {
    if (session.child !== undefined) this.signal(session.child, "SIGKILL");
  }

  private signal(child: ChildProcessByStdio<Writable, Readable, Readable>, signal: NodeJS.Signals): void {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  private writeRecord(session: Session): void {
    const record: RecordOnDisk = {
      session_id: session.status.session_id,
      ...(session.status.engine_session_id !== undefined ? { engine_session_id: session.status.engine_session_id } : {}),
      cwd: session.status.cwd,
      command: session.status.command,
      started_at: session.status.started_at,
    };
    const path = join(this.dir, `${session.status.session_id}.acp.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(record));
    renameSync(`${path}.tmp`, path);
  }

  private removeRecord(id: string): void {
    try {
      unlinkSync(join(this.dir, `${id}.acp.json`));
    } catch {
      // Never written, or already gone.
    }
  }
}
