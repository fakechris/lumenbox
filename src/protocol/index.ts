/**
 * The host <-> box wire contract.
 *
 * Plain JSON over HTTP, not an RPC framework with generated schemas: that buys
 * wire compatibility across independently-versioned services, and here host and
 * box ship together from this repo, so the schema lives in one file and
 * both sides import it.
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
}

export interface ExecResult {
  stdout: string;
  stderr: string
  exit_code: number;
  timed_out: boolean;
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
}

export interface ListDirResult {
  path: string;
  entries: DirEntry[];
}

export interface HealthResult {
  ok: boolean;
  version: string;
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
 * Base port for each desktop's noVNC inside the container: display N listens on
 * NOVNC_BASE_PORT + N.
 *
 * These are never published. boxd proxies them, so one published port serves any
 * number of desktops — otherwise the desktop count would be capped by whatever
 * port mappings were fixed at container-create time.
 */
export const NOVNC_BASE_PORT = 6080;

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
