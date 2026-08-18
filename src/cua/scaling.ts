/**
 * Coordinate scaling between the model's API resolution and the real display.
 *
 * The model always sees screenshots at API width (1280); the X display may run
 * at anything. Every incoming coordinate is scaled up before it reaches xdotool,
 * and the cursor position is scaled back down before the model sees it.
 */

import type { ResolutionConfig } from "../protocol/index.ts";

/** Aspect ratios closer than this are treated as equal. */
const MAX_RATIO_DRIFT = 0.02;

export class CoordinateScaler {
  private readonly xScaleUp: number;
  private readonly yScaleUp: number;
  private readonly xScaleDown: number;
  private readonly yScaleDown: number;

  constructor(private readonly config: ResolutionConfig) {
    const displayRatio = config.display.width / config.display.height;
    const apiRatio = config.api.width / config.api.height;

    if (Math.abs(displayRatio - apiRatio) > MAX_RATIO_DRIFT) {
      throw new Error(
        `Aspect ratio mismatch: display=${displayRatio.toFixed(3)}, ` +
          `api=${apiRatio.toFixed(3)}. Clicks would land off-target.`
      );
    }

    this.xScaleUp = config.display.width / config.api.width;
    this.yScaleUp = config.display.height / config.api.height;
    this.xScaleDown = config.api.width / config.display.width;
    this.yScaleDown = config.api.height / config.display.height;
  }

  /** API space -> display space. Used when executing mouse actions. */
  apiToDisplay(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round(x * this.xScaleUp),
      y: Math.round(y * this.yScaleUp),
    };
  }

  /** Display space -> API space. Used when reporting the cursor position. */
  displayToApi(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.round(x * this.xScaleDown),
      y: Math.round(y * this.yScaleDown),
    };
  }

  get apiWidth(): number {
    return this.config.api.width;
  }

  get apiHeight(): number {
    return this.config.api.height;
  }

  get displayWidth(): number {
    return this.config.display.width;
  }

  get displayHeight(): number {
    return this.config.display.height;
  }
}
