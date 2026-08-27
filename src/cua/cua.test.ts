/**
 * Tests for the CUA logic that has no X server dependency.
 *
 * These are the parts where a subtle error is silent in production: a coordinate
 * that scales wrong makes every click miss, and a WebP header that stays zero
 * makes every screenshot unreadable to the model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CoordinateScaler } from "./scaling.ts";
import {
  buildResolutionConfig,
  parseDisplayNum,
  parseXrandrOutput,
} from "./display.ts";
import {
  actionRequiresSettle,
  assertWindowId,
  keyForXdotool,
  patchWebpHeader,
  pointerPath,
  runThatFits,
  scrollButtonFor,
  windowPointToScreen,
} from "./x11-executor.ts";
import { API_WIDTH } from "../protocol/index.ts";

test("scaler maps API coordinates onto a larger display", () => {
  const scaler = new CoordinateScaler({
    display: { width: 1920, height: 1200 },
    api: { width: 1280, height: 800 },
  });

  assert.deepEqual(scaler.apiToDisplay(640, 400), { x: 960, y: 600 });
  assert.deepEqual(scaler.displayToApi(960, 600), { x: 640, y: 400 });
  // Origin and far corner must be exact, not merely close.
  assert.deepEqual(scaler.apiToDisplay(0, 0), { x: 0, y: 0 });
  assert.deepEqual(scaler.apiToDisplay(1280, 800), { x: 1920, y: 1200 });
});

test("scaler is identity when display and API resolutions match", () => {
  const scaler = new CoordinateScaler({
    display: { width: 1280, height: 800 },
    api: { width: 1280, height: 800 },
  });
  assert.deepEqual(scaler.apiToDisplay(377, 291), { x: 377, y: 291 });
});

test("scaler refuses a mismatched aspect ratio rather than skewing clicks", () => {
  assert.throws(
    () =>
      new CoordinateScaler({
        display: { width: 1920, height: 1080 }, // 16:9
        api: { width: 1280, height: 800 }, // 16:10
      }),
    /Aspect ratio mismatch/
  );
});

test("resolution config derives API height from the display aspect ratio", () => {
  assert.deepEqual(buildResolutionConfig(1920, 1200).api, {
    width: API_WIDTH,
    height: 800,
  });
  assert.deepEqual(buildResolutionConfig(1920, 1080).api, {
    width: API_WIDTH,
    height: 720,
  });
  // A square display should stay square.
  assert.deepEqual(buildResolutionConfig(1000, 1000).api, {
    width: API_WIDTH,
    height: 1280,
  });
});

test("xrandr parsing prefers the starred active mode", () => {
  const output = [
    "Screen 0: minimum 8 x 8, current 1920 x 1200, maximum 32767 x 32767",
    "HDMI-1 connected primary 1920x1200+0+0 (normal left inverted right) 0mm x 0mm",
    "   1920x1200    120.00*+  60.00",
    "   1280x800      60.00",
  ].join("\n");

  assert.deepEqual(parseXrandrOutput(output), {
    width: 1920,
    height: 1200,
    refreshRate: 120,
  });
});

test("xrandr parsing falls back to the 'current WxH' line", () => {
  const output = "Screen 0: minimum 8 x 8, current 1280 x 800, maximum 32767 x 32767";
  const info = parseXrandrOutput(output);
  assert.equal(info.width, 1280);
  assert.equal(info.height, 800);
  // Virtual displays often report no rate; 60 is the honest default.
  assert.equal(info.refreshRate, 60);
});

test("xrandr parsing throws rather than guessing a resolution", () => {
  assert.throws(() => parseXrandrOutput("no useful output here"), /Could not detect/);
});

test("display number parsing handles hostnames and screen suffixes", () => {
  assert.equal(parseDisplayNum(":1"), 1);
  assert.equal(parseDisplayNum(":0.0"), 0);
  assert.equal(parseDisplayNum(":1.0"), 1);
  assert.equal(parseDisplayNum("localhost:1.0"), 1);
  assert.throws(() => parseDisplayNum("nonsense"), /missing ':'/);
});

test("WebP header patch fills in the sizes ffmpeg leaves at zero", () => {
  // A minimal RIFF/WEBP/VP8 container with both size fields zeroed, as ffmpeg
  // writes them when it cannot seek in a pipe.
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(0, 4);
  buffer.write("WEBP", 8);
  buffer.write("VP8 ", 12);
  buffer.writeUInt32LE(0, 16);

  const patched = patchWebpHeader(buffer);
  assert.equal(patched.readUInt32LE(4), 32, "RIFF size is total minus 8");
  assert.equal(patched.readUInt32LE(16), 20, "VP8 chunk size is total minus 20");
});

test("WebP header patch leaves non-VP8 buffers alone", () => {
  const buffer = Buffer.alloc(40);
  buffer.write("RIFF", 0);
  buffer.write("WEBP", 8);
  buffer.write("VP8L", 12); // lossless: a different chunk layout
  buffer.writeUInt32LE(0, 4);

  patchWebpHeader(buffer);
  assert.equal(buffer.readUInt32LE(4), 0, "an unrecognized layout must not be rewritten");
});

test("settle is required after actions that change the screen", () => {
  assert.equal(actionRequiresSettle({ action: "click", coordinate: [1, 1] }), true);
  assert.equal(actionRequiresSettle({ action: "key", key: "Return" }), true);
  assert.equal(
    actionRequiresSettle({ action: "scroll", direction: "down", amount: 3 }),
    true
  );
  // Typing plain text does not reflow the page; committing a line does.
  assert.equal(actionRequiresSettle({ action: "type", text: "hello" }), false);
  assert.equal(actionRequiresSettle({ action: "type", text: "hello\n" }), true);
  assert.equal(actionRequiresSettle({ action: "wait", duration_ms: 10 }), false);
  assert.equal(actionRequiresSettle({ action: "screenshot" }), false);
});

test("keycode-borrowing runs are bounded by distinct unmapped characters", () => {
  // ASCII costs no keycodes, so the whole string fits regardless of capacity.
  assert.equal(runThatFits("hello world", 0), "hello world");

  // Three distinct accented characters need three keycodes.
  assert.equal(runThatFits("áéí", 3), "áéí");
  assert.equal(runThatFits("áéí", 2), "áé");
  assert.equal(runThatFits("áéí", 1), "á");

  // A repeated character is only paid for once.
  assert.equal(runThatFits("áaáaá", 1), "áaáaá");

  // ASCII before the budget runs out is still included.
  assert.equal(runThatFits("ab-áé", 1), "ab-á");
});

test("keycode-borrowing runs do not split surrogate pairs", () => {
  // An emoji is one code point across two UTF-16 units; a run must include both
  // or xdotool receives U+FFFD, which has no key.
  const emoji = "😀";
  assert.equal(emoji.length, 2);
  const run = runThatFits(emoji, 1);
  assert.equal(run, emoji);
  assert.equal([...run].length, 1);
});

test("a mixed-up field name is named, not crashed on", () => {
  // "type" takes text and "key" takes key; swapping them is an easy mistake for a model,
  // and it used to surface as "Cannot read properties of undefined (reading 'split')".
  assert.throws(
    () => keyForXdotool(undefined as unknown as string),
    /needs a non-empty "key" field/
  );
  assert.throws(() => keyForXdotool("   "), /needs a non-empty "key" field/);
});

test("a scroll with no direction is refused by name, not by the X server", () => {
  // It reached xdotool as `click --repeat 3 undefined` and came back as a BadValue quoting
  // an XTEST opcode, which points the reader at the display rather than at the field they
  // got wrong. The caller had written scroll_direction, the other computer-use dialect.
  assert.equal(scrollButtonFor("down"), "5");
  assert.throws(() => scrollButtonFor(undefined), /needs a "direction" field/);
  assert.throws(() => scrollButtonFor("scroll_down"), /Got "scroll_down"/);
  assert.equal(keyForXdotool("ctrl+shift+v"), "ctrl+shift+v");
  assert.equal(keyForXdotool("meta+a"), "super+a");
});

test("window ids are validated, since they come from the model", () => {
  assert.equal(assertWindowId("0x01e00003"), "0x01e00003");
  assert.equal(assertWindowId("  0x2A  "), "0x2A");
  assert.throws(() => assertWindowId("terminal"), /Not a window id/);
  assert.throws(() => assertWindowId("0x01e00003; rm -rf /"), /Not a window id/);
  assert.throws(() => assertWindowId(""), /Not a window id/);
});

test("activating a window needs a settle; listing does not", () => {
  // Raising repaints the screen, so a screenshot straight after would catch it mid-move.
  assert.equal(actionRequiresSettle({ action: "activate_window", window_id: "0x1" }), true);
  assert.equal(actionRequiresSettle({ action: "list_windows" }), false);
  assert.equal(
    actionRequiresSettle({ action: "screenshot_window", window_id: "0x1" }),
    false
  );
});

test("a point in a window becomes a point on the screen", () => {
  // Translation, not scaling: a window capture is the window's own physical pixels.
  const geometry = { x: 160, y: 178, width: 244, height: 108 };
  assert.deepEqual(windowPointToScreen(geometry, [0, 0]), { x: 160, y: 178 });
  assert.deepEqual(windowPointToScreen(geometry, [12, 30]), { x: 172, y: 208 });
  assert.deepEqual(windowPointToScreen(geometry, [243, 107]), { x: 403, y: 285 });
});

test("a point outside the window is refused, not clamped", () => {
  // Clamping would turn "the model read the wrong image" into a click somewhere else,
  // which is far harder to notice than an error.
  const geometry = { x: 160, y: 178, width: 244, height: 108 };
  assert.throws(() => windowPointToScreen(geometry, [244, 10]), /outside the window/);
  assert.throws(() => windowPointToScreen(geometry, [10, 108]), /outside the window/);
  assert.throws(() => windowPointToScreen(geometry, [-1, 10]), /outside the window/);
  assert.throws(
    () => windowPointToScreen(geometry, [Number.NaN, 0]),
    /Not a coordinate/
  );
});

test("a move to where the pointer already is, is not sent", () => {
  // Measured in the box: `mousemove --sync` costs 2ms when the pointer travels and
  // 15,541ms when it does not, and succeeds either way. The commands are bounded at 30s,
  // so this never failed -- it cost fifteen seconds per occurrence and said nothing.
  assert.deepEqual(pointerPath({ x: 400, y: 300 }, [{ x: 400, y: 300 }]), []);
  assert.deepEqual(pointerPath({ x: 400, y: 300 }, [{ x: 401, y: 300 }]), [
    "mousemove --sync 401 300",
  ]);
});

test("a repeated point mid-path is dropped too", () => {
  // A drag path may hold the same point twice, and each repeat is another fifteen seconds.
  assert.deepEqual(
    pointerPath({ x: 0, y: 0 }, [
      { x: 10, y: 10 },
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]),
    ["mousemove --sync 10 10", "mousemove --sync 20 20"]
  );
});

test("an unreadable pointer position skips nothing", () => {
  // The fallback has to be the old behaviour: a query that fails must never be worse than
  // not asking, because the alternative is a click that silently does not happen.
  assert.deepEqual(pointerPath(undefined, [{ x: 400, y: 300 }]), [
    "mousemove --sync 400 300",
  ]);
});
