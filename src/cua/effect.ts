/**
 * Did the click do anything? Measured from pixels, around the point, before and after.
 *
 * The hole this closes (docs/11 R33 residue, docs/49 A1): a click that a grab or an
 * overlay swallowed returned success, because success meant "xdotool exited zero".
 * huashu-mac-use's finding is the design here — diff only a neighbourhood of the point,
 * because a whole-screen diff is defeated by anything that animates (a carousel, a
 * clock, a blinking caret elsewhere), and a neighbourhood is where a taken click shows.
 *
 * Pure functions; the executor supplies the frames.
 */

import type { Effect } from "../protocol/index.ts";

export interface Point {
  x: number;
  y: number;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of the screen, each way from the point, counts as "near it". */
export const NEIGHBOURHOOD_FRACTION = 0.12;

/**
 * The region around a point, in the same pixel space as the screen size given.
 *
 * ±12% of each dimension, clamped to the screen, and even-sized because ffmpeg's rawvideo
 * grab wants even dimensions on some builds. Never smaller than 8×8: a region that small
 * cannot show anything.
 */
export function neighbourhoodOf(
  point: Point,
  screen: { width: number; height: number },
  fraction = NEIGHBOURHOOD_FRACTION
): Region {
  const halfW = Math.max(4, Math.round(screen.width * fraction));
  const halfH = Math.max(4, Math.round(screen.height * fraction));
  const x0 = Math.max(0, Math.min(Math.round(point.x) - halfW, screen.width - 8));
  const y0 = Math.max(0, Math.min(Math.round(point.y) - halfH, screen.height - 8));
  const x1 = Math.min(screen.width, Math.round(point.x) + halfW);
  const y1 = Math.min(screen.height, Math.round(point.y) + halfH);
  let width = Math.max(8, x1 - x0);
  let height = Math.max(8, y1 - y0);
  if (width % 2 === 1) width -= 1;
  if (height % 2 === 1) height -= 1;
  return { x: x0, y: y0, width, height };
}

/** Per-channel difference below this is noise (dithering, a compositor's rounding). */
export const CHANNEL_THRESHOLD = 24;

/**
 * The fraction of pixels that differ between two raw RGB frames of the same region.
 *
 * Throws on a size mismatch rather than comparing what overlaps: two frames of different
 * sizes are not the same region, and a silent partial compare would report a change
 * that is only the offset.
 */
export function regionDiff(before: Buffer, after: Buffer, channels = 3, threshold = CHANNEL_THRESHOLD): number {
  if (before.length !== after.length) {
    throw new Error(`frames differ in size (${before.length} vs ${after.length} bytes)`);
  }
  if (before.length === 0) return 0;
  const pixels = Math.floor(before.length / channels);
  let changed = 0;
  for (let p = 0; p < pixels; p++) {
    const at = p * channels;
    for (let c = 0; c < channels; c++) {
      if (Math.abs(before[at + c]! - after[at + c]!) > threshold) {
        changed++;
        break;
      }
    }
  }
  return changed / pixels;
}

/** A taken click repaints at least a button's worth of the neighbourhood. */
export const CONFIRMED_FRACTION = 0.02;
/** Below this, what changed is a caret or a hover ring, not a taken action. */
export const PARTIAL_FRACTION = 0.002;

export function effectOf(changedFraction: number): Effect {
  if (changedFraction >= CONFIRMED_FRACTION) return "confirmed";
  if (changedFraction >= PARTIAL_FRACTION) return "partial";
  return "suspected_noop";
}

const SEVERITY: Record<Effect, number> = {
  unverifiable: 0,
  suspected_noop: 1,
  partial: 2,
  confirmed: 3,
};

/** The batch's effect is its weakest write: one swallowed click spoils a batch. */
export function worstEffect(effects: readonly Effect[]): Effect | undefined {
  let worst: Effect | undefined;
  for (const effect of effects) {
    if (worst === undefined || SEVERITY[effect] < SEVERITY[worst]) worst = effect;
  }
  return worst;
}

/** One measured write, as the model reads it in `effect_detail`. */
export function describeMeasurement(
  action: string,
  point: Point | undefined,
  effect: Effect,
  changedFraction?: number
): string {
  const where = point !== undefined ? `@(${Math.round(point.x)},${Math.round(point.y)})` : "";
  const pct = changedFraction !== undefined ? ` ${(changedFraction * 100).toFixed(1)}%` : "";
  return `${action}${where} ${effect}${pct}`;
}
