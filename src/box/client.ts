/**
 * Host-side client for the box daemon.
 *
 * Everything the agent does inside the box goes through here.
 */

import { BOXD_PROTOCOL } from "../protocol/index.ts";
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

/**
 * What kind of failure this was, because each has a different remedy:
 *
 *   - `refused` — the box answered and said no. The request or its authorization is
 *     wrong, and sending it again unchanged will be refused again.
 *   - `timeout` — no answer in time. The operation may still be running in the box, so
 *     the honest next step is to check its effect, not to redo it.
 *   - `crashed` — the box hit an internal error mid-request; the effect is unknown.
 *     Check before redoing, same as a timeout.
 *   - `unreachable` — the request never reached a box. Nothing was delivered, so a
 *     retry is safe once the box is back (`agentbox box up`).
 *   - `protocol` — the box answered something that is not the protocol, which usually
 *     means a version skew the handshake has not caught yet.
 *
 * These used to arrive as one undifferentiated message, and the reader — model or
 * person — had to guess which of three very different situations they were in.
 */
export type BoxFailure = "refused" | "timeout" | "crashed" | "unreachable" | "protocol";

export class BoxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: BoxFailure = "protocol"
  ) {
    super(message);
    this.name = "BoxError";
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Computer batches can legitimately include waits and long typing runs. */
const COMPUTER_TIMEOUT_MS = 180_000;

/**
 * Refuses a box this host cannot correctly drive, and says which half to upgrade.
 *
 * On connect rather than on first use, for the same reason unreachability is: a mismatch
 * that surfaces mid-turn as one route behaving oddly is far harder to recognise than a
 * refusal at the door. Boxes and hosts are upgraded independently, and `box down` followed
 * by `box up` restarts the *existing* container — so "I upgraded and restarted" and "the
 * box is still the old one" is the normal way to arrive here, not an exotic one.
 */
export function assertCompatible(health: HealthResult, where: string): void {
  const speaks = health.protocol;
  if (speaks === BOXD_PROTOCOL) return;
  const box = `The box at ${where}`;
  throw new BoxError(
    speaks === undefined || speaks < BOXD_PROTOCOL
      ? `${box} is older than this host expects (it speaks ${speaks ?? "no announced"} ` +
        `version; this host needs ${BOXD_PROTOCOL}). Rebuild the image and recreate the ` +
        `container: \`npm run build:box\`, rebuild the image, then \`agentbox box up ` +
        `--recreate\`. Note that \`box down\` and \`box up\` restart the old container ` +
        `and will not fix this.`
      : `${box} is newer than this host (it speaks ${speaks}; this host understands ` +
        `${BOXD_PROTOCOL}). Update this host, or recreate the box from the image this ` +
        `host was built alongside.`
  );
}

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
          response.status,
          "protocol"
        );
      }

      if (!response.ok) {
        const message =
          (parsed as { error?: string }).error ?? `HTTP ${response.status}`;
        // A 4xx is the box saying no; a 5xx is the box breaking. The difference decides
        // whether redoing the request is pointless or merely needs checking first.
        if (response.status >= 500) {
          throw new BoxError(
            `${path}: ${message}. The box hit an internal error mid-request, so the ` +
              `effect is unknown — check what happened before redoing it.`,
            response.status,
            "crashed"
          );
        }
        throw new BoxError(
          `${path}: ${message}. The box refused this; sending it again unchanged will ` +
            `be refused again.`,
          response.status,
          "refused"
        );
      }
      return parsed as T;
    } catch (error) {
      if (error instanceof BoxError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new BoxError(
          `${path} timed out after ${timeoutMs}ms. The operation may still be running ` +
            `in the box — check its effect before redoing it.`,
          undefined,
          "timeout"
        );
      }
      throw new BoxError(
        `${path} could not reach the box: ` +
          `${error instanceof Error ? error.message : String(error)}. Nothing was ` +
          `delivered, so this is safe to retry once the box is back.`,
        undefined,
        "unreachable"
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
      /** Who asked, for the box's record. A label, not a permission. */
      actor?: string;
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
        actor: options.actor,
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
    options: { cwd?: string; env?: Record<string, string>; display?: number; owner?: string; jobId?: string } = {}
  ): Promise<JobStartedResult> {
    return this.post<JobStartedResult>("/exec", {
      command,
      background: true,
      cwd: options.cwd,
      env: options.env,
      display: options.display,
      owner: options.owner,
      job_id: options.jobId,
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
