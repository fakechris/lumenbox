/**
 * The same frame as a JPEG, for a reader that cannot take WebP (INV-1417).
 *
 * Screenshots leave the box as lossless WebP, which the model reads. The decision model the host
 * uses to check a screen takes only PNG or JPEG, so the host asks for this copy alongside — the same
 * frame, never a second capture, or the check would be about a different moment. Optionally with a
 * red box drawn around a point, so a question can say "the control inside the red box" instead of
 * naming coordinates a reader is bad at (INV-1420).
 *
 * Through files rather than pipes, like screenshotWindow: ffmpeg seeks in a file and writes correct
 * sizes, and a bounded temp path is easier to reason about than a pipe's buffering.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execBuffer } from "./shell.ts";

/** A rectangle in the screenshot's own pixels, drawn as a red outline. */
export interface Mark {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Runner = (command: string, args: string[]) => Promise<unknown>;

/** The ffmpeg arguments, apart so a test can read them. */
export function jpegArgs(input: string, output: string, mark?: Mark): string[] {
  const filter = mark === undefined ? [] : ["-vf", `drawbox=x=${Math.round(mark.x)}:y=${Math.round(mark.y)}:w=${Math.round(mark.width)}:h=${Math.round(mark.height)}:color=red@0.9:t=4`];
  return ["-loglevel", "error", "-i", input, ...filter, "-frames:v", "1", "-q:v", "4", "-y", output];
}

export async function webpToJpeg(webpBase64: string, options: { mark?: Mark; env?: Record<string, string>; run?: Runner } = {}): Promise<string> {
  const stem = join(tmpdir(), `agentbox-jpeg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const input = `${stem}.webp`;
  const output = `${stem}.jpg`;
  const run = options.run ?? ((command: string, args: string[]) => execBuffer(command, args, options.env !== undefined ? { env: options.env } : undefined));
  try {
    writeFileSync(input, Buffer.from(webpBase64, "base64"));
    await run("ffmpeg", jpegArgs(input, output, options.mark));
    return readFileSync(output).toString("base64");
  } finally {
    for (const path of [input, output]) {
      try {
        unlinkSync(path);
      } catch {
        // Not written, because a step above failed; that failure is the one worth reporting.
      }
    }
  }
}
