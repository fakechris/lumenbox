/**
 * Host-side client for the box daemon.
 *
 * Everything the agent does inside the box goes through here.
 */

import type {
  ComputerAction,
  ComputerResult,
  ExecResult,
  HealthResult,
  ListDirResult,
  ReadFileResult,
  WriteFileResult,
} from "../protocol/index.ts";

export interface BoxClientOptions {
  /** Base URL of the daemon as reachable from the host, e.g. http://127.0.0.1:49173 */
  baseUrl: string;
  token: string;
  /** Default per-request timeout. Computer actions get a longer one. */
  timeoutMs?: number;
}

export class BoxError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "BoxError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Computer batches can legitimately include waits and long typing runs. */
const COMPUTER_TIMEOUT_MS = 180_000;

export class BoxClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: BoxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async post<T>(
    path: string,
    body: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new BoxError(
          `Box returned non-JSON on ${path} (HTTP ${response.status}): ${text.slice(0, 200)}`,
          response.status
        );
      }

      if (!response.ok) {
        const message =
          (parsed as { error?: string }).error ?? `HTTP ${response.status}`;
        throw new BoxError(`${path}: ${message}`, response.status);
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof BoxError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new BoxError(`${path} timed out after ${timeoutMs}ms`);
      }
      throw new BoxError(
        `${path} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async health(timeoutMs = 5000): Promise<HealthResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BoxError(`health: HTTP ${response.status}`, response.status);
      }
      return (await response.json()) as HealthResult;
    } catch (error) {
      if (error instanceof BoxError) throw error;
      throw new BoxError(
        `health failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  computer(
    actions: readonly ComputerAction[],
    bindUnmappedCharacters = true
  ): Promise<ComputerResult> {
    return this.post<ComputerResult>(
      "/computer",
      { actions, bind_unmapped_characters: bindUnmappedCharacters },
      COMPUTER_TIMEOUT_MS
    );
  }

  exec(
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {}
  ): Promise<ExecResult> {
    const commandTimeout = options.timeoutMs ?? 120_000;
    return this.post<ExecResult>(
      "/exec",
      { command, cwd: options.cwd, timeout_ms: commandTimeout },
      // Give the HTTP layer headroom over the command's own timeout, so a
      // command that times out reports its output instead of aborting the request.
      commandTimeout + 15_000
    );
  }

  readFile(
    path: string,
    range: { startLine?: number; endLine?: number } = {}
  ): Promise<ReadFileResult> {
    return this.post<ReadFileResult>("/fs/read", {
      path,
      start_line: range.startLine,
      end_line: range.endLine,
    });
  }

  writeFile(path: string, content: string): Promise<WriteFileResult> {
    return this.post<WriteFileResult>("/fs/write", { path, content });
  }

  listDir(path: string): Promise<ListDirResult> {
    return this.post<ListDirResult>("/fs/list", { path });
  }
}
