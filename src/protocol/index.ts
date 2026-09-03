/**
 * The host <-> box wire contract.
 *
 * Plain JSON over HTTP, not an RPC framework with generated schemas: that buys
 * wire compatibility across independently-versioned services, and here host and
 * box ship together from this repo — so the schema lives in one file and both
 * sides import it.
 */

export const API_WIDTH = 1280;

/** Model-facing coordinate space. Screenshots are always scaled to this. */
export interface Resolution {
  width: number;
  height: number;
}

export interface ResolutionConfig {
  /** The X display's real framebuffer size. */
  display: Resolution;
  /** What the model sees. */
  api: Resolution;
}

export type MouseButton = "left" | "middle" | "right" | "back" | "forward";
export type ScrollDirection = "up" | "down" | "left" | "right";

export type Coordinate = readonly [x: number, y: number];

/**
 * One computer-use action in API coordinate space.
 *
 * `modifiers` is a "+"-joined chord ("ctrl+shift"); `meta` maps to X11 `super`.
 */
export type ComputerAction =
  | { action: "mouse_move"; coordinate: Coordinate }
  | {
      action: "click";
      coordinate?: Coordinate;
      button?: MouseButton;
      count?: number;
      modifiers?: string;
    }
  | { action: "mouse_down"; button?: MouseButton }
  | { action: "mouse_up"; button?: MouseButton }
  | {
      action: "drag";
      path: readonly Coordinate[];
      button?: MouseButton;
      modifiers?: string;
    }
  | {
      action: "scroll";
      coordinate?: Coordinate;
      direction: ScrollDirection;
      amount?: number;
      modifiers?: string;
    }
  | { action: "type"; text: string }
  | { action: "key"; key: string; hold_duration_ms?: number }
  | { action: "wait"; duration_ms: number }
  | { action: "screenshot" }
  | { action: "cursor_position" }
  /** The windows on this desktop, so a window can be found without hunting visually. */
  | { action: "list_windows" }
  /**
   * Raises a window and gives it focus.
   *
   * Needed before typing into it: synthetic input is global — it goes to whatever holds
   * focus — so a window cannot be operated while it is behind another one.
   */
  | { action: "activate_window"; window_id: string }
  | { action: "close_window"; window_id: string }
  /**
   * One window's own contents, whether or not it is visible.
   *
   * For reading something a window in front is covering. Clicking still needs
   * activate_window first, and the coordinates in the result are the window's, not the
   * screen's.
   */
  | { action: "screenshot_window"; window_id: string }
  /**
   * Clicks a point inside a window, in that window's own coordinates.
   *
   * The counterpart to screenshot_window: coordinates read off a window capture are the
   * window's, not the screen's, so clicking them directly would land somewhere else. This
   * takes them as they are. It raises the window first, because a click goes to whatever
   * is on top at that point regardless of which window was meant.
   */
  | {
      action: "click_in_window";
      window_id: string;
      coordinate: Coordinate;
      button?: MouseButton;
      count?: number;
      modifiers?: string;
    };

export interface ComputerRequest {
  actions: readonly ComputerAction[];
  /**
   * Proof that the caller owns this desktop.
   *
   * A display is bound to a token when it is created, and input carrying anyone else's
   * token is refused. Without it, any caller that could name a display could drive it —
   * which meant one agent could type into another's screen.
   */
  owner?: string;
  /**
   * Which desktop to act on. Each agent gets its own, so their input and their
   * screenshots cannot cross. Defaults to 1.
   */
  display?: number;
  /**
   * Bind a spare keycode per unmapped character before typing instead of letting
   * `xdotool type` remap one per character and lose it. See the SAND-1271 note in
   * the X11 executor.
   */
  bind_unmapped_characters?: boolean;
}

export interface WindowInfo {
  /** X window id, e.g. "0x01e00003". What activate_window and screenshot_window take. */
  id: string;
  /**
   * Workspace index, or -1 for the furniture: the layer that draws the desktop and its
   * icons, and the dock. Those are not windows anyone means.
   */
  desktop: number;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

export interface ComputerResult {
  success: boolean;
  /** base64 WebP at API resolution. Empty only if capture failed. */
  screenshot: string;
  cursor_position?: { x: number; y: number };
  /** Present when the batch included list_windows. */
  windows?: readonly WindowInfo[];
  action_count: number;
  duration_ms: number;
  error?: string;
}

/**
 * How much of a tool result survives in the transcript.
 *
 * Here, in the protocol, because two packages have to agree about it and did not. The
 * host trims a stored result to this; the box decides when to spill full output to a
 * file. Those numbers were set against *different* things — the spill was placed below
 * the host's 20,000-character **display** cap, while the transcript keeps 2,000 — so a
 * result between the two was shown to the model in full, stored as a 2 KB head, and
 * given no spool pointer. Its tail was durably gone, and nothing said so.
 *
 * The rule that keeps them honest: **spill before anything durable is truncated.** A
 * pointer that appears later than the truncation points at nothing.
 */
export const DURABLE_RESULT_CHARS = 2_000;

export interface ExecRequest {
  command: string;
  /** Same as on a computer request: proof of ownership when a display is named. */
  owner?: string;
  cwd?: string;
  /** Sets DISPLAY, so a GUI launched from the shell lands on the agent's own desktop. */
  display?: number;
  timeout_ms?: number;
  env?: Record<string, string>;
  /**
   * Groups calls into one persistent shell session, so `cd`, `export`, and an
   * activated virtualenv survive between commands. Usually the agent's id.
   */
  session?: string;
  /**
   * Start it and answer now, rather than holding the request until it exits.
   *
   * For the work that outlives a tool call: a build, a test suite, a delegated coding
   * engine. The reply carries a job id; its output goes to a file that survives the
   * turn, and `/jobs/*` is how anyone asks what became of it.
   */
  background?: boolean;
  /**
   * Who asked for this, for the record — an agent id, or what the host was doing.
   *
   * A label, never a bypass. It changes nothing about what runs, what is allowed, or
   * who may call: the token is the access control and stays the access control. It
   * exists because host housekeeping and an agent's own shell arrive on this one
   * endpoint looking identical, so `mkdir` for a starter skill and `rm -rf` typed by a
   * model were the same line in the box's log — and, until this landed, that line did
   * not exist at all. A record that cannot say who acted answers the only question
   * anybody asks it with a shrug.
   *
   * Untrusted by construction. Anything holding the token can write anything here, so
   * it is evidence about *our* callers and not proof about a stranger's.
   */
  actor?: string;
  /**
   * A job id the caller minted (docs/32 slice two): `job-` plus 8–32 hex characters. Lets
   * the host record the job before it exists and makes a repeated start idempotent — the
   * same id twice returns the job already running rather than spawning it again.
   */
  job_id?: string;
}

/** What starting a background job answers with, instead of its output. */
export interface JobStartedResult {
  job_id: string;
  pid: number;
  /** Where the combined output is being written, readable with the file tools. */
  log_path: string;
}

export interface JobStatus {
  job_id: string;
  command: string;
  running: boolean;
  /**
   * True for a job that was running when the daemon last stopped: its process is gone or
   * orphaned and its exit was never observed, so `exit_code` is absent and the log is all
   * there is. Read back from the jobs directory at start (docs/32 slice two).
   */
  interrupted?: boolean;
  /** Absent while it runs. */
  exit_code?: number;
  started_at: string;
  ended_at?: string;
  log_path: string;
  /** Bytes written to the log so far — how a caller sees progress without reading it. */
  log_bytes: number;
}

export interface JobWaitRequest {
  job_id: string;
  /** How long to wait before answering with whatever is true then. */
  timeout_ms?: number;
  /**
   * Stop waiting when this appears in the output, rather than only at exit.
   *
   * A server that says "listening on 3000" is ready long before it is finished, and
   * waiting for exit would wait forever. A plain substring; the whole point is that
   * the caller already knows the line it is looking for.
   */
  until?: string;
}

export interface JobWaitResult extends JobStatus {
  /** Why the wait ended: the job finished, the text appeared, or time ran out. */
  reason: "exited" | "matched" | "timeout";
  /** The last of the output, for reading without a second call. */
  tail: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string
  exit_code: number;
  timed_out: boolean;
  /**
   * The timeout actually applied, which is not always the one requested: the box caps it. Sent
   * back so a caller that asked for an hour and got ten minutes is told, rather than concluding
   * its command died for some other reason.
   */
  timeout_ms?: number;
}

export interface ReadFileRequest {
  path: string;
  /** 1-indexed, inclusive. Omit for the whole file. */
  start_line?: number;
  end_line?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  total_lines: number;
  truncated: boolean;
}

export interface WriteFileRequest {
  path: string;
  content: string;
  /** Create parent directories. Defaults to true. */
  mkdirp?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytes_written: number;
}

export interface ListDirRequest {
  path: string;
}

export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  /**
   * Last modified, ISO 8601.
   *
   * Added because "what did the agent just make" is the question a person actually has, and
   * alphabetical order answers a different one.
   */
  modified?: string;
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
}

export interface HealthResult {
  ok: boolean;
  version: string;
  /**
   * The surface version this box speaks. Absent from any box built before it existed,
   * which is itself the answer: that box is too old for this host.
   */
  protocol?: number;
  display: string;
  /** Absent when no X server is reachable; shell and fs still work. */
  resolution?: ResolutionConfig;
  refresh_rate?: number;
  uptime_seconds: number;
  /**
   * Processes that died in the box with nothing supervising them.
   *
   * Recorded by PID 1, which is the only thing that sees an orphan die. A browser the agent
   * abandoned, or a binary it installed and ran crash-looping, used to leave no trace at
   * all. Aggregated per (process, signal) so a crash loop is one entry with a count.
   */
  crashes?: readonly {
    at: string;
    process: string;
    uid: string;
    kind: string;
    detail: string;
    count: number;
  }[];
  /** Desktops currently running. */
  /**
   * Per-component state for each desktop.
   *
   * "ok" is not the whole answer a control plane needs: a desktop whose compositor has
   * been given up on still serves a screen, and one whose x11vnc is crash-looping does
   * not, and both used to report the same thing here. Anything deciding whether to
   * recycle a box reads this.
   */
  desktop_health?: readonly {
    index: number;
    degraded: boolean;
    components: readonly {
      name: string;
      state: string;
      restarts: number;
      crashloops: number;
      reason?: string;
      lastRestartAt?: string;
    }[];
  }[];
  displays?: DisplayInfo[];
}

export interface DisplayInfo {
  index: number;
  display: string;
  resolution?: ResolutionConfig;
  /** Path on the daemon that serves this desktop's noVNC. */
  vnc_path: string;
}

export interface EnsureDisplayRequest {
  index: number;
  /**
   * Binds this desktop to the caller. Once bound, computer and exec requests naming this
   * display must present the same token. Re-binding with the same token is idempotent;
   * a different token is refused while the binding stands.
   */
  owner?: string;
}

export type EnsureDisplayResult = DisplayInfo;

export interface ErrorResult {
  error: string;
}

/** Port the box daemon listens on inside the container. */
export const BOXD_PORT = 1337;

/**
 * The version of the surface boxd and the host speak to each other over.
 *
 * Separate from any package version and bumped only when this HTTP surface changes in a
 * way an older peer cannot survive — a route removed, a field's meaning changed, a
 * required argument added. Cosmetic releases leave it alone.
 *
 * It exists because the two are upgraded independently and, until this, silently: the box
 * reported a version string that was hardcoded to "0.1.0" and that nothing compared. A box
 * running ahead of its host then presents as unrelated failures in whichever route moved,
 * which is a bad way to find out you restarted only half of the system.
 */
export const BOXD_PROTOCOL = 1;

/** Handing a work product to a person, verbatim. Confined to the work directory — see fs-service. */
export interface DownloadFileRequest {
  path: string;
}

/** Putting a file into the box, verbatim. The inverse of a download, and confined the same way. */
export interface UploadFileRequest {
  path: string;
  base64: string;
}

export interface UploadFileResult {
  path: string;
  size: number;
}

export interface DownloadFileResult {
  path: string;
  size: number;
  /** So a browser renders what it can show and downloads what it cannot. */
  media_type: string;
  base64: string;
}

/**
 * Port the in-box orchestrator's web UI listens on inside the container.
 *
 * Named here rather than written as 7777 in each of the four places that knew it, because the
 * control plane publishes it on an ephemeral host port and the two numbers are no longer the same.
 */
export const UI_PORT = 7777;

/**
 * Base port for each desktop's noVNC inside the container: display N listens on
 * NOVNC_BASE_PORT + N.
 *
 * These are never published. boxd proxies them, so one published port serves any
 * number of desktops — otherwise the desktop count would be capped by whatever
 * port mappings were fixed at container-create time.
 */
export const NOVNC_BASE_PORT = 6080;

/**
 * Where the same desktop's *view-only* noVNC listens.
 *
 * A second x11vnc started with `-viewonly` against the same display. It exists because the product
 * promises a role that can watch without taking over, and RFB cannot be made read-only downstream:
 * everything after the handshake is framed, so a proxy would have to parse it and drop key and
 * pointer messages, failing closed on anything it did not recognise. x11vnc already implements this
 * correctly. Chosen in `start-display`; this constant has to agree with it.
 */
export const NOVNC_VIEW_ONLY_BASE_PORT = 6180;

/** Base port for each desktop's VNC server: display N listens on VNC_BASE_PORT + N. */
export const VNC_BASE_PORT = 5900;

/** The desktop an agent uses when it has no assignment of its own. */
export const DEFAULT_DISPLAY_INDEX = 1;

/** Screen recording. One recording per desktop; the file lands on the work volume. */
export interface RecordStartRequest {
  display?: number;
  /** Used in the file name, so a recording can be found by what it was for. */
  name?: string;
  framerate?: number;
  crf?: number;
  draw_mouse?: boolean;
}

export interface RecordStopRequest {
  display?: number;
}

export interface RecordingInfo {
  display: number;
  file: string;
  path: string;
  started_at: string;
  size_bytes?: number;
  duration_ms?: number;
}

export interface RecordListResult {
  recordings: RecordingInfo[];
}

/** The box's clipboard. Text only, and bounded: this is not a file transfer. */
export interface ClipboardReadRequest {
  display?: number;
}

export interface ClipboardWriteRequest {
  display?: number;
  text: string;
}

export interface ClipboardResult {
  text: string;
}

/**
 * Driving the box's browser by name rather than by coordinate.
 *
 * One request shape for every browser action, because they all answer the same question —
 * what does the page look like now — and a separate result type per verb would say the
 * same thing four times.
 */
export interface BrowserRequest {
  display?: number;
  owner?: string;
  /** What to do: open, snapshot, read, act, scroll or upload. */
  op: string;
  /** For `open`. */
  url?: string;
  /** For `act`: click, type, key or hover. */
  action?: string;
  /** The handle of the thing to act on, from a snapshot: e4, or e4@f1 inside a frame. */
  ref?: string;
  text?: string;
  key?: string;
  /** Whether typing replaces what is there. Defaults to true. */
  replace?: boolean;
  direction?: string;
  amount?: number;
  /** For `upload`: paths inside the box. */
  files?: string[];
  /** For `wait`: what to watch — text, url or title — and what to watch for. */
  waitFor?: string;
  value?: string;
  seconds?: number;
}

export interface BrowserResponse {
  url: string;
  title: string;
  /** The page as an outline, with a ref on everything actionable. */
  snapshot: string;
  /** Present when the page asked a question while we were acting. */
  dialog?: string;
  /** For `read`: the page's prose. */
  text?: string;
  /** Something that happened to the page itself: a tab opened, a tab closed, a wait ended. */
  note?: string;
}
