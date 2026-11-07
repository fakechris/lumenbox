/**
 * The screen of a Mac, driven as a desktop (INV-1707, docs/96 §8 Q2).
 *
 * An organisation's node can open its native environment's screen to the `computer` tool: the
 * same contract the Linux box's X11 executor speaks (`DesktopDriver`), so the gates in front of it
 * — the desktop's owner, the takeover lease, the control guard, the policy gate's ask — are the
 * ones every desktop already has (src/boxd/native-screen.ts). This file is only the hands.
 *
 * What macOS asks for, and how it is never asked here: capturing the screen needs Screen
 * Recording, posting input needs Accessibility, both granted in System Settings to the app that
 * started the node (TCC's "responsible" app: LumenBox, or Terminal when run by hand). Asking for
 * either puts a dialog on the machine's screen, which on a machine nobody is sitting at blocks the
 * work and on anybody's machine is a surprise; so every batch starts by *reading* both
 * (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`, which never prompt) and refuses with
 * PERMISSION_DENIED before anything is sent when one is missing. `screencapture` itself would
 * prompt, so it runs only after the read said yes. A permission withdrawn mid-batch is seen at the
 * batch's end and reported as unknown, never as done.
 *
 * Coordinates: the model works at API resolution; CoreGraphics posts in points (a Retina screen
 * has twice as many pixels), so the scaler maps API space to the main display's bounds in points,
 * and the capture is resampled from pixels to API width. The geometry is read at every batch, so
 * a display that changed is never clicked by yesterday's numbers.
 *
 * The input goes through one small helper per action, its request on stdin and never on a
 * command line (native-helper.ts), with the authority rechecked before each and while it runs:
 * a takeover, a revoked guard or a closed screen stops the batch at the next action and kills the
 * one in flight. The default helper is a JXA script run by `/usr/bin/osascript`; a node may name a
 * signed helper of its own that speaks the same requests (`BOXD_NATIVE_SCREEN_HELPER`).
 *
 * Not in this version, and refused before anything is sent: an accessibility outline
 * (list_elements answers with a note), element refs, windows by id.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopDriver, DesktopExecutionOptions, DesktopExecutionResult } from "./driver.ts";
import { deliveryOf } from "./delivery.ts";
import { ComputerExecutionError, DesktopTargetError, isComputerWrite } from "./execution.ts";
import { nativeHelper } from "./native-helper.ts";
import { CoordinateScaler } from "./scaling.ts";
import { buildResolutionConfig } from "./display.ts";
import { exec, sleep } from "./shell.ts";
import { actionRequiresSettle, DEFAULT_SCREENSHOT_DELAY_MS } from "./x11-executor.ts";
import type { ComputerAction, DesktopCapabilities, DesktopObservation, MouseButton, ResolutionConfig } from "../protocol/index.ts";

/**
 * The programs that capture or drive this screen, which a confined command may not start where the
 * screen is open (confinement.ts): the app's Screen Recording and Accessibility are inherited by
 * whatever it starts, and a shell running these would reach the screen past every gate.
 */
export const SCREEN_PROGRAMS = ["/usr/sbin/screencapture", "/usr/bin/osascript", "/usr/bin/osacompile", "/usr/bin/automator", "/usr/bin/shortcuts"] as const;

export const MACOS_DESKTOP_CAPABILITIES = { backend: "macos-cg", platform: "darwin", semantic_actions: [], background_semantic: false, observation_refs: false } as const satisfies DesktopCapabilities;

/** What the helper reports before a batch: both permissions, read without prompting; the main display in points; the pointer. */
export interface ScreenState {
  screen: boolean;
  input: boolean;
  width: number;
  height: number;
  cursor: { x: number; y: number };
}

/** One request to the input helper, in points. */
export type HelperRequest =
  | { op: "state" }
  | { op: "move"; x: number; y: number }
  | { op: "click"; x?: number; y?: number; button: "left" | "right" | "middle"; count: number; flags: number }
  | { op: "down" | "up"; button: "left" | "right" | "middle" }
  | { op: "drag"; path: [number, number][]; button: "left" | "right" | "middle"; flags: number }
  | { op: "scroll"; x?: number; y?: number; dy: number; dx: number; flags: number }
  | { op: "type"; text: string }
  | { op: "key"; keycode: number; flags: number; hold_ms: number };

/** The two things this driver does to the machine; replaced in tests, which never touch a real screen. */
export interface MacScreenPorts {
  helper(request: HelperRequest, authorize: () => void): Promise<Record<string, unknown>>;
  /** The main display as PNG, `width` pixels wide. */
  capture(width: number, authorize: () => void): Promise<Buffer>;
}

/** CGEventFlags. */
const FLAGS: Record<string, number> = {
  shift: 0x20000, ctrl: 0x40000, control: 0x40000, alt: 0x80000, option: 0x80000, opt: 0x80000,
  cmd: 0x100000, command: 0x100000, super: 0x100000, meta: 0x100000, win: 0x100000,
};

/** macOS virtual key codes (ANSI layout), by the xdotool-style names the model already uses. */
const KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, equal: 24, "9": 25, "7": 26, "-": 27, minus: 27, "8": 28, "0": 29,
  "]": 30, bracketright: 30, o: 31, u: 32, "[": 33, bracketleft: 33, i: 34, p: 35, l: 37, j: 38, "'": 39, apostrophe: 39, k: 40,
  ";": 41, semicolon: 41, "\\": 42, backslash: 42, ",": 43, comma: 43, "/": 44, slash: 44, n: 45, m: 46, ".": 47, period: 47,
  "`": 50, grave: 50,
  return: 36, enter: 36, kp_enter: 76, tab: 48, space: 49, backspace: 51, escape: 53, esc: 53,
  delete: 117, home: 115, end: 119, prior: 116, page_up: 116, pageup: 116, next: 121, page_down: 121, pagedown: 121,
  left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** "ctrl+shift+t" → modifier flags; undefined when a part is not a modifier this driver knows. */
export function modifierFlags(chord: string | undefined): number | undefined {
  if (chord === undefined || chord.trim() === "") return 0;
  let flags = 0;
  for (const part of chord.toLowerCase().split("+").map(p => p.trim().replace(/_[lr]$/, ""))) {
    const flag = FLAGS[part];
    if (flag === undefined) return undefined;
    flags |= flag;
  }
  return flags;
}

/** A key chord as the helper takes it, or undefined when this driver cannot press it. */
export function macKey(key: string): { keycode: number; flags: number } | undefined {
  const parts = key.split("+").map(p => p.trim()).filter(p => p !== "");
  const last = parts.pop();
  if (last === undefined) return undefined;
  const flags = modifierFlags(parts.join("+"));
  const keycode = KEYCODES[last.length === 1 ? last.toLowerCase() : last.toLowerCase()];
  if (flags === undefined || keycode === undefined) return undefined;
  // A capital letter is the letter with shift, as xdotool reads it.
  return { keycode, flags: flags | (last.length === 1 && last !== last.toLowerCase() ? FLAGS.shift! : 0) };
}

function button(name: MouseButton | undefined): "left" | "right" | "middle" | undefined {
  return name === undefined || name === "left" ? "left" : name === "right" ? "right" : name === "middle" ? "middle" : undefined;
}

/** Actions this driver refuses before anything is sent, and why. */
function unsupported(action: ComputerAction): string | undefined {
  switch (action.action) {
    case "list_windows": case "activate_window": case "close_window": case "screenshot_window": case "click_in_window":
      return `${action.action}: windows by id are not available on the machine's own screen in this version`;
    case "click_element": case "invoke_element": case "set_value":
      return `${action.action}: there is no accessibility outline of the machine's own screen in this version`;
    case "click": case "drag": case "scroll":
      if (button("button" in action ? action.button : undefined) === undefined) return `${action.action}: only the left, right and middle buttons`;
      if (modifierFlags(action.modifiers) === undefined) return `${action.action}: modifiers "${action.modifiers}" are not ones this screen knows (shift, ctrl, alt/option, cmd)`;
      return undefined;
    case "mouse_down": case "mouse_up":
      return button(action.button) === undefined ? `${action.action}: only the left, right and middle buttons` : undefined;
    case "key":
      return macKey(action.key) === undefined ? `key "${action.key}" is not one this screen can press` : undefined;
    default:
      return undefined;
  }
}

export interface MacExecutorOptions {
  ports: MacScreenPorts;
  /** Pause before the final capture after an action that changes the screen. */
  screenshotDelayMs?: number;
}

export class MacExecutor implements DesktopDriver {
  readonly capabilities = MACOS_DESKTOP_CAPABILITIES;
  private readonly ports: MacScreenPorts;
  private readonly settleMs: number;
  /** The geometry of the last batch, for the pointer the teach and health paths ask about. */
  private scaler: CoordinateScaler | undefined;

  constructor(options: MacExecutorOptions) {
    this.ports = options.ports;
    this.settleMs = options.screenshotDelayMs ?? DEFAULT_SCREENSHOT_DELAY_MS;
  }

  /** No element refs are handed out, so there is nothing to forget. */
  invalidateElements(): void {}

  /** The machine's state now: permissions, geometry, pointer. */
  async state(authorize: () => void = () => {}): Promise<ScreenState> {
    const reply = await this.ports.helper({ op: "state" }, authorize);
    const width = Number(reply.width), height = Number(reply.height);
    const cursor = reply.cursor as { x?: unknown; y?: unknown } | undefined;
    if (reply.ok !== true || !(width > 0) || !(height > 0)) throw new Error(`the screen helper did not report the screen (${String(reply.error ?? "no answer")})`);
    return { screen: reply.screen === true, input: reply.input === true, width, height, cursor: { x: Number(cursor?.x ?? 0), y: Number(cursor?.y ?? 0) } };
  }

  async takeScreenshot(): Promise<string> {
    const state = await this.state();
    if (!state.screen) throw permission("screen");
    return (await this.ports.capture(this.scalerFor(state).apiWidth, () => {})).toString("base64");
  }

  async pointerWithWindow(): Promise<{ x: number; y: number }> {
    const state = await this.state();
    return this.scalerFor(state).displayToApi(state.cursor.x, state.cursor.y);
  }

  async execute(actions: readonly ComputerAction[], options: DesktopExecutionOptions = {}): Promise<DesktopExecutionResult> {
    const authorize = options.authorize ?? (() => {});
    const start = Date.now();
    let executed = 0;
    let attemptedWrite = false;
    let failedAt: number | undefined;
    try {
      authorize();
      for (const action of actions) {
        const why = unsupported(action);
        if (why !== undefined) throw new DesktopTargetError(why, "UNSUPPORTED_ACTION");
      }
      const writes = actions.some(isComputerWrite);
      const state = await this.state(authorize);
      if (!state.screen) throw permission("screen");
      if (writes && !state.input) throw permission("input");
      const scaler = this.scalerFor(state);
      const resolution = buildResolutionConfig(state.width, state.height);
      let screenshot: string | undefined;
      let observation: DesktopObservation | undefined;
      let cursorPosition: { x: number; y: number } | undefined;
      let elementsNote: string | undefined;
      let settle = false;
      const capture = async () => {
        authorize();
        const begun = Date.now();
        const image = (await this.ports.capture(scaler.apiWidth, authorize)).toString("base64");
        observation = { id: randomUUID(), display: "native", captured_start_ms: begun, captured_end_ms: Date.now(), after_action: executed, coordinate_space: "screen", resolution };
        return image;
      };
      for (const action of actions) {
        failedAt = executed;
        authorize();
        if (action.action === "screenshot") {
          if (settle) { await sleep(this.settleMs); settle = false; }
          screenshot = await capture();
        } else if (action.action === "cursor_position") {
          const now = await this.state(authorize);
          cursorPosition = scaler.displayToApi(now.cursor.x, now.cursor.y);
        } else if (action.action === "list_elements") {
          elementsNote = "there is no accessibility outline of the machine's own screen in this version; work from the screenshot";
        } else if (action.action === "wait") {
          await sleep(Math.max(0, Math.min(action.duration_ms, 30_000)));
          screenshot = undefined;
        } else {
          attemptedWrite = true;
          screenshot = undefined;
          for (const request of requestsFor(action, scaler)) {
            authorize();
            const reply = await this.ports.helper(request, authorize);
            if (reply.ok !== true) throw new Error(`the screen helper did not deliver ${action.action} (${String(reply.error ?? "no receipt")})`);
          }
          if (actionRequiresSettle(action)) settle = true;
        }
        executed++;
      }
      failedAt = undefined;
      if (writes) {
        // Withdrawn while the batch ran: the input may have been dropped, and a capture now would be the wallpaper.
        const after = await this.state(authorize);
        if (!after.screen || !after.input) throw permission(after.screen ? "input" : "screen", true);
      }
      if (screenshot === undefined) {
        if (settle) await sleep(this.settleMs);
        screenshot = await capture();
      }
      authorize();
      const verification = attemptedWrite ? { status: "unknown" as const, source: "none" as const, detail: "no batch postcondition was verified" } : undefined;
      const dispatch = attemptedWrite ? "sent" as const : "not_started" as const;
      return {
        success: true,
        ...(verification !== undefined ? { verification } : {}),
        ...(observation !== undefined ? { observation } : {}),
        progress: { executed_count: executed, dispatch, delivery: deliveryOf({ dispatch, ...(verification !== undefined ? { verification } : {}) }) },
        screenshot,
        screenshotMediaType: "image/png",
        ...(cursorPosition !== undefined ? { cursorPosition } : {}),
        ...(elementsNote !== undefined ? { elementsNote } : {}),
        actionCount: actions.length,
        durationMs: Date.now() - start,
      };
    } catch (error) {
      const dispatch = attemptedWrite ? (failedAt === undefined ? "sent" : "partial") : "not_started";
      throw new ComputerExecutionError(error, { executed_count: executed, ...(failedAt !== undefined ? { failed_at: failedAt } : {}), dispatch, delivery: deliveryOf({ dispatch }) });
    }
  }

  private scalerFor(state: ScreenState): CoordinateScaler {
    this.scaler = new CoordinateScaler(buildResolutionConfig(state.width, state.height));
    return this.scaler;
  }
}

/** The refusal a missing permission is: nothing was sent, and only the person at the machine can change it. */
function permission(which: "screen" | "input", during = false): DesktopTargetError {
  const pane = which === "screen" ? "Screen Recording" : "Accessibility";
  return new DesktopTargetError(
    `${during ? "macOS withdrew" : "macOS has not given"} LumenBox ${pane} on this machine${during ? " while the batch ran, so whether its input landed is unknown" : ", so nothing was sent"}. ` +
      `A person at the machine grants it in System Settings → Privacy & Security → ${pane} (to the app that started the node) and restarts the node; nothing here asks for it`,
    "PERMISSION_DENIED"
  );
}

/** The helper requests one action is, in points. */
export function requestsFor(action: ComputerAction, scaler: CoordinateScaler): HelperRequest[] {
  const at = (coordinate: readonly [number, number] | undefined) => (coordinate === undefined ? {} : scaler.apiToDisplay(coordinate[0], coordinate[1]));
  switch (action.action) {
    case "mouse_move": return [{ op: "move", ...scaler.apiToDisplay(action.coordinate[0], action.coordinate[1]) }];
    case "click": return [{ op: "click", ...at(action.coordinate), button: button(action.button)!, count: Math.max(1, Math.min(action.count ?? 1, 3)), flags: modifierFlags(action.modifiers)! }];
    case "mouse_down": return [{ op: "down", button: button(action.button)! }];
    case "mouse_up": return [{ op: "up", button: button(action.button)! }];
    case "drag": return [{ op: "drag", path: action.path.map(point => { const p = scaler.apiToDisplay(point[0], point[1]); return [p.x, p.y] as [number, number]; }), button: button(action.button)!, flags: modifierFlags(action.modifiers)! }];
    case "scroll": {
      const amount = Math.max(1, Math.min(action.amount ?? 3, 50));
      const dy = action.direction === "up" ? amount : action.direction === "down" ? -amount : 0;
      const dx = action.direction === "left" ? amount : action.direction === "right" ? -amount : 0;
      return [{ op: "scroll", ...at(action.coordinate), dy, dx, flags: modifierFlags(action.modifiers)! }];
    }
    case "type": return action.text === "" ? [] : [{ op: "type", text: action.text }];
    case "key": { const key = macKey(action.key)!; return [{ op: "key", ...key, hold_ms: Math.max(0, Math.min(action.hold_duration_ms ?? 0, 5_000)) }]; }
    default: throw new DesktopTargetError(`${action.action} is not available on the machine's own screen`, "UNSUPPORTED_ACTION");
  }
}

/**
 * The default helper, JXA: reads one request on stdin, answers one JSON line on stdout. Only
 * preflight reads of the permissions — never a request for them, which would show a dialog.
 */
export const MAC_HELPER_SOURCE = String.raw`ObjC.import("Foundation"); ObjC.import("CoreGraphics"); ObjC.import("ApplicationServices");
function out(value) { var s = $.NSString.alloc.initWithUTF8String(JSON.stringify(value) + "\n"); $.NSFileHandle.fileHandleWithStandardOutput.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding)); }
var BUTTONS = { left: [1, 2, 6, 0], right: [3, 4, 7, 1], middle: [25, 26, 27, 2] };
function post(event, flags) { if (flags) $.CGEventSetFlags(event, flags); $.CGEventPost(0, event); }
function cursor() { var p = $.CGEventGetLocation($.CGEventCreate(null)); return { x: p.x, y: p.y }; }
function mouse(type, point, number, flags, clicks) { var e = $.CGEventCreateMouseEvent(null, type, point, number); if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks); post(e, flags); }
function pause(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
function run() {
  try {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var r = JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
    var b = BUTTONS[r.button || "left"];
    var here = r.x === undefined ? cursor() : { x: r.x, y: r.y };
    if (r.op === "state") { var bounds = $.CGDisplayBounds($.CGMainDisplayID()); out({ ok: true, screen: $.CGPreflightScreenCaptureAccess() === true, input: $.AXIsProcessTrusted() === true, width: bounds.size.width, height: bounds.size.height, cursor: cursor() }); return; }
    if (r.op === "move") { mouse(5, here, 0, 0); }
    else if (r.op === "click") { if (r.x !== undefined) mouse(5, here, 0, 0); for (var n = 1; n <= r.count; n++) { mouse(b[0], here, b[3], r.flags, n); mouse(b[1], here, b[3], r.flags, n); } }
    else if (r.op === "down" || r.op === "up") { mouse(r.op === "down" ? b[0] : b[1], here, b[3], 0); }
    else if (r.op === "drag") { var first = { x: r.path[0][0], y: r.path[0][1] }; mouse(5, first, 0, 0); mouse(b[0], first, b[3], r.flags); for (var i = 1; i < r.path.length; i++) { pause(16); mouse(b[2], { x: r.path[i][0], y: r.path[i][1] }, b[3], r.flags); } var last = r.path[r.path.length - 1]; mouse(b[1], { x: last[0], y: last[1] }, b[3], r.flags); }
    else if (r.op === "scroll") { if (r.x !== undefined) mouse(5, here, 0, 0); post($.CGEventCreateScrollWheelEvent2(null, 1, 2, r.dy, r.dx, 0), r.flags); }
    else if (r.op === "type") { var chars = Array.from(r.text); for (var c = 0; c < chars.length; c++) { var d = $.CGEventCreateKeyboardEvent(null, 0, true); $.CGEventKeyboardSetUnicodeString(d, chars[c].length, chars[c]); post(d, 0); var u = $.CGEventCreateKeyboardEvent(null, 0, false); $.CGEventKeyboardSetUnicodeString(u, chars[c].length, chars[c]); post(u, 0); pause(8); } }
    else if (r.op === "key") { post($.CGEventCreateKeyboardEvent(null, r.keycode, true), r.flags); if (r.hold_ms) pause(r.hold_ms); post($.CGEventCreateKeyboardEvent(null, r.keycode, false), r.flags); }
    else { out({ ok: false, error: "unknown op" }); return; }
    out({ ok: true });
  } catch (e) { out({ ok: false, error: String(e) }); }
}`;

/** The last JSON line a helper wrote: osascript may print the run handler's own result after it. */
export function helperReply(stdout: string): Record<string, unknown> {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
    } catch {
      // Not the receipt.
    }
  }
  return { ok: false, error: "no receipt" };
}

/**
 * The machine's own ports: the helper (`helper` names a program speaking the same requests, or
 * the JXA script by default) and `screencapture` resampled by `sips`, both macOS's own.
 */
export function macScreenPorts(input: { helper?: string; log?: (line: string) => void } = {}): MacScreenPorts {
  return {
    async helper(request, authorize) {
      const [command, args] = input.helper !== undefined && input.helper !== "" ? [input.helper, []] : ["/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_HELPER_SOURCE]];
      return helperReply(await nativeHelper(command, args, request, { authorize, timeoutMs: request.op === "type" ? 60_000 : 10_000, maxBytes: 64 * 1024 }));
    },
    async capture(width, authorize) {
      const dir = mkdtempSync(join(tmpdir(), "lumenbox-screen-"));
      try {
        authorize();
        await exec("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", join(dir, "full.png")], { timeoutMs: 15_000 });
        authorize();
        await exec("/usr/bin/sips", ["--resampleWidth", width, join(dir, "full.png"), "--out", join(dir, "api.png")], { timeoutMs: 15_000 });
        return readFileSync(join(dir, "api.png"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The resolution a desktop record shows before the first batch has read the screen. */
export function macResolution(state: Pick<ScreenState, "width" | "height">): ResolutionConfig {
  return buildResolutionConfig(state.width, state.height);
}
