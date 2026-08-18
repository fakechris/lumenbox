/**
 * X11 display detection via xrandr / xdpyinfo.
 *
 * Resolution is detected once at daemon start rather than assumed, because the
 * whole coordinate-scaling contract depends on the real framebuffer size being
 * correct. Detection failures throw — a silent fallback would mean every click
 * silently lands at the wrong place.
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { API_WIDTH, type ResolutionConfig } from "../protocol/index.ts";

const execFileAsync = promisify(execFile);

export const DEFAULT_DISPLAY = ":1";

export function getDisplay(override?: string): string {
  return override ?? process.env.DISPLAY ?? DEFAULT_DISPLAY;
}

/**
 * Extracts the display number from an X11 display string.
 * Handles ":1", ":0.0", ":1.0", "localhost:1.0".
 */
export function parseDisplayNum(display: string): number {
  const colonIndex = display.lastIndexOf(":");
  if (colonIndex === -1) {
    throw new Error(`Invalid X11 display string: ${display} (missing ':')`);
  }
  const afterColon = display.slice(colonIndex + 1);
  const numStr = afterColon.split(".")[0] ?? "";
  const num = Number.parseInt(numStr, 10);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(
      `Invalid X11 display number in: ${display} (parsed: ${numStr})`
    );
  }
  return num;
}

export interface DisplayInfo {
  width: number;
  height: number;
  refreshRate: number;
}

export interface DisplayDetectionResult {
  display: DisplayInfo;
  resolution: ResolutionConfig;
  resolutionString: string;
}

/**
 * Parses xrandr output for the active mode.
 *
 * Expected shape:
 *   Screen 0: minimum 8 x 8, current 1920 x 1200, maximum 32767 x 32767
 *   HDMI-1 connected 1920x1200+0+0 ...
 *      1920x1200    120.00*+  60.00      <- the asterisk marks the active mode
 *      1280x800      60.00
 */
export function parseXrandrOutput(output: string): DisplayInfo {
  let width: number | undefined;
  let height: number | undefined;
  let refreshRate: number | undefined;

  for (const line of output.split("\n")) {
    if (!line.includes("*")) continue;

    const resMatch = /^(\d+)x(\d+)/.exec(line.trim());
    if (resMatch) {
      width = Number.parseInt(resMatch[1]!, 10);
      height = Number.parseInt(resMatch[2]!, 10);
    }

    // The refresh rate is the number immediately before the asterisk.
    const rateMatch = /(\d+(?:\.\d+)?)\*\+?/.exec(line);
    if (rateMatch) {
      const rate = Number.parseFloat(rateMatch[1]!);
      if (rate > 0 && rate <= 500) refreshRate = Math.round(rate);
    }

    if (width && height) break;
  }

  if (!width || !height) {
    const currentMatch = /current\s+(\d+)\s*x\s*(\d+)/i.exec(output);
    if (currentMatch) {
      width = Number.parseInt(currentMatch[1]!, 10);
      height = Number.parseInt(currentMatch[2]!, 10);
    }
  }

  if (!width || !height) {
    throw new Error(
      "Could not detect display resolution from xrandr output.\n" +
        "Expected a line with '*' marking the active mode, or 'current WxH'.\n" +
        `xrandr output:\n${output}`
    );
  }

  return { width, height, refreshRate: refreshRate ?? 60 };
}

/** API height follows the display's aspect ratio so scaling stays uniform. */
export function buildResolutionConfig(
  displayWidth: number,
  displayHeight: number
): ResolutionConfig {
  const aspectRatio = displayWidth / displayHeight;
  return {
    display: { width: displayWidth, height: displayHeight },
    api: { width: API_WIDTH, height: Math.round(API_WIDTH / aspectRatio) },
  };
}

export async function detectDisplay(
  display: string
): Promise<DisplayDetectionResult> {
  const { stdout } = await execFileAsync("xrandr", ["--display", display], {
    timeout: 5000,
  });
  const info = parseXrandrOutput(stdout);
  return {
    display: info,
    resolution: buildResolutionConfig(info.width, info.height),
    resolutionString: `${info.width}x${info.height}`,
  };
}

export function isX11Installed(): boolean {
  try {
    execFileSync("xdpyinfo", ["-version"], { stdio: "ignore", timeout: 500 });
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;

export async function waitForDisplay(
  display: string,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS
): Promise<void> {
  if (!isX11Installed()) {
    throw new Error(
      "X11 is not installed (xdpyinfo not found in PATH). " +
        `Cannot wait for display ${display}.`
    );
  }

  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      await execFileAsync("xdpyinfo", ["-display", display], { timeout: 2000 });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(
    `Timed out waiting for X11 display ${display} after ${timeoutMs}ms`
  );
}
