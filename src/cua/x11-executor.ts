/**
 * X11 computer-use executor: translates model actions into synthetic input via
 * xdotool, and captures the screen via ffmpeg.
 *
 * Runs inside the box. The host never invokes xdotool or ffmpeg directly.
 */

import type {
  ComputerAction,
  Coordinate,
  MouseButton,
  ResolutionConfig,
  ScrollDirection,
} from "../protocol/index.ts";
import { CoordinateScaler } from "./scaling.ts";
import { exec, execBuffer, execWithInput, sleep } from "./shell.ts";

const BUTTON_MAP: Record<MouseButton, string> = {
  left: "1",
  middle: "2",
  right: "3",
  back: "8",
  forward: "9",
};

const SCROLL_BUTTON: Record<ScrollDirection, string> = {
  up: "4",
  down: "5",
  left: "6",
  right: "7",
};

/**
 * How long a keymap change is held before and after the keystrokes relying on it.
 *
 * An application translates a key event against its own cached copy of the
 * keymap, and X offers no way to ask whether it has caught up: MappingNotify
 * carries no version and the server keeps no history.
 */
const KEYMAP_SETTLE_MS = 300;

/** Pause before a screenshot when the preceding action needs the UI to settle. */
export const DEFAULT_SCREENSHOT_DELAY_MS = 350;
export const DEFAULT_TYPING_DELAY_MS = 12;
export const DEFAULT_TYPING_BATCH_SIZE = 50;

/**
 * A single keysym or modifier name: letters, digits, and underscore.
 *
 * Key names arrive from the model and are appended to an xdotool argument list,
 * and xdotool chains subcommands within one invocation — so an unvalidated name
 * containing a space could smuggle in an extra command. Real keysyms
 * ("Return", "ctrl", "F5", "aacute") never need anything outside this set.
 */
const KEYSYM_PATTERN = /^[A-Za-z0-9_]+$/;

function assertKeysym(part: string, whole: string): string {
  if (!KEYSYM_PATTERN.test(part)) {
    throw new Error(
      `Invalid key name ${JSON.stringify(whole)}: ` +
        `the component ${JSON.stringify(part)} is not a keysym. ` +
        "Use names like 'Return', 'ctrl+c', or 'F5'."
    );
  }
  return part;
}

/** xdotool spells the macOS-style `meta` modifier `super`. */
function modifiersForXdotool(raw: string | undefined): string[] {
  return (raw?.split("+").filter(Boolean) ?? []).map(modifier =>
    assertKeysym(modifier === "meta" ? "super" : modifier, raw ?? "")
  );
}

function keyForXdotool(key: string): string {
  return key
    .split("+")
    .filter(Boolean)
    .map(part => assertKeysym(part === "meta" ? "super" : part, key))
    .join("+");
}

/** Whether every character in `text` has a key on the default keymap. */
function isAscii(text: string): boolean {
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) return false;
  }
  return true;
}

/** The distinct characters of `text` with no key, in order of appearance. */
function unmappedCharacters(text: string): string[] {
  return [...new Set([...text].filter(char => !isAscii(char)))];
}

/** The `UXXXX` keysym name X uses for a Unicode character. */
function unicodeKeysym(char: string): string {
  return `U${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * The longest prefix of `text` needing no more than `capacity` keys bound.
 *
 * Only distinct unmapped characters cost a key, so ASCII is free and a run ends
 * only where the next new character would not fit.
 */
export function runThatFits(text: string, capacity: number): string {
  const needed = new Set<string>();
  let length = 0;
  for (const char of text) {
    if (!isAscii(char) && !needed.has(char)) {
      if (needed.size === capacity) break;
      needed.add(char);
    }
    length += char.length;
  }
  return text.slice(0, length);
}

/** Actions after which the UI needs a moment before a screenshot is meaningful. */
export function actionRequiresSettle(action: ComputerAction): boolean {
  switch (action.action) {
    case "mouse_move":
    case "click":
    case "mouse_down":
    case "mouse_up":
    case "drag":
    case "key":
    case "scroll":
      return true;
    case "type":
      // Typing only reflows the page when it commits a line.
      return /[\r\n]/.test(action.text);
    case "wait":
    case "screenshot":
    case "cursor_position":
      return false;
  }
}

/**
 * ffmpeg cannot seek in a pipe, so it leaves the RIFF and VP8 chunk sizes as 0.
 * The image data is valid but browsers and image viewers reject the file. Patch
 * the two size fields in place.
 */
export function patchWebpHeader(buffer: Buffer): Buffer {
  const isSimpleVP8Webp =
    buffer.length > 20 &&
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP" &&
    buffer.subarray(12, 16).toString() === "VP8 ";

  if (isSimpleVP8Webp) {
    buffer.writeUInt32LE(buffer.length - 8, 4); // RIFF size
    buffer.writeUInt32LE(buffer.length - 20, 16); // VP8 chunk size
  }
  return buffer;
}

export interface X11Config {
  display: string;
  resolution: ResolutionConfig;
  screenshotDelayMs?: number;
  typingDelayMs?: number;
  typingBatchSize?: number;
}

export interface TypingOptions {
  /**
   * Bind a keycode for each character with no key before typing it, rather than
   * letting `xdotool type` remap one per character and lose it. See
   * `typeWithBorrowedKeys`.
   */
  bindUnmappedCharacters?: boolean;
}

export interface X11ExecutionResult {
  success: boolean;
  screenshot: string;
  cursorPosition?: { x: number; y: number };
  actionCount: number;
  durationMs: number;
  error?: string;
}

export class X11Executor {
  private readonly config: Required<X11Config>;
  private readonly scaler: CoordinateScaler;
  private readonly env: Record<string, string>;

  constructor(config: X11Config) {
    this.config = {
      display: config.display,
      resolution: config.resolution,
      screenshotDelayMs: config.screenshotDelayMs ?? DEFAULT_SCREENSHOT_DELAY_MS,
      typingDelayMs: config.typingDelayMs ?? DEFAULT_TYPING_DELAY_MS,
      typingBatchSize: config.typingBatchSize ?? DEFAULT_TYPING_BATCH_SIZE,
    };
    this.scaler = new CoordinateScaler(this.config.resolution);
    this.env = { DISPLAY: this.config.display };
  }

  private xdotool(args: string): Promise<string> {
    return exec("xdotool", args.split(" ").filter(Boolean), { env: this.env });
  }

  private scale(coord: Coordinate): { x: number; y: number } {
    return this.scaler.apiToDisplay(coord[0], coord[1]);
  }

  /**
   * Runs a batch of actions and returns a screenshot of the end state.
   *
   * A batch is the unit the model gets feedback on: it can click, type, and press
   * Enter in one call and see a single settled screenshot, rather than paying a
   * round trip per keystroke.
   */
  async execute(
    actions: readonly ComputerAction[],
    options: TypingOptions = {}
  ): Promise<X11ExecutionResult> {
    const start = Date.now();
    let cursorPosition: { x: number; y: number } | undefined;
    let lastScreenshot: string | undefined;
    let screenshotTaken = false;
    let settleNeeded = false;

    for (const action of actions) {
      if (action.action === "screenshot") {
        if (settleNeeded) {
          await sleep(this.config.screenshotDelayMs);
          settleNeeded = false;
        }
        lastScreenshot = await this.takeScreenshot();
        screenshotTaken = true;
      } else if (action.action === "cursor_position") {
        cursorPosition = await this.readCursorPosition();
      } else {
        await this.executeAction(action, options);
        if (actionRequiresSettle(action)) settleNeeded = true;
      }
    }

    // Always hand back a screenshot, so the model never has to ask for one.
    if (!screenshotTaken) {
      if (settleNeeded) await sleep(this.config.screenshotDelayMs);
      lastScreenshot = await this.takeScreenshot();
    }

    return {
      success: true,
      screenshot: lastScreenshot ?? "",
      cursorPosition,
      actionCount: actions.length,
      durationMs: Date.now() - start,
    };
  }

  private async executeAction(
    action: ComputerAction,
    options: TypingOptions
  ): Promise<void> {
    switch (action.action) {
      case "mouse_move": {
        const { x, y } = this.scale(action.coordinate);
        await this.xdotool(`mousemove --sync ${x} ${y}`);
        return;
      }

      case "click": {
        const button = BUTTON_MAP[action.button ?? "left"];
        const count = action.count ?? 1;
        const clickArgs =
          count > 1 ? `--repeat ${count} --delay 50 ${button}` : button;

        const parts: string[] = [];
        const modifiers = modifiersForXdotool(action.modifiers);
        for (const mod of modifiers) parts.push(`keydown ${mod}`);
        if (action.coordinate) {
          const { x, y } = this.scale(action.coordinate);
          parts.push(`mousemove --sync ${x} ${y}`);
        }
        parts.push(`click ${clickArgs}`);
        // Release in reverse order so the modifier stack unwinds LIFO.
        for (const mod of [...modifiers].reverse()) parts.push(`keyup ${mod}`);

        await this.xdotool(parts.join(" "));
        return;
      }

      case "mouse_down":
        await this.xdotool(`mousedown ${BUTTON_MAP[action.button ?? "left"]}`);
        return;

      case "mouse_up":
        await this.xdotool(`mouseup ${BUTTON_MAP[action.button ?? "left"]}`);
        return;

      case "drag": {
        if (action.path.length < 2) {
          throw new Error("drag path must have at least 2 points");
        }
        const button = BUTTON_MAP[action.button ?? "left"];
        const scaled = action.path.map(coord => this.scale(coord));
        const parts: string[] = [];

        const modifiers = modifiersForXdotool(action.modifiers);
        for (const mod of modifiers) parts.push(`keydown ${mod}`);

        const first = scaled[0]!;
        parts.push(`mousemove --sync ${first.x} ${first.y}`);
        parts.push(`mousedown ${button}`);
        for (const point of scaled.slice(1)) {
          parts.push(`mousemove --sync ${point.x} ${point.y}`);
        }
        parts.push(`mouseup ${button}`);
        for (const mod of [...modifiers].reverse()) parts.push(`keyup ${mod}`);

        await this.xdotool(parts.join(" "));
        return;
      }

      case "scroll": {
        const button = SCROLL_BUTTON[action.direction];
        const amount = action.amount ?? 3;
        const parts: string[] = [];

        const modifiers = modifiersForXdotool(action.modifiers);
        for (const mod of modifiers) parts.push(`keydown ${mod}`);
        if (action.coordinate) {
          const { x, y } = this.scale(action.coordinate);
          parts.push(`mousemove --sync ${x} ${y}`);
        }
        // A wheel notch is a button press, so N notches is N presses.
        parts.push(`click --repeat ${amount} ${button}`);
        for (const mod of [...modifiers].reverse()) parts.push(`keyup ${mod}`);

        await this.xdotool(parts.join(" "));
        return;
      }

      case "type":
        await this.typeText(action.text, options);
        return;

      case "key": {
        const key = keyForXdotool(action.key);
        if (action.hold_duration_ms && action.hold_duration_ms > 0) {
          await this.xdotool(`keydown ${key}`);
          await sleep(action.hold_duration_ms);
          await this.xdotool(`keyup ${key}`);
        } else {
          await this.xdotool(`key -- ${key}`);
        }
        return;
      }

      case "wait":
        await sleep(action.duration_ms);
        return;

      case "screenshot":
      case "cursor_position":
        // Handled by the caller, which owns settle timing and the result fields.
        return;
    }
  }

  private async readCursorPosition(): Promise<{ x: number; y: number }> {
    const output = await this.xdotool("getmouselocation --shell");
    const xMatch = /X=(\d+)/.exec(output);
    const yMatch = /Y=(\d+)/.exec(output);
    if (!xMatch || !yMatch) {
      throw new Error(
        `Failed to parse cursor position from xdotool output: ${output}`
      );
    }
    return this.scaler.displayToApi(
      Number.parseInt(xMatch[1]!, 10),
      Number.parseInt(yMatch[1]!, 10)
    );
  }

  /**
   * Types text, converting newlines to Return presses, because `xdotool type`
   * sends Linefeed for `\n` and most applications expect Return.
   */
  private async typeText(
    text: string,
    { bindUnmappedCharacters = true }: TypingOptions
  ): Promise<void> {
    const lines = text.split(/\r\n|\r|\n/);
    for (const [index, line] of lines.entries()) {
      if (index > 0) await this.xdotool("key Return");
      if (bindUnmappedCharacters && !isAscii(line)) {
        await this.typeWithBorrowedKeys(line);
      } else {
        await this.sendKeystrokes(line);
      }
    }
  }

  /**
   * Types text containing characters that have no key on the keymap.
   *
   * `xdotool type` handles such a character by borrowing a spare keycode,
   * pressing it, and handing it straight back, once per character. The
   * application translates the event against its own lazily-refreshed copy of the
   * keymap, so a keystroke that overtakes the server's MappingNotify resolves
   * against the stale mapping and vanishes — while xdotool still exits 0. That is
   * how "Aprenderás" reaches a live page as "Aprenders".
   *
   * Borrowing here instead means every character is already on the keymap before
   * a single key is pressed, and stays there until the run has been typed, so
   * nothing is remapped mid-type. The keymap holds only so many spare keycodes,
   * so longer text is typed as several runs that each fit.
   */
  private async typeWithBorrowedKeys(text: string): Promise<void> {
    let remaining = text;
    while (remaining !== "") {
      // Re-read per run rather than reusing a list from before the last release,
      // so a keycode another action has since taken is never handed out twice.
      const spare = await this.spareKeycodes();
      if (spare.length === 0) {
        throw new Error(
          `Cannot type ${JSON.stringify(unmappedCharacters(remaining).join(""))}: ` +
            "the X keymap has no spare keycode to bind them to."
        );
      }

      const run = runThatFits(remaining, spare.length);
      remaining = remaining.slice(run.length);
      const bindings = unmappedCharacters(run).map(
        (char, index) => [spare[index]!, unicodeKeysym(char)] as const
      );

      try {
        // Each keysym twice: X expands a keycode holding one alphabetic keysym
        // into [lowercase, uppercase], so "Á" alone would arrive as "á".
        await this.changeKeymap(
          bindings.map(
            ([keycode, keysym]) => `keycode ${keycode} = ${keysym} ${keysym}`
          )
        );
        await sleep(KEYMAP_SETTLE_MS);
        await this.sendKeystrokes(run, {
          clearModifiers: true,
          byCodePoint: true,
        });
        await sleep(KEYMAP_SETTLE_MS);
      } finally {
        await this.changeKeymap(
          bindings.map(([keycode]) => `keycode ${keycode} =`)
        ).catch(() => {
          // A keycode left bound produces nothing on any physical key, so a
          // failed release must not mask a typing error.
        });
      }
    }
  }

  private async sendKeystrokes(
    text: string,
    {
      clearModifiers = false,
      byCodePoint = false,
    }: { clearModifiers?: boolean; byCodePoint?: boolean } = {}
  ): Promise<void> {
    const { typingDelayMs, typingBatchSize } = this.config;
    // A batch boundary inside a surrogate pair reaches xdotool as U+FFFD, which
    // has no key.
    const units = byCodePoint ? [...text] : text.split("");
    for (let i = 0; i < units.length; i += typingBatchSize) {
      const batch = units.slice(i, i + typingBatchSize).join("");
      await exec(
        "xdotool",
        [
          "type",
          ...(clearModifiers ? ["--clearmodifiers"] : []),
          "--delay",
          String(typingDelayMs),
          "--",
          batch,
        ],
        { env: { ...this.env, LC_ALL: "C.UTF-8" } }
      );
    }
  }

  /** Keycodes carrying no keysyms at all, and so free to borrow. */
  private async spareKeycodes(): Promise<number[]> {
    const table = await exec("xmodmap", ["-pke"], { env: this.env });
    return table
      .split("\n")
      .map(line => /^keycode\s+(\d+)\s*=\s*$/.exec(line.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => Number(match[1]));
  }

  private changeKeymap(entries: string[]): Promise<void> {
    return execWithInput("xmodmap", ["-"], {
      input: `${entries.join("\n")}\n`,
      env: this.env,
    });
  }

  async takeScreenshot(): Promise<string> {
    const { width, height } = this.config.resolution.display;
    const buffer = await execBuffer(
      "ffmpeg",
      [
        "-loglevel", "error",
        "-f", "x11grab",
        "-video_size", `${width}x${height}`,
        "-i", this.config.display,
        "-frames:v", "1",
        // Physical -> API space. This is what the model sees.
        "-vf", `scale=${this.scaler.apiWidth}:${this.scaler.apiHeight}`,
        "-c:v", "libwebp",
        // Tuned for sharp edges and text rather than photos.
        "-preset", "text",
        "-lossless", "1",
        "-f", "webp",
        "pipe:1",
      ],
      { env: this.env }
    );

    return patchWebpHeader(buffer).toString("base64");
  }
}
