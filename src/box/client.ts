/**
 * Host-side client for the box daemon.
 *
 * Everything the agent does inside the box goes through here.
 */

import type {
  BrowserRequest,
  BrowserResponse,
  ClipboardResult,
  ComputerAction,
  ComputerResult,
  EnsureDisplayResult,
  ExecResult,
  HealthResult,
  DownloadFileResult,
  UploadFileResult,
  ListDirResult,
  JobStartedResult,
  JobStatus,
  JobWaitRequest,
  JobWaitResult,
  ReadFileResult,
  RecordListResult,
  RecordingInfo,
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
    options: {
      display?: number;
      bindUnmappedCharacters?: boolean;
      /** Proof that this desktop is the caller's. Refused if it belongs to someone else. */
      owner?: string;
    } = {}
  ): Promise<ComputerResult> {
    return this.post<ComputerResult>(
      "/computer",
      {
        actions,
        display: options.display,
        owner: options.owner,
        bind_unmapped_characters: options.bindUnmappedCharacters ?? true,
      },
      COMPUTER_TIMEOUT_MS
    );
  }

  /** Brings up an agent's desktop, or adopts it if already running. */
  ensureDisplay(index: number, owner?: string): Promise<EnsureDisplayResult> {
    // Starting Xvfb, a window manager, VNC and noVNC takes a moment.
    return this.post<EnsureDisplayResult>("/displays/ensure", { index, owner }, 120_000);
  }

  exec(
    command: string,
    options: {
      cwd?: string;
      timeoutMs?: number;
      session?: string;
      display?: number;
      owner?: string;
    } = {}
  ): Promise<ExecResult> {
    const commandTimeout = options.timeoutMs ?? 120_000;
    return this.post<ExecResult>(
      "/exec",
      {
        command,
        cwd: options.cwd,
        timeout_ms: commandTimeout,
        session: options.session,
        display: options.display,
        owner: options.owner,
      },
      // Give the HTTP layer headroom over the command's own timeout, so a
      // command that times out reports its output instead of aborting the request.
      commandTimeout + 15_000
    );
  }

  /**
   * Starts a command and answers now, with a job id instead of its output.
   *
   * For work that outlives a tool call. Its output goes to a file in the box, which is
   * both how a wait reads it later and how truncation stops being loss.
   */
  startJob(
    command: string,
    options: { cwd?: string; env?: Record<string, string>; display?: number; owner?: string } = {}
  ): Promise<JobStartedResult> {
    return this.post<JobStartedResult>("/exec", {
      command,
      background: true,
      cwd: options.cwd,
      env: options.env,
      display: options.display,
      owner: options.owner,
    });
  }

  jobs(): Promise<{ jobs: JobStatus[] }> {
    return this.post<{ jobs: JobStatus[] }>("/jobs", {});
  }

  /** Waits for a job to finish, for a line to appear, or for the time to run out. */
  waitForJob(request: JobWaitRequest): Promise<JobWaitResult> {
    // The HTTP timeout has to outlast the wait the box is doing, or the request dies
    // before the answer it is waiting for exists.
    return this.post<JobWaitResult>("/jobs/wait", request, (request.timeout_ms ?? 60_000) + 15_000);
  }

  killJob(jobId: string): Promise<JobStatus> {
    return this.post<JobStatus>("/jobs/kill", { job_id: jobId });
  }

  /** What is on a desktop's clipboard. Empty when nothing owns the selection. */
  readClipboard(display?: number): Promise<ClipboardResult> {
    return this.post<ClipboardResult>("/clipboard/read", { display });
  }

  /** Puts text on a desktop's clipboard, ready for the user or agent to paste. */
  writeClipboard(text: string, display?: number): Promise<ClipboardResult> {
    return this.post<ClipboardResult>("/clipboard/write", { display, text });
  }

  /** Starts recording a desktop. One recording per desktop at a time. */
  startRecording(
    options: { display?: number; name?: string; framerate?: number; drawMouse?: boolean } = {}
  ): Promise<RecordingInfo> {
    return this.post<RecordingInfo>("/record/start", {
      display: options.display,
      name: options.name,
      framerate: options.framerate,
      draw_mouse: options.drawMouse,
    });
  }

  /** Stops it and returns the finished file. Waits for ffmpeg to write its trailer. */
  stopRecording(display?: number): Promise<RecordingInfo> {
    return this.post<RecordingInfo>("/record/stop", { display }, 30_000);
  }

  listRecordings(): Promise<RecordListResult> {
    return this.post<RecordListResult>("/recordings", {});
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

  /**
   * A file's bytes, for handing to a person.
   *
   * Separate from `readFile` because that one is for the model — it returns text with line ranges
   * and refuses anything it cannot decode. This returns the file exactly, which is what a download
   * has to be, and is confined to the work directory by the daemon.
   */
  downloadFile(path: string): Promise<DownloadFileResult> {
    return this.post<DownloadFileResult>("/fs/download", { path });
  }

  uploadFile(path: string, base64: string): Promise<UploadFileResult> {
    return this.post<UploadFileResult>("/fs/upload", { path, base64 });
  }

  /**
   * Drives the browser on a desktop. Longer than the default timeout because a page
   * that is slow to settle is normal, and the service already bounds its own waits.
   */
  browser(request: BrowserRequest): Promise<BrowserResponse> {
    return this.post<BrowserResponse>("/browser", request, 120_000);
  }

  listDir(path: string): Promise<ListDirResult> {
    return this.post<ListDirResult>("/fs/list", { path });
  }
}
