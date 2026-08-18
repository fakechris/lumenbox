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
  timeout_ms?: number;
  env?: Record<string, string>;
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
}

export interface ErrorResult {
  error: string;
}

/** Port the box daemon listens on inside the container. */
export const BOXD_PORT = 1337;

/** noVNC's HTTP port inside the container. */
export const NOVNC_PORT = 6080;
