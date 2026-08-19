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
  | { action: "cursor_position" };

export interface ComputerRequest {
  actions: readonly ComputerAction[];
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

export interface ComputerResult {
  success: boolean;
  /** base64 WebP at API resolution. Empty only if capture failed. */
  screenshot: string;
  cursor_position?: { x: number; y: number };
  action_count: number;
  duration_ms: number;
  error?: string;
}

export interface ExecRequest {
  command: string;
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
  /** Desktops currently running. */
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
